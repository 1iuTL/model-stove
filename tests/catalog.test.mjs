// 模型目录层测试（src/core/catalog.js）。
//
// 全部在临时目录里造合成 GGUF；真实模型目录的那一条用 fs.existsSync 条件跳过。
// 不读写生产目录，不依赖 electron / 第三方库。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const catalog = require('../src/core/catalog.js');
const cfg = require('../src/config.js');

const REAL_DIR = 'D:\\Qwen3.8-35B-A3B-Distill-Abl';
const REAL_MODEL = path.join(REAL_DIR, 'Qwen3.8-35B-A3B-Distill.APEX-I-MiniPlus-V2.1-Abliterated.gguf');
const REAL_MMPROJ = path.join(REAL_DIR, 'mmproj-Q8_0.gguf');

const tmpDirs = [];
function tmpDir(prefix = 'model-stove-catalog-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ------------------------------------------------------------ 合成 GGUF

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(Number(n) >>> 0);
  return b;
}
function u64(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}
function strBuf(text) {
  const raw = Buffer.from(String(text), 'utf8');
  return Buffer.concat([u64(raw.length), raw]);
}
function kvString(key, value) {
  return Buffer.concat([strBuf(key), u32(8), strBuf(value)]);
}
function kvU32(key, value) {
  return Buffer.concat([strBuf(key), u32(4), u32(value)]);
}
function buildGguf({ arch = 'qwen35moe', ctx = 32768, blocks = 40, experts = [16, 4], template = 'plain template' } = {}) {
  const values = [
    kvString('general.architecture', arch),
    kvU32(`${arch}.context_length`, ctx),
    kvU32(`${arch}.block_count`, blocks),
    kvU32(`${arch}.embedding_length`, 2048),
    kvU32(`${arch}.attention.head_count`, 16),
    kvU32(`${arch}.attention.head_count_kv`, 2),
    kvU32(`${arch}.expert_count`, experts[0]),
    kvU32(`${arch}.expert_used_count`, experts[1]),
    kvString('tokenizer.chat_template', template),
  ];
  const parts = [
    Buffer.from('GGUF', 'latin1'), u32(3), u64(733), u64(values.length),
    ...values,
  ];
  return Buffer.concat(parts);
}
function writeModel(file, options) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buildGguf(options));
  return file;
}
function writeBad(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from('not a gguf'));
  return file;
}

function namesOf(entries) {
  return entries.map((e) => e.name).sort();
}

// ------------------------------------------------------------ 扫描

test('scanModelRoots：深度 3、忽略 hidden/.parts/.tmp/*.part、mmproj 不作为模型', () => {
  const root = tmpDir();
  writeModel(path.join(root, 'a.gguf'), { ctx: 8192 });
  fs.writeFileSync(path.join(root, 'mmproj-F16.gguf'), buildGguf());
  fs.writeFileSync(path.join(root, 'mmproj-Q8_0.gguf'), buildGguf());
  fs.writeFileSync(path.join(root, 'notes.txt'), 'ignore');
  fs.writeFileSync(path.join(root, '.hidden.gguf'), buildGguf());
  fs.writeFileSync(path.join(root, 'partial.gguf.part'), buildGguf());

  writeModel(path.join(root, 'sub1', 'b.gguf'));
  writeModel(path.join(root, 'sub1', 'sub2', 'c.gguf'));
  writeModel(path.join(root, 'sub1', 'sub2', 'sub3', 'd.gguf'));
  writeModel(path.join(root, 'sub1', 'sub2', 'sub3', 'sub4', 'too-deep.gguf'));

  writeModel(path.join(root, '.hidden-dir', 'hidden.gguf'));
  writeModel(path.join(root, '.parts', 'parts.gguf'));
  writeModel(path.join(root, '.tmp', 'tmp.gguf'));

  const scan = catalog.scanModelRoots([root]);
  assert.deepEqual(scan.roots, [path.resolve(root)]);
  assert.deepEqual(scan.warnings, []);
  const files = scan.entries.map((e) => path.basename(e.file)).sort();
  assert.deepEqual(files, ['a.gguf', 'b.gguf', 'c.gguf', 'd.gguf']);
  assert.ok(scan.entries.every((e) => e.sizeBytes > 0));
  assert.ok(scan.entries.every((e) => e.realPath));
  assert.ok(scan.entries.every((e) => !/^mmproj/i.test(path.basename(e.file))));

  const a = scan.entries.find((e) => path.basename(e.file) === 'a.gguf');
  assert.ok(a.mmproj, '根目录模型应配对上视觉投影');
  assert.match(path.basename(a.mmproj), /^mmproj-Q8_0\.gguf$/i); // Q8_0 优先
  const b = scan.entries.find((e) => path.basename(e.file) === 'b.gguf');
  assert.equal(b.mmproj, null); // 子目录没有 mmproj，不跨目录误配

  const shallow = catalog.scanModelRoots([root], { maxDepth: 1 });
  assert.deepEqual(shallow.entries.map((e) => path.basename(e.file)).sort(), ['a.gguf', 'b.gguf']);
});

