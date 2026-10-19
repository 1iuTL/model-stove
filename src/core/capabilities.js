// 构建能力探测：先问 llama-server“你支持哪些参数”，再决定发哪些参数。
//
// 背景：P0 之前 src/config.js 的 buildArgs() 是“无条件拼参数”的 —— 不管
// 手上的 llama-server 是哪个构建、支不支持 -fa / -ctk / --reasoning-* 等，
// 都照发。换一个旧构建或上游构建就会因为 unknown argument 起不来，而且
// 报错是一大段日志，用户看不出该删什么。
//
// 本模块只做三件事：
//   1. probeBuild()：真的执行一次 `exe --version` 与 `exe --help`，解析版本
//      与帮助文本里的参数集合；失败不抛，返回 ok:false。
//   2. loadCapabilities()：带缓存（key = 绝对路径 + mtime + size），损坏或
//      版本不匹配时自动重建。
//   3. supports()：判断某个参数能不能发。
//
// 关键策略（已定，不要改）：**探测失败时 supports() 返回 true**。
// 也就是说，拿不到能力信息时宁可按旧行为把参数发出去、让 llama-server 自己
// 报错，也不要静默少发参数。少发 -fa/-ctk 可能让 8GB 卡悄悄溢出到内存
// （README 里那个“显存读数一样、速度掉 6-8 倍”的坑），比启动时报错难查得多。
// 只有明确知道构建不支持某个参数时，才允许删它。
//
// 依赖全部可注入（execFileSync / fs / now / systemRoot / tmpDir），测试不需要
// 真实 llama-server。子进程输出走**文件**（stdio 接 fd），不用管道 —— 受限
// 环境里管道会让 Electron 主进程原生崩溃，README 有记录。
const nodeFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync: nodeExecFileSync } = require('node:child_process');
const pathsModule = require('./paths');

// 缓存文件结构版本。解析逻辑或字段变化时 +1，旧缓存会被整体丢弃重建。
const CACHE_VERSION = 1;
const CACHE_FILE_NAME = 'capabilities.json';
const PROBE_TIMEOUT_MS = 5000;

// 这些是这个外壳的核心参数：缺任何一个，要么不是 llama-server，要么构建太旧。
// 缺了必须明确报错，不能静默降级 —— 少 -m 根本起不来，少 -ngl 则会把整个
// 模型压在 CPU 上（用户会以为“软件坏了”）。
const REQUIRED_FLAGS = Object.freeze(['-m', '-c', '-ngl', '-np', '--host', '--port']);

// 短参数的长别名。llama.cpp 的 --help 每行通常写成 `-m, --model PATH`，
// 但不同构建的排版可能只列出长名。判断“核心参数是否存在”时两种都认，
// 避免把真实可用的构建误判成“不是 llama-server”。
const REQUIRED_ALIASES = Object.freeze({
  '-m': '--model',
  '-c': '--ctx-size',
  '-ngl': '--n-gpu-layers',
  '-np': '--parallel',
  '--host': null,
  '--port': null,
});

const TMP_PREFIX = 'model-stove-caps-';
let captureSeq = 0;

function flagsOf(caps) {
  if (!caps) return null;
  if (caps.flags instanceof Set) return caps.flags;
  if (Array.isArray(caps.flags)) return new Set(caps.flags);
  return null;
}

/**
 * 从 `--help` 文本里提取参数名。
 *
 * 长参数用 `--[a-z][a-z0-9-]*`；单横线参数不能只认 `-[a-z]` ——
 * llama.cpp 里 -fa / -ctk / -ctv / -ngl / -np 都是多字母单横线选项，
 * 只匹配一个字母会把 -fa 漏掉，进而把“构建支持 -fa”误判成不支持。
 * 起始位置用反向断言挡住 `--model` 里的第二个 `-`，避免把长参数拆成 -m。
 */
function extractFlags(text) {
  const flags = new Set();
  const source = String(text == null ? '' : text);
  if (!source) return flags;

  const longRe = /(?<![A-Za-z0-9_-])--[a-z][a-z0-9-]*/g;
  let m;
  while ((m = longRe.exec(source)) !== null) {
    const name = m[0].replace(/-+$/, '');
    if (name.length > 2) flags.add(name);
  }

  const shortRe = /(?<![A-Za-z0-9_-])-[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?=[\s,=/]|$)/g;
  while ((m = shortRe.exec(source)) !== null) {
    flags.add(m[0].replace(/-+$/, ''));
  }
  return flags;
}

