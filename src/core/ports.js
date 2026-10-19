// 端口与进程标识。
//
// 为什么单独一层：重构前这些逻辑埋在 src/main.js 里，且有四个问题：
//   1. `PORT = 8091` 写死，端口被占时只能失败，不能换一个；
//   2. 解析 `netstat` 依赖英文状态词 `LISTENING`（中文/其它语言系统上会失效）；
//   3. 停止时只能杀"本外壳 spawn 过的"进程，外部起的服务变成幽灵；
//   4. PID 台账只有数字，PID 被系统复用后可能误杀别人的进程。
//
// 这里的做法：
//   - 监听端口从 8091 起动态挑第一个空闲的（只绑回环）；
//   - netstat 解析**不看状态词**：listen 行的判据是"外部地址端口为 0 且 PID > 0"，
//     这两点在所有语言的 Windows 上都是数字；
//   - 台账项除了 PID 还记启动时间，清理前用 PowerShell 的 StartTime 核对，
//     对不上说明 PID 已被复用，不杀。
//
// 所有外部依赖（execFileSync / 文件系统 / 探测函数）都可注入，便于单测。
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const DEFAULT_BASE_PORT = 8091;
const DEFAULT_SCAN_RANGE = 64;
const LOOPBACK = '127.0.0.1';

/** PID 是否还活着（不发信号，只探测）。 */
function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

function splitEndpoint(endpoint) {
  const text = String(endpoint || '').trim();
  const i = text.lastIndexOf(':');
  if (i <= 0) return null;
  const host = text.slice(0, i).replace(/^\[|\]$/g, '');
  const port = Number(text.slice(i + 1));
  if (!Number.isInteger(port) || port < 0) return null;
  return { host, port };
}

/**
 * 解析 `netstat -ano -p TCP` 的输出。
 *
 * 行结构（所有语言一致）：Proto LocalAddress ForeignAddress State PID。
 * 只认 Proto === TCP 且 PID 为数字的行；State 那一列可能是本地化单词，
 * 所以**不用它做判断**。
 *
 * 返回 [{ localHost, localPort, foreignHost, foreignPort, state, pid }]。
 */
function parseNetstat(text) {
  const rows = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5) continue;
    if (cols[0].toUpperCase() !== 'TCP') continue;
    const local = splitEndpoint(cols[1]);
    const foreign = splitEndpoint(cols[2]);
    if (!local || !foreign) continue;
    const pid = Number(cols[cols.length - 1]);
    if (!Number.isInteger(pid) || pid < 0) continue;
    rows.push({
      localHost: local.host,
      localPort: local.port,
      foreignHost: foreign.host,
      foreignPort: foreign.port,
      state: cols.slice(3, -1).join(' '),
      pid,
    });
  }
  return rows;
}

/**
 * 从解析结果里挑出监听指定端口的 PID。
 *
 * 判据 = 本地端口匹配 + 外部端口为 0 + PID > 0。
 * 为什么不用 state 列：`LISTENING` 是英文；中文系统上状态词可能被本地化。
 * 而"外部地址端口 0"是监听套接字在所有语言下的共同特征；TIME_WAIT 行的
 * 外部端口非 0、PID 也是 0，所以不会被误选。
 */
function listeningPid(rows, port) {
  const target = Number(port);
  for (const row of rows) {
    if (row.localPort !== target) continue;
    if (row.foreignPort !== 0) continue;
    if (!row.pid) continue;
    return row.pid;
  }
  return null;
}

/** 默认执行 netstat：输出写文件再读回，避免管道（受限环境里管道会被拒）。 */
function defaultRunNetstat(options = {}) {
  const {
    execFileSync = require('child_process').execFileSync,
    dir = os.tmpdir(),
    timeoutMs = 15000,
  } = options;
  const tmp = path.join(dir, `_netstat-${process.pid}-${Date.now()}.txt`);
  let fd;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fd = fs.openSync(tmp, 'w');
  } catch {
    return '';
  }
  try {
    execFileSync('netstat', ['-ano', '-p', 'TCP'], {
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      timeout: timeoutMs,
    });
  } catch { /* 命令失败时按"查不到"处理 */ }
  try { fs.closeSync(fd); } catch {}
  let text = '';
  try { text = fs.readFileSync(tmp, 'utf8'); } catch {}
  try { fs.unlinkSync(tmp); } catch {}
  return text;
}

/**
 * 监听某端口的 PID；查不到返回 null。
 *
 * 选项：
 *   text        直接给 netstat 文本（测试用，优先）
 *   runNetstat  自定义执行器，返回文本
 */
function pidOnPort(port, options = {}) {
  const { text, runNetstat = defaultRunNetstat } = options;
  const raw = text != null ? text : runNetstat({ dir: options.dir });
  return listeningPid(parseNetstat(raw), port);
}

/** 端口的原始监听行（debug 用，返回全部匹配行）。 */
function listenersOnPort(port, options = {}) {
  const { text, runNetstat = defaultRunNetstat } = options;
  const raw = text != null ? text : runNetstat({ dir: options.dir });
  return parseNetstat(raw).filter((r) => r.localPort === Number(port) && r.foreignPort === 0 && r.pid > 0);
}

/** 试着在 host:port 上真正 bind 一次，判断端口是否空闲。 */
function isPortFree(port, host = LOOPBACK) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      try { srv.close(); } catch {}
      resolve(v);
    };
    srv.once('error', () => done(false));
    try {
      srv.listen({ port, host, exclusive: true }, () => done(true));
    } catch {
      done(false);
    }
  });
}

/**
 * 从 start 起找第一个空闲端口（只测回环）。
 *
 * 到范围末尾仍没有就抛错 —— 不静默回绕到 0（那会让监听地址不可预测）。
 */
