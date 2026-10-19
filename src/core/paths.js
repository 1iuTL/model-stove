// 路径层：安装目录 / 数据目录 / 日志 / 模型根 / 构建根 / 配置文件来源的唯一来源。
//
// 重构前这些路径散在 src/config.js（三个绝对路径常量）和 src/main.js
// （LOG_DIR = <repo>/logs）里，换一台机器就全错。本模块把"东西放哪"
// 收成一处，并给出可测试的优先级规则：
//
//   数据目录（dataDir）
//     1. 环境变量 MODEL_STOVE_HOME（测试/运维显式指定，最高）
//     2. 便携模式：<安装目录>/data 存在 → 用它（对应便携 ZIP）
//     3. 调用方传入的 userDataDir（Electron app.getPath('userData')）
//     4. 平台默认的应用数据目录（Windows: %APPDATA%\Model Stove）
//
//   配置优先级（低 → 高，后写的覆盖先写的）
//     1. 内置默认值（本文件的 DEFAULT_CONFIG）
//     2. 安装目录 site.json（运维预置，只读）
//     3. 数据目录 config.json（便携或用户数据；用户可写）
//     4. 环境变量（MODEL_STOVE_MODELS / MODEL_STOVE_BUILDS / MODEL_STOVE_HOST / MODEL_STOVE_PORT）
//     5. CLI 指定的配置文件（--config，最高）
//
//   模型根（modelRoots）
//     环境变量 MODEL_STOVE_MODELS（多个用系统路径分隔符分开）
//     → 配置里的 models.roots
//     → 自动建议：非系统盘里空闲空间最大的那块盘的 Models 子目录
//        （没有任何候选盘时回落 %USERPROFILE%\Models）
//
// 设计约束：
//   - 不依赖 electron / 不读写用户目录以外的位置，纯 Node 就能测；
//   - 所有会碰文件系统的依赖都可以注入（statfs / isDirectory / readFile / env），
//     测试用临时目录，不碰真实 APPDATA。
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_NAME = 'Model Stove';

const ENV_HOME = 'MODEL_STOVE_HOME';
const ENV_MODELS = 'MODEL_STOVE_MODELS';
const ENV_BUILDS = 'MODEL_STOVE_BUILDS';
const ENV_HOST = 'MODEL_STOVE_HOST';
const ENV_PORT = 'MODEL_STOVE_PORT';

const DATA_FILE = 'config.json';
const SITE_FILE = 'site.json';

// 内置默认值。P0 就把"默认只监听回环、端口自动"写进配置模型，
// 之后各层只能收紧不能放松。
const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  models: { roots: [] },
  builds: { roots: [] },
  server: { host: '127.0.0.1', port: 0 },
});

/** 按系统路径分隔符拆开环境变量里的多个目录。 */
function splitList(value) {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter(Boolean);
  }
  const text = String(value == null ? '' : value).trim();
  if (!text) return [];
  return text.split(path.delimiter).map((s) => s.trim()).filter(Boolean);
}

/** 去重并转成绝对路径，保持首次出现的顺序。 */
function resolveRoots(list) {
  const seen = new Set();
  const out = [];
  for (const raw of list || []) {
    const text = String(raw == null ? '' : raw).trim();
    if (!text) continue;
    let abs;
    try {
      abs = path.resolve(text);
    } catch {
      continue;
    }
    const key = process.platform === 'win32' ? abs.toLowerCase() : abs;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(abs);
  }
  return out;
}

/** 平台默认的应用数据目录（还没有加 APP_NAME 的那一层）。 */
function platformAppDataDir({ platform, env, homeDir }) {
  if (platform === 'win32') {
    return env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
  }
  if (platform === 'darwin') {
    return path.join(homeDir, 'Library', 'Application Support');
  }
  return env.XDG_CONFIG_HOME || path.join(homeDir, '.config');
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function clonePlain(v) {
  if (Array.isArray(v)) return v.map(clonePlain);
  if (isPlainObject(v)) {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = clonePlain(val);
    return out;
  }
  return v;
}

/**
 * 深度合并，并记录每个叶子键最终来自哪一层。
 *
 * 数组整体替换（不拼接）：模型根顺序是有意义的，合并数组会让"删掉一个根"
 * 变成不可能的操作。
 */
function mergeInto(target, patch, sourceLabel, provenance, prefix = '') {
  for (const [key, value] of Object.entries(patch)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(value) && isPlainObject(target[key])) {
      mergeInto(target[key], value, sourceLabel, provenance, full);
    } else if (isPlainObject(value)) {
      target[key] = clonePlain(value);
      markLeaves(target[key], sourceLabel, provenance, full);
    } else {
      target[key] = Array.isArray(value) ? value.slice() : value;
      provenance[full] = sourceLabel;
    }
  }
  return target;
}

