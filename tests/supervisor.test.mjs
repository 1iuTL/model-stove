// 进程监管层（src/core/supervisor.js）的单元测试。
//
// 全部用"假子进程"（EventEmitter + 可控 pid）驱动，不需要真的 llama-server：
// 只验证状态机、身份校验、快速失败、动态端口、台账与停止升级这些协议。
//
// 跑法：node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Supervisor, STATE, defaultMaskArgs, defaultHealthCheck } = require('../src/core/supervisor.js');
const ports = require('../src/core/ports.js');

const tmpRoots = [];
function tmpDir(prefix = 'model-stove-sup-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of tmpRoots) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

/** 假 spawn：每个子进程是 EventEmitter，pid 从 9001 起。 */
function fakeSpawn(onSpawn) {
  const children = [];
  const spawn = (exe, args, opts) => {
    const child = new EventEmitter();
    child.pid = 9001 + children.length;
    child.exe = exe;
    child.args = args;
    child.opts = opts;
    child.unref = () => {};
    children.push(child);
    if (onSpawn) onSpawn(child, exe, args, opts);
    return child;
  };
  return { spawn, children };
}

/** 造一个使用临时目录的 Supervisor，其余依赖按需覆盖。 */
function makeSup(overrides = {}) {
  const dir = tmpDir();
  const logDir = path.join(dir, 'logs');
  const ledgerFile = path.join(dir, 'running-pids.json');
  return new Supervisor({
    logDir,
    ledgerFile,
    fs: Object.assign({}, fs, { existsSync: () => true }), // 假进程不需要真的 exe 文件
    findFreePort: async () => 8123,
    readinessPollMs: 5,
    readyTimeoutMs: 500,
    killGraceMs: 100,
    startFailFastMs: 200,
    isReady: async () => true,
    pidAlive: () => false,
    killProcess: () => {},
    ...overrides,
  });
}

const EXE = 'C:\\fake\\llama-server.exe';
const basicParams = (extra = {}) => ({
  exe: EXE,
  modelId: 'onbit',
  argsForPort: (port) => ['-m', 'm.gguf', '--port', String(port)],
  ...extra,
});

// ---------------------------------------------------------------- 启动成功

test('start：选端口 → 拼参数 → 等就绪 → 状态 ready，台账写入', async () => {
  const fake = fakeSpawn();
  const sup = makeSup({ spawn: fake.spawn });
  const st = await sup.start(basicParams());
  assert.equal(st.state, STATE.READY);
  assert.equal(st.port, 8123);
  assert.equal(st.pid, 9001);
  assert.equal(st.url, 'http://127.0.0.1:8123/');
  assert.deepEqual(fake.children[0].args, ['-m', 'm.gguf', '--port', '8123']);

  const ledger = ports.readLedger(sup.ledgerFile);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].pid, 9001);
  assert.equal(ledger[0].port, 8123);
  assert.ok(ledger[0].startedAt > 0);
  assert.match(ledger[0].argvHash, /^[0-9a-f]{16}$/);
});

test('start：状态事件序列 starting → ready', async () => {
  const fake = fakeSpawn();
  const sup = makeSup({ spawn: fake.spawn });
  const states = [];
  sup.on('state', (s) => states.push(s.state));
  await sup.start(basicParams());
  assert.deepEqual(states, [STATE.STARTING, STATE.READY]);
});

test('start：就绪可以由日志里的 listening on 触发（不依赖 /health）', async () => {
  const fake = fakeSpawn((child, exe, args, opts) => {
    // 在 supervisor 关掉 fd 之前写一行就绪日志，模拟 llama.cpp 的输出
    fs.writeSync(opts.stdio[1], 'main: server is listening on http://127.0.0.1:8123\n');
  });
  const sup = makeSup({
    spawn: fake.spawn,
    isReady: undefined,
    healthCheck: async () => false,
  });
  const st = await sup.start(basicParams());
  assert.equal(st.state, STATE.READY);
});

test('start：日志没有就绪行时回落到 /health 探测', async () => {
  const fake = fakeSpawn();
  let healthCalls = 0;
  const sup = makeSup({
    spawn: fake.spawn,
    isReady: undefined,
    healthCheck: async () => { healthCalls++; return healthCalls >= 2; },
  });
  const st = await sup.start(basicParams());
  assert.equal(st.state, STATE.READY);
  assert.ok(healthCalls >= 2);
});

test('start：日志里的 --api-key 值必须遮掉', async () => {
  const fake = fakeSpawn();
  const sup = makeSup({ spawn: fake.spawn });
  await sup.start(basicParams({ argsForPort: (port) => ['-m', 'm', '--api-key', 'topsecret', '--port', String(port)] }));
  const files = fs.readdirSync(sup.logDir).filter((f) => f.endsWith('.log'));
  assert.equal(files.length, 1);
  const text = fs.readFileSync(path.join(sup.logDir, files[0]), 'utf8');
  assert.ok(text.includes('<已隐藏>'));
  assert.ok(!text.includes('topsecret'));
});

