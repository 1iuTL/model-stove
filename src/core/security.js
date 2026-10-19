// P1 安全核心：设备密钥注册表、配对码、审计日志、令牌桶限流。
//
// 这个文件刻意只做"纯核心"：
//   - 不 require electron / 不读 config / 不猜路径，所有文件路径由调用方传入；
//   - 不 spawn、不发网络请求；proxy/main 的接线留给 Lead 的下一步；
//   - fs / now / crypto 全部可注入，测试用临时目录 + 假时钟，不碰真实用户目录。
//
// 威胁模型（详见 docs/P1-安全进度.md）：
//   - 主要防线是"同一局域网里的其他设备"，不是已经能读本机文件的攻击者。
//     设备 key 只存 sha256，配对码只存"带盐 sha256"；能防顺手看到文件，
//     但防不了本地离线爆破 6 位配对码（1e6 种，很快）。配对码的真正边界是
//     5 分钟 TTL + 尝试上限 + 上游限流 + 单次使用。
//   - 审计日志的 detail 由调用方保证不含提示词/补全内容/请求头/API Key；
//     本模块只做 500 字符截断与 JSON 转义，无法识别语义。
//   - 注册表/配对文件假定单进程单写者（本应用只有一个外壳进程）。多进程同时
//     写会互相覆盖，没有文件锁。
//
// 约定：
//   - 时间统一为毫秒 epoch（可注入 now）；
//   - 文件写入走"临时文件 + fsync + rename"（audit 的追加日志除外）；
//   - 坏文件先备份成 *.bad-<ISO 时间戳>，再从空状态继续，不把异常抛给调用方；
//   - 磁盘写入失败（权限/磁盘满）会抛错，调用方决定是否降级。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SECURITY_VERSION = 1;

// 设备 key：32 字节随机数 → 64 位十六进制。展示前缀只取前 8 个字符。
const KEY_BYTES = 32;
const KEY_PREFIX_LEN = 8;
const LAST_USED_THROTTLE_MS = 60 * 1000;
const MAX_DEVICE_NAME_CHARS = 64;

// 配对码：6 位十进制数字，默认 5 分钟有效、错 5 次作废。
const DEFAULT_PAIRING_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 5;
const PAIRING_CODE_SPACE = 1_000_000;
const PAIRING_CODE_LEN = 6;
const PAIRING_SALT_BYTES = 16;

// 审计：detail 是给短文本留的；超过 500 字符截断，避免把整段对话写进日志。
const DETAIL_MAX_CHARS = 500;
const AUDIT_FIELD_MAX_CHARS = 64;

// 限流：key 最多保留 256 字符，防止调用方把超长 header 当 key 撑大内存。
const RATE_LIMIT_KEY_MAX_CHARS = 256;

/** 审计事件名。调用方用常量而不是手写字符串，避免拼写漂移。 */
const AUDIT_EVENTS = Object.freeze({
  AUTH_OK: 'auth_ok',
  AUTH_FAIL: 'auth_fail',
  PAIR_CREATE: 'pair_create',
  PAIR_REDEEM_FAIL: 'pair_redeem_fail',
  PAIR_REDEEM_OK: 'pair_redeem_ok',
  REVOKE: 'revoke',
  RATE_LIMITED: 'rate_limited',
});

