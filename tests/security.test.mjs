// 安全核心（src/core/security.js）的单元测试。
//
// 覆盖：设备 key 的签发/验证/吊销/轮换/持久化/坏文件恢复；配对码的
// 生成/兑换/过期/单次/错码上限；审计日志的追加/轮转/读取/截断/坏行；
// 令牌桶限流的容量/补充/retryAfter/forget/LRU 清理。
//
// 全部在临时目录里跑，时间用注入的假时钟；不碰真实用户目录、不启动 Electron。
//
// 跑法：node --test tests/security.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const security = require('../src/core/security.js');
const { AUDIT_EVENTS } = security;

const tmpRoots = [];
function tmpDir(prefix = 'model-stove-security-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of tmpRoots) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

/** 假时钟：毫秒 epoch，可前进。 */
function makeClock(start = 1_700_000_000_000) {
  let value = start;
  return {
    now: () => value,
    advance(ms) { value += ms; },
    get value() { return value; },
  };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}
/** 找一个与给定 6 位码不同的 6 位码。 */
function wrongCode(code) {
  return String((Number(code) + 1) % 1_000_000).padStart(6, '0');
}

function newRegistry(options = {}) {
  const clock = options.clock || makeClock();
  const dir = options.dir || tmpDir();
  const file = options.file || path.join(dir, 'devices.json');
  const registry = security.createDeviceRegistry({
    file,
    fs: options.fs,
    now: clock.now,
    crypto: options.crypto,
  });
  return { dir, file, clock, registry };
}

function newPairing(options = {}) {
  const base = newRegistry({ clock: options.clock });
  const service = security.createPairingService({
    registry: base.registry,
    file: options.file,
    now: base.clock.now,
    crypto: options.crypto,
    ttlMs: options.ttlMs,
    maxAttempts: options.maxAttempts,
  });
  return { ...base, service };
}

function newAudit(options = {}) {
  const clock = options.clock || makeClock();
  const dir = options.dir || tmpDir();
  const file = options.file || path.join(dir, 'audit.log');
  const log = security.createAuditLog({
    file,
    fs: options.fs,
    now: clock.now,
    maxBytes: options.maxBytes,
    keepFiles: options.keepFiles,
  });
  return { dir, file, clock, log };
}

function newRateLimiter(options = {}) {
  const clock = options.clock || makeClock();
  const limiter = security.createRateLimiter({
    capacity: options.capacity,
    refillPerSec: options.refillPerSec,
    maxKeys: options.maxKeys,
    now: clock.now,
  });
  return { clock, limiter };
}

// ================================================================ 设备注册表

test('设备注册表：issueDevice 生成 64 位 hex key，文件只存 hash 和前缀', () => {
  const { file, registry } = newRegistry();
  const issued = registry.issueDevice({ name: '客厅手机' });

  assert.match(issued.id, /^dev_[0-9a-f]{8}$/);
  assert.match(issued.key, /^[0-9a-f]{64}$/);
  assert.equal(issued.name, '客厅手机');
  assert.equal(issued.createdAt, 1_700_000_000_000);

  const text = fs.readFileSync(file, 'utf8');
  assert.ok(!text.includes(issued.key), '文件里绝不能出现明文 key');

  const onDisk = readJson(file);
  assert.equal(onDisk.version, security.SECURITY_VERSION);
  assert.equal(onDisk.devices.length, 1);
  assert.equal(onDisk.devices[0].hash, sha256(issued.key), '必须存 sha256(key)');
  assert.equal(onDisk.devices[0].prefix, issued.key.slice(0, 8), '前缀用于展示');
  assert.equal(onDisk.devices[0].key, undefined);
  assert.deepEqual(onDisk.pairing, []);
});

test('设备注册表：verifyKey 支持多设备，返回信息不含 hash/明文', () => {
  const { registry } = newRegistry();
  const first = registry.issueDevice({ name: '手机' });
  const second = registry.issueDevice({ name: '平板' });

  const r1 = registry.verifyKey(first.key, { ip: '192.168.1.20' });
  assert.equal(r1.ok, true);
  assert.equal(r1.reason, 'ok');
  assert.equal(r1.device.id, first.id);
  assert.equal(r1.device.name, '手机');
  assert.equal(r1.device.prefix, first.key.slice(0, 8));
  assert.equal(r1.device.hash, undefined);
  assert.equal(r1.device.key, undefined);

  const r2 = registry.verifyKey(second.key);
  assert.equal(r2.ok, true);
  assert.equal(r2.device.id, second.id);
  assert.notEqual(r1.device.id, r2.device.id);
});

test('设备注册表：错误/缺失/格式非法的 key 被拒绝', () => {
  const { registry } = newRegistry();
  registry.issueDevice({ name: '手机' });

  assert.deepEqual(registry.verifyKey(''), { ok: false, reason: 'missing' });
  assert.deepEqual(registry.verifyKey(null), { ok: false, reason: 'missing' });
  assert.deepEqual(registry.verifyKey('not-a-key'), { ok: false, reason: 'invalid' });
  assert.deepEqual(registry.verifyKey('a'.repeat(64)), { ok: false, reason: 'invalid' });
});

test('设备注册表：吊销立即生效，其他设备不受影响', () => {
  const { registry } = newRegistry();
  const a = registry.issueDevice({ name: 'a' });
  const b = registry.issueDevice({ name: 'b' });

  const revoked = registry.revokeDevice(a.id);
  assert.equal(revoked.ok, true);
  assert.equal(typeof revoked.device.revokedAt, 'number');
  assert.equal(registry.verifyKey(a.key).reason, 'revoked');
  assert.equal(registry.verifyKey(b.key).ok, true);

  const again = registry.revokeDevice(a.id);
  assert.equal(again.ok, true);
  assert.equal(again.alreadyRevoked, true);
  assert.equal(registry.revokeDevice('dev-missing').reason, 'not-found');

  const listed = registry.listDevices().find((d) => d.id === a.id);
  assert.equal(typeof listed.revokedAt, 'number');
});

test('设备注册表：rotateKey 后旧 key 立即失效、新 key 可用且前缀更新', () => {
  const { registry } = newRegistry();
  const issued = registry.issueDevice({ name: '要轮换的设备' });
  const oldKey = issued.key;

  const rotated = registry.rotateKey(issued.id);
  assert.equal(rotated.id, issued.id);
  assert.equal(rotated.name, issued.name);
  assert.match(rotated.key, /^[0-9a-f]{64}$/);
  assert.notEqual(rotated.key, oldKey);
  assert.equal(registry.verifyKey(oldKey).ok, false, '旧 key 必须立即失效');
  assert.equal(registry.verifyKey(rotated.key).ok, true);

  const listed = registry.listDevices().find((d) => d.id === issued.id);
  assert.equal(listed.prefix, rotated.key.slice(0, 8));
  assert.equal(registry.rotateKey('dev-missing').reason, 'not-found');

  registry.revokeDevice(issued.id);
  assert.equal(registry.rotateKey(issued.id).reason, 'revoked');
});

test('设备注册表：listDevices 只暴露非敏感字段', () => {
  const { registry } = newRegistry();
  const issued = registry.issueDevice({ name: '手机' });
  registry.verifyKey(issued.key);
  registry.revokeDevice(issued.id);

  const list = registry.listDevices();
  assert.equal(list.length, 1);
  assert.deepEqual(
    Object.keys(list[0]).sort(),
    ['createdAt', 'id', 'lastUsedAt', 'name', 'prefix', 'revokedAt'],
  );
  assert.equal(list[0].hash, undefined);
  assert.equal(list[0].key, undefined);
  assert.ok(!JSON.stringify(list).includes(issued.key));
});

test('设备注册表：lastUsedAt 按 60 秒节流写盘', () => {
  const clock = makeClock(1_000_000);
  const { file, registry } = newRegistry({ clock });
  const issued = registry.issueDevice({ name: '手机' });

  const first = registry.verifyKey(issued.key);
  assert.equal(first.device.lastUsedAt, 1_000_000);
  assert.equal(readJson(file).devices[0].lastUsedAt, 1_000_000);

  clock.advance(30_000);
  const second = registry.verifyKey(issued.key);
  assert.equal(second.device.lastUsedAt, 1_000_000, '60 秒内不再写盘');
  assert.equal(readJson(file).devices[0].lastUsedAt, 1_000_000);

  clock.advance(30_001);
  const third = registry.verifyKey(issued.key);
  assert.equal(third.device.lastUsedAt, 1_060_001, '超过 60 秒后刷新');
  assert.equal(readJson(file).devices[0].lastUsedAt, 1_060_001);
});

test('设备注册表：持久化重载后 key 仍可验证', () => {
  const clock = makeClock();
  const { file, registry } = newRegistry({ clock });
  const issued = registry.issueDevice({ name: '重载测试' });

  const reloaded = security.createDeviceRegistry({ file, now: clock.now });
  assert.equal(reloaded.listDevices().length, 1);
  assert.equal(reloaded.verifyKey(issued.key).ok, true);

  const another = reloaded.issueDevice({ name: '第二个' });
  assert.equal(reloaded.listDevices().length, 2);
  assert.equal(reloaded.verifyKey(another.key).ok, true);
});

test('设备注册表：坏 JSON 备份后从空注册表继续', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'devices.json');
  const broken = '{ this is not json';
  fs.writeFileSync(file, broken, 'utf8');

  const registry = security.createDeviceRegistry({ file, now: makeClock().now });
  assert.ok(registry.backupFile && fs.existsSync(registry.backupFile), '坏文件必须留档');
  assert.match(path.basename(registry.backupFile), /\.bad-/);
  assert.deepEqual(registry.listDevices(), []);
  assert.ok(!fs.existsSync(file));

  const issued = registry.issueDevice({ name: '恢复后' });
  assert.equal(registry.verifyKey(issued.key).ok, true);
  assert.equal(readJson(file).version, security.SECURITY_VERSION);
  assert.equal(fs.readFileSync(registry.backupFile, 'utf8'), broken);
});

