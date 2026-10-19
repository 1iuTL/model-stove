// 主进程接线测试：用假 spawn 验证 "动态端口 → buildArgs → Supervisor" 这条链。
//
// 本机没有模型/llama-server，所以这里不跑真进程：
//   - 在 require main.js 之前替换 child_process.spawn（Supervisor 会拿到同一个）；
//   - 假子进程往 stdio 文件里写一行 llama 风格的 "listening on ..."；
//   - 把一个临时模型/二进制塞进 MODELS，files 都真实存在（预检不拦）；
//   - 关掉探针（否则它会向假 URL 发 5 分钟超时的请求）。
//
// 验证点：
//   1. startServer() 返回的 URL/端口来自 Supervisor，而不是写死的 8091；
//   2. buildArgs() 收到的 port 就是 Supervisor 选中的端口（argv 快照语义不变）；
//   3. stopServer() 能回到 idle 并清掉台账。
//
// 用法：node tools/test_main_wiring.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'model-stove-wiring-'));

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};

const FAKE_PID = 98765;
let fakeAlive = true;
let spawned = null;

// 先占一个所有测试都用的空闲端口，写进 MODEL_STOVE_PORT，
// 这样 stopServer() 的空闲态 lastPort 不会去碰真实的 8091。
const ports = require('../src/core/ports.js');
const basePort = await ports.findFreePort({ start: 18291, count: 100, host: '127.0.0.1' });

// 设置/模型/二进制的临时文件
const modelFile = path.join(TMP, 'fake.gguf');
const binFile = path.join(TMP, 'fake-llama-server.exe');
fs.writeFileSync(modelFile, 'fake model', 'utf8');
fs.writeFileSync(binFile, 'fake binary', 'utf8');
fs.writeFileSync(path.join(TMP, 'settings.json'),
  JSON.stringify({ version: 2, apiKey: '', probe: false }), 'utf8');

// 假 spawn：所有子进程共用同一个假 PID，模拟"启动后立刻打印 listening 行"。
const childProcess = require('node:child_process');
const realSpawn = childProcess.spawn;
childProcess.spawn = function fakeSpawn(exe, args, opts) {
  const child = new EventEmitter();
  spawned = { exe, args, opts, child };
  child.pid = FAKE_PID;
  child.unref = () => {};
  // Supervisor 把 stdout/stderr 接到同一个文件 fd；写一行就绪日志给它看。
  try {
    const fd = opts && opts.stdio && opts.stdio[1];
    if (fd != null) fs.writeSync(fd, 'main: server is listening on http://127.0.0.1:0\n');
  } catch { /* 忽略 */ }
  return child;
};
const realKill = process.kill;
process.kill = function fakeKill(pid, signal) {
  if (pid === FAKE_PID) {
    // 注意：pidAlive 的判据是 process.kill(pid, 0) **不抛异常**，
    // 返回 true/false 没用 —— 进程没了必须 throw。
    if (signal === 0) {
      if (!fakeAlive) {
        const err = new Error('fake process gone');
        err.code = 'ESRCH';
        throw err;
      }
      return true;
    }
    fakeAlive = false;
    const c = spawned && spawned.child;
    if (c) setImmediate(() => c.emit('exit', 0, null));
    return true;
  }
  return realKill.call(process, pid, signal);
};

// Electron 桩
const fakeApp = {
  whenReady: () => Promise.resolve(),
  getPath: () => TMP,
  on: () => {},
  quit: () => {},
};
const fakeWin = {
  setMenuBarVisibility() {}, loadFile() {}, on() {}, isDestroyed: () => true,
  webContents: { send() {}, isLoadingMainFrame: () => false, once() {} },
};
const electronStub = {
  app: fakeApp,
  BrowserWindow: function BrowserWindow() { return fakeWin; },
  ipcMain: { handle() {} },
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub;
  return origLoad.call(this, request, parent, isMain);
};

