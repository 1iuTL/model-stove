// 构建能力探测（src/core/capabilities.js）的单元测试。
//
// 全部用注入的 execFileSync，不依赖真实 llama-server / GPU / 模型：
// 假命令把 --version / --help 的输出写进探测层打开的临时文件 fd，
// 正好也验证“stdio 走文件、不走管道”的实现方式。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const caps = require('../src/core/capabilities.js');

const tmpRoots = [];
function tmpDir(prefix = 'model-stove-caps-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of tmpRoots) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function writeExe(dir, content = 'fake llama-server') {
  const file = path.join(dir, 'llama-server.exe');
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

/**
 * 造一个假 execFileSync：按第一个参数（--version / --help）返回对应输出。
 * 输出写进 opts.stdio[1]（真实实现就是这样接文件的），并返回同一段文本。
 */
function fakeExec(outputs, calls = []) {
  return (exe, args, opts) => {
    calls.push(args[0]);
    const out = outputs[args[0]];
    if (out instanceof Error) throw out;
    if (out == null) {
      throw Object.assign(new Error(`未预置的输出: ${args[0]}`), { code: 'ENOENT' });
    }
    if (opts && Array.isArray(opts.stdio) && opts.stdio[1] != null) {
      fs.writeSync(opts.stdio[1], out);
    }
    return out;
  };
}

const HELP_FULL = `
usage: llama-server [options]

 -m, --model PATH              model path
 -c, --ctx-size N              context size
 -ngl, --n-gpu-layers N        layers offload
 -np, --parallel N             slots
 -fa, --flash-attn [on|off|auto]
 -ctk, --cache-type-k TYPE
 -ctv, --cache-type-v TYPE
 --jinja
 --host HOST
 --port PORT
 --reasoning-budget N
 --no-mmproj-offload
`;

// ---------------------------------------------------------------- 版本解析

test('parseVersionText：支持 "version: 0.0.0 (build: b1234)"', () => {
  const r = caps.parseVersionText('llama-server version: 0.0.0 (build: b1234)');
  assert.equal(r.version, '0.0.0');
  assert.equal(r.build, 1234);
});

test('parseVersionText：支持 "llama-server version 1234 (abc)"', () => {
  const r = caps.parseVersionText('llama-server version 1234 (abc)');
  assert.equal(r.build, 1234);
});

test('parseVersionText：semver 与 build 各自独立解析', () => {
  const r = caps.parseVersionText('llama-server 0.0.0 (build 777, commit deadbeef)');
  assert.equal(r.version, '0.0.0');
  assert.equal(r.build, 777);
});

test('parseVersionText：没有 build 号时返回 null', () => {
  const r = caps.parseVersionText('llama-server version 0.0.0');
  assert.equal(r.version, '0.0.0');
  assert.equal(r.build, null);
});

test('parseVersionText：允许 v 前缀（node --version 风格）', () => {
  assert.equal(caps.parseVersionText('v24.22.0').version, '24.22.0');
});

// ---------------------------------------------------------------- flag 提取

test('extractFlags：长短参数都提取，且支持 -fa/-ngl 这类多字母短参数', () => {
  const flags = caps.extractFlags(HELP_FULL);
  for (const f of ['-m', '--model', '-c', '--ctx-size', '-ngl', '--n-gpu-layers',
    '-np', '--parallel', '-fa', '--flash-attn', '-ctk', '--cache-type-k',
    '--host', '--port', '--jinja', '--no-mmproj-offload']) {
    assert.ok(flags.has(f), `缺少 ${f}`);
  }
  // 长参数不能被拆成 -m / -c 这种短参数来源之外的碎片
  assert.ok(!flags.has('--m'));
  assert.ok(!flags.has('-f'));
});

// ---------------------------------------------------------------- 探测结果

test('probeBuild：正常构建 → ok、version、build、flags 齐全', () => {
  const dir = tmpDir();
  const exe = writeExe(dir);
  const result = caps.probeBuild(exe, {
    execFileSync: fakeExec({
      '--version': 'llama-server version: 0.0.0 (build: b1234)\n',
      '--help': HELP_FULL,
    }),
    tmpDir: path.join(dir, 'probe'),
    now: () => Date.UTC(2026, 9, 19, 4, 0, 0),
  });
  assert.equal(result.ok, true);
  assert.equal(result.version, '0.0.0');
  assert.equal(result.build, 1234);
  assert.ok(result.flags instanceof Set);
  assert.ok(result.flags.has('-fa'));
  assert.equal(result.error, null);
  assert.equal(result.probedAt, '2026-10-19T04:00:00.000Z');
  assert.equal(result.exe, path.resolve(exe));
});

test('probeBuild：--help 失败但 --version 成功 → ok:false（没法门控）且不抛', () => {
  const dir = tmpDir();
  const exe = writeExe(dir);
  const result = caps.probeBuild(exe, {
    execFileSync: fakeExec({
      '--version': 'llama-server version 0.0.0\n',
      '--help': Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }),
    }),
    tmpDir: path.join(dir, 'probe'),
  });
  assert.equal(result.ok, false);
  assert.equal(result.flags.size, 0);
  assert.match(result.error, /EACCES|--help/);
});