test('设备注册表：未知版本/坏结构备份后从空注册表继续', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'devices.json');
  fs.writeFileSync(file, JSON.stringify({ version: 99, devices: [], pairing: [] }), 'utf8');

  const registry = security.createDeviceRegistry({ file, now: makeClock().now });
  assert.ok(registry.backupFile && fs.existsSync(registry.backupFile));
  assert.deepEqual(registry.listDevices(), []);

  const issued = registry.issueDevice({ name: '继续' });
  assert.equal(readJson(file).version, security.SECURITY_VERSION);
  assert.equal(registry.verifyKey(issued.key).ok, true);

  const badShape = path.join(dir, 'bad-shape.json');
  fs.writeFileSync(badShape, JSON.stringify({ version: 1, devices: 'nope', pairing: [] }), 'utf8');
  const recovered = security.createDeviceRegistry({ file: badShape, now: makeClock().now });
  assert.ok(recovered.backupFile && fs.existsSync(recovered.backupFile));
  assert.deepEqual(recovered.listDevices(), []);
});

test('设备注册表：注入 fs/crypto，确实走 fsync+rename 与常量时间比较', () => {
  let fsyncCalls = 0;
  let renameCalls = 0;
  let equalCalls = 0;
  const fsStub = Object.assign({}, fs, {
    fsyncSync(fd) { fsyncCalls++; return fs.fsyncSync(fd); },
    renameSync(from, to) { renameCalls++; return fs.renameSync(from, to); },
  });
  const cryptoStub = {
    randomBytes: (...args) => crypto.randomBytes(...args),
    randomInt: (...args) => crypto.randomInt(...args),
    createHash: (...args) => crypto.createHash(...args),
    timingSafeEqual: (a, b) => { equalCalls++; return crypto.timingSafeEqual(a, b); },
  };

  const { registry } = newRegistry({ fs: fsStub, crypto: cryptoStub });
  const issued = registry.issueDevice({ name: '注入依赖' });
  assert.ok(fsyncCalls >= 1, '原子写必须 fsync');
  assert.ok(renameCalls >= 1, '原子写必须 rename');
  assert.equal(registry.verifyKey(issued.key).ok, true);
  assert.ok(equalCalls >= 1, '验证必须走 timingSafeEqual');
});