// ---------------------------------------------------------------- 失败路径

test('start：spawn 没有 PID 且报 ENOENT → 立刻失败（不等就绪超时）', async () => {
  const spawn = () => {
    const child = new EventEmitter();
    child.unref = () => {};
    setImmediate(() => child.emit('error', Object.assign(new Error('spawn llama-server ENOENT'), { code: 'ENOENT' })));
    return child;
  };
  const sup = makeSup({ spawn, readyTimeoutMs: 10000 });
  const t0 = Date.now();
  await assert.rejects(() => sup.start(basicParams()), /ENOENT|无法启动/);
  assert.ok(Date.now() - t0 < 2000, '必须在 2 秒内失败');
  assert.equal(sup.status().state, STATE.ERROR);
});

test('start：可执行文件不存在 → 预检直接失败', async () => {
  const sup = makeSup({
    spawn: fakeSpawn().spawn,
    fs: Object.assign({}, fs, { existsSync: () => false }),
  });
  await assert.rejects(
    () => sup.start(basicParams({ exe: path.join(tmpDir(), 'nope.exe') })),
    /可执行文件不存在/,
  );
  assert.equal(sup.status().state, STATE.ERROR);
});

test('start：就绪前退出 → 报错并带上退出码', async () => {
  const fake = fakeSpawn((child) => setImmediate(() => child.emit('exit', 3, null)));
  const sup = makeSup({ spawn: fake.spawn, isReady: async () => false, readyTimeoutMs: 1000 });
  await assert.rejects(() => sup.start(basicParams()), /就绪前退出|code=3/);
  assert.equal(sup.status().state, STATE.ERROR);
  assert.deepEqual(ports.readLedger(sup.ledgerFile), []);
});

test('start：就绪超时 → 收尸（kill + 清台账）', async () => {
  const alive = new Set();
  const killed = [];
  const fake = fakeSpawn((child) => alive.add(child.pid));
  const sup = makeSup({
    spawn: fake.spawn,
    isReady: async () => false,
    readyTimeoutMs: 60,
    pidAlive: (pid) => alive.has(pid),
    killProcess: (pid) => { killed.push(pid); alive.delete(pid); },
  });
  await assert.rejects(() => sup.start(basicParams()), /启动超时/);
  assert.deepEqual(killed, [9001]);
  assert.equal(sup.status().state, STATE.ERROR);
  assert.deepEqual(ports.readLedger(sup.ledgerFile), []);
});

test('start：argsForPort 返回非字符串数组 → 明确报错', async () => {
  const sup = makeSup({ spawn: fakeSpawn().spawn });
  await assert.rejects(
    () => sup.start(basicParams({ argsForPort: () => ['-m', 42] })),
    /字符串数组/,
  );
});

test('start：ready 状态下重复 start 被拒绝', async () => {
  const sup = makeSup({ spawn: fakeSpawn().spawn });
  await sup.start(basicParams());
  await assert.rejects(() => sup.start(basicParams()), /不能启动/);
});

// ---------------------------------------------------------------- 退出/崩溃

test('ready 后退出 → 状态 error + crash 事件 + 清台账', async () => {
  const fake = fakeSpawn();
  const sup = makeSup({ spawn: fake.spawn });
  const crashes = [];
  sup.on('crash', (e) => crashes.push(e));
  await sup.start(basicParams());
  fake.children[0].emit('exit', 1, null);
  assert.equal(sup.status().state, STATE.ERROR);
  assert.equal(crashes.length, 1);
  assert.equal(crashes[0].pid, 9001);
  assert.equal(crashes[0].code, 1);
  assert.deepEqual(ports.readLedger(sup.ledgerFile), []);
});

test('上一代的 exit 事件不能影响新进程（generation 身份校验）', async () => {
  const fake = fakeSpawn();
  const sup = makeSup({ spawn: fake.spawn });
  await sup.start(basicParams());
  await sup.stop();

  await sup.start(basicParams());
  const current = sup.status();
  // 旧子进程的 exit 晚到
  fake.children[0].emit('exit', 9, null);
  assert.equal(sup.status().state, STATE.READY, '旧事件必须被丢弃');
  assert.equal(sup.status().pid, current.pid);
});

// ---------------------------------------------------------------- 停止

