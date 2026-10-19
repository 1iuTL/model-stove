// 设置层（src/core/settings.js）的单元测试。
//
// 重点验证：版本迁移、非法值回落、坏文件备份、原子写不留半截文件。
// 全部在临时目录里跑。
//
// 跑法：node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const settings = require('../src/core/settings.js');

const tmpRoots = [];
function tmpDir(prefix = 'model-stove-settings-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}
function settingsFile() {
  return path.join(tmpDir(), 'settings.json');
}
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
test.after(() => {
  for (const dir of tmpRoots) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

// ---------------------------------------------------------------- 默认值

test('文件不存在 → 默认值，existed=false', () => {
  const res = settings.loadSettings(path.join(tmpDir(), 'settings.json'));
  assert.equal(res.existed, false);
  assert.deepEqual(res.settings, settings.DEFAULT_SETTINGS);
  assert.deepEqual(res.warnings, []);
});

test('默认值本身合法：normalize(默认值) 不再产生 warning', () => {
  const res = settings.normalize(settings.DEFAULT_SETTINGS);
  assert.deepEqual(res.warnings, []);
  assert.equal(res.settings.version, settings.SCHEMA_VERSION);
  assert.deepEqual(res.settings, settings.DEFAULT_SETTINGS);
});

// ---------------------------------------------------------------- 读写往返

test('save → load 往返，文件里带版本号', () => {
  const file = settingsFile();
  settings.saveSettings(file, { ...settings.DEFAULT_SETTINGS, apiKey: 'abc123' });
  const onDisk = readJson(file);
  assert.equal(onDisk.version, settings.SCHEMA_VERSION);

  const loaded = settings.loadSettings(file);
  assert.equal(loaded.existed, true);
  assert.equal(loaded.settings.apiKey, 'abc123');
  assert.equal(loaded.migratedFrom, null);
  assert.equal(loaded.wroteBack, false);
});

test('updateSettings：只覆盖 patch 里的键', () => {
  const file = settingsFile();
  settings.saveSettings(file, settings.DEFAULT_SETTINGS);
  const res = settings.updateSettings(file, { apiKey: 'k-1', probe: false });
  assert.equal(res.settings.apiKey, 'k-1');
  assert.equal(res.settings.probe, false);
  assert.equal(res.settings.keepServerOnClose, true, '未传的键保持原值');
  assert.equal(readJson(file).apiKey, 'k-1');
});

// ---------------------------------------------------------------- 迁移

test('迁移：未带 version 的旧文件按 v1 读入并写回 v2', () => {
  const file = settingsFile();
  fs.writeFileSync(file, JSON.stringify({ apiKey: '  legacy-key  ', probe: false, lanMode: true }), 'utf8');

  const res = settings.loadSettings(file);
  assert.equal(res.migratedFrom, 1);
  assert.equal(res.wroteBack, true);
  assert.equal(res.settings.version, settings.SCHEMA_VERSION);
  assert.equal(res.settings.apiKey, 'legacy-key', 'apiKey 应去掉首尾空白');
  assert.equal(res.settings.probe, false);
  assert.equal(res.settings.lanMode, true);
  assert.equal(res.settings.accessMode, 'local', '新字段用默认值');

  const onDisk = readJson(file);
  assert.equal(onDisk.version, 2, '迁移结果必须落盘');
  assert.equal(onDisk.apiKey, 'legacy-key');
});

test('迁移：persist=false 时只读不写回', () => {
  const file = settingsFile();
  const legacy = JSON.stringify({ apiKey: 'k' });
  fs.writeFileSync(file, legacy, 'utf8');
  const res = settings.loadSettings(file, { persist: false });
  assert.equal(res.migratedFrom, 1);
  assert.equal(res.wroteBack, false);
  assert.equal(fs.readFileSync(file, 'utf8'), legacy);
});

test('未来版本：不降级、不丢字段，只提示', () => {
  const file = settingsFile();
  fs.writeFileSync(file, JSON.stringify({ version: 99, apiKey: 'k', futureField: { a: 1 } }), 'utf8');
  const res = settings.loadSettings(file);
  assert.equal(res.settings.version, 99);
  assert.equal(res.settings.apiKey, 'k');
  assert.deepEqual(res.settings.futureField, { a: 1 });
  assert.ok(res.warnings.some((w) => String(w.reason).startsWith('newer-version')));
  assert.equal(res.wroteBack, false, '未来版本不写回');
});

// ---------------------------------------------------------------- 校验

test('非法类型回落到默认值，并给出 warning', () => {
  const file = settingsFile();
  fs.writeFileSync(file, JSON.stringify({
    version: 2,
    apiKey: 12345,
    probe: 'yes',
    lanMode: 'no',
    keepServerOnClose: 0,
    lastModelId: 7,
    accessMode: 'public',
  }), 'utf8');
  const res = settings.loadSettings(file);
  assert.equal(res.settings.apiKey, '');
  assert.equal(res.settings.probe, true);
  assert.equal(res.settings.lanMode, false);
  assert.equal(res.settings.keepServerOnClose, true);
  assert.equal(res.settings.lastModelId, null);
  assert.equal(res.settings.accessMode, 'local');

  const keys = res.warnings.map((w) => w.key);
  assert.ok(keys.includes('apiKey'));
  assert.ok(keys.includes('probe'));
  assert.ok(keys.includes('accessMode'));
});

test('未知字段原样保留（向前兼容）', () => {
  const file = settingsFile();
  fs.writeFileSync(file, JSON.stringify({ version: 2, customThing: { a: 1 }, apiKey: 'k' }), 'utf8');
  const res = settings.loadSettings(file);
  assert.deepEqual(res.settings.customThing, { a: 1 });
});

// ---------------------------------------------------------------- 坏文件

test('坏 JSON → 备份坏文件 + 回落默认值 + warning', () => {
  const file = settingsFile();
  fs.writeFileSync(file, '{ this is not json', 'utf8');
  const res = settings.loadSettings(file);
  assert.equal(res.existed, true);
  assert.deepEqual(res.settings, settings.DEFAULT_SETTINGS);
  assert.ok(res.warnings.some((w) => w.reason === 'corrupt-json'));
  assert.ok(res.backupFile && fs.existsSync(res.backupFile), '坏文件必须留档');
  assert.ok(!fs.existsSync(file), '坏文件应被移走，避免下次继续报错');
  assert.equal(fs.readFileSync(res.backupFile, 'utf8'), '{ this is not json');
});

// ---------------------------------------------------------------- 原子写

test('原子写：不留下临时文件，且结果可被解析', () => {
  const file = settingsFile();
  settings.saveSettings(file, settings.DEFAULT_SETTINGS);
  settings.updateSettings(file, { apiKey: 'k-2' });
  const leftovers = fs.readdirSync(path.dirname(file)).filter((n) => n.includes('.tmp-'));
  assert.deepEqual(leftovers, []);
  assert.equal(readJson(file).apiKey, 'k-2');
});

test('原子写：rename 失败时抛错并清掉临时文件', () => {
  const file = settingsFile();
  const brokenFs = Object.assign({}, fs, {
    renameSync: () => { throw Object.assign(new Error('EACCES: rename denied'), { code: 'EACCES' }); },
  });
  assert.throws(() => settings.saveSettings(file, settings.DEFAULT_SETTINGS, { fs: brokenFs }), /rename denied/);
  assert.ok(!fs.existsSync(file));
  const leftovers = fs.readdirSync(path.dirname(file)).filter((n) => n.includes('.tmp-'));
  assert.deepEqual(leftovers, []);
});

test('写出的设置总是被规范化（patch 里的非法值不会落盘）', () => {
  const file = settingsFile();
  settings.saveSettings(file, { apiKey: 42, probe: 'x' });
  const onDisk = readJson(file);
  assert.equal(onDisk.apiKey, '');
  assert.equal(onDisk.probe, true);
  assert.equal(onDisk.version, settings.SCHEMA_VERSION);
});

// ---------------------------------------------------------------- API Key

test('generateApiKey：32 位十六进制且不重复', () => {
  const keys = new Set();
  for (let i = 0; i < 100; i++) {
    const key = settings.generateApiKey();
    assert.match(key, /^[0-9a-f]{32}$/);
    keys.add(key);
  }
  assert.equal(keys.size, 100);
});