test('probeBuild：版本只从 --version 解析，不会被 help 里的 127.0.0.1 带偏', () => {
  const dir = tmpDir();
  const exe = writeExe(dir);
  const result = caps.probeBuild(exe, {
    execFileSync: fakeExec({
      '--version': 'v24.22.0\n',
      '--help': 'usage: server\n --host HOST (default: 127.0.0.1)\n -m, --model PATH\n',
    }),
    tmpDir: path.join(dir, 'probe'),
  });
  assert.equal(result.ok, true);
  assert.equal(result.version, '24.22.0');
  assert.equal(result.build, null);
});

test('probeBuild：--version 没有版本号时才从 help 的 version 行兜底', () => {
  const dir = tmpDir();
  const exe = writeExe(dir);
  const result = caps.probeBuild(exe, {
    execFileSync: fakeExec({
      '--version': '',
      '--help': 'llama-server version: 1.2.3 (build: b9)\n --host HOST (default: 127.0.0.1)\n',
    }),
    tmpDir: path.join(dir, 'probe'),
  });
  assert.equal(result.version, '1.2.3');
  assert.equal(result.build, 9);
});

test('probeBuild：探测失败仍返回完整结构，supports 走兼容模式', () => {
  const dir = tmpDir();
  const exe = writeExe(dir);
  const result = caps.probeBuild(exe, {
    execFileSync: () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); },
    tmpDir: path.join(dir, 'probe'),
  });
  assert.equal(result.ok, false);
  assert.equal(result.version, null);
  assert.equal(result.build, null);
  assert.equal(result.flags.size, 0);
  assert.ok(result.error);
  assert.equal(caps.supports(result, '-fa'), true);
  assert.equal(caps.supports(result, '--not-a-real-flag'), true);
  assert.equal(caps.supports(null, '-fa'), true);
  assert.deepEqual(caps.missingRequired(result), []);
});

test('probeBuild：临时输出文件用完即删', () => {
  const dir = tmpDir();
  const exe = writeExe(dir);
  const probeTmp = path.join(dir, 'probe');
  caps.probeBuild(exe, {
    execFileSync: fakeExec({
      '--version': 'llama-server version 0.0.0\n',
      '--help': HELP_FULL,
    }),
    tmpDir: probeTmp,
  });
  assert.deepEqual(fs.readdirSync(probeTmp), []);
});

// ---------------------------------------------------------------- supports