// ---------------------------------------------------------------- 通用小工具

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function nonNegativeInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 把值收敛成有限数字；null/undefined/非法 → null。用于时间戳的"可空"字段。 */
function optionalTime(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeDeviceName(name) {
  const text = typeof name === 'string' ? name.trim() : '';
  return (text || '未命名设备').slice(0, MAX_DEVICE_NAME_CHARS);
}

function textField(value, maxChars) {
  if (value == null) return null;
  return String(value).slice(0, maxChars);
}

/** sha256 的十六进制摘要（小写）。设备 key 与配对码都只存这个值。 */
function sha256Hex(cryptoImpl, text) {
  return cryptoImpl.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/**
 * 常量时间比较两段文本。
 *
 * 优先用 crypto.timingSafeEqual（比较字节数固定为 64，长度不等直接 false，
 * 不会泄露 key 内容）；注入的 crypto 没有该函数时用等长 XOR 兜底。
 */
function safeEqualText(left, right, cryptoImpl) {
  const a = Buffer.from(String(left), 'utf8');
  const b = Buffer.from(String(right), 'utf8');
  if (a.length !== b.length) return false;
  if (cryptoImpl && typeof cryptoImpl.timingSafeEqual === 'function') {
    try {
      return cryptoImpl.timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** 备份坏文件。尽力而为：rename 失败就 copy + unlink，再失败返回 null。 */
function backupBadFile(file, fsImpl, now) {
  const stamp = new Date(Number(now())).toISOString().replace(/[:.]/g, '-');
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

/** 读文本；文件不存在返回 { text: null, missing: true }，其它读错误也返回 null。 */
function readTextOrMissing(file, fsImpl) {
  try {
    return { text: fsImpl.readFileSync(file, 'utf8'), missing: false, error: null };
  } catch (e) {
    return {
      text: null,
      missing: !!(e && e.code === 'ENOENT'),
      error: e || null,
    };
  }
}

let tmpSeq = 0;

/**
 * 原子写 JSON：临时文件 + fsync + rename。
 *
 * 为什么不用 writeFileSync 直接写目标文件：写到一半崩溃/断电会留下半截 JSON，
 * 下次启动读到坏文件就只能备份并清空 —— 所有设备 key 一起失效。
 */
function atomicWriteJson(file, value, fsImpl, now) {
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Number(now())}-${tmpSeq++}`;
  const fd = fsImpl.openSync(tmp, 'w', 0o600);
  try {
    fsImpl.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n', 'utf8');
    if (typeof fsImpl.fsyncSync === 'function') {
      try { fsImpl.fsyncSync(fd); } catch { /* 某些文件系统/测试桩不支持 fsync */ }
    }
  } finally {
    try { fsImpl.closeSync(fd); } catch { /* 关闭失败不掩盖上面的错误 */ }
  }
  try {
    fsImpl.renameSync(tmp, file);
  } catch (e) {
    try { fsImpl.unlinkSync(tmp); } catch { /* 清临时文件是尽力而为 */ }
    throw e;
  }
}

// ---------------------------------------------------------------- 状态校验

function emptyRegistryState() {
  return { version: SECURITY_VERSION, devices: [], pairing: [] };
}

/**
 * 收敛一条设备记录；无法识别（缺 id/hash）的条目返回 null。
 * 注意这里只接受 sha256 hex，绝不接受/保存明文 key。
 */
function normalizeDevice(raw) {
  if (!isPlainObject(raw)) return null;
  const id = typeof raw.id === 'string' ? raw.id.trim().slice(0, AUDIT_FIELD_MAX_CHARS) : '';
  const hash = typeof raw.hash === 'string' ? raw.hash.trim().toLowerCase() : '';
  if (!id || !/^[0-9a-f]{64}$/.test(hash)) return null;
  const createdAt = optionalTime(raw.createdAt);
  return {
    id,
    name: normalizeDeviceName(raw.name),
    prefix: typeof raw.prefix === 'string' ? raw.prefix.slice(0, KEY_PREFIX_LEN) : '',
    hash,
    createdAt: createdAt == null ? 0 : createdAt,
    lastUsedAt: optionalTime(raw.lastUsedAt),
    revokedAt: optionalTime(raw.revokedAt),
    expiresAt: optionalTime(raw.expiresAt),
    rotatedAt: optionalTime(raw.rotatedAt),
    lastIp: typeof raw.lastIp === 'string' ? raw.lastIp.slice(0, AUDIT_FIELD_MAX_CHARS) : null,
  };
}

/** 收敛一条配对码记录；只保留 hash + salt，绝不保留 code。 */
function normalizePairing(raw) {
  if (!isPlainObject(raw)) return null;
  const id = typeof raw.id === 'string' ? raw.id.trim().slice(0, AUDIT_FIELD_MAX_CHARS) : '';
  const hash = typeof raw.hash === 'string' ? raw.hash.trim().toLowerCase() : '';
  const salt = typeof raw.salt === 'string' ? raw.salt.trim().slice(0, 128) : '';
  const expiresAt = optionalTime(raw.expiresAt);
  if (!id || !/^[0-9a-f]{64}$/.test(hash) || !salt || expiresAt == null) return null;
  const createdAt = optionalTime(raw.createdAt);
  const attemptsRaw = Number(raw.attempts);
  return {
    id,
    hash,
    salt,
    createdAt: createdAt == null ? 0 : createdAt,
    expiresAt,
    attempts: Number.isInteger(attemptsRaw) && attemptsRaw >= 0 ? attemptsRaw : 0,
    lastAttemptAt: optionalTime(raw.lastAttemptAt),
  };
}

/** 对外设备视图：不含 hash / 明文 key / 上次 IP。 */
function publicDevice(device) {
  return {
    id: device.id,
    name: device.name,
    prefix: device.prefix,
    createdAt: device.createdAt,
    lastUsedAt: device.lastUsedAt,
    revokedAt: device.revokedAt,
  };
}

/**
 * 读注册表。坏 JSON / 未知版本 / 顶层结构非法 → 备份 + 空注册表；
 * 单条记录非法只丢弃该条（并记 warning）。
 *
 * 返回 { state, backupFile, warnings }。
 */
function loadRegistryState(file, fsImpl, now) {
  const out = { state: emptyRegistryState(), backupFile: null, warnings: [] };
  const read = readTextOrMissing(file, fsImpl);
  if (read.missing) return out;
  if (read.text == null) {
    out.warnings.push({ reason: 'unreadable' });
    return out;
  }

  let parsed;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    out.warnings.push({ reason: 'corrupt-json' });
    out.backupFile = backupBadFile(file, fsImpl, now);
    return out;
  }

  if (!isPlainObject(parsed) || parsed.version !== SECURITY_VERSION
    || (parsed.devices !== undefined && !Array.isArray(parsed.devices))
    || (parsed.pairing !== undefined && !Array.isArray(parsed.pairing))) {
    out.warnings.push({ reason: 'unknown-version-or-bad-shape' });
    out.backupFile = backupBadFile(file, fsImpl, now);
    return out;
  }

  const devices = [];
  for (const raw of parsed.devices || []) {
    const device = normalizeDevice(raw);
    if (device) devices.push(device);
    else out.warnings.push({ reason: 'bad-device-entry' });
  }
  const pairing = [];
  for (const raw of parsed.pairing || []) {
    const entry = normalizePairing(raw);
    if (entry) pairing.push(entry);
    else out.warnings.push({ reason: 'bad-pairing-entry' });
  }

  out.state = { version: SECURITY_VERSION, devices, pairing };
  return out;
}

// ---------------------------------------------------------------- 设备注册表

/** 生成不与现有 id 冲突的短 id；randomBytes(4) 只有 32 bit，重试 32 次足够。 */
function uniqueId(prefix, existingIds, cryptoImpl) {
  const used = new Set(existingIds);
  for (let i = 0; i < 32; i++) {
    const id = `${prefix}_${cryptoImpl.randomBytes(4).toString('hex')}`;
    if (!used.has(id)) return id;
  }
  return `${prefix}_${cryptoImpl.randomBytes(8).toString('hex')}`;
}

/**
 * 设备密钥注册表。
 *
 * 文件格式：
 *   { "version": 1,
 *     "devices": [{ id, name, prefix, hash, createdAt, lastUsedAt, revokedAt,
 *                    expiresAt, rotatedAt, lastIp }],
 *     "pairing": [ ...配对服务写入... ] }
 *
 * 公开方法：
 *   issueDevice({ name, ttlMs? }) → { id, key, name, createdAt }
 *   verifyKey(key, { ip? })       → { ok, device?, reason }
 *   revokeDevice(id)              → { ok, device? , reason? }
 *   rotateKey(id)                 → { id, key, name, createdAt }（失败 { ok:false, reason }）
 *   listDevices()                 → [{ id, name, prefix, createdAt, lastUsedAt, revokedAt }]
 *   readPairing() / writePairing(entries)  配对服务同文件模式使用，一般不要直接调用
 *
 * 参数 file 必填；fs / now / crypto 可注入。
 */
function createDeviceRegistry(options = {}) {
  const file = options.file;
  if (!file || typeof file !== 'string') {
    throw new TypeError('createDeviceRegistry 需要 file（注册表 JSON 的完整路径）');
  }
  const fsImpl = options.fs || fs;
  const now = options.now || Date.now;
  const cryptoImpl = options.crypto || crypto;

  const loaded = loadRegistryState(file, fsImpl, now);
  let state = loaded.state;

  /** 先落盘成功再替换内存状态，避免写失败后内存与文件不一致。 */
  function persist(nextState) {
    atomicWriteJson(file, nextState, fsImpl, now);
    state = nextState;
  }

  function findIndex(id) {
    const target = id == null ? '' : String(id);
    return state.devices.findIndex((d) => d.id === target);
  }

  const registry = {
    file,
    backupFile: loaded.backupFile,
    warnings: loaded.warnings,

    issueDevice(input = {}) {
      const payload = input || {};
      const t = Number(now());
      const ttlMs = Number(payload.ttlMs);
      const expiresAt = Number.isFinite(ttlMs) && ttlMs > 0 ? t + ttlMs : null;
      const name = normalizeDeviceName(payload.name);
      const key = cryptoImpl.randomBytes(KEY_BYTES).toString('hex');
      const id = uniqueId('dev', state.devices.map((d) => d.id), cryptoImpl);
      const device = {
        id,
        name,
        prefix: key.slice(0, KEY_PREFIX_LEN),
        hash: sha256Hex(cryptoImpl, key),
        createdAt: Number.isFinite(t) ? t : Date.now(),
        lastUsedAt: null,
        revokedAt: null,
        expiresAt,
        rotatedAt: null,
        lastIp: textField(payload.ip, AUDIT_FIELD_MAX_CHARS),
      };
      persist({ ...state, devices: [...state.devices, device] });
      // 明文 key 只在这里出现一次，绝不写盘；调用方也不要写日志。
      return { id, key, name, createdAt: device.createdAt };
    },

    verifyKey(key, opts = {}) {
      if (typeof key !== 'string' || key.trim() === '') {
        return { ok: false, reason: 'missing' };
      }
      const normalized = key.trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(normalized)) {
        return { ok: false, reason: 'invalid' };
      }
      const hash = sha256Hex(cryptoImpl, normalized);

      // 不提前 break：比较次数只与设备数量有关，不随命中位置变化。
      let matched = null;
      for (const device of state.devices) {
        if (safeEqualText(hash, device.hash, cryptoImpl) && !matched) matched = device;
      }
      if (!matched) return { ok: false, reason: 'invalid' };

      const t = Number(now());
      if (matched.revokedAt != null) return { ok: false, reason: 'revoked' };
      if (matched.expiresAt != null && matched.expiresAt <= t) {
        return { ok: false, reason: 'expired' };
      }

      const ip = opts && typeof opts.ip === 'string'
        ? opts.ip.slice(0, AUDIT_FIELD_MAX_CHARS)
        : null;
      let resultDevice = matched;

      // 节流写盘：同一设备 60 秒内只刷新一次 lastUsedAt，避免每次请求都写文件。
      if (matched.lastUsedAt == null || t - matched.lastUsedAt >= LAST_USED_THROTTLE_MS) {
        // 没有传 ip 的验证（例如探活）不应把上次记录的来源 IP 擦掉。
        const updated = { ...matched, lastUsedAt: t, lastIp: ip == null ? matched.lastIp : ip };
        try {
          persist({
            ...state,
            devices: state.devices.map((d) => (d.id === updated.id ? updated : d)),
          });
          resultDevice = updated;
        } catch {
          // 认证优先：审计/统计落盘失败不应把已经验证通过的请求打回 401。
        }
      }

      return { ok: true, device: publicDevice(resultDevice), reason: 'ok' };
    },

    revokeDevice(id) {
      const index = findIndex(id);
      if (index < 0) return { ok: false, reason: 'not-found' };
      const current = state.devices[index];
      if (current.revokedAt != null) {
        return { ok: true, device: publicDevice(current), alreadyRevoked: true };
      }
      const updated = { ...current, revokedAt: Number(now()) };
      const devices = state.devices.slice();
      devices[index] = updated;
      persist({ ...state, devices });
      return { ok: true, device: publicDevice(updated) };
    },

    rotateKey(id) {
      const index = findIndex(id);
      if (index < 0) return { ok: false, reason: 'not-found' };
      const current = state.devices[index];
      if (current.revokedAt != null) return { ok: false, reason: 'revoked' };
      const t = Number(now());
      // 已过期的记录再发新 key 也没法通过 verify；让调用方重新 issue 设备。
      if (current.expiresAt != null && current.expiresAt <= t) {
        return { ok: false, reason: 'expired' };
      }

      const key = cryptoImpl.randomBytes(KEY_BYTES).toString('hex');
      const updated = {
        ...current,
        prefix: key.slice(0, KEY_PREFIX_LEN),
        hash: sha256Hex(cryptoImpl, key),
        lastUsedAt: null,
        lastIp: null,
        rotatedAt: t,
        // expiresAt 保持原值：续期由调用方决定，避免 rotate 悄悄延长生命周期。
      };
      const devices = state.devices.slice();
      devices[index] = updated;
      persist({ ...state, devices });
      // 旧 key 的 hash 已被覆盖，下一次 verify 立即失效。
      return { id: updated.id, key, name: updated.name, createdAt: updated.createdAt };
    },

    listDevices() {
      return state.devices.map(publicDevice);
    },

    // 以下两个方法供 createPairingService 的"同文件模式"使用。
    readPairing() {
      return state.pairing.map((entry) => ({ ...entry }));
    },

    writePairing(entries) {
      const pairing = [];
      for (const raw of entries || []) {
        const entry = normalizePairing(raw);
        if (entry) pairing.push(entry);
      }
      persist({ ...state, pairing });
      return pairing.map((entry) => ({ ...entry }));
    },
  };

  return registry;
}

// ---------------------------------------------------------------- 配对码

/** 读取独立的配对文件（file 参数模式）；坏文件备份后返回空列表。 */
function readPairingFile(file, fsImpl, now) {
  const out = { pairing: [], backupFile: null };
  const read = readTextOrMissing(file, fsImpl);
  if (read.missing || read.text == null) return out;

  let parsed;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    out.backupFile = backupBadFile(file, fsImpl, now);
    return out;
  }
  if (!isPlainObject(parsed) || parsed.version !== SECURITY_VERSION
    || !Array.isArray(parsed.pairing)) {
    out.backupFile = backupBadFile(file, fsImpl, now);
    return out;
  }
  for (const raw of parsed.pairing) {
    const entry = normalizePairing(raw);
    if (entry) out.pairing.push(entry);
  }
  return out;
}

function writePairingFile(file, pairing, fsImpl, now) {
  atomicWriteJson(file, { version: SECURITY_VERSION, pairing }, fsImpl, now);
}

/** 6 位数字码归一化；数字类型允许丢掉前导零后再补回来。 */
function normalizePairingCode(code) {
  if (typeof code === 'number' && Number.isInteger(code) && code >= 0 && code < PAIRING_CODE_SPACE) {
    return String(code).padStart(PAIRING_CODE_LEN, '0');
  }
  if (typeof code !== 'string') return null;
  const text = code.trim();
  return new RegExp(`^\\d{${PAIRING_CODE_LEN}}$`).test(text) ? text : null;
}

function pairingMatches(entry, code, cryptoImpl) {
  const hash = sha256Hex(cryptoImpl, `${entry.salt}:${code}`);
  return safeEqualText(entry.hash, hash, cryptoImpl);
}

/** 生成不与现存配对码重复的 code 与 salt+hash。 */
function makePairingCode(existing, cryptoImpl) {
  for (let attempt = 0; attempt < 32; attempt++) {
    const code = String(cryptoImpl.randomInt(0, PAIRING_CODE_SPACE)).padStart(PAIRING_CODE_LEN, '0');
    const duplicate = existing.some((entry) =>
      safeEqualText(entry.hash, sha256Hex(cryptoImpl, `${entry.salt}:${code}`), cryptoImpl));
    if (duplicate) continue;
    const salt = cryptoImpl.randomBytes(PAIRING_SALT_BYTES).toString('hex');
    return { code, salt, hash: sha256Hex(cryptoImpl, `${salt}:${code}`) };
  }
  // 32 次都撞码在 1e6 空间里几乎不可能；宁可抛错也不静默复用一个码。
  throw new Error('无法生成不重复的配对码');
}

/**
 * 配对码服务。
 *
 * 参数：
 *   registry     createDeviceRegistry() 的返回值（必需）
 *   file         独立配对文件路径；省略时与注册表共用同一个文件（推荐）
 *   now / crypto 可注入
 *   ttlMs        默认 5 分钟
 *   maxAttempts  默认 5 次
 *
 * 文件里只存 sha256(salt + ':' + code) 和 salt；code 只在 createPairing()
 * 的返回值与用户屏幕上出现一次。
 *
 * 方法：
 *   createPairing() → { code, expiresAt }
 *   redeem(code, { name, ip? }) → { ok, device?, reason }
 *   pruneExpired() → 删除的条数
 *
 * 为什么默认与注册表同文件：
 *   一次配对最终要"删码 + 发设备 key"，放同一个文件里可以让这两步共享同一个
 *   状态快照、少一个需要备份/校验的文件；独立文件模式留给"想把配对状态放到
 *   其它目录/其它存储"的调用方。坏文件恢复策略与注册表完全一致。
 *
 * 尝试次数的取舍（重要）：
 *   只有 code 一个输入时，服务端无法知道"这个错误码本来想兑换哪一条配对"，
 *   所以一次 6 位错码会给**当前所有活动配对**各 +1（通常同一时间只有一条）。
 *   这是"防止无限猜码"与"可被恶意耗尽"之间的取舍：错误猜测最多 5 次就会把
 *   待配对码作废，需用户重新生成；真正的抗爆破交给上游限流器（按 IP/路由）。
 */
function createPairingService(options = {}) {
  const registry = options.registry;
  if (!registry || typeof registry.issueDevice !== 'function'
    || typeof registry.readPairing !== 'function' || typeof registry.writePairing !== 'function') {
    throw new TypeError('createPairingService 需要 createDeviceRegistry() 返回的 registry');
  }
  const file = options.file == null ? null : String(options.file);
  if (file && registry.file && path.resolve(file) === path.resolve(registry.file)) {
    // 独立文件模式只写 { version, pairing }，若与注册表同路径会把 devices 覆盖掉。
    throw new TypeError('配对 file 不能与注册表文件相同；同文件模式请省略 file');
  }
  const fsImpl = options.fs || fs;
  const now = options.now || Date.now;
  const cryptoImpl = options.crypto || crypto;
  const ttlMs = positiveNumber(options.ttlMs, DEFAULT_PAIRING_TTL_MS);
  const maxAttempts = positiveInt(options.maxAttempts, DEFAULT_MAX_ATTEMPTS);
  let lastBackupFile = registry.backupFile || null;

  const store = file
    ? {
      read() {
        const result = readPairingFile(file, fsImpl, now);
        if (result.backupFile) lastBackupFile = result.backupFile;
        return result.pairing;
      },
      write(entries) {
        writePairingFile(file, entries, fsImpl, now);
      },
    }
    : {
      read() {
        return registry.readPairing();
      },
      write(entries) {
        registry.writePairing(entries);
      },
    };

  function activeAndExpired(entries, t) {
    const active = [];
    const expired = [];
    for (const entry of entries) {
      if (entry.expiresAt <= t) expired.push(entry);
      else active.push(entry);
    }
    return { active, expired };
  }

  const service = {
    file,
    ttlMs,
    maxAttempts,

    get backupFile() {
      return lastBackupFile;
    },

    createPairing() {
      const t = Number(now());
      const entries = store.read();
      // 顺手清掉过期的/已作废的，避免文件里堆旧码。
      const { active } = activeAndExpired(entries, t);
      const usable = active.filter((entry) => (Number(entry.attempts) || 0) < maxAttempts);
      const fresh = makePairingCode(usable, cryptoImpl);
      const entry = {
        id: uniqueId('pair', usable.map((e) => e.id), cryptoImpl),
        hash: fresh.hash,
        salt: fresh.salt,
        createdAt: t,
        expiresAt: t + ttlMs,
        attempts: 0,
        lastAttemptAt: null,
      };
      store.write([...usable, entry]);
      return { code: fresh.code, expiresAt: entry.expiresAt };
    },

    redeem(code, opts = {}) {
      const t = Number(now());
      const text = normalizePairingCode(code);
      if (!text) return { ok: false, reason: 'malformed' };

      const entries = store.read();
      const { active, expired } = activeAndExpired(entries, t);

      let candidate = null;
      for (const entry of active) {
        if (pairingMatches(entry, text, cryptoImpl)) {
          candidate = entry;
          break;
        }
      }
      // 过期码单独识别，返回 expired 而不是笼统的 invalid；同时把过期的清掉。
      let expiredMatch = false;
      if (!candidate) {
        for (const entry of expired) {
          if (pairingMatches(entry, text, cryptoImpl)) {
            expiredMatch = true;
            break;
          }
        }
      }

      if (candidate) {
        const remaining = active.filter((entry) => entry.id !== candidate.id);
        // 先删码再发设备：中途崩溃最多需要重新配对，不存在同一个码被用两次。
        store.write(remaining);
        if (candidate.attempts >= maxAttempts) {
          return { ok: false, reason: 'max-attempts' };
        }
        const device = registry.issueDevice({
          name: opts && opts.name,
          ip: opts && opts.ip,
        });
        return { ok: true, device, reason: 'ok' };
      }

      if (expiredMatch) {
        if (expired.length) store.write(active);
        return { ok: false, reason: 'expired' };
      }

      if (active.length === 0) {
        if (expired.length) store.write([]);
        return { ok: false, reason: 'no-pairing' };
      }

      // 错码：所有活动配对一起 +1；达到上限的立即删除（单次失败可能作废多条，
      // 原因见函数头注释）。
      const remaining = [];
      for (const entry of active) {
        const attempts = (Number(entry.attempts) || 0) + 1;
        if (attempts >= maxAttempts) continue;
        remaining.push({ ...entry, attempts, lastAttemptAt: t });
      }
      store.write(remaining);
      return {
        ok: false,
        reason: remaining.length === 0 ? 'max-attempts' : 'invalid-code',
      };
    },

    pruneExpired() {
      const t = Number(now());
      const entries = store.read();
      const kept = entries.filter((entry) =>
        entry.expiresAt > t && (Number(entry.attempts) || 0) < maxAttempts);
      const removed = entries.length - kept.length;
      if (removed > 0) store.write(kept);
      return removed;
    },
  };

  return service;
}

// ---------------------------------------------------------------- 审计日志

/**
 * 审计日志：JSONL（每行一个对象），超过 maxBytes 自动轮转。
 *
 * 文件：
 *   <file>        当前日志
 *   <file>.1      上一次轮转（较新）
 *   <file>.2      更早一次（keepFiles=2 时保留到 .2）
 *
 * 轮转策略：写新行之前，若"当前大小 + 新行字节数 > maxBytes"且当前文件非空，
 * 先滚动（删掉最旧的 .keepFiles，其余依次后移，当前文件 → .1），再追加。
 * keepFiles=0 表示不保留历史，直接删掉当前文件。
 *
 * 安全边界（调用方责任）：
 *   detail 只应放设备名/模型 id/错误码这类短文本。**绝不能**把提示词、补全
 *   内容、请求头、API Key 或整个请求体写进来。本模块只能做 500 字符截断，
 *   无法判断内容语义。
 *
 * 方法：
 *   append({ event, deviceId?, ip?, detail? }) → 写入的条目
 *   read({ limit = 200 }) → 最近 limit 条，按时间从旧到新（跨轮转文件）
 *
 * read 会跳过坏行/非对象行；单进程写者假设，不做文件锁。
 */
function createAuditLog(options = {}) {
  const file = options.file;
  if (!file || typeof file !== 'string') {
    throw new TypeError('createAuditLog 需要 file（审计日志的完整路径）');
  }
  const fsImpl = options.fs || fs;
  const now = options.now || Date.now;
  const maxBytes = positiveInt(options.maxBytes, 5 * 1024 * 1024);
  const keepFiles = nonNegativeInt(options.keepFiles, 2);

  function currentSize() {
    try {
      return fsImpl.statSync(file).size;
    } catch {
      return 0;
    }
  }

  function unlinkQuietly(target) {
    try {
      fsImpl.unlinkSync(target);
    } catch (e) {
      if (!e || e.code !== 'ENOENT') throw e;
    }
  }

  function renameQuietly(source, target) {
    try {
      fsImpl.renameSync(source, target);
    } catch (e) {
      if (!e || e.code !== 'ENOENT') throw e;
    }
  }

  function rotate() {
    if (keepFiles <= 0) {
      unlinkQuietly(file);
      return;
    }
    // 从最旧开始：删 .keepFiles，然后 .keepFiles-1 → .keepFiles ... file → .1。
    for (let i = keepFiles; i >= 1; i--) {
      const source = i === 1 ? file : `${file}.${i - 1}`;
      const target = `${file}.${i}`;
      unlinkQuietly(target);
      renameQuietly(source, target);
    }
  }

  function normalizeDetail(detail) {
    if (detail == null) return null;
    let text;
    if (typeof detail === 'string') text = detail;
    else if (typeof detail === 'number' || typeof detail === 'boolean') text = String(detail);
    else {
      try {
        text = JSON.stringify(detail);
      } catch {
        text = String(detail);
      }
    }
    return text.slice(0, DETAIL_MAX_CHARS);
  }

  return {
    file,
    maxBytes,
    keepFiles,

    append(input = {}) {
      const payload = input || {};
      const event = typeof payload.event === 'string' ? payload.event.trim() : '';
      if (!event) throw new TypeError('audit.append: event 必须是非空字符串');

      const t = Number(now());
      const entry = {
        ts: new Date(Number.isFinite(t) ? t : Date.now()).toISOString(),
        event: event.slice(0, AUDIT_FIELD_MAX_CHARS),
      };
      if (payload.deviceId != null) {
        entry.deviceId = String(payload.deviceId).slice(0, AUDIT_FIELD_MAX_CHARS);
      }
      if (payload.ip != null) {
        entry.ip = String(payload.ip).slice(0, AUDIT_FIELD_MAX_CHARS);
      }
      const detail = normalizeDetail(payload.detail);
      if (detail != null) entry.detail = detail;

      const line = JSON.stringify(entry) + '\n';
      const bytes = Buffer.byteLength(line, 'utf8');

      fsImpl.mkdirSync(path.dirname(file), { recursive: true });
      const size = currentSize();
      if (size > 0 && size + bytes > maxBytes) rotate();
      fsImpl.appendFileSync(file, line, { encoding: 'utf8', mode: 0o600 });
      return entry;
    },

    read(readOptions = {}) {
      const opts = readOptions || {};
      const rawLimit = Number(opts.limit);
      const limit = Number.isFinite(rawLimit) && rawLimit >= 0 ? Math.floor(rawLimit) : 200;
      if (limit === 0) return [];

      const files = [file];
      for (let i = 1; i <= keepFiles; i++) files.push(`${file}.${i}`);

      // 从最新文件读到最旧文件，每个文件从最后一行往上读；凑够 limit 后反转成
      // "从旧到新"，方便调用方直接按顺序展示。
      const newestFirst = [];
      for (const target of files) {
        let text;
        try {
          text = fsImpl.readFileSync(target, 'utf8');
        } catch {
          continue;
        }
        const lines = text.split(/\r?\n/);
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i].trim();
          if (!line) continue;
          let parsed;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue; // 坏行跳过
          }
          if (!isPlainObject(parsed) || typeof parsed.event !== 'string') continue;
          newestFirst.push(parsed);
          if (newestFirst.length >= limit) {
            newestFirst.reverse();
            return newestFirst;
          }
        }
      }
      newestFirst.reverse();
      return newestFirst;
    },
  };
}

// ---------------------------------------------------------------- 限流器

/**
 * 令牌桶限流器（内存）。
 *
 * 每个 key 一个桶：tokens 初始为 capacity，按 refillPerSec 连续补充（支持小数）。
 * take(key) 消费 1 个令牌；retryAfterMs(key) 不消费，只估算"还差多少毫秒
 * 才够 1 个令牌"。
 *
 * 内存上限（maxKeys）：
 *   - 用 Map 的插入顺序当 LRU：take 与 retryAfterMs 都算一次访问（移到队尾）；
 *   - 新 key 加入后若超过 maxKeys，从队首逐个删除最久未访问的 key；
 *   - key 超过 256 字符会截断（不同超长 key 可能合并到同一个桶，只会更严格）。
 *
 * 注意：用大量伪造 key 的调用方可以把旧桶挤出内存，从而绕过"按 key 计数"的
 * 限制。这是有界内存与精确限流之间的取舍；接线时 key 应取稳定身份
 * （例如 `${ip}|${route}`），且对未知来源另有全局上限。
 *
 * 方法：take(key) / retryAfterMs(key) / forget(key) / size()
 */
function createRateLimiter(options = {}) {
  const capacity = positiveInt(options.capacity, 20);
  const refillPerSec = positiveNumber(options.refillPerSec, 1);
  const maxKeys = positiveInt(options.maxKeys, 1024);
  const now = options.now || Date.now;

  const buckets = new Map(); // key -> { tokens, last }

  function keyOf(rawKey) {
    if (rawKey == null) return null;
    const key = String(rawKey);
    if (!key) return null;
    return key.slice(0, RATE_LIMIT_KEY_MAX_CHARS);
  }

  function timeNow() {
    const t = Number(now());
    return Number.isFinite(t) ? t : 0;
  }

  function refill(bucket, t) {
    if (t <= bucket.last) return;
    bucket.tokens = Math.min(
      capacity,
      bucket.tokens + ((t - bucket.last) / 1000) * refillPerSec,
    );
    bucket.last = t;
  }

  function touch(key, bucket) {
    buckets.delete(key);
    buckets.set(key, bucket); // Map 尾部 = 最近访问
  }

  function evictIfNeeded() {
    while (buckets.size > maxKeys) {
      const oldest = buckets.keys().next().value;
      buckets.delete(oldest);
    }
  }

  return {
    take(rawKey) {
      const key = keyOf(rawKey);
      if (key == null) return false;
      const t = timeNow();
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { tokens: capacity, last: t };
        touch(key, bucket);
        evictIfNeeded();
      } else {
        refill(bucket, t);
        touch(key, bucket);
      }
      if (bucket.tokens + 1e-9 >= 1) {
        bucket.tokens = Math.max(0, bucket.tokens - 1);
        return true;
      }
      return false;
    },

    retryAfterMs(rawKey) {
      const key = keyOf(rawKey);
      if (key == null) return 0;
      const bucket = buckets.get(key);
      if (!bucket) return 0; // 从未出现过 = 新桶是满的
      refill(bucket, timeNow());
      touch(key, bucket);
      if (bucket.tokens + 1e-9 >= 1) return 0;
      return Math.ceil(((1 - bucket.tokens) / refillPerSec) * 1000);
    },

    forget(rawKey) {
      const key = keyOf(rawKey);
      if (key == null) return false;
      return buckets.delete(key);
    },

    size() {
      return buckets.size;
    },
  };
}

module.exports = {
  SECURITY_VERSION,
  KEY_BYTES,
  KEY_PREFIX_LEN,
  LAST_USED_THROTTLE_MS,
  DEFAULT_PAIRING_TTL_MS,
  DEFAULT_MAX_ATTEMPTS,
  DETAIL_MAX_CHARS,
  AUDIT_EVENTS,
  createDeviceRegistry,
  createPairingService,
  createAuditLog,
  createRateLimiter,
};