test('scanModelRoots：重复根/相对路径按 realpath 去重', () => {
  const root = tmpDir();
  writeModel(path.join(root, 'one.gguf'));
  writeModel(path.join(root, 'nested', 'two.gguf'));

  const relative = path.relative(process.cwd(), root);
  const variants = [root, relative];
  if (process.platform === 'win32') variants.push(root.toUpperCase());
  const scan = catalog.scanModelRoots(variants);
  assert.equal(scan.roots.length, 1); // 三个写法解析成同一个根
  assert.deepEqual(scan.entries.map((e) => path.basename(e.file)).sort(), ['one.gguf', 'two.gguf']);

  // 重叠根（根 + 子目录）也不应重复收录
  const overlap = catalog.scanModelRoots([root, path.join(root, 'nested')]);
  assert.deepEqual(overlap.entries.map((e) => path.basename(e.file)).sort(), ['one.gguf', 'two.gguf']);
});

test('scanModelRoots：根不存在/不是目录只记 warning，不抛错', () => {
  const root = tmpDir();
  writeModel(path.join(root, 'ok.gguf'));
  const fileAsRoot = path.join(root, 'ok.gguf');

  const warnings = [];
  const scan = catalog.scanModelRoots([path.join(root, 'missing'), fileAsRoot, root], { warnings });
  assert.deepEqual(scan.entries.map((e) => path.basename(e.file)), ['ok.gguf']);
  assert.equal(warnings.length, 2);
  assert.deepEqual(warnings.map((w) => w.code).sort(), ['root-missing', 'root-not-directory']);
});

// ------------------------------------------------------------ 构建目录

test('buildCatalog：稳定 id、显示名去量化后缀、尺寸/字段/nameOf/overrides', () => {
  const root = tmpDir();
  const file = writeModel(path.join(root, 'My-Model-Q4_K_M.gguf'), {
    arch: 'qwen35moe', ctx: 262144, blocks: 40, experts: [256, 8],
    template: '{% if enable_thinking %}think{% endif %}',
  });
  const scan = catalog.scanModelRoots([root]);
  const first = catalog.buildCatalog(scan.entries);
  const second = catalog.buildCatalog(scan.entries);

  assert.equal(first.length, 1);
  const m = first[0];
  assert.equal(m.id, second[0].id);
  assert.match(m.id, /^[0-9a-f]{12}$/);
  assert.equal(m.name, 'My-Model');
  assert.equal(m.quantization, 'Q4_K_M');
  assert.equal(m.source, 'scan');
  assert.equal(m.available, true);
  assert.equal(m.sizeBytes, fs.statSync(file).size);
  assert.equal(m.arch, 'qwen35moe');
  assert.equal(m.ctxTrain, 262144);
  assert.equal(m.blockCount, 40);
  assert.deepEqual(m.experts, { count: 256, used: 8, shared: null });
  assert.equal(m.headCount, 16);
  assert.equal(m.headCountKv, 2);
  assert.equal(m.embeddingLength, 2048);
  assert.equal(m.thinking, true);
  assert.ok(m.chatTemplateBytes > 0);
  assert.equal(m.mmproj, null);
  assert.equal(m.error, null);

  const named = catalog.buildCatalog(scan.entries, {
    nameOf: (info) => `自定义:${info.baseName}`,
  });
  assert.equal(named[0].name, '自定义:My-Model-Q4_K_M.gguf');

  const overridden = catalog.buildCatalog(scan.entries, {
    overrides: [{
      file,
      name: '覆盖名',
      safeCtx: { q4_0: 131072 },
      extraArgs: ['--n-cpu-moe', '23'],
    }],
  });
  assert.equal(overridden[0].name, '覆盖名');
  assert.deepEqual(overridden[0].overrides.safeCtx, { q4_0: 131072 });
  assert.deepEqual(overridden[0].overrides.extraArgs, ['--n-cpu-moe', '23']);
  assert.equal(overridden[0].overrides.file, undefined);

  const byMap = catalog.buildCatalog(scan.entries, {
    overrides: { [m.id]: { name: '映射覆盖' } },
  });
  assert.equal(byMap[0].name, '映射覆盖');
});

