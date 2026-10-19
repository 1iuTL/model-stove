// 热接管接线测试：electron 桩 + 真 HTTP + 假进程。
//
// 场景：外壳重启时台账里还留着一个 llama-server（PID 活着、/health 正常）。
// 验证主进程在 whenReady 里认领它，而不是杀掉重来：
//   1. Supervisor 进入 ready，status().adopted=true，端口/PID 与台账一致；
//   2. current 恢复 modelId/preset/lanMode/startedAt；
//   3. 台账保留并回写字段（下次重启还能认）；
//   4. stopServer() 杀掉被接管的 PID、清空台账、回到 idle；
//   5. 从进入 whenReady 到 ready 的耗时 < 2000ms（日志里也带毫秒）。
//
// 全部在独立临时目录里跑；HTTP 服务由本进程提供，不会被真的 kill。
//
// 用法：node tools/test_adoption_wiring.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import Module from 'node:module';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'model-stove-adopt-'));

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};

// ---------------------------------------------------------------- 临时目录

const HOME = TMP;
const LOGS_DIR = path.join(HOME, 'logs');
const MODELS_DIR = path.join(HOME, 'models');
const BUILDS_DIR = path.join(HOME, 'builds');
fs.mkdirSync(LOGS_DIR, { recursive: true });
fs.mkdirSync(MODELS_DIR, { recursive: true });
fs.mkdirSync(BUILDS_DIR, { recursive: true });
// 关掉启动速度探针，避免向假 URL 发长超时请求。
fs.writeFileSync(path.join(HOME, 'settings.json'),
  JSON.stringify({ version: 2, apiKey: '', probe: false }), 'utf8');

// ---------------------------------------------------------------- 真 HTTP /health

const healthServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"status":"ok"}');
    return;
  }
  if (req.url === '/props') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"model_path":"__wired__"}');
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise((resolve) => healthServer.listen(0, '127.0.0.1', resolve));
const httpPort = healthServer.address().port;

// ---------------------------------------------------------------- 假进程

const FAKE_PID = 98532;
let fakeAlive = true;
let spawned = null;
const unexpectedKills = [];

const childProcess = require('node:child_process');
const realSpawn = childProcess.spawn;
childProcess.spawn = function fakeSpawn(exe, args, opts) {
  const child = new EventEmitter();
  spawned = { exe, args, opts, child };
  child.pid = FAKE_PID;
  child.unref = () => {};
  return child;
};
const realKill = process.kill;
process.kill = function fakeKill(pid, signal) {
  if (pid === FAKE_PID) {
    if (signal === 0) {
      if (!fakeAlive) {
        const err = new Error('fake process gone');
        err.code = 'ESRCH';
        throw err;
      }
      return true;
    }
    fakeAlive = false;
    return true;
  }
  // 测试里不允许真的杀掉别的进程（尤其是本测试进程自己）。
  if (signal === 0) throw Object.assign(new Error('not tracked'), { code: 'ESRCH' });
  unexpectedKills.push(pid);
  return true;
};

// ---------------------------------------------------------------- 台账

const ports = require('../src/core/ports.js');
const ledgerFile = path.join(LOGS_DIR, 'running-pids.json');
ports.writeLedger(ledgerFile, [{
  pid: FAKE_PID,
  port: httpPort,
  exe: 'C:\\fake\\llama-server.exe',
  argvHash: 'deadbeefdeadbeef',
  modelId: '__wired__',
  preset: 'text-32k',
  lanMode: false,
  // 模拟旧格式台账：没有启动时间 → 允许 weak 认领。
  startedAt: null,
}]);

// 起始端口用空闲值，避免 stopServer 的空闲态回落到真实 8091。
const basePort = await ports.findFreePort({ start: 18491, count: 100, host: '127.0.0.1' });

// ---------------------------------------------------------------- Electron 桩