async function findFreePort(options = {}) {
  const {
    start = DEFAULT_BASE_PORT,
    count = DEFAULT_SCAN_RANGE,
    host = LOOPBACK,
    probe = (port) => isPortFree(port, host),
  } = options;
  const first = Number(start);
  const total = Number(count);
  if (!Number.isInteger(first) || first < 1 || first > 65535) {
    throw new Error(`起始端口非法: ${start}`);
  }
  for (let i = 0; i < total; i++) {
    const port = first + i;
    if (port > 65535) break;
    if (await probe(port)) return port;
  }
  throw new Error(`在 ${first}..${Math.min(65535, first + total - 1)} 范围内找不到空闲端口（只测 ${host}）`);
}

/**
 * 取进程的启动时间（毫秒 epoch）；查不到返回 null。
 *
 * 用途：PID 台账核对。只看 PID 会被系统复用骗到 —— 一个被复用的 PID
 * 可能是用户的编辑器，杀它就是事故。启动时间对不上就不认。
 *
 * 走 PowerShell 的 Get-Process.StartTime：非提权可读、语言无关（输出是 ISO 时间，
 * 不受本地化影响）。起子进程约 0.3-0.5 秒，只在启动清理/停止时调用，不在热路径。
 */
function processStartTime(pid, options = {}) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return null;
  const {
    execFileSync = require('child_process').execFileSync,
    timeoutMs = 4000,
    systemRoot = process.env.SystemRoot || 'C:\\Windows',
  } = options;
  const ps = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = [
    `$p = Get-Process -Id ${n} -ErrorAction SilentlyContinue`,
    'if ($p) { $p.StartTime.ToUniversalTime().ToString("o") }',
  ].join('; ');
  let out;
  try {
    out = execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
    });
  } catch {
    return null;
  }
  return parseDotNetDate(String(out || '').trim());
}

/** 解析 .NET 的 "o" 格式（可能带 7 位小数）；失败返回 null。 */
function parseDotNetDate(text) {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3})\d*Z$/.exec(text);
  const iso = m ? `${m[1]}Z` : text;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

// ------------------------------------------------------------------ 台账
//
// 台账记录"本外壳启动过哪些进程"，用来在外壳崩溃后收拾残局，而不是
// 靠进程名匹配（那会误伤用户自己起的服务）。

const START_TIME_TOLERANCE_MS = 30_000;

/**
 * 台账项：{ pid, startedAt, exe, argvHash, port, generation, modelId, preset, lanMode }
 *
 * modelId/preset/lanMode 是 P3 热接管新增的：外壳重启后 /health 只能证明
 * “端口上有个活着的服务”，模型是谁、用什么预设、是不是 LAN 模式只能靠台账
 * 记住 —— 否则接管回来界面只能显示一个空壳。
 */
function makeLedgerEntry(fields) {
  return {
    pid: Number(fields.pid),
    startedAt: Number(fields.startedAt) || null,
    exe: fields.exe || null,
    argvHash: fields.argvHash || null,
    port: Number(fields.port) || null,
    generation: Number(fields.generation) || null,
    modelId: fields.modelId == null ? null : String(fields.modelId),
    preset: fields.preset == null ? null : String(fields.preset),
    lanMode: !!fields.lanMode,
  };
}

function isValidEntry(entry) {
  return !!entry && Number.isInteger(entry.pid) && entry.pid > 0;
}

/** 写台账：先写临时文件再 rename，避免外壳中途退出留下半截 JSON。 */
function writeLedger(file, entries) {
  const list = (entries || []).filter(isValidEntry).map(makeLedgerEntry);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return list;
}

/** 读台账；坏文件/旧格式（纯数字数组）都兼容。 */
function readLedger(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out = [];
  for (const item of parsed) {
    if (Number.isInteger(item) && item > 0) {
      // 旧格式（重构前的纯 PID 数组）：没有启动时间，只能按 PID 认。
      out.push(makeLedgerEntry({ pid: item }));
    } else if (isValidEntry(item)) {
      out.push(makeLedgerEntry(item));
    }
  }
  return out;
}

/**
 * 判断台账项对应的进程是否还是"当初那个"。
 *
 * 返回 { alive, same, reason }：
 *   alive  —— PID 现在是否活着
 *   same   —— 是否确认是同一个进程（无启动时间时退化为 "alive 即 same"，
 *             但 reason 会标 weak，调用方可以选择不杀）
 */
function checkLedgerEntry(entry, options = {}) {
  const {
    startTimeReader = (pid) => processStartTime(pid),
    alive = pidAlive,
  } = options;
  if (!isValidEntry(entry)) return { alive: false, same: false, reason: 'invalid' };
  if (!entry.startedAt) {
    const isAlive = alive(entry.pid);
    return { alive: isAlive, same: isAlive, reason: isAlive ? 'weak-no-start-time' : 'dead' };
  }
  const actual = startTimeReader(entry.pid);
  if (actual == null) {
    return { alive: alive(entry.pid), same: false, reason: 'start-time-unavailable' };
  }
  const same = Math.abs(actual - entry.startedAt) <= START_TIME_TOLERANCE_MS;
  return { alive: true, same, reason: same ? 'match' : 'pid-reused' };
}

module.exports = {
  DEFAULT_BASE_PORT,
  DEFAULT_SCAN_RANGE,
  LOOPBACK,
  START_TIME_TOLERANCE_MS,
  pidAlive,
  parseNetstat,
  listeningPid,
  listenersOnPort,
  pidOnPort,
  defaultRunNetstat,
  isPortFree,
  findFreePort,
  processStartTime,
  parseDotNetDate,
  makeLedgerEntry,
  writeLedger,
  readLedger,
  checkLedgerEntry,
};