test('buildCatalog：坏 GGUF 不丢条目，只加 metadata-error warning', () => {
  const root = tmpDir();
  writeModel(path.join(root, 'good.gguf'));
  writeBad(path.join(root, 'bad.gguf'));
  fs.writeFileSync(path.join(root, 'empty.gguf'), Buffer.alloc(0));

  const scan = catalog.scanModelRoots([root]);
  assert.equal(scan.entries.length, 3);
  const warnings = [];
  const models = catalog.buildCatalog(scan.entries, { warnings });
  assert.equal(models.length, 3);

  const good = models.find((m) => path.basename(m.file) === 'good.gguf');
  assert.equal(good.error, null);
  assert.equal(good.arch, 'qwen35moe');

  for (const name of ['bad.gguf', 'empty.gguf']) {
    const bad = models.find((m) => path.basename(m.file) === name);
    assert.ok(bad, `缺少条目 ${name}`);
    assert.equal(bad.available, true);
    assert.ok(bad.error);
    assert.equal(bad.arch, null);
  }
  assert.equal(warnings.length, 2);
  assert.ok(warnings.every((w) => w.code === 'metadata-error'));
  assert.deepEqual(
    warnings.map((w) => path.basename(w.file)).sort(),
    ['bad.gguf', 'empty.gguf'],
  );
});

// ------------------------------------------------------------ 旧配置

function legacyFixture(root) {
  const existing = writeModel(path.join(root, 'legacy-existing.gguf'));
  const mmproj = path.join(root, 'mmproj-Q8_0.gguf');
  fs.writeFileSync(mmproj, buildGguf());
  return {
    existing,
    mmproj,
    models: [
      {
        id: 'legacy-existing-id',
        name: '旧配置 · 已有文件',
        note: '用户实测配置',
        file: existing,
        bin: 'C:\\bin\\llama-server.exe',
        safeCtx: { q4_0: 163840, q8_0: 65536 },
        maxCtx: 262144,
        probeTps: 50,
        extraArgs: ['--n-cpu-moe', '23', '-t', '12'],
        temp: 0.6,
        topP: 0.95,
        topK: 20,
        mmproj,
        kvLayers: { total: 40, withKv: 10 },
        defaultPreset: 'text-64k',
      },
      {
        id: 'legacy-missing-id',
        name: '旧配置 · 文件不在',
        file: path.join(root, 'not-downloaded.gguf'),
        safeCtx: 98304,
        probeTps: 31,
        note: '归档盘没接',
      },
      { id: 'no-file-id', name: '没有 file 字段' },
    ],
  };
}

test('importLegacyConfig：保留旧字段为 overrides，缺失文件 available:false', () => {
  const root = tmpDir();
  const fixture = legacyFixture(root);
  const entries = catalog.importLegacyConfig(fixture.models);
  assert.equal(entries.length, 2); // 没有 file 字段的条目跳过

  const existing = entries.find((e) => e.overrides.legacyId === 'legacy-existing-id');
  assert.ok(existing);
  assert.equal(existing.source, 'legacy');
  assert.equal(existing.available, true);
  assert.equal(existing.sizeBytes, fs.statSync(fixture.existing).size);
  assert.equal(existing.name, '旧配置 · 已有文件');
  assert.equal(existing.note, '用户实测配置');
  assert.equal(existing.overrides.safeCtx.q4_0, 163840);
  assert.equal(existing.overrides.maxCtx, 262144);
  assert.equal(existing.overrides.probeTps, 50);
  assert.deepEqual(existing.overrides.extraArgs, ['--n-cpu-moe', '23', '-t', '12']);
  assert.equal(existing.overrides.temp, 0.6);
  assert.equal(existing.overrides.topP, 0.95);
  assert.equal(existing.overrides.topK, 20);
  assert.deepEqual(existing.overrides.kvLayers, { total: 40, withKv: 10 });
  assert.equal(existing.overrides.defaultPreset, 'text-64k');
  assert.equal(existing.mmproj, fixture.mmproj);

  const missing = entries.find((e) => e.overrides.legacyId === 'legacy-missing-id');
  assert.ok(missing, '文件不存在也不能丢弃条目');
  assert.equal(missing.available, false);
  assert.equal(missing.sizeBytes, null);
  assert.equal(missing.error, '文件不存在');
  assert.equal(missing.overrides.safeCtx, 98304);
  assert.equal(missing.overrides.probeTps, 31);
});