test('supports：已知能力按 flags 判断', () => {
  const c = { ok: true, flags: new Set(['-fa', '--jinja']) };
  assert.equal(caps.supports(c, '-fa'), true);
  assert.equal(caps.supports(c, '--jinja'), true);
  assert.equal(caps.supports(c, '-ctk'), false);
  // 兼容模式：未知/失败一律 true
  assert.equal(caps.supports({ ok: false, flags: new Set(['-fa']) }, '-ctk'), true);
  assert.equal(caps.supports({ ok: true }, '-ctk'), true);
});

// ---------------------------------------------------------------- 核心参数

test('missingRequired：缺 -m 时明确列出', () => {
  const flags = new Set(['-c', '-ngl', '-np', '--host', '--port']);
  assert.deepEqual(caps.missingRequired({ ok: true, flags }), ['-m']);
});

test('missingRequired：只有长别名时也算存在（不同构建排版不同）', () => {
  const flags = new Set([
    '--model', '--ctx-size', '--n-gpu-layers', '--parallel', '--host', '--port',
  ]);
  assert.deepEqual(caps.missingRequired({ ok: true, flags }), []);
  assert.equal(caps.supportsRequired({ ok: true, flags }, '-m'), true);
});

test('missingRequired：全都没有时返回完整列表', () => {
  assert.deepEqual(
    caps.missingRequired({ ok: true, flags: new Set() }),
    ['-m', '-c', '-ngl', '-np', '--host', '--port'],
  );
});

// ---------------------------------------------------------------- 缓存

test('缓存：命中时不再执行探测', () => {
  const dir = tmpDir();
  const exe = writeExe(dir);
  const cacheFile = path.join(dir, 'cache', 'capabilities.json');
  const calls = [];
  const first = caps.loadCapabilities(exe, {
    cacheFile,
    execFileSync: fakeExec({
      '--version': 'llama-server version: 0.0.0 (build: b1)\n',
      '--help': HELP_FULL,
    }, calls),
    tmpDir: path.join(dir, 'probe'),
  });
  assert.equal(first.ok, true);
  assert.deepEqual(calls, ['--version', '--help']);
  assert.ok(fs.existsSync(cacheFile));

  const second = caps.loadCapabilities(exe, {
    cacheFile,
    execFileSync: () => { throw new Error('命中缓存时不该再探测'); },
    tmpDir: path.join(dir, 'probe'),
  });
  assert.equal(second.ok, true);
  assert.equal(second.build, 1);
  assert.ok(second.flags.has('-fa'));
  // 缓存目录里不应残留临时文件
  assert.ok(fs.readdirSync(path.dirname(cacheFile)).every((f) => !f.includes('.tmp-')));
});

test('缓存：可执行文件 mtime/size 变化后失效', () => {
  const dir = tmpDir();
  const exe = writeExe(dir, 'aaaa');
  const cacheFile = path.join(dir, 'cache', 'capabilities.json');
  const outputs = {
    '--version': 'llama-server version: 0.0.0 (build: b1)\n',
    '--help': HELP_FULL,
  };
  let calls = 0;
  const exec = (e, args, opts) => { calls++; return fakeExec(outputs)(e, args, opts); };
  caps.loadCapabilities(exe, { cacheFile, execFileSync: exec, tmpDir: path.join(dir, 'probe') });
  assert.equal(calls, 2);

  fs.writeFileSync(exe, 'bbbbbbbb', 'utf8'); // size 变了
  fs.utimesSync(exe, new Date(), new Date(Date.now() + 3000));
  calls = 0;
  caps.loadCapabilities(exe, { cacheFile, execFileSync: exec, tmpDir: path.join(dir, 'probe') });
  assert.equal(calls, 2, '文件变了必须重新探测');
});

test('缓存：坏 JSON 会被重建', () => {
  const dir = tmpDir();
  const exe = writeExe(dir);
  const cacheFile = path.join(dir, 'cache', 'capabilities.json');
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, '{ this is not json', 'utf8');
  let calls = 0;
  const result = caps.loadCapabilities(exe, {
    cacheFile,
    execFileSync: (e, args, opts) => {
      calls++;
      return fakeExec({ '--version': 'llama-server version 0.0.0\n', '--help': HELP_FULL })(e, args, opts);
    },
    tmpDir: path.join(dir, 'probe'),
  });
  assert.equal(result.ok, true);
  assert.equal(calls, 2);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(cacheFile, 'utf8')));
});

