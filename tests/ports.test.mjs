// 端口/进程标识层（src/core/ports.js）的单元测试。
//
// 解析、端口探测、台账都是纯逻辑或本地可注入的，不需要真的 llama-server。
// 跑法：node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ports = require('../src/core/ports.js');

const tmpRoots = [];
function tmpDir(prefix = 'model-stove-ports-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of tmpRoots) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

const NETSTAT_SAMPLE = [
  '',
  'Active Connections',
  '',
  '  Proto  Local Address          Foreign Address        State           PID',
  '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1808',
  '  TCP    127.0.0.1:8091         0.0.0.0:0              LISTENING       4321',
  '  TCP    127.0.0.1:8091         127.0.0.1:52344        ESTABLISHED     4321',
  '  TCP    127.0.0.1:52344        127.0.0.1:8091         TIME_WAIT       0',
  '  TCP    [::]:445               [::]:0                 LISTENING       4',
  '  UDP    0.0.0.0:5353          *:*                                    1188',
  '  TCP    0.0.0.0:9000           0.0.0.0:0              侦听            7777',
  '  TCP    10.0.0.2:7000          10.0.0.2:7001          ESTABLISHED     7000',
  '',
].join('\r\n');

// ---------------------------------------------------------------- parseNetstat

test('parseNetstat：只认 TCP 行，端点/PID 解析正确', () => {
  const rows = ports.parseNetstat(NETSTAT_SAMPLE);
  assert.ok(rows.length >= 6);
  const first = rows.find((r) => r.localPort === 8091 && r.foreignPort === 0);
  assert.deepEqual(first, {
    localHost: '127.0.0.1', localPort: 8091,
    foreignHost: '0.0.0.0', foreignPort: 0,
    state: 'LISTENING', pid: 4321,
  });
  const v6 = rows.find((r) => r.localHost === '::' && r.localPort === 445);
  assert.equal(v6.pid, 4);
});

test('parseNetstat：状态词本地化也能解析（不依赖 LISTENING）', () => {
  const rows = ports.parseNetstat(NETSTAT_SAMPLE);
  const localized = rows.find((r) => r.localPort === 9000);
  assert.ok(localized, '本地化状态词的行必须被解析出来');
  assert.equal(localized.pid, 7777);
});

test('parseNetstat：垃圾行/乱码/空行不抛异常', () => {
  assert.deepEqual(ports.parseNetstat(''), []);
  assert.deepEqual(ports.parseNetstat('hello world\n\x00\x01\n  TCP  bad'), []);
});

// ---------------------------------------------------------------- listeningPid

test('listeningPid：只返回监听该端口的 PID', () => {
  const rows = ports.parseNetstat(NETSTAT_SAMPLE);
  assert.equal(ports.listeningPid(rows, 8091), 4321);
  assert.equal(ports.listeningPid(rows, 445), 4);
  assert.equal(ports.listeningPid(rows, 9000), 7777);
  assert.equal(ports.listeningPid(rows, 52344), null, 'TIME_WAIT 不能算监听');
  assert.equal(ports.listeningPid(rows, 9999), null);
});

test('pidOnPort：支持直接注入 netstat 文本', () => {
  assert.equal(ports.pidOnPort(8091, { text: NETSTAT_SAMPLE }), 4321);
  assert.equal(ports.pidOnPort(8091, { runNetstat: () => NETSTAT_SAMPLE }), 4321);
  assert.equal(ports.pidOnPort(8091, { runNetstat: () => '' }), null);
});

test('listenersOnPort：返回全部监听行', () => {
  const hits = ports.listenersOnPort(8091, { text: NETSTAT_SAMPLE });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].pid, 4321);
});

// ---------------------------------------------------------------- 端口探测

function listenOnEphemeral() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

function closeServer(srv) {
  return new Promise((resolve) => srv.close(() => resolve()));
}

test('isPortFree：被占用返回 false，释放后返回 true', async () => {
  const { srv, port } = await listenOnEphemeral();
  try {
    assert.equal(await ports.isPortFree(port, '127.0.0.1'), false);
  } finally {
    await closeServer(srv);
  }
  assert.equal(await ports.isPortFree(port, '127.0.0.1'), true);
});

test('findFreePort：跳过被占端口（真实 bind 探测）', async () => {
  const { srv, port } = await listenOnEphemeral();
  try {
    const found = await ports.findFreePort({ start: port, count: 4 });
    assert.notEqual(found, port);
    assert.ok(found > port);
    assert.equal(await ports.isPortFree(found, '127.0.0.1'), true);
  } finally {
    await closeServer(srv);
  }
});

test('findFreePort：可注入 probe，确定性验证跳过逻辑', async () => {
  const probed = [];
  const found = await ports.findFreePort({
    start: 9000,
    count: 8,
    probe: (p) => { probed.push(p); return p >= 9005; },
  });
  assert.equal(found, 9005);
  assert.deepEqual(probed, [9000, 9001, 9002, 9003, 9004, 9005]);
});

test('findFreePort：范围内没空端口时明确报错', async () => {
  await assert.rejects(
    () => ports.findFreePort({ start: 9000, count: 3, probe: () => false }),
    /找不到空闲端口/,
  );
  await assert.rejects(() => ports.findFreePort({ start: 0, count: 3 }), /起始端口非法/);
});

