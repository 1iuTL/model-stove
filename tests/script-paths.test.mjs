// 外部进程脚本路径解析（src/core/script-paths.js）的单元测试。
//
// 重点验证明明是同一份代码，在源码运行与打包后（asar）分别落到
// `resources\app.asar` 和 `resources\app.asar.unpacked`。
//
// 跑法：node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveScriptRoot, resolveScriptPath } = require('../src/core/script-paths.js');

// ------------------------------------------------------------ resolveScriptRoot

test('resolveScriptRoot：未打包时返回 repoRoot 本身', () => {
  const root = path.join('C:\\', 'repo', 'model-stove');
  assert.equal(resolveScriptRoot({ repoRoot: root, isPackaged: false }), root);
  assert.equal(resolveScriptRoot({ repoRoot: root }), root);
});

test('resolveScriptRoot：isPackaged=true 时追加 .unpacked', () => {
  const root = path.join('C:\\', 'Program Files', 'Model Stove', 'resources', 'app.asar');
  assert.equal(
    resolveScriptRoot({ repoRoot: root, isPackaged: true }),
    `${root}.unpacked`,
  );
});

test('resolveScriptRoot：即使没有 app.asar 后缀，isPackaged=true 也按打包处理', () => {
  const root = path.join('C:\\', 'Program Files', 'Model Stove', 'app');
  assert.equal(resolveScriptRoot({ repoRoot: root, isPackaged: true }), `${root}.unpacked`);
});

test('resolveScriptRoot：拿不到 isPackaged 时用 app.asar 后缀兜底', () => {
  const root = path.join('C:\\', 'repo', 'dist', 'win-unpacked', 'resources', 'app.asar');
  assert.equal(resolveScriptRoot({ repoRoot: root }), `${root}.unpacked`);
  assert.equal(resolveScriptRoot({ repoRoot: root, isPackaged: undefined }), `${root}.unpacked`);
});

test('resolveScriptRoot：app.asar 后缀不区分大小写，且容忍末尾分隔符', () => {
  const base = path.join('C:\\', 'repo', 'resources', 'APP.ASAR');
  assert.equal(resolveScriptRoot({ repoRoot: base, isPackaged: false }), `${base}.unpacked`);
  assert.equal(
    resolveScriptRoot({ repoRoot: `${base}${path.sep}`, isPackaged: false }),
    `${base}.unpacked`,
  );
});

test('resolveScriptRoot：只认 app.asar 后缀，不误伤相似的目录名', () => {
  for (const root of [
    path.join('C:\\', 'repo', 'app.asar2'),
    path.join('C:\\', 'repo', 'my-app.asar.bak'),
    path.join('C:\\', 'repo', 'asar'),
  ]) {
    assert.equal(resolveScriptRoot({ repoRoot: root, isPackaged: false }), root);
  }
});

// ------------------------------------------------------------ resolveScriptPath

test('resolveScriptPath：未打包时拼在 repoRoot 下', () => {
  const root = path.join('C:\\', 'repo', 'model-stove');
  assert.equal(
    resolveScriptPath({ repoRoot: root, isPackaged: false, relative: 'context-proxy.mjs' }),
    path.join(root, 'context-proxy.mjs'),
  );
});

test('resolveScriptPath：打包后拼在 app.asar.unpacked 下（Windows 路径）', () => {
  const root = path.join('C:\\', 'Program Files', 'Model Stove', 'resources', 'app.asar');
  const unpacked = `${root}.unpacked`;
  assert.equal(
    resolveScriptPath({ repoRoot: root, isPackaged: true, relative: 'context-proxy.mjs' }),
    path.join(unpacked, 'context-proxy.mjs'),
  );
  assert.equal(
    resolveScriptPath({ repoRoot: root, isPackaged: true, relative: path.join('tools', 'allow-lan.ps1') }),
    path.join(unpacked, 'tools', 'allow-lan.ps1'),
  );
});

test('resolveScriptPath：relative 里的正斜杠按平台规范归一化', () => {
  const root = path.join('C:\\', 'repo', 'resources', 'app.asar');
  assert.equal(
    resolveScriptPath({ repoRoot: root, isPackaged: true, relative: 'src/core/script-paths.js' }),
    path.join(`${root}.unpacked`, 'src', 'core', 'script-paths.js'),
  );
});

test('resolveScriptPath：不修改传入的 repoRoot 字符串', () => {
  const root = path.join('C:\\', 'repo', 'resources', 'app.asar');
  const before = String(root);
  resolveScriptPath({ repoRoot: root, isPackaged: true, relative: 'ui-inject.mjs' });
  assert.equal(root, before);
});
