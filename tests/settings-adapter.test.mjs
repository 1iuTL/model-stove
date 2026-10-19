// src/settings.js 薄适配层的测试。
//
// 这一层的价值不是"又包了一层"，而是保证两件事：
//   1. 旧版 `<userData>/settings.json` 里的 API Key / 局域网开关不会因为
//      换到 core/settings.js 而丢失（自动迁移成 v2）；
//   2. main.js 继续用 initSettings()/readSettings()/writeSettings()/
//      generateApiKey() 这四个旧接口，不需要在业务代码里感知 schema 变化。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const settings = require('../src/settings.js');
const core = require('../src/core/settings.js');

const tmpRoots = [];
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-stove-adapter-'));
  tmpRoots.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of tmpRoots) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('initSettings(userData) 指向 userData/settings.json（和旧版位置一致）', () => {
  const dir = tmpDir();
  assert.equal(settings.initSettings(dir), path.join(dir, 'settings.json'));
  assert.equal(settings.currentFile(), path.join(dir, 'settings.json'));
});

test('initSettingsFile(paths.settingsFile) 直接用 core 的路径', () => {
  const file = path.join(tmpDir(), 'custom', 'settings.json');
  settings.initSettingsFile(file);
  assert.equal(settings.currentFile(), file);
});

test('旧版设置文件自动迁移成 v2，字段不丢', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
    apiKey: 'legacy-key-0123456789',
    lanMode: true,
    probe: false,
    lastModelId: 'onbit',
  }), 'utf8');

  settings.initSettings(dir);
  const s = settings.readSettings();
  assert.equal(s.version, core.SCHEMA_VERSION);
  assert.equal(s.apiKey, 'legacy-key-0123456789');
  assert.equal(s.lanMode, true);
  assert.equal(s.probe, false);
  assert.equal(s.lastModelId, 'onbit');
  // 迁移应写回磁盘（而不是每次读都重新迁移）
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.equal(onDisk.version, core.SCHEMA_VERSION);
});

test('坏 JSON 被备份，读取回落到默认值而不是抛错', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'settings.json'), '{ not json', 'utf8');
  settings.initSettings(dir);
  const s = settings.readSettings();
  assert.equal(s.apiKey, '');
  assert.equal(s.lanMode, false);
  const files = fs.readdirSync(dir);
  assert.ok(files.some((f) => f.includes('.bad-')), files.join(','));
});

test('writeSettings 只覆盖传进来的键，并保持原子写', () => {
  const dir = tmpDir();
  settings.initSettings(dir);
  fs.writeFileSync(path.join(dir, 'settings.json'),
    JSON.stringify({ version: 2, apiKey: 'keep-me', probe: false }), 'utf8');

  const next = settings.writeSettings({ lastPreset: 'text-32k' });
  assert.equal(next.apiKey, 'keep-me');
  assert.equal(next.probe, false);
  assert.equal(next.lastPreset, 'text-32k');
  // 不应该留下临时文件（原子写会在 rename 后消失）
  assert.ok(!fs.readdirSync(dir).some((f) => f.includes('.tmp-')), fs.readdirSync(dir).join(','));
});

test('generateApiKey 是 32 位十六进制', () => {
  const key = settings.generateApiKey();
  assert.match(key, /^[0-9a-f]{32}$/);
  assert.notEqual(key, settings.generateApiKey());
});