test('设备注册表：ttlMs 到期的设备 key 被拒绝', () => {
  const clock = makeClock(2_000_000);
  const { registry } = newRegistry({ clock });
  const issued = registry.issueDevice({ name: '临时设备', ttlMs: 1000 });

  clock.advance(999);
  assert.equal(registry.verifyKey(issued.key).ok, true);
  clock.advance(1);
  assert.equal(registry.verifyKey(issued.key).reason, 'expired');
  assert.equal(registry.rotateKey(issued.id).reason, 'expired', '过期设备不应再发新 key');
});

test('设备注册表：设备名回退与长度限制', () => {
  const { registry } = newRegistry();
  assert.equal(registry.issueDevice({}).name, '未命名设备');
  assert.equal(registry.issueDevice({ name: '   ' }).name, '未命名设备');
  assert.equal(registry.issueDevice({ name: 'x'.repeat(100) }).name.length, 64);
});

// ================================================================ 配对码

test('配对：createPairing 生成 6 位数字，文件只存 salt + hash', () => {
  const { file, clock, service } = newPairing({ ttlMs: 300_000 });
  const created = service.createPairing();

  assert.match(created.code, /^\d{6}$/);
  assert.equal(created.expiresAt, clock.value + 300_000);

  const onDisk = readJson(file);
  assert.equal(onDisk.pairing.length, 1);
  const entry = onDisk.pairing[0];
  assert.match(entry.id, /^pair_[0-9a-f]{8}$/);
  assert.equal(entry.code, undefined, '绝不能把明文 code 写盘');
  assert.equal(entry.hash, sha256(`${entry.salt}:${created.code}`));
  assert.ok(entry.salt && /^[0-9a-f]+$/.test(entry.salt));
  assert.equal(entry.attempts, 0);
});