const handlers = new Map();
const appEvents = [];
let appQuit = false;
const fakeApp = {
  whenReady: () => Promise.resolve(),
  getPath: () => HOME,
  on: (ev) => { appEvents.push(ev); },
  quit: () => { appQuit = true; },
  requestSingleInstanceLock: () => true,
};
const fakeWin = {
  setMenuBarVisibility() {}, loadFile() {}, on() {},
  isDestroyed: () => true, hide() {}, show() {}, focus() {},
  isMinimized: () => false, restore() {},
  webContents: { send() {}, isLoadingMainFrame: () => false, once() {} },
};
const electronStub = {
  app: fakeApp,
  BrowserWindow: function BrowserWindow() { return fakeWin; },
  ipcMain: {
    handle: (channel, fn) => {
      if (handlers.has(channel)) throw new Error(`IPC 通道重复注册: ${channel}`);
      handlers.set(channel, fn);
    },
  },
  // 刻意不提供 Tray/Menu/nativeImage：验证托盘失败不崩、且不改变服务状态。
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub;
  return origLoad.call(this, request, parent, isMain);
};

// ---------------------------------------------------------------- 环境

const ENV_KEYS = [
  'MODEL_STOVE_HOME', 'MODEL_STOVE_MODELS', 'MODEL_STOVE_BUILDS',
  'MODEL_STOVE_SETTINGS_DIR', 'MODEL_STOVE_NO_AUTO_PROXY', 'MODEL_STOVE_QUIET',
  'MODEL_STOVE_PORT',
];
const savedEnv = {};
for (const key of ENV_KEYS) savedEnv[key] = process.env[key];

process.env.MODEL_STOVE_HOME = HOME;
process.env.MODEL_STOVE_MODELS = MODELS_DIR;
process.env.MODEL_STOVE_BUILDS = BUILDS_DIR;
process.env.MODEL_STOVE_SETTINGS_DIR = HOME;
process.env.MODEL_STOVE_NO_AUTO_PROXY = '1';
process.env.MODEL_STOVE_QUIET = '1';
process.env.MODEL_STOVE_PORT = String(basePort);