test('缓存：版本号不匹配会被整体重建', () => {
  const dir = tmpDir();
  const exe = writeExe(dir);
  const cacheFile = path.join(dir, 'cache', 'capabilities.json');
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify({ version: 999, entries: {} }), 'utf8');
  let calls = 0;
  caps.loadCapabilities(exe, {
    cacheFile,
    execFileSync: (e, args, opts) => {
      calls++;
      return fakeExec({ '--version': 'llama-server version 0.0.0\n', '--help': HELP_FULL })(e, args, opts);
    },
    tmpDir: path.join(dir, 'probe'),
  });
  assert.equal(calls, 2);
  const written = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  assert.equal(written.version, caps.CACHE_VERSION);
});

test('缓存：MODEL_STOVE_CAPS_CACHE=0 时禁用', () => {
  const dir = tmpDir();
  const exe = writeExe(dir);
  const cacheFile = path.join(dir, 'cache', 'capabilities.json');
  const old = process.env.MODEL_STOVE_CAPS_CACHE;
  process.env.MODEL_STOVE_CAPS_CACHE = '0';
  try {
    let calls = 0;
    const exec = (e, args, opts) => {
      calls++;
      return fakeExec({ '--version': 'llama-server version 0.0.0\n', '--help': HELP_FULL })(e, args, opts);
    };
    caps.loadCapabilities(exe, { cacheFile, execFileSync: exec, tmpDir: path.join(dir, 'probe') });
    caps.loadCapabilities(exe, { cacheFile, execFileSync: exec, tmpDir: path.join(dir, 'probe') });
    assert.equal(calls, 4);
    assert.equal(fs.existsSync(cacheFile), false);
  } finally {
    if (old === undefined) delete process.env.MODEL_STOVE_CAPS_CACHE;
    else process.env.MODEL_STOVE_CAPS_CACHE = old;
  }
});

test('缓存：options.cache=false 时禁用', () => {
  const dir = tmpDir();
  const exe = writeExe(dir);
  const cacheFile = path.join(dir, 'cache', 'capabilities.json');
  let calls = 0;
  const exec = (e, args, opts) => {
    calls++;
    return fakeExec({ '--version': 'llama-server version 0.0.0\n', '--help': HELP_FULL })(e, args, opts);
  };
  caps.loadCapabilities(exe, {
    cache: false, cacheFile, execFileSync: exec, tmpDir: path.join(dir, 'probe'),
  });
  caps.loadCapabilities(exe, {
    cache: false, cacheFile, execFileSync: exec, tmpDir: path.join(dir, 'probe'),
  });
  assert.equal(calls, 4);
  assert.equal(fs.existsSync(cacheFile), false);
});

test('缓存：探测失败也会落盘，下次直接走兼容模式', () => {
  const dir = tmpDir();
  const exe = writeExe(dir);
  const cacheFile = path.join(dir, 'cache', 'capabilities.json');
  let calls = 0;
  const exec = () => {
    calls++;
    throw Object.assign(new Error('boom'), { code: 'EACCES' });
  };
  const first = caps.loadCapabilities(exe, {
    cacheFile, execFileSync: exec, tmpDir: path.join(dir, 'probe'),
  });
  assert.equal(first.ok, false);
  assert.equal(calls, 2);
  const second = caps.loadCapabilities(exe, {
    cacheFile,
    execFileSync: () => { throw new Error('不该再探测'); },
    tmpDir: path.join(dir, 'probe'),
  });
  assert.equal(second.ok, false);
  assert.match(second.error, /EACCES|boom/);
});