test('配对：redeem 成功发设备 key，同一个码只能使用一次', () => {
  const { file, registry, service } = newPairing();
  const created = service.createPairing();

  const result = service.redeem(created.code, { name: '配对手机', ip: '192.168.1.9' });
  assert.equal(result.ok, true);
  assert.equal(result.device.name, '配对手机');
  assert.match(result.device.key, /^[0-9a-f]{64}$/);
  assert.equal(registry.verifyKey(result.device.key).ok, true);
  assert.deepEqual(readJson(file).pairing, []);
  assert.equal(readJson(file).devices.length, 1);
  assert.equal(readJson(file).devices[0].lastIp, '192.168.1.9');

  const reused = service.redeem(created.code, { name: '再来一次' });
  assert.equal(reused.ok, false);
  assert.equal(reused.reason, 'no-pairing');
  assert.equal(registry.listDevices().length, 1);
});

test('配对：数字类型 code 可按 6 位补零兑换', () => {
  const { service } = newPairing();
  const created = service.createPairing();
  const result = service.redeem(Number(created.code), { name: '数字输入' });
  assert.equal(result.ok, true);
  assert.match(result.device.key, /^[0-9a-f]{64}$/);
});

test('配对：过期码不可用，pruneExpired 清理', () => {
  const clock = makeClock();
  const { file, service } = newPairing({ clock, ttlMs: 1000 });
  const created = service.createPairing();

  clock.advance(1000);
  const result = service.redeem(created.code);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'expired');
  assert.deepEqual(readJson(file).pairing, []);
  assert.equal(service.pruneExpired(), 0);

  service.createPairing();
  clock.advance(2000);
  assert.equal(service.pruneExpired(), 1);
  assert.deepEqual(readJson(file).pairing, []);
});