let main = null;
let stopped = false;
try {
  console.log('=== 热接管接线（electron 桩 + 真 HTTP + 假进程）===');
  console.log(`  临时目录: ${HOME}`);
  console.log(`  台账 PID: ${FAKE_PID}  port: ${httpPort}（/health 200）`);

  const t0 = Date.now();
  main = require('../src/main.js');

  // 等 whenReady 的初始化链跑完：轮询 Supervisor 状态（最多 5s）。
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const st = main.__test.runtime().supervisor;
    if (st && st.state === 'ready') break;
    await new Promise((r) => setTimeout(r, 10));
  }
  const readyMs = Date.now() - t0;

  const st = main.__test.runtime().supervisor;
  check('whenReady 后 Supervisor 进入 ready', st.state === 'ready', st.state);
  check('status().adopted === true', st.adopted === true, String(st.adopted));
  check('status().identity === weak（旧台账无启动时间）', st.identity === 'weak', String(st.identity));
  check('接管端口来自台账', st.port === httpPort, `${st.port} vs ${httpPort}`);
  check('接管 PID 来自台账', st.pid === FAKE_PID, String(st.pid));
  check('URL 指向真实健康端口', st.url === `http://127.0.0.1:${httpPort}/`, String(st.url));
  check('没有 spawn 新进程', spawned === null, spawned ? spawned.exe : '');

  const cur = main.__test.current();
  check('current.modelId 已恢复', cur.modelId === '__wired__', String(cur.modelId));
  check('current.preset 已恢复', cur.preset === 'text-32k', String(cur.preset));
  check('current.lanMode 已恢复', cur.lanMode === false, String(cur.lanMode));
  check('current.startedAt 已恢复', typeof cur.startedAt === 'number' && cur.startedAt > 0,
    String(cur.startedAt));
  check('current 的 ctx/kv 保持未知（不猜旧 argv）', cur.ctx === null && cur.kv === null,
    `ctx=${cur.ctx} kv=${cur.kv}`);

  // 台账必须保留，并回写 modelId/preset（下次重启还能认）。
  const ledger = ports.readLedger(ledgerFile);
  check('台账保留且 PID 不变', ledger.length === 1 && ledger[0].pid === FAKE_PID,
    JSON.stringify(ledger));
  check('台账回写了 modelId/preset', ledger[0] && ledger[0].modelId === '__wired__'
    && ledger[0].preset === 'text-32k', ledger[0] ? `${ledger[0].modelId}/${ledger[0].preset}` : '');
  check('弱身份台账的 startedAt 仍为 null',
    ledger[0] && ledger[0].startedAt === null, String(ledger[0] && ledger[0].startedAt));

  // shell 日志里要有可读的接管记录与毫秒数。
  let shellLog = '';
  try { shellLog = fs.readFileSync(path.join(LOGS_DIR, 'shell.log'), 'utf8'); } catch {}
  const m = /热接管已有服务 pid=(\d+) port=(\d+) \(model=([^,]+), 用时 (\d+)ms, 启动链 (\d+)ms\)/.exec(shellLog);
  check('shell.log 记录热接管（含 pid/port/model/毫秒）', !!m,
    m ? m[0] : shellLog.split(/\r?\n/).filter((l) => l.includes('热接管')).slice(-1)[0] || '(没有)');
  const adoptMs = m ? Number(m[4]) : NaN;
  check('日志里的接管耗时 < 2000ms', Number.isFinite(adoptMs) && adoptMs < 2000,
    Number.isFinite(adoptMs) ? `${adoptMs}ms` : '(无法解析)');
  check('从 require 到 ready < 2000ms', readyMs < 2000, `${readyMs}ms`);
  if (m) console.log(`  接管耗时: ${adoptMs}ms（从 require 到 ready ${readyMs}ms）`);

  check('托盘不可用时没有崩、也没有进入退出流程',
    main.__test.isQuitting() === false, String(main.__test.isQuitting()));
  check('window-all-closed / before-quit / activate 都已监听',
    ['window-all-closed', 'before-quit', 'activate'].every((e) => appEvents.includes(e)),
    appEvents.join(', '));
  check('Tray 缺失时 keepServerOnClose 仍为 true（设置默认）',
    main.__test.keepServerOnClose() === true, String(main.__test.keepServerOnClose()));

  // ---- 停止：必须收掉被接管的进程 ----
  const res = await main.__test.stopServer();
  stopped = true;
  check('stopServer 停掉被接管的 PID', Array.isArray(res.stopped) && res.stopped.includes(FAKE_PID),
    JSON.stringify(res));
  check('假进程确实被标记为退出', fakeAlive === false);
  check('停止后回到 idle', main.__test.runtime().supervisor.state === 'idle',
    main.__test.runtime().supervisor.state);
  check('停止后 status().adopted === false', main.__test.runtime().supervisor.adopted === false,
    String(main.__test.runtime().supervisor.adopted));
  check('台账已清空', ports.readLedger(ledgerFile).length === 0,
    JSON.stringify(ports.readLedger(ledgerFile)));
  check('current 已重置', main.__test.current().modelId === null,
    String(main.__test.current().modelId));
  check('没有误杀其它进程', unexpectedKills.length === 0, unexpectedKills.join(','));
  check('没有意外调用 app.quit', appQuit === false, String(appQuit));
} catch (e) {
  check('测试执行无异常', false, e && e.message ? e.message : String(e));
  console.log(e && e.stack ? e.stack : e);
} finally {
  // 只有仍处于 ready（还有被接管 handle）时才再停一次；否则 stopServer 会
  // 回落到 lastPort 上的真实监听者，可能误伤本测试进程（HTTP 服务就在本进程）。
  try {
    if (main && !stopped && main.__test.runtime().supervisor.state === 'ready') {
      await main.__test.stopServer();
    }
  } catch {}
  childProcess.spawn = realSpawn;
  process.kill = realKill;
  Module._load = origLoad;
  await new Promise((resolve) => {
    try {
      healthServer.close(() => resolve());
      // Node 19+ 的 http.globalAgent 默认 keep-alive，不断开空闲连接 close 会等。
      healthServer.closeAllConnections?.();
    } catch {
      resolve();
    }
    setTimeout(resolve, 500); // 兜底，避免 close 回调因连接残留永不触发
  });
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
}

console.log(failed === 0 ? '\n全部通过' : `\n有 ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