process.env.MODEL_STOVE_PORT = String(basePort);
process.env.MODEL_STOVE_SETTINGS_DIR = TMP;
process.env.MODEL_STOVE_NO_AUTO_PROXY = '1';
process.env.MODEL_STOVE_QUIET = '1';

let main = null;
try {
  console.log('=== 主进程接线（假 spawn）===');
  console.log(`  临时目录: ${TMP}  起始端口: ${basePort}`);

  const cfg = require('../src/config.js');
  cfg.MODELS.push({
    id: '__wiring__',
    name: 'wiring fake',
    file: modelFile,
    bin: binFile,
    defaultPreset: 'text-32k',
  });

  main = require('../src/main.js');
  // 让 whenReady().then 的微任务跑完（initRuntime/createWindow）
  await new Promise((r) => setImmediate(r));

  const runtime = main.__test.runtime();
  check('createPaths 初始化成功', !!runtime.paths, runtime.paths ? runtime.paths.dataDir : '');
  check('设置文件落在临时目录', runtime.paths && runtime.paths.settingsFile === path.join(TMP, 'settings.json'),
    runtime.paths ? runtime.paths.settingsFile : '');

  const result = await main.__test.startServer('__wiring__', 'text-32k', null, false, null, null, 'q4_0');
  check('startServer 返回 URL', /^http:\/\/127\.0\.0\.1:\d+\/$/.test(result.url), result.url);
  check('端口来自 Supervisor（不是写死的 8091）', Number.isInteger(result.port) && result.port === basePort, String(result.port));
  check('假进程真的被"启动"了', !!spawned && spawned.exe === binFile, spawned ? spawned.exe : '');
  const argv = spawned ? spawned.args : [];
  check('buildArgs 收到了同一个动态端口', argv[argv.indexOf('--port') + 1] === String(result.port),
    argv.join(' '));
  check('默认只绑 127.0.0.1', argv[argv.indexOf('--host') + 1] === '127.0.0.1',
    argv[argv.indexOf('--host') + 1]);
  check('argv 里有模型与 KV 参数', argv.includes('-m') && argv.includes('-ctk') && argv.includes('q4_0'));

  const st = main.__test.runtime().supervisor;
  check('Supervisor 状态 ready', st.state === 'ready', st.state);
  check('status 里的 URL 与 startServer 一致', st.url === result.url, st.url);

  const stopped = await main.__test.stopServer();
  check('stopServer 停掉了句柄', stopped.stopped.includes(FAKE_PID), JSON.stringify(stopped));
  check('停止后 Supervisor 回到 idle', main.__test.runtime().supervisor.state === 'idle',
    main.__test.runtime().supervisor.state);
  check('进程确实被标记为退出', fakeAlive === false);

  const ledger = ports.readLedger(path.join(TMP, 'logs', 'running-pids.json'));
  check('台账已清空', ledger.length === 0, JSON.stringify(ledger));

  // P1 安全护栏：局域网模式没有 API Key 必须在 spawn 之前就被拒绝。
  // 这里不依赖 capabilities（假 exe 探测必然失败 → caps 未知），正好验证
  // “caps 未知时也要求 Key”这条兜底规则。
  const spawnedBefore = spawned;
  let lanErr = null;
  try {
    await main.__test.startServer('__wiring__', 'text-32k', null, true, null, null, 'q4_0');
  } catch (e) {
    lanErr = e;
  }
  check('LAN 无 API Key 启动被拒绝', !!lanErr && /API Key/.test(lanErr.message),
    lanErr ? lanErr.message.split('\n')[0] : '(没有被拒绝)');
  check('被拒绝时没有 spawn 新进程', spawned === spawnedBefore,
    spawned === spawnedBefore ? '' : '竟然又起了一个进程');
} catch (e) {
  check('测试执行无异常', false, e && e.message ? e.message : String(e));
  console.log(e && e.stack ? e.stack : e);
} finally {
  try { await main?.__test.stopServer(); } catch {}
  childProcess.spawn = realSpawn;
  process.kill = realKill;
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
}

console.log(failed === 0 ? '\n全部通过' : `\n有 ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