test('mergeCatalog：按 realpath 合并、legacy 名字/字段覆盖、scan 未发现的旧条目保留', () => {
  const root = tmpDir();
  const shared = writeModel(path.join(root, 'Shared-Model-Q8_0.gguf'));
  const scan = catalog.buildCatalog(catalog.scanModelRoots([root]).entries);

  const legacy = catalog.importLegacyConfig([
    {
      id: 'shared-legacy',
      name: '共享模型（旧名）',
      note: '旧备注',
      file: shared,
      safeCtx: { q4_0: 65536 },
      probeTps: 42,
      extraArgs: ['-t', '12'],
    },
    {
      id: 'missing-legacy',
      name: 'AAA 缺失的模型',
      file: path.join(root, 'gone.gguf'),
    },
  ]);

  const merged = catalog.mergeCatalog(scan, legacy);
  assert.equal(merged.length, 2); // shared 合并成一条 + missing 保留

  const hit = merged.find((m) => path.basename(m.file) === path.basename(shared));
  assert.ok(hit);
  assert.equal(hit.name, '共享模型（旧名）');
  assert.equal(hit.note, '旧备注');
  assert.equal(hit.legacy, true);
  assert.equal(hit.legacyId, 'shared-legacy');
  assert.equal(hit.source, 'scan');
  assert.equal(hit.available, true);
  assert.equal(hit.overrides.safeCtx.q4_0, 65536);
  assert.equal(hit.overrides.probeTps, 42);
  assert.deepEqual(hit.overrides.extraArgs, ['-t', '12']);
  assert.equal(merged.filter((m) => path.basename(m.file) === path.basename(shared)).length, 1);

  const missing = merged.find((m) => m.name === 'AAA 缺失的模型');
  assert.ok(missing);
  assert.equal(missing.available, false);
  assert.equal(missing.source, 'legacy');
  assert.equal(missing.legacyId, 'missing-legacy');

  // 按 name 稳定排序：AAA 在前
  assert.equal(merged[0].name, 'AAA 缺失的模型');
  assert.deepEqual(merged.map((m) => m.name), ['AAA 缺失的模型', '共享模型（旧名）']);
});

test('discoverCatalog：一次完成 scan+merge，warnings 不抛错，排序稳定', () => {
  const root = tmpDir();
  writeModel(path.join(root, 'Good-Q4_K_M.gguf'), { ctx: 65536 });
  writeBad(path.join(root, 'Broken.gguf'));
  fs.writeFileSync(path.join(root, 'mmproj-Q8_0.gguf'), buildGguf());

  const elsewhere = tmpDir();
  const fixture = legacyFixture(elsewhere);
  const missingRoot = path.join(root, 'no-such-dir');

  const result = catalog.discoverCatalog({
    roots: [root, missingRoot],
    legacyModels: fixture.models,
    now: '2026-10-19T05:00:00.000Z',
  });

  assert.equal(result.scannedAt, '2026-10-19T05:00:00.000Z');
  assert.deepEqual(result.roots, [path.resolve(root), path.resolve(missingRoot)]);
  assert.equal(result.models.length, 4); // good + broken + legacy-existing + legacy-missing

  const codes = result.warnings.map((w) => w.code).sort();
  assert.deepEqual(codes, ['metadata-error', 'root-missing']);

  const good = result.models.find((m) => path.basename(m.file) === 'Good-Q4_K_M.gguf');
  assert.ok(good);
  assert.equal(good.name, 'Good');
  assert.equal(good.ctxTrain, 65536);
  assert.match(path.basename(good.mmproj), /^mmproj-Q8_0\.gguf$/i);

  const broken = result.models.find((m) => path.basename(m.file) === 'Broken.gguf');
  assert.ok(broken);
  assert.ok(broken.error);
  assert.equal(broken.available, true);

  const legacyExisting = result.models.find((m) => m.overrides.legacyId === 'legacy-existing-id');
  assert.ok(legacyExisting);
  assert.equal(legacyExisting.available, true);
  assert.equal(legacyExisting.source, 'legacy');

  const legacyMissing = result.models.find((m) => m.overrides.legacyId === 'legacy-missing-id');
  assert.ok(legacyMissing);
  assert.equal(legacyMissing.available, false);

  // 排序稳定：连续两次结果一致。
  const again = catalog.discoverCatalog({
    roots: [root, missingRoot],
    legacyModels: fixture.models,
    now: '2026-10-19T05:00:00.000Z',
  });
  assert.deepEqual(result.models.map((m) => m.id), again.models.map((m) => m.id));
  assert.deepEqual(result.models.map((m) => m.name), sortNames(result.models));
});