/**
 * 从版本输出里解析 semver 与 build 号。
 *
 * 兼容两种常见格式（不同 fork/年份的 llama.cpp 写法不一样）：
 *   version: 0.0.0 (build: b1234)
 *   llama-server version 1234 (abc)
 *
 * 注意 build 不一定是数字（有的构建写 commit hash），这时 build 返回 null，
 * 不影响 flags 探测与参数门控。
 */
function parseVersionText(text) {
  const source = String(text == null ? '' : text);
  // 允许可选的 v 前缀（node --version 这类输出），返回时去掉。
  const semver = source.match(/\bv?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\b/i);

  let build = null;
  let m = source.match(/\bbuild\s*[:=]?\s*b?(\d+)\b/i);
  if (!m) m = source.match(/\bb(\d+)\b/i);
  if (!m) m = source.match(/\bversion\s+(\d+)\b(?!\.\d)/i);
  if (m) {
    const n = Number(m[1]);
    if (Number.isSafeInteger(n)) build = n;
  }
  return {
    version: semver ? semver[0].replace(/^v/i, '') : null,
    build,
  };
}

/**
 * 版本信息在 --version 拿不到时才去 --help 里找，而且只认含 version 的那一行。
 *
 * 不能直接对整段 help 跑 parseVersionText：help 里常出现
 * `http://127.0.0.1:8080` 这类地址，会被 semver 正则误认成 127.0.0。
 */
function parseVersionFromHelp(text) {
  const line = String(text == null ? '' : text)
    .split(/\r?\n/)
    .find((l) => /\bversion\b/i.test(l));
  return line ? parseVersionText(line) : { version: null, build: null };
}

/** 把子进程错误收敛成一行可读文本（不要把整段 help 塞进错误里）。 */
function describeExecError(err) {
  if (!err) return '';
  if (err.code === 'ETIMEDOUT' || err.killed) return '执行超时（5s）';
  const code = err.code ? `${err.code}: ` : '';
  return `${code}${err.message || String(err)}`.trim();
}

/**
 * 执行一个探测命令，把 stdout/stderr 写进临时文件再读回来。
 *
 * 不用管道：受限环境下管道 stdio 会让 Electron 主进程原生崩溃（README 第 3 条）。
 * 返回 { text, error }，任何失败都不抛。
 */
function captureCommand(exe, args, options) {
  const fs = options.fs;
  const outFile = path.join(
    options.tmpDir,
    `${TMP_PREFIX}${process.pid}-${Date.now()}-${captureSeq++}.log`,
  );
  let fd = null;
  let text = '';
  let error = null;
  try {
    fs.mkdirSync(options.tmpDir, { recursive: true });
    fd = fs.openSync(outFile, 'w');
    try {
      const returned = options.execFileSync(exe, args, {
        stdio: ['ignore', fd, fd],
        timeout: options.timeoutMs,
        windowsHide: true,
        env: options.env,
      });
      // 正常注入的实现会通过上面的 fd 写文件；返回值只作为额外兼容路径。
      if (typeof returned === 'string') text = returned;
      else if (Buffer.isBuffer(returned)) text = returned.toString('utf8');
    } catch (err) {
      error = err;
    }
  } catch (err) {
    error = err;
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch { /* 已经关了 */ } }
    if (!text) {
      try { text = fs.readFileSync(outFile, 'utf8'); } catch { /* 没有输出 */ }
    }
    try { fs.unlinkSync(outFile); } catch { /* 临时文件删不掉不影响结果 */ }
  }
  return { text, error };
}

/**
 * 探测一个 llama-server 构建。
 *
 * 返回 { exe, ok, version, build, flags:Set, probedAt, error }。永不抛异常：
 * 可执行文件不存在、没有权限、超时、--help 输出为空，都会变成 ok:false。
 * ok 的判据是“从 --help 里解析到了至少一个参数”——没有参数集合就没法门控。
 */