test('配对：错码累计 attempts，达到 maxAttempts 立即作废', () => {
  const { file, registry, service } = newPairing({ maxAttempts: 5 });
  const created = service.createPairing();
  const wrong = wrongCode(created.code);

  for (let i = 0; i < 4; i++) {
    const result = service.redeem(wrong);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid-code');
  }
  assert.equal(readJson(file).pairing[0].attempts, 4);

  const fifth = service.redeem(wrong);
  assert.equal(fifth.ok, false);
  assert.equal(fifth.reason, 'max-attempts');
  assert.deepEqual(readJson(file).pairing, []);

  const correct = service.redeem(created.code);
  assert.equal(correct.ok, false);
  assert.equal(correct.reason, 'no-pairing');
  assert.equal(registry.listDevices().length, 0, '作废的码不能发出设备');
});

test('配对：格式非法的码不消耗尝试次数', () => {
  const { file, service } = newPairing();
  const created = service.createPairing();

  for (const bad of ['12345', 'abcdef', '', null]) {
    assert.equal(service.redeem(bad).reason, 'malformed');
  }
  assert.equal(readJson(file).pairing[0].attempts, 0);
  assert.equal(service.redeem(created.code, { name: '仍然可用' }).ok, true);
});

test('配对：独立文件模式与注册表分离', () => {
  const base = newRegistry();
  const pairingFile = path.join(base.dir, 'pairing.json');
  const service = security.createPairingService({
    registry: base.registry,
    file: pairingFile,
    now: base.clock.now,
  });

  const created = service.createPairing();
  assert.equal(base.registry.readPairing().length, 0, '独立文件模式不应写注册表的 pairing');
  assert.equal(readJson(pairingFile).version, security.SECURITY_VERSION);
  assert.equal(readJson(pairingFile).pairing.length, 1);

  const result = service.redeem(created.code, { name: '独立文件设备' });
  assert.equal(result.ok, true);
  assert.deepEqual(readJson(pairingFile).pairing, []);
  const registryOnDisk = readJson(base.file);
  assert.deepEqual(registryOnDisk.pairing, []);
  assert.equal(registryOnDisk.devices.length, 1);
  assert.equal(base.registry.verifyKey(result.device.key).ok, true);
});

test('配对：独立文件损坏时备份并继续', () => {
  const base = newRegistry();
  const pairingFile = path.join(base.dir, 'pairing.json');
  fs.writeFileSync(pairingFile, '{ broken pairing file', 'utf8');

  const service = security.createPairingService({
    registry: base.registry,
    file: pairingFile,
    now: base.clock.now,
  });
  const created = service.createPairing();
  assert.ok(service.backupFile && fs.existsSync(service.backupFile));
  assert.match(path.basename(service.backupFile), /\.bad-/);
  assert.equal(readJson(pairingFile).pairing.length, 1);
  assert.equal(service.redeem(created.code, { name: '恢复' }).ok, true);
});

test('配对：file 与注册表相同会被拒绝，避免覆盖 devices', () => {
  const base = newRegistry();
  assert.throws(() => security.createPairingService({
    registry: base.registry,
    file: base.file,
    now: base.clock.now,
  }), TypeError);
});

// ================================================================ 审计日志

test('审计：append 写入 JSONL，read 按从旧到新返回', () => {
  const clock = makeClock(3_000_000);
  const { file, log } = newAudit({ clock });

  log.append({
    event: AUDIT_EVENTS.AUTH_OK,
    deviceId: 'dev_abc',
    ip: '10.0.0.2',
    detail: '手机登录',
  });
  clock.advance(1000);
  log.append({ event: AUDIT_EVENTS.AUTH_FAIL, ip: '10.0.0.3' });

  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).event, 'auth_ok');
  assert.equal(JSON.parse(lines[1]).event, 'auth_fail');

  const entries = log.read();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].event, AUDIT_EVENTS.AUTH_OK);
  assert.equal(entries[0].deviceId, 'dev_abc');
  assert.equal(entries[0].ip, '10.0.0.2');
  assert.equal(entries[0].detail, '手机登录');
  assert.equal(entries[0].ts, new Date(3_000_000).toISOString());
  assert.equal(entries[1].event, AUDIT_EVENTS.AUTH_FAIL);
});