test('stop：温和 kill 后进程消失 → idle + 清台账', async () => {
  const alive = new Set();
  const signals = [];
  const fake = fakeSpawn((child) => alive.add(child.pid));
  const sup = makeSup({
    spawn: fake.spawn,
    pidAlive: (pid) => alive.has(pid),
    killProcess: (pid, signal) => { signals.push(signal || 'SIGTERM'); alive.delete(pid); },
  });
  await sup.start(basicParams());
  const res = await sup.stop();
  assert.deepEqual(res.stopped, [9001]);
  assert.equal(res.adopted, false);
  assert.deepEqual(signals, ['SIGTERM']);
  assert.equal(sup.status().state, STATE.IDLE);
  assert.deepEqual(ports.readLedger(sup.ledgerFile), []);
});

test('stop：温和 kill 无效时升级 SIGKILL', async () => {
  const alive = new Set();
  const signals = [];
  const fake = fakeSpawn((child) => alive.add(child.pid));
  const sup = makeSup({
    spawn: fake.spawn,
    killGraceMs: 50,
    pidAlive: (pid) => alive.has(pid),
    killProcess: (pid, signal) => {
      signals.push(signal || 'SIGTERM');
      if (signal === 'SIGKILL') alive.delete(pid); // 只有强杀才死
    },
  });
  await sup.start(basicParams());
  const res = await sup.stop();
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(res.dead, true);
  assert.equal(sup.status().state, STATE.IDLE);
});

test('stop：没有句柄时按上次端口认领外部监听者', async () => {
  const alive = new Set([7777]);
  const sup = makeSup({
    spawn: fakeSpawn().spawn,
    lastPort: 8091,
    pidOnPort: (port) => (port === 8091 ? 7777 : null),
    pidAlive: (pid) => alive.has(pid),
    killProcess: (pid) => alive.delete(pid),
  });
  sup.lastPort = 8091;
  const res = await sup.stop();
  assert.deepEqual(res.stopped, [7777]);
  assert.equal(res.adopted, true);
  assert.equal(sup.status().state, STATE.IDLE);
});

test('stop：空闲且无句柄 → 空操作', async () => {
  const sup = makeSup({ spawn: fakeSpawn().spawn });
  const res = await sup.stop();
  assert.deepEqual(res.stopped, []);
  assert.equal(sup.status().state, STATE.IDLE);
});

// ---------------------------------------------------------------- 清理遗留

test('cleanupLeftovers：启动时间吻合才杀，PID 被复用的跳过', async () => {
  const sup = makeSup({ spawn: fakeSpawn().spawn });
  ports.writeLedger(sup.ledgerFile, [
    { pid: 7001, startedAt: 1000, exe: 'llama-server.exe', generation: 1 },
    { pid: 7002, startedAt: 2000, exe: 'llama-server.exe', generation: 2 },
  ]);
  const alive = new Set([7001, 7002]);
  sup.pidAlive = (pid) => alive.has(pid);
  sup.processStartTime = (pid) => (pid === 7001 ? 1000 : 999999);
  sup.killProcess = (pid) => alive.delete(pid);

  const res = await sup.cleanupLeftovers();
  assert.deepEqual(res.killed, [7001]);
  assert.equal(res.skipped.length, 1);
  assert.equal(res.skipped[0].pid, 7002);
  assert.equal(res.skipped[0].reason, 'pid-reused');
  assert.deepEqual(ports.readLedger(sup.ledgerFile), []);
  assert.ok(alive.has(7002), '被复用的 PID 对应的进程不许动');
});

test('start 之前会先清理上次遗留', async () => {
  const fake = fakeSpawn();
  const sup = makeSup({ spawn: fake.spawn });
  ports.writeLedger(sup.ledgerFile, [{ pid: 7001, startedAt: 1000 }]);
  const alive = new Set([7001]);
  sup.pidAlive = (pid) => alive.has(pid);
  sup.processStartTime = () => 1000;
  sup.killProcess = (pid) => alive.delete(pid);

  await sup.start(basicParams());
  assert.deepEqual([...alive], [], '旧进程必须被收掉');
});

// ---------------------------------------------------------------- 工具函数

test('defaultMaskArgs：只遮 --api-key 的值', () => {
  assert.deepEqual(
    defaultMaskArgs(['-m', 'x', '--api-key', 'secret', '--port', '1']),
    ['-m', 'x', '--api-key', '<已隐藏>', '--port', '1'],
  );
});

test('defaultHealthCheck：真实 http 服务 200 → true，关掉后 → false', async () => {
  const srv = http.createServer((req, res) => { res.writeHead(200); res.end('ok'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const handle = { url: `http://127.0.0.1:${port}/` };
  assert.equal(await defaultHealthCheck(handle, 500), true);
  await new Promise((r) => srv.close(r));
  assert.equal(await defaultHealthCheck(handle, 200), false);
});