function probeBuild(exePath, options = {}) {
  const fs = options.fs || nodeFs;
  const now = options.now || Date.now;
  const execFileSync = options.execFileSync || nodeExecFileSync;
  const timeoutMs = options.timeoutMs == null ? PROBE_TIMEOUT_MS : options.timeoutMs;
  const systemRoot = options.systemRoot || process.env.SystemRoot || process.env.windir || '';
  const env = { ...process.env, ...(options.env || {}) };
  if (systemRoot) env.SystemRoot = systemRoot;
  const tmpDir = options.tmpDir || path.join(os.tmpdir(), 'model-stove-caps');
  const exe = exePath ? path.resolve(String(exePath)) : String(exePath == null ? '' : exePath);
  const probedAt = new Date(now()).toISOString();

  const failed = (error) => ({
    exe,
    ok: false,
    version: null,
    build: null,
    flags: new Set(),
    probedAt,
    error,
  });

  if (!exe) return failed('没有提供可执行文件路径');

  try {
    const versionRun = captureCommand(exe, ['--version'], {
      fs, execFileSync, tmpDir, timeoutMs, env,
    });
    const helpRun = captureCommand(exe, ['--help'], {
      fs, execFileSync, tmpDir, timeoutMs, env,
    });

    // --version 是首选来源；它什么都没给时才从 --help 的 version 行兜底。
    // （不能对整段 help 解析：里面的 127.0.0.1 会被当成 semver。）
    let parsed = parseVersionText(versionRun.text);
    if (!parsed.version && parsed.build == null) {
      parsed = parseVersionFromHelp(helpRun.text);
    }
    const flags = extractFlags(helpRun.text);
    const ok = flags.size > 0;

    const errors = [];
    if (versionRun.error) errors.push(`--version: ${describeExecError(versionRun.error)}`);
    if (helpRun.error) errors.push(`--help: ${describeExecError(helpRun.error)}`);

    let error = null;
    if (!ok) {
      error = errors.length ? errors.join('; ') : '--help 输出里没有解析到任何参数';
    }

    return {
      exe,
      ok,
      version: parsed.version,
      build: parsed.build,
      flags,
      probedAt,
      error,
    };
  } catch (err) {
    // 解析/文件系统层的意外错误也不能让启动流程挂掉。
    return failed(describeExecError(err) || String(err));
  }
}

/**
 * 某个参数是否被构建支持。
 *
 * 兼容模式（**已定策略**）：caps 为空、探测失败（ok !== true）或结构未知时
 * 一律返回 true。宁可把参数发出去让 llama-server 报 “unknown argument”，
 * 也不在信息不足时静默少发参数 —— 少发 -fa/-ctk 会让显存溢出变成静默故障。
 */
function supports(caps, flag) {
  if (!caps || caps.ok !== true) return true;
  const flags = flagsOf(caps);
  if (!flags) return true;
  return flags.has(String(flag));
}

/**
 * 核心参数是否被支持。与 supports() 的区别：短参数的长别名也算存在。
 * caps 未知时返回 true（不阻断）。
 */
function supportsRequired(caps, flag) {
  if (!caps || caps.ok !== true) return true;
  const flags = flagsOf(caps);
  if (!flags) return true;
  const alias = REQUIRED_ALIASES[flag];
  return flags.has(flag) || !!(alias && flags.has(alias));
}

/** 返回缺失的核心参数列表；caps 未知时返回空数组（不阻断）。 */
function missingRequired(caps) {
  if (!caps || caps.ok !== true) return [];
  const flags = flagsOf(caps);
  if (!flags) return [];
  const missing = [];
  for (const flag of REQUIRED_FLAGS) {
    if (!supportsRequired(caps, flag)) missing.push(flag);
  }
  return missing;
}

// ------------------------------------------------------------------ 缓存

function emptyCache() {
  return { version: CACHE_VERSION, entries: {} };
}

function readCache(fs, file) {
  if (!file) return emptyCache();
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return emptyCache(); // 不存在 / 坏 JSON 都按“没有缓存”处理
  }
  if (!parsed || parsed.version !== CACHE_VERSION
    || !parsed.entries || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) {
    return emptyCache();
  }
  return parsed;
}

