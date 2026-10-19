// 外壳设置（用户可写）：版本化 + 校验 + 迁移 + 原子写。
//
// 重构前的 src/settings.js 只有三步：readFileSync → JSON.parse → 用 patch 覆盖。
// 问题：
//   1. 没有版本号，以后想改结构只能靠猜；
//   2. 写文件是直接 writeFileSync，写到一半断电/崩溃会留下半截 JSON，
//      下次读的时候静默变成"没设置过"，API Key 就丢了；
//   3. 坏文件被静默当成空对象，用户无从知道自己的 Key 被清掉了；
//   4. 没有校验：手工把 apiKey 写成数字，运行时才炸在别的模块。
//
// 本模块的做法：
//   - 文件里一定有 version（当前 2）；未带 version 的旧文件按 v1 读入并迁移；
//   - 已知字段做类型校验，非法值回落到默认并给出 warning（不抛错、不丢整份文件）；
//   - 写盘走"临时文件 + fsync + rename"，原子替换；
//   - 解析失败时把坏文件备份成 *.bad-<时间戳>，再回落到默认值。
//
// 文件位置由调用方决定（通常 paths.settingsFile），模块本身不猜路径。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SCHEMA_VERSION = 2;
const LEGACY_VERSION = 1;

const ACCESS_MODES = Object.freeze(['local', 'lan', 'tunnel']);

// 默认值。注意 keepServerOnClose 默认 true（关窗口不关服务）是已定决策。
// deviceAuth 默认 false：局域网客户端不要求设备密钥，行为与 P1 接线前完全一致。
const DEFAULT_SETTINGS = Object.freeze({
  version: SCHEMA_VERSION,
  apiKey: '',
  probe: true,
  lanMode: false,
  keepServerOnClose: true,
  lastModelId: null,
  lastPreset: null,
  accessMode: 'local',
  deviceAuth: false,
});

const STRING_KEYS = Object.freeze(['apiKey', 'lastModelId', 'lastPreset']);
const NULLABLE_STRING_KEYS = Object.freeze(['lastModelId', 'lastPreset']);
const BOOLEAN_KEYS = Object.freeze(['probe', 'lanMode', 'keepServerOnClose', 'deviceAuth']);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * 把任意读到的对象收敛成合法设置。
 *
 * 返回 { settings, warnings, migratedFrom }：
 *   migratedFrom  非 null 表示这份数据来自旧版本（需要写回新格式）
 *   warnings      [{ key, reason }]，供日志/界面提示，不阻断使用
 */
function normalize(raw) {
  const warnings = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      settings: clone(DEFAULT_SETTINGS),
      warnings: [{ key: null, reason: 'settings-not-an-object' }],
      migratedFrom: null,
    };
  }

  const declared = Number(raw.version);
  const version = Number.isInteger(declared) && declared > 0 ? declared : LEGACY_VERSION;
  const migratedFrom = version === LEGACY_VERSION ? LEGACY_VERSION : null;

  if (version > SCHEMA_VERSION) {
    // 未来版本写的文件：不降级、不丢字段，只提示。
    warnings.push({ key: 'version', reason: `newer-version:${version}` });
  } else if (!Number.isInteger(declared) || declared < 1) {
    warnings.push({ key: 'version', reason: 'missing-version-assumed-v1' });
  }

  const settings = clone(DEFAULT_SETTINGS);

  // 旧格式就是"平铺对象"，字段名和 v1 一致（apiKey/probe/lanMode），
  // 所以迁移只需要把 version 补上；下面按同一套规则取值即可。
  for (const key of STRING_KEYS) {
    if (raw[key] === undefined) continue;
    if (raw[key] === null && NULLABLE_STRING_KEYS.includes(key)) {
      settings[key] = null;
    } else if (typeof raw[key] === 'string') {
      settings[key] = key === 'apiKey' ? raw[key].trim() : raw[key];
    } else {
      warnings.push({ key, reason: 'not-a-string' });
    }
  }
  for (const key of BOOLEAN_KEYS) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] === 'boolean') settings[key] = raw[key];
    else warnings.push({ key, reason: 'not-a-boolean' });
  }

  if (raw.accessMode !== undefined) {
    if (typeof raw.accessMode === 'string' && ACCESS_MODES.includes(raw.accessMode)) {
      settings.accessMode = raw.accessMode;
    } else {
      warnings.push({ key: 'accessMode', reason: 'not-an-access-mode' });
    }
  }

  // 未知字段原样保留（向前兼容：别让旧外壳把它删掉）。
  const known = new Set([...Object.keys(DEFAULT_SETTINGS)]);
  for (const [key, value] of Object.entries(raw)) {
    if (known.has(key)) continue;
    settings[key] = value;
  }

  if (version <= SCHEMA_VERSION) settings.version = SCHEMA_VERSION;
  else settings.version = version;

  return { settings, warnings, migratedFrom };
}