test('审计：detail 截断到 500 字符，设备/IP 字段也有限长', () => {
  const { log } = newAudit();
  const entry = log.append({
    event: AUDIT_EVENTS.AUTH_FAIL,
    deviceId: 'd'.repeat(100),
    ip: 'i'.repeat(100),
    detail: '中'.repeat(700),
  });

  assert.equal(entry.detail.length, security.DETAIL_MAX_CHARS);
  assert.equal(entry.deviceId.length, 64);
  assert.equal(entry.ip.length, 64);

  const [stored] = log.read();
  assert.equal(stored.detail.length, 500);
});

test('审计：read 跳过坏行与非对象行', () => {
  const { file, log } = newAudit();
  log.append({ event: AUDIT_EVENTS.AUTH_OK });
  fs.appendFileSync(file, '{ not json\n42\n[]\n{"event":123}\n{"event":"pair_create"}\n', 'utf8');

  const entries = log.read();
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((e) => e.event), ['auth_ok', 'pair_create']);
});

test('审计：read 的 limit 只取最近 N 条（跨轮转）', () => {
  const { log } = newAudit();
  for (let i = 0; i < 5; i++) log.append({ event: AUDIT_EVENTS.AUTH_OK, detail: `d${i}` });

  const lastTwo = log.read({ limit: 2 });
  assert.equal(lastTwo.length, 2);
  assert.deepEqual(lastTwo.map((e) => e.detail), ['d3', 'd4']);
  assert.deepEqual(log.read({ limit: 0 }), []);
});

test('审计：超过 maxBytes 轮转 file→.1→.2，丢弃更旧', () => {
  const { file, log } = newAudit({ maxBytes: 240, keepFiles: 2 });
  const details = [];
  for (let i = 0; i < 20; i++) {
    const detail = `event-${i}-${'x'.repeat(30)}`;
    details.push(detail);
    log.append({ event: AUDIT_EVENTS.AUTH_OK, detail });
  }

  assert.ok(fs.existsSync(`${file}.1`), '必须生成 .1');
  assert.ok(fs.existsSync(`${file}.2`), '必须生成 .2');
  assert.ok(!fs.existsSync(`${file}.3`), 'keepFiles=2 时不能生成 .3');
  assert.ok(fs.statSync(file).size <= 240, '当前文件不应超过 maxBytes');

  const oldLines = fs.readFileSync(`${file}.2`, 'utf8').trim().split('\n').filter(Boolean);
  assert.ok(oldLines.length > 0);
  assert.doesNotThrow(() => JSON.parse(oldLines[0]));

  const entries = log.read({ limit: 1000 });
  assert.ok(entries.length > 0);
  assert.ok(entries.length < details.length, '最旧的轮转文件应被丢弃');
  for (let i = 1; i < entries.length; i++) {
    assert.ok(entries[i - 1].ts <= entries[i].ts, 'read 必须按时间从旧到新');
  }
});

test('审计：文件不存在返回空，limit 非法时回落默认值', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'missing.log');
  const log = security.createAuditLog({ file, now: makeClock().now });
  assert.deepEqual(log.read(), []);
  assert.deepEqual(log.read({ limit: -5 }), []);
  assert.deepEqual(log.read({ limit: 2 }), []);
});

test('审计：缺 event 抛 TypeError；keepFiles=0 时不留备份', () => {
  const { file, log } = newAudit();
  assert.throws(() => log.append({}), TypeError);
  assert.throws(() => log.append({ event: '   ' }), TypeError);

  const noBackupFile = path.join(path.dirname(file), 'no-backup.log');
  const noBackup = security.createAuditLog({
    file: noBackupFile,
    now: makeClock().now,
    maxBytes: 80,
    keepFiles: 0,
  });
  for (let i = 0; i < 5; i++) noBackup.append({ event: AUDIT_EVENTS.AUTH_OK, detail: `d${i}` });
  assert.ok(!fs.existsSync(`${noBackupFile}.1`));
  assert.ok(fs.existsSync(noBackupFile));
});