function markLeaves(obj, sourceLabel, provenance, prefix) {
  for (const [key, value] of Object.entries(obj)) {
    const full = `${prefix}.${key}`;
    if (isPlainObject(value)) markLeaves(value, sourceLabel, provenance, full);
    else provenance[full] = sourceLabel;
  }
}

/** 读一个 JSON 配置文件；不存在/坏文件都按"这一层没有"处理，并在 sources 里标记。 */
function readJsonConfig(file, sourceLabel, readFile, sources) {
  if (!file) return null;
  let text;
  try {
    text = readFile(file);
  } catch {
    return null; // 不存在是常态，不算错误
  }
  try {
    const parsed = JSON.parse(text);
    if (!isPlainObject(parsed)) throw new Error('顶层必须是对象');
    sources.push({ label: sourceLabel, file, loaded: true });
    return parsed;
  } catch (e) {
    // 坏配置不能静默吞掉，但也不该让应用起不来：记下来，界面/日志能提示用户。
    sources.push({ label: sourceLabel, file, loaded: false, error: e.message });
    return null;
  }
}

/**
 * 计算配置的每一层来源（低 → 高）。
 *
 * 返回 [{ label, file|null, values }]，其中 values 可能是 null（该层不存在）。
 */
function configLayers({ installDir, dataDir, env, cliConfigPath, readFile }) {
  return [
    { label: 'defaults', file: null, values: clonePlain(DEFAULT_CONFIG) },
    { label: 'site', file: path.join(installDir, SITE_FILE), values: null },
    { label: 'data', file: path.join(dataDir, DATA_FILE), values: null },
    { label: 'env', file: null, values: envConfig(env) },
    { label: 'cli', file: cliConfigPath || null, values: null },
  ];
}

/** 环境变量层的配置对象。没设任何变量时返回 null（不参与合并）。 */
function envConfig(env) {
  const out = {};
  const models = splitList(env[ENV_MODELS]);
  if (models.length) out.models = { roots: models };
  const builds = splitList(env[ENV_BUILDS]);
  if (builds.length) out.builds = { roots: builds };
  const host = String(env[ENV_HOST] || '').trim();
  if (host) out.server = { ...(out.server || {}), host };
  const port = String(env[ENV_PORT] || '').trim();
  if (port) out.server = { ...(out.server || {}), port: Number(port) };
  return Object.keys(out).length ? out : null;
}

/**
 * 读配置并按优先级合并。返回 { values, sources, provenance }。
 *
 * sources 只记录真正尝试过的文件层（defaults/env 不产生文件记录），
 * 供日志与设置面板显示"这一项是哪来的"。
 */
function loadConfig({ installDir, dataDir, env = {}, cliConfigPath = null, readFile } = {}) {
  if (typeof readFile !== 'function') {
    readFile = (file) => fs.readFileSync(file, 'utf8');
  }
  const layers = configLayers({ installDir, dataDir, env, cliConfigPath, readFile });
  const values = {};
  const provenance = {};
  const sources = [];

  for (const layer of layers) {
    let payload = layer.values;
    if (!payload) {
      if (!layer.file) continue; // 该层不存在（例如没有设置任何环境变量）
      payload = readJsonConfig(layer.file, layer.label, readFile, sources);
      if (!payload) continue;
    } else {
      sources.push({ label: layer.label, file: null, loaded: true });
    }
    mergeInto(values, payload, layer.label, provenance);
  }
  return { values, sources, provenance };
}

/**
 * 自动建议模型根：Windows 上选"非系统盘里空闲空间最大的盘"下的 Models 目录。
 *
 * 为什么不用 `Get-PSDrive`：那要走子进程，还要解析本地化输出；Node 自带的
 * fs.statfs 直接拿文件系统统计，纯函数、可注入，测试里不需要真的存在 D 盘。
 */