/** 备份坏文件（尽力而为，失败也不影响回落）。 */
function backupBadFile(file, fsImpl, now) {
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
  const target = `${file}.bad-${stamp}`;
  try {
    fsImpl.renameSync(file, target);
    return target;
  } catch {
    try {
      fsImpl.copyFileSync(file, target);
      fsImpl.unlinkSync(file);
      return target;
    } catch {
      return null;
    }
  }
}

/**
 * 读设置（不存在 → 默认值；坏文件 → 备份 + 默认值；旧版本 → 默认值合并后写回）。
 *
 * 选项：fs / now / persist（旧版本迁移是否立即写回，默认 true）。
 */
function loadSettings(file, options = {}) {
  const fsImpl = options.fs || fs;
  const now = options.now || Date.now;
  const persist = options.persist !== false;
  const result = {
    settings: clone(DEFAULT_SETTINGS),
    warnings: [],
    existed: false,
    migratedFrom: null,
    wroteBack: false,
    backupFile: null,
  };

  let text;
  try {
    text = fsImpl.readFileSync(file, 'utf8');
    result.existed = true;
  } catch {
    return result; // 没设置过：直接用默认值
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    result.warnings.push({ key: null, reason: 'corrupt-json' });
    result.backupFile = backupBadFile(file, fsImpl, now);
    return result;
  }

  const normalized = normalize(raw);
  result.settings = normalized.settings;
  result.warnings.push(...normalized.warnings);
  result.migratedFrom = normalized.migratedFrom;

  // 旧版本（或未来版本被动保留）需要写回时，由调用方决定是否 persist。
  if (result.migratedFrom !== null && persist) {
    try {
      saveSettings(file, result.settings, { fs: fsImpl, now });
      result.wroteBack = true;
    } catch (e) {
      result.warnings.push({ key: null, reason: `migration-write-failed:${e.message}` });
    }
  }

  return result;
}

/**
 * 原子写设置：临时文件 + fsync + rename。
 *
 * 不用 writeFileSync(file) 的原因是写到一半崩溃会留下半截 JSON，
 * 而读侧会把坏文件当成"没设置过"——用户的 API Key 就这么无声丢了。
 */
function saveSettings(file, settings, options = {}) {
  const fsImpl = options.fs || fs;
  const now = options.now || Date.now;
  const normalized = normalize(settings).settings; // 写出去的永远合法

  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${now()}`;
  const fd = fsImpl.openSync(tmp, 'w', 0o600);
  try {
    fsImpl.writeFileSync(fd, JSON.stringify(normalized, null, 2) + '\n', 'utf8');
    try { fsImpl.fsyncSync(fd); } catch { /* 有些文件系统不支持 fsync，忽略 */ }
  } finally {
    try { fsImpl.closeSync(fd); } catch {}
  }
  try {
    fsImpl.renameSync(tmp, file);
  } catch (e) {
    try { fsImpl.unlinkSync(tmp); } catch {}
    throw e;
  }
  return normalized;
}

/** 读-改-写：patch 里只覆盖传进来的键，其余保持。返回 { settings, warnings }。 */
function updateSettings(file, patch, options = {}) {
  const loaded = loadSettings(file, { persist: false, ...options });
  const next = { ...loaded.settings };
  for (const [key, value] of Object.entries(patch || {})) {
    if (key === 'version') continue; // 版本号由本模块维护
    next[key] = value;
  }
  const normalized = normalize(next);
  saveSettings(file, normalized.settings, options);
  return { settings: normalized.settings, warnings: [...loaded.warnings, ...normalized.warnings] };
}

/**
 * 造一个够用的随机 API Key（32 位十六进制，128 bit）。
 *
 * 攻击面是同一个局域网里的其他人，128 bit 足够；只用 0-9a-f 是为了
 * 好手抄、不用 URL 转义。和重构前的实现保持一致，避免用户的旧 Key 记忆失效。
 */
function generateApiKey() {
  return crypto.randomBytes(16).toString('hex');
}

module.exports = {
  SCHEMA_VERSION,
  LEGACY_VERSION,
  ACCESS_MODES,
  DEFAULT_SETTINGS,
  STRING_KEYS,
  NULLABLE_STRING_KEYS,
  BOOLEAN_KEYS,
  normalize,
  loadSettings,
  saveSettings,
  updateSettings,
  generateApiKey,
};