function statIdentity(fs, exe) {
  try {
    const st = fs.statSync(exe);
    return { mtimeMs: Number(st.mtimeMs), size: Number(st.size) };
  } catch {
    return null;
  }
}

function serializeCaps(caps) {
  return {
    exe: caps.exe,
    ok: !!caps.ok,
    version: caps.version == null ? null : caps.version,
    build: caps.build == null ? null : caps.build,
    flags: caps.flags instanceof Set ? [...caps.flags] : (Array.isArray(caps.flags) ? caps.flags.slice() : []),
    probedAt: caps.probedAt || null,
    error: caps.error == null ? null : caps.error,
  };
}

function hydrateCaps(raw, exe) {
  if (!raw || typeof raw !== 'object' || typeof raw.ok !== 'boolean' || !Array.isArray(raw.flags)) {
    return null;
  }
  return {
    exe: raw.exe || exe,
    ok: raw.ok,
    version: raw.version == null ? null : raw.version,
    build: raw.build == null ? null : raw.build,
    flags: new Set(raw.flags.filter((f) => typeof f === 'string')),
    probedAt: raw.probedAt || null,
    error: raw.error == null ? null : raw.error,
  };
}

/** 原子写：同目录写临时文件再 rename；失败不影响探测结果。 */
function writeCache(fs, file, cache) {
  if (!file) return false;
  let tmp = null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    fs.writeFileSync(tmp, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
    try {
      fs.renameSync(tmp, file);
    } catch {
      // Windows 上目标被占用时 rename 可能失败；退化成“先删再改名”。
      try { fs.unlinkSync(file); } catch { /* 不存在 */ }
      fs.renameSync(tmp, file);
    }
    return true;
  } catch {
    if (tmp) { try { fs.unlinkSync(tmp); } catch { /* 已经没了 */ } }
    return false;
  }
}

/** 默认缓存路径：数据目录下的 cache/capabilities.json。 */
function defaultCacheFile(env) {
  try {
    const p = pathsModule.createPaths({ env: env || process.env });
    return p.cacheDir ? path.join(p.cacheDir, CACHE_FILE_NAME) : null;
  } catch {
    return null;
  }
}

/**
 * 读缓存或探测构建。
 *
 * - key = 可执行文件绝对路径 + mtimeMs + size；文件被替换后自动失效。
 * - 探测结果（含失败）都会落盘：失败时下次启动直接走兼容模式，不用再等
 *   两次 5 秒超时；build 更新后 mtime/size 变化会重新探测。
 * - MODEL_STOVE_CAPS_CACHE=0 或 options.cache=false 时完全绕过缓存。
 */
function loadCapabilities(exePath, options = {}) {
  const fs = options.fs || nodeFs;
  const env = options.env || process.env;
  const exe = exePath ? path.resolve(String(exePath)) : String(exePath == null ? '' : exePath);
  const cacheDisabled = options.cache === false || String(env.MODEL_STOVE_CAPS_CACHE || '') === '0';
  const cacheFile = options.cacheFile != null ? options.cacheFile : defaultCacheFile(env);

  if (cacheDisabled) return probeBuild(exe, options);

  const identity = exe ? statIdentity(fs, exe) : null;
  const cache = readCache(fs, cacheFile);
  if (identity) {
    const entry = cache.entries[exe];
    if (entry && entry.mtimeMs === identity.mtimeMs && entry.size === identity.size) {
      const cached = hydrateCaps(entry.caps, exe);
      if (cached) return cached;
    }
  }

  const caps = probeBuild(exe, options);
  if (identity) {
    cache.entries[exe] = {
      mtimeMs: identity.mtimeMs,
      size: identity.size,
      caps: serializeCaps(caps),
    };
    writeCache(fs, cacheFile, cache);
  }
  return caps;
}

module.exports = {
  CACHE_VERSION,
  CACHE_FILE_NAME,
  PROBE_TIMEOUT_MS,
  REQUIRED_FLAGS,
  REQUIRED_ALIASES,
  probeBuild,
  loadCapabilities,
  supports,
  supportsRequired,
  missingRequired,
  extractFlags,
  parseVersionText,
  defaultCacheFile,
};