test('审计：事件常量齐全，且没有手写漂移', () => {
  const expected = [
    'auth_ok',
    'auth_fail',
    'pair_create',
    'pair_redeem_fail',
    'pair_redeem_ok',
    'revoke',
    'rate_limited',
  ];
  assert.deepEqual(Object.values(AUDIT_EVENTS).sort(), expected.sort());
});

// ================================================================ 限流器

test('限流：容量耗尽后拒绝，retryAfterMs 给出等待时间', () => {
  const { limiter } = newRateLimiter({ capacity: 3, refillPerSec: 1 });
  assert.equal(limiter.take('ip-1'), true);
  assert.equal(limiter.take('ip-1'), true);
  assert.equal(limiter.take('ip-1'), true);
  assert.equal(limiter.take('ip-1'), false);
  assert.equal(limiter.retryAfterMs('ip-1'), 1000);
  assert.equal(limiter.retryAfterMs('other-key'), 0);
});

test('限流：按注入时间连续补充令牌', () => {
  const { clock, limiter } = newRateLimiter({ capacity: 3, refillPerSec: 1 });
  for (let i = 0; i < 3; i++) assert.equal(limiter.take('ip'), true);

  clock.advance(500);
  assert.equal(limiter.retryAfterMs('ip'), 500);
  assert.equal(limiter.take('ip'), false);

  clock.advance(500);
  assert.equal(limiter.take('ip'), true);

  clock.advance(10_000);
  assert.equal(limiter.take('ip'), true);
  assert.equal(limiter.take('ip'), true);
  assert.equal(limiter.take('ip'), true);
  assert.equal(limiter.take('ip'), false, '补充后不能超过容量');
});

test('限流：支持小数补充速率', () => {
  const { clock, limiter } = newRateLimiter({ capacity: 2, refillPerSec: 0.5 });
  assert.equal(limiter.take('k'), true);
  assert.equal(limiter.take('k'), true);
  assert.equal(limiter.take('k'), false);
  assert.equal(limiter.retryAfterMs('k'), 2000);

  clock.advance(1000);
  assert.equal(limiter.retryAfterMs('k'), 1000);
  assert.equal(limiter.take('k'), false);

  clock.advance(1000);
  assert.equal(limiter.take('k'), true);
});

test('限流：forget 清掉桶后重新满容量', () => {
  const { limiter } = newRateLimiter({ capacity: 1, refillPerSec: 1 });
  assert.equal(limiter.take('k'), true);
  assert.equal(limiter.take('k'), false);
  assert.equal(limiter.forget('k'), true);
  assert.equal(limiter.take('k'), true);
  assert.equal(limiter.forget('k'), true);
  assert.equal(limiter.forget('k'), false);
});

test('限流：超过 maxKeys 按 LRU 清理最久未访问的键', () => {
  const { limiter } = newRateLimiter({ capacity: 1, refillPerSec: 1, maxKeys: 2 });
  assert.equal(limiter.take('a'), true);
  assert.equal(limiter.take('b'), true);

  // retryAfterMs 也算访问：a 被移到队尾，b 变成最旧。
  assert.equal(limiter.retryAfterMs('a'), 1000);
  assert.equal(limiter.take('c'), true);

  assert.equal(limiter.size(), 2);
  assert.equal(limiter.retryAfterMs('b'), 0, '最旧的 b 应被清理');
  assert.equal(limiter.retryAfterMs('a'), 1000, '刚访问过的 a 应保留');
});

test('限流：非法 key 不占内存，超长 key 会被截断', () => {
  const { limiter } = newRateLimiter({ capacity: 1, refillPerSec: 1 });
  assert.equal(limiter.take(null), false);
  assert.equal(limiter.take(''), false);
  assert.equal(limiter.retryAfterMs(undefined), 0);
  assert.equal(limiter.forget(null), false);
  assert.equal(limiter.size(), 0);

  const longA = 'x'.repeat(500);
  const longB = 'x'.repeat(256) + 'tail-different';
  assert.equal(limiter.take(longA), true);
  assert.equal(limiter.take(longB), false, '前 256 字符相同则视为同一个桶');
});