// ------------------------------------------------------------ 进程启动时间

test('parseDotNetDate：.NET "o" 格式（7 位小数）也能解析', () => {
  const t = ports.parseDotNetDate('2026-10-19T04:03:17.2382625Z');
  assert.equal(t, Date.UTC(2026, 9, 19, 4, 3, 17, 238));
  assert.equal(ports.parseDotNetDate('2026-10-19T04:03:17.238Z'), Date.UTC(2026, 9, 19, 4, 3, 17, 238));
  assert.equal(ports.parseDotNetDate(''), null);
  assert.equal(ports.parseDotNetDate('not a date'), null);
});

test('processStartTime：解析 PowerShell 输出的 ISO 时间', () => {
  const calls = [];
  const execFileSync = (exe, args) => {
    calls.push({ exe, args });
    return '2026-10-19T04:03:17.2382625Z\r\n';
  };
  const t = ports.processStartTime(4321, { execFileSync, systemRoot: 'C:\\Windows' });
  assert.equal(t, Date.UTC(2026, 9, 19, 4, 3, 17, 238));
  assert.equal(calls.length, 1);
  assert.match(calls[0].exe, /WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/i);
  assert.ok(calls[0].args.join(' ').includes('4321'));
});

test('processStartTime：查不到/命令失败/非法 PID 都返回 null', () => {
  assert.equal(ports.processStartTime(0), null);
  assert.equal(ports.processStartTime('x'), null);
  assert.equal(ports.processStartTime(4321, { execFileSync: () => { throw new Error('denied'); } }), null);
  assert.equal(ports.processStartTime(4321, { execFileSync: () => '' }), null);
});

test('pidAlive：自己活着，非法 PID 一律 false', () => {
  assert.equal(ports.pidAlive(process.pid), true);
  assert.equal(ports.pidAlive(0), false);
  assert.equal(ports.pidAlive(-1), false);
  assert.equal(ports.pidAlive('abc'), false);
});

// ---------------------------------------------------------------- 台账

function ledgerFile() {
  return path.join(tmpDir('model-stove-ledger-'), 'running-pids.json');
}

test('台账：写入/读取往返，字段完整', () => {
  const file = ledgerFile();
  const written = ports.writeLedger(file, [
    { pid: 4321, startedAt: 1792370000000, exe: 'llama-server.exe', argvHash: 'abc', port: 8091, generation: 2 },
    { pid: 0, startedAt: 1 },       // 非法，应被过滤
    { pid: 5555 },
  ]);
  assert.equal(written.length, 2);
  const read = ports.readLedger(file);
  assert.deepEqual(read.map((e) => e.pid), [4321, 5555]);
  assert.equal(read[0].exe, 'llama-server.exe');
  assert.equal(read[0].generation, 2);
  assert.equal(read[1].startedAt, null);
});

test('台账：兼容旧格式（纯 PID 数字数组）与坏文件', () => {
  const file = ledgerFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '[123, 456, "x", -3]', 'utf8');
  assert.deepEqual(ports.readLedger(file).map((e) => e.pid), [123, 456]);

  fs.writeFileSync(file, '{not json', 'utf8');
  assert.deepEqual(ports.readLedger(file), []);

  assert.deepEqual(ports.readLedger(path.join(tmpDir(), 'missing.json')), []);
});

test('台账：写入是原子的（不留下半截文件）', () => {
  const file = ledgerFile();
  ports.writeLedger(file, [{ pid: 4321, startedAt: 1792370000000 }]);
  const dir = path.dirname(file);
  const leftovers = fs.readdirSync(dir).filter((n) => n.includes('.tmp-'));
  assert.deepEqual(leftovers, []);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file, 'utf8')));
});

test('checkLedgerEntry：启动时间吻合才算同一个进程', () => {
  const startedAt = 1792370000000;
  const entry = ports.makeLedgerEntry({ pid: 4321, startedAt });

  const match = ports.checkLedgerEntry(entry, {
    startTimeReader: () => startedAt + 500,
    alive: () => true,
  });
  assert.deepEqual(match, { alive: true, same: true, reason: 'match' });

  const reused = ports.checkLedgerEntry(entry, {
    startTimeReader: () => startedAt + 3600_000,
    alive: () => true,
  });
  assert.equal(reused.same, false);
  assert.equal(reused.reason, 'pid-reused');

  const gone = ports.checkLedgerEntry(entry, {
    startTimeReader: () => null,
    alive: () => false,
  });
  assert.equal(gone.alive, false);
  assert.equal(gone.same, false);
  assert.equal(gone.reason, 'start-time-unavailable');
});

test('checkLedgerEntry：旧格式没有启动时间 → 标记 weak，不谎称精确', () => {
  const entry = ports.makeLedgerEntry({ pid: 4321 });
  const res = ports.checkLedgerEntry(entry, { alive: () => true });
  assert.deepEqual(res, { alive: true, same: true, reason: 'weak-no-start-time' });
  const dead = ports.checkLedgerEntry(entry, { alive: () => false });
  assert.deepEqual(dead, { alive: false, same: false, reason: 'dead' });
  assert.equal(ports.checkLedgerEntry({}, {}).reason, 'invalid');
});