function suggestModelRoot(options = {}) {
  const {
    platform = process.platform,
    env = process.env,
    homeDir = os.homedir(),
    systemDrive = env.SystemDrive,
    statfs = fs.statfsSync,
    driveLetters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split(''),
  } = options;

  const fallback = path.join(homeDir, 'Models');
  if (platform !== 'win32') {
    return { root: fallback, source: 'fallback', candidates: [] };
  }

  const sys = String(systemDrive || 'C:').slice(0, 2).toUpperCase();
  const candidates = [];
  for (const letter of driveLetters) {
    const drive = `${String(letter).toUpperCase()}:\\`;
    if (drive.slice(0, 2) === sys) continue;
    let st;
    try {
      st = statfs(drive);
    } catch {
      continue; // 盘符不存在 / 未挂载，跳过
    }
    const freeBytes = Number(st && st.bavail) * Number(st && st.bsize);
    if (!Number.isFinite(freeBytes) || freeBytes <= 0) continue;
    candidates.push({ root: path.join(drive, 'Models'), drive, freeBytes });
  }
  candidates.sort((a, b) => b.freeBytes - a.freeBytes);
  if (!candidates.length) {
    return { root: fallback, source: 'fallback', candidates: [] };
  }
  return { root: candidates[0].root, source: 'largest-free-drive', candidates };
}

/** 默认的目录存在性判断（不抛异常）。 */
function defaultIsDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 建出应用要用的全部路径。
 *
 * 注意：本函数会读配置（不写任何文件）。调用方拿到结果后再决定是否
 * ensureDirs() —— 测试与只读场景不该被动建目录。
 */
function createPaths(options = {}) {
  const {
    platform = process.platform,
    env = process.env,
    homeDir = os.homedir(),
    installDir = path.resolve(__dirname, '..', '..'),
    userDataDir = null,
    cliConfigPath = null,
    statfs = fs.statfsSync,
    isDirectory = defaultIsDirectory,
    readFile = (file) => fs.readFileSync(file, 'utf8'),
  } = options;

  const appDir = path.resolve(installDir);
  const portable = isDirectory(path.join(appDir, 'data'));

  let dataDir;
  let dataSource;
  if (String(env[ENV_HOME] || '').trim()) {
    dataDir = path.resolve(String(env[ENV_HOME]).trim());
    dataSource = 'env';
  } else if (portable) {
    dataDir = path.join(appDir, 'data');
    dataSource = 'portable';
  } else if (userDataDir) {
    dataDir = path.resolve(userDataDir);
    dataSource = 'userData';
  } else {
    dataDir = path.join(platformAppDataDir({ platform, env, homeDir }), APP_NAME);
    dataSource = 'appData';
  }

  const config = loadConfig({
    installDir: appDir,
    dataDir,
    env,
    cliConfigPath,
    readFile,
  });

  const suggestion = suggestModelRoot({ platform, env, homeDir, statfs });
  const envModelRoots = resolveRoots(splitList(env[ENV_MODELS]));
  const configModelRoots = resolveRoots((config.values.models && config.values.models.roots) || []);
  const modelRoots = envModelRoots.length
    ? envModelRoots
    : (configModelRoots.length ? configModelRoots : [suggestion.root]);

  const envBuildRoots = resolveRoots(splitList(env[ENV_BUILDS]));
  const configBuildRoots = resolveRoots((config.values.builds && config.values.builds.roots) || []);
  const buildRoots = envBuildRoots.length ? envBuildRoots : configBuildRoots;

  const paths = {
    installDir: appDir,
    dataDir,
    dataSource,
    portable,
    logsDir: path.join(dataDir, 'logs'),
    cacheDir: path.join(dataDir, 'cache'),
    settingsFile: path.join(dataDir, 'settings.json'),
    configFile: path.join(dataDir, DATA_FILE),
    siteConfigFile: path.join(appDir, SITE_FILE),
    modelRoots,
    buildRoots,
    suggestedModelRoot: suggestion,
    config,
  };
  return Object.freeze(paths);
}

/** 建数据目录与日志目录（幂等）。只建必要的，不在只读场景里乱写。 */
function ensureDirs(paths) {
  const created = [];
  for (const dir of [paths.dataDir, paths.logsDir]) {
    if (!dir) continue;
    fs.mkdirSync(dir, { recursive: true });
    created.push(dir);
  }
  return created;
}

module.exports = {
  APP_NAME,
  DATA_FILE,
  SITE_FILE,
  ENV_HOME,
  ENV_MODELS,
  ENV_BUILDS,
  ENV_HOST,
  ENV_PORT,
  DEFAULT_CONFIG,
  createPaths,
  loadConfig,
  suggestModelRoot,
  ensureDirs,
  splitList,
  resolveRoots,
  platformAppDataDir,
};