function sortNames(models) {
  return models.map((m) => m.name).slice().sort((a, b) => {
    const la = String(a).toLowerCase();
    const lb = String(b).toLowerCase();
    if (la < lb) return -1;
    if (la > lb) return 1;
    return 0;
  });
}

// ------------------------------------------------------------ 真机条件集成

test('真实模型目录：discoverCatalog 发现模型并配对 mmproj（不存在则跳过）', {
  skip: !fs.existsSync(REAL_DIR) || !fs.existsSync(REAL_MODEL),
}, (t) => {
  const started = performance.now();
  const result = catalog.discoverCatalog({ roots: [REAL_DIR] });
  const elapsed = performance.now() - started;

  assert.deepEqual(result.roots, [path.resolve(REAL_DIR)]);
  assert.equal(result.warnings.length, 0);
  assert.equal(result.models.length, 1, 'mmproj 不应作为独立模型出现');

  const model = result.models[0];
  assert.equal(path.resolve(model.file), path.resolve(REAL_MODEL));
  assert.equal(model.available, true);
  assert.equal(model.source, 'scan');
  assert.equal(model.arch, 'qwen35moe');
  assert.ok(model.ctxTrain >= 32768);
  assert.ok(model.blockCount > 0);
  assert.ok(model.experts && model.experts.count > 0 && model.experts.used > 0);
  assert.ok(model.chatTemplateBytes > 1000);
  assert.equal(model.thinking, true);
  assert.ok(model.mmproj);
  assert.equal(path.resolve(model.mmproj), path.resolve(REAL_MMPROJ));
  assert.match(path.basename(model.mmproj), /^mmproj.*Q8_0\.gguf$/i);
  assert.equal(model.sizeBytes, fs.statSync(REAL_MODEL).size);

  // 再接一次真实 config.MODELS：应合并成 6 条（1 条真实存在 + 5 条旧条目），
  // 且旧字段仍在 overrides 里。
  const withLegacy = catalog.discoverCatalog({ roots: [REAL_DIR], legacyModels: cfg.MODELS });
  assert.equal(withLegacy.models.length, 6);
  const merged = withLegacy.models.find((m) => m.overrides.legacyId === 'qwen38distill-abl');
  assert.ok(merged);
  assert.equal(merged.legacy, true);
  assert.equal(merged.available, true);
  assert.equal(merged.overrides.safeCtx.q4_0, 163840);
  assert.equal(merged.overrides.probeTps, 50);
  assert.deepEqual(merged.overrides.extraArgs, ['--n-cpu-moe', '23', '-t', '12']);

  console.log('[真实目录]', JSON.stringify({
    dir: REAL_DIR,
    discoverMs: Number(elapsed.toFixed(1)),
    models: result.models.length,
    file: model.file,
    arch: model.arch,
    ctxTrain: model.ctxTrain,
    blockCount: model.blockCount,
    experts: model.experts,
    thinking: model.thinking,
    chatTemplateBytes: model.chatTemplateBytes,
    sizeBytes: model.sizeBytes,
    mmproj: model.mmproj,
    mergedWithLegacy: withLegacy.models.length,
  }));
  t.diagnostic(`真实目录 discoverCatalog ${elapsed.toFixed(1)}ms`);
});
