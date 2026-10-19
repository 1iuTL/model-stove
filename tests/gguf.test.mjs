// GGUF 解析层测试（src/core/gguf.js）。
//
// 合成文件全部在测试里用 Buffer 拼出来，不需要真实模型；唯一依赖真机的两条
// 用 fs.existsSync 做条件跳过（本机已有那个 13.65 GiB 的 GGUF 时会真的执行）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const gguf = require('../src/core/gguf.js');

const REAL_MODEL = 'D:\\Qwen3.8-35B-A3B-Distill-Abl\\Qwen3.8-35B-A3B-Distill.APEX-I-MiniPlus-V2.1-Abliterated.gguf';
const REAL_MMPROJ = 'D:\\Qwen3.8-35B-A3B-Distill-Abl\\mmproj-Q8_0.gguf';

const tmpDirs = [];
function tmpDir(prefix = 'model-stove-gguf-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ------------------------------------------------------------ 合成 GGUF 工具

const VALUE_TYPE = Object.freeze({
  u8: 0, i8: 1, u16: 2, i16: 3, u32: 4, i32: 5, f32: 6,
  bool: 7, string: 8, array: 9, u64: 10, i64: 11, f64: 12,
});

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(Number(n) >>> 0);
  return b;
}

function u64(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(typeof n === 'bigint' ? n : BigInt(Math.trunc(Number(n))));
  return b;
}

function i64(n) {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(typeof n === 'bigint' ? n : BigInt(Math.trunc(Number(n))));
  return b;
}

function ggufString(text) {
  const raw = Buffer.from(String(text), 'utf8');
  return Buffer.concat([u64(raw.length), raw]);
}

function encodeValue(type, value) {
  switch (type) {
    case VALUE_TYPE.u8:
    case VALUE_TYPE.i8:
    case VALUE_TYPE.bool: {
      const b = Buffer.alloc(1);
      if (type === VALUE_TYPE.i8) b.writeInt8(Number(value));
      else if (type === VALUE_TYPE.bool) b.writeUInt8(value ? 1 : 0);
      else b.writeUInt8(Number(value) & 0xff);
      return b;
    }
    case VALUE_TYPE.u16:
    case VALUE_TYPE.i16: {
      const b = Buffer.alloc(2);
      if (type === VALUE_TYPE.i16) b.writeInt16LE(Number(value));
      else b.writeUInt16LE(Number(value));
      return b;
    }
    case VALUE_TYPE.u32: return u32(value);
    case VALUE_TYPE.i32: {
      const b = Buffer.alloc(4);
      b.writeInt32LE(Number(value));
      return b;
    }
    case VALUE_TYPE.f32: {
      const b = Buffer.alloc(4);
      b.writeFloatLE(Number(value));
      return b;
    }
    case VALUE_TYPE.f64: {
      const b = Buffer.alloc(8);
      b.writeDoubleLE(Number(value));
      return b;
    }
    case VALUE_TYPE.string: return ggufString(value);
    case VALUE_TYPE.u64: return u64(value);
    case VALUE_TYPE.i64: return i64(value);
    case VALUE_TYPE.array: {
      // value = [elemType, items]
      const [elemType, items] = value;
      const parts = [u32(elemType), u64(items.length)];
      for (const item of items) parts.push(encodeValue(elemType, item));
      return Buffer.concat(parts);
    }
    default:
      throw new Error(`encodeValue 不支持类型 ${type}`);
  }
}

function kv(key, type, value) {
  return Buffer.concat([ggufString(key), u32(type), encodeValue(type, value)]);
}

function buildGguf(values, { version = 3, tensorCount = 0, kvCount = null } = {}) {
  const parts = [
    Buffer.from('GGUF', 'latin1'),
    u32(version),
    u64(tensorCount),
    u64(kvCount == null ? values.length : kvCount),
  ];
  for (const [key, type, value] of values) parts.push(kv(key, type, value));
  return Buffer.concat(parts);
}

function writeBytes(buffer, name = 'synthetic.gguf') {
  const dir = tmpDir();
  const file = path.join(dir, name);
  fs.writeFileSync(file, buffer);
  return file;
}

function writeGguf(values, options) {
  return writeBytes(buildGguf(values, options));
}

/** 一组覆盖常见目录字段的 metadata。 */
function basicValues(overrides = {}) {
  const base = {
    'general.architecture': 'qwen35moe',
    'qwen35moe.context_length': 262144,
    'qwen35moe.block_count': 40,
    'qwen35moe.embedding_length': 2048,
    'qwen35moe.attention.head_count': 16,
    'qwen35moe.attention.head_count_kv': 2,
    'qwen35moe.expert_count': 256,
    'qwen35moe.expert_used_count': 8,
    'tokenizer.chat_template': '{% if enable_thinking %}think{% endif %}',
  };
  const merged = { ...base, ...overrides };
  return Object.entries(merged).map(([key, value]) => {
    if (typeof value === 'number') return [key, VALUE_TYPE.u32, value];
    if (typeof value === 'boolean') return [key, VALUE_TYPE.bool, value];
    return [key, VALUE_TYPE.string, value];
  });
}

// ------------------------------------------------------------ 头部与类型

test('readGgufMetadata：v2 头部、基础元数据与 counts', () => {
  const file = writeGguf(basicValues(), { version: 2, tensorCount: 733 });
  const r = gguf.readGgufMetadata(file);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.version, 2);
  assert.equal(r.tensorCount, 733);
  assert.equal(r.kvCount, 9);
  assert.equal(r.error, null);
  assert.equal(r.metadata['general.architecture'], 'qwen35moe');
  assert.equal(r.architecture, 'qwen35moe');
  assert.equal(gguf.getContextTrain(r.metadata), 262144);
  assert.equal(gguf.getBlockCount(r.metadata), 40);
  assert.equal(gguf.getEmbeddingLength(r.metadata), 2048);
  assert.equal(gguf.getHeadCount(r.metadata), 16);
  assert.equal(gguf.getHeadCountKv(r.metadata), 2);
  assert.deepEqual(gguf.getExpertInfo(r.metadata), { count: 256, used: 8, shared: null });
  assert.equal(r.truncated, false);
  assert.ok(r.metaBytes > 0);
  assert.ok(r.fileSize > 0);
});

test('readGgufMetadata：v3 支持 0..12 全部值类型', () => {
  const values = [
    ['t.u8', VALUE_TYPE.u8, 255],
    ['t.i8', VALUE_TYPE.i8, -8],
    ['t.u16', VALUE_TYPE.u16, 65535],
    ['t.i16', VALUE_TYPE.i16, -1234],
    ['t.u32', VALUE_TYPE.u32, 4000000000],
    ['t.i32', VALUE_TYPE.i32, -2000000000],
    ['t.f32', VALUE_TYPE.f32, 1.5],
    ['t.bool', VALUE_TYPE.bool, true],
    ['t.string', VALUE_TYPE.string, '中文 UTF-8 ✓'],
    ['t.array', VALUE_TYPE.array, [VALUE_TYPE.i32, [1, -2, 3]]],
    ['t.u64', VALUE_TYPE.u64, 12345678901234567890n],
    ['t.i64', VALUE_TYPE.i64, -1234567890123456789n],
    ['t.f64', VALUE_TYPE.f64, 3.141592653589793],
  ];
  const file = writeGguf(values, { version: 3 });
  const r = gguf.readGgufMetadata(file);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.version, 3);
  assert.equal(r.kvCount, 13);
  const m = r.metadata;
  assert.equal(m['t.u8'], 255);
  assert.equal(m['t.i8'], -8);
  assert.equal(m['t.u16'], 65535);
  assert.equal(m['t.i16'], -1234);
  assert.equal(m['t.u32'], 4000000000);
  assert.equal(m['t.i32'], -2000000000);
  assert.ok(Math.abs(m['t.f32'] - 1.5) < 1e-6);
  assert.equal(m['t.bool'], true);
  assert.equal(m['t.string'], '中文 UTF-8 ✓');
  assert.deepEqual(m['t.array'], [1, -2, 3]);
  assert.equal(typeof m['t.u64'], 'bigint');
  assert.equal(m['t.u64'], 12345678901234567890n);
  assert.equal(typeof m['t.i64'], 'bigint');
  assert.equal(m['t.i64'], -1234567890123456789n);
  assert.ok(Math.abs(m['t.f64'] - Math.PI) < 1e-12);
});

test('readGgufMetadata：空数组与嵌套数组', () => {
  const file = writeGguf([
    ['t.empty', VALUE_TYPE.array, [VALUE_TYPE.string, []]],
    ['t.nested', VALUE_TYPE.array, [
      VALUE_TYPE.array,
      [
        [VALUE_TYPE.i32, [1, 2]],
        [VALUE_TYPE.i32, [3]],
      ],
    ]],
  ]);
  const r = gguf.readGgufMetadata(file);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.metadata['t.empty'], []);
  assert.deepEqual(r.metadata['t.nested'], [[1, 2], [3]]);
});

// ------------------------------------------------------------ 错误路径

test('readGgufMetadata：坏 magic 返回清晰错误而不是抛异常', () => {
  const buffer = Buffer.concat([
    Buffer.from('NOPE', 'latin1'), u32(3), u64(0), u64(0),
  ]);
  const r = gguf.readGgufMetadata(writeBytes(buffer));
  assert.equal(r.ok, false);
  assert.match(r.error, /GGUF/i);
  assert.equal(r.metadata, null);
});

test('readGgufMetadata：文件头截断', () => {
  const r = gguf.readGgufMetadata(writeBytes(Buffer.alloc(10)));
  assert.equal(r.ok, false);
  assert.match(r.error, /不完整|EOF|截断/);
});

test('readGgufMetadata：不支持的版本明确报错', () => {
  const r = gguf.readGgufMetadata(writeGguf([], { version: 1 }));
  assert.equal(r.ok, false);
  assert.match(r.error, /版本/);
  assert.equal(r.version, 1);
});

test('readGgufMetadata：字符串读到一半 EOF', () => {
  const parts = [
    Buffer.from('GGUF', 'latin1'), u32(3), u64(0), u64(1),
    ggufString('bad.string'), u32(VALUE_TYPE.string), u64(100), Buffer.from('abc'),
  ];
  const r = gguf.readGgufMetadata(writeBytes(Buffer.concat(parts)));
  assert.equal(r.ok, false);
  assert.match(r.error, /EOF|截断|文件大小/);
});

test('readGgufMetadata：未知值类型明确报错', () => {
  const parts = [
    Buffer.from('GGUF', 'latin1'), u32(3), u64(0), u64(1),
    ggufString('bad.type'), u32(99),
  ];
  const r = gguf.readGgufMetadata(writeBytes(Buffer.concat(parts)));
  assert.equal(r.ok, false);
  assert.match(r.error, /类型/);
});

test('readGgufMetadata：metadata 超过 maxMetaBytes 时报“元数据过大”', () => {
  const file = writeGguf(basicValues());
  const r = gguf.readGgufMetadata(file, { maxMetaBytes: 16 });
  assert.equal(r.ok, false);
  assert.match(r.error, /元数据过大/);
});

test('readGgufMetadata：超大数组只保留前缀并标记 truncated', () => {
  const big = Array.from({ length: 1000 }, (_, i) => i);
  const file = writeGguf([
    ['t.big', VALUE_TYPE.array, [VALUE_TYPE.u32, big]],
    ['t.after', VALUE_TYPE.string, '数组之后还能继续解析'],
  ]);
  const r = gguf.readGgufMetadata(file, { maxArrayItems: 8 });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.metadata['t.big'].length, 8);
  assert.deepEqual(r.metadata['t.big'], big.slice(0, 8));
  assert.equal(r.truncated, true);
  assert.deepEqual(r.truncatedKeys, ['t.big']);
  assert.deepEqual(r.truncatedInfo['t.big'], { type: 'uint32', count: 1000, kept: 8 });
  // 跳过的部分没有影响后续 KV 的解析。
  assert.equal(r.metadata['t.after'], '数组之后还能继续解析');
});

test('readGgufMetadata：注入 fs，只读头部与 metadata 且会关闭 fd', () => {
  const file = writeGguf(basicValues());
  const source = fs.readFileSync(file);
  let closed = false;
  let totalRead = 0;
  let maxRead = 0;
  const fakeFs = {
    openSync() { return 7; },
    fstatSync() { return { size: source.length }; },
    closeSync() { closed = true; },
    readSync(fd, target, targetOffset, length, position) {
      const chunk = source.subarray(position, position + length);
      chunk.copy(target, targetOffset);
      totalRead += chunk.length;
      maxRead = Math.max(maxRead, chunk.length);
      return chunk.length;
    },
  };
  const r = gguf.readGgufMetadata(file, { fs: fakeFs, chunkSize: 32 });
  assert.equal(r.ok, true, r.error);
  assert.equal(closed, true);
  assert.ok(totalRead > 0);
  assert.ok(maxRead <= 64); // 32 字节块；超过块大小的单条字符串直接读
  // 合成文件只有 header+metadata，没有权重；分块读取会有少量跨块重读，
  // 但总量应远小于“整文件反复读”的量级（这里允许 2 倍 + 一个块）。
  assert.ok(
    totalRead <= source.length * 2 + 32,
    `读取了 ${totalRead} 字节 / 文件 ${source.length}`,
  );
});

// ------------------------------------------------------------ 派生 helper

test('派生 helper：架构反推、前缀兼容、数组头数与字符串数字', () => {
  const meta = {
    'llama.context_length': '262144',
    'llama.block_count': 40,
    'llama.embedding_length': 2048,
    'llama.attention.head_count': [16, 32],
    'llama.attention.head_count_kv': [2, 4],
    'llama.expert_count': 256,
    'llama.expert_used_count': 8,
    'tokenizer.chat_template': 'plain template',
  };
  assert.equal(gguf.getArchitecture(meta), null); // 没有 general.architecture，推断不应命中 llama 前缀
  assert.equal(gguf.getContextTrain(meta), 262144);
  assert.equal(gguf.getBlockCount(meta), 40);
  assert.equal(gguf.getEmbeddingLength(meta), 2048);
  assert.equal(gguf.getHeadCount(meta), 32);
  assert.equal(gguf.getHeadCountKv(meta), 4);
  assert.deepEqual(gguf.getHeadCountValues(meta, 'head'), [16, 32]);
  assert.deepEqual(gguf.getExpertInfo(meta), { count: 256, used: 8, shared: null });

  const inferred = {
    'qwen35moe.block_count': 40,
    'qwen35moe.context_length': 32768,
  };
  assert.equal(gguf.getArchitecture(inferred), 'qwen35moe');
  assert.equal(gguf.getContextTrain(inferred), 32768);
  assert.equal(gguf.getBlockCount(inferred), 40);
});

test('派生 helper：聊天模板与思考标记', () => {
  assert.equal(gguf.getChatTemplate({ 'tokenizer.chat_template': 'abc' }), 'abc');
  assert.equal(gguf.getChatTemplate({ 'llama.chat_template': 'def' }), 'def');
  assert.equal(gguf.getChatTemplate({}), null);
  assert.equal(gguf.isThinkingTemplate('{% if enable_thinking %}...'), true);
  assert.equal(gguf.isThinkingTemplate('before <|think|> after'), true);
  assert.equal(gguf.isThinkingTemplate('reasoning_content'), true);
  assert.equal(gguf.isThinkingTemplate('plain instruct template'), false);
  assert.equal(gguf.isThinkingTemplate(null), false);
});

test('describeGguf：返回目录摘要且不含完整 metadata', () => {
  const file = writeGguf(basicValues());
  const d = gguf.describeGguf(file);
  assert.equal(d.ok, true, d.error);
  assert.equal(d.arch, 'qwen35moe');
  assert.equal(d.ctxTrain, 262144);
  assert.equal(d.blockCount, 40);
  assert.deepEqual(d.experts, { count: 256, used: 8, shared: null });
  assert.equal(d.headCount, 16);
  assert.equal(d.headCountKv, 2);
  assert.equal(d.embeddingLength, 2048);
  assert.equal(d.thinking, true);
  assert.equal(d.chatTemplateBytes, Buffer.byteLength('{% if enable_thinking %}think{% endif %}', 'utf8'));
  assert.equal(d.sizeBytes, fs.statSync(file).size);
  assert.equal(d.version, 3);
  assert.equal(d.truncated, false);
  assert.equal('metadata' in d, false);
});

test('describeGguf：坏文件返回 ok:false 且保留文件大小', () => {
  const file = writeBytes(Buffer.from('not a gguf file'), 'broken.gguf');
  const d = gguf.describeGguf(file);
  assert.equal(d.ok, false);
  assert.ok(d.error);
  assert.equal(d.sizeBytes, fs.statSync(file).size);
  assert.equal(d.arch, null);
  assert.equal(d.thinking, false);
});

// ------------------------------------------------------------ 真机条件测试

test('真实 13.65 GiB GGUF：只读解析 metadata（不存在则跳过）', {
  skip: !fs.existsSync(REAL_MODEL),
}, (t) => {
  const started = performance.now();
  const r = gguf.readGgufMetadata(REAL_MODEL);
  const elapsed = performance.now() - started;
  assert.equal(r.ok, true, r.error);
  assert.equal(r.version, 3);
  assert.ok(r.tensorCount > 0);
  assert.ok(r.kvCount > 0);
  assert.ok(r.metaBytes > 0 && r.metaBytes < 64 * 1024 * 1024);
  assert.equal(gguf.getArchitecture(r.metadata), 'qwen35moe');
  assert.ok(gguf.getContextTrain(r.metadata) >= 32768);
  assert.ok(gguf.getBlockCount(r.metadata) > 0);
  assert.ok(gguf.getEmbeddingLength(r.metadata) > 0);
  const experts = gguf.getExpertInfo(r.metadata);
  assert.ok(experts && experts.count > 0 && experts.used > 0);
  const template = gguf.getChatTemplate(r.metadata);
  assert.equal(typeof template, 'string');
  assert.ok(template.length > 100);
  assert.equal(gguf.isThinkingTemplate(template), true);
  assert.equal(r.truncated, true);
  assert.ok(r.truncatedKeys.includes('tokenizer.ggml.tokens'));
  assert.ok(elapsed < 2000, `真实文件解析耗时 ${elapsed.toFixed(1)}ms，超过 2000ms`);

  const d = gguf.describeGguf(REAL_MODEL);
  assert.equal(d.ok, true, d.error);
  assert.equal(d.sizeBytes, fs.statSync(REAL_MODEL).size);
  assert.equal(d.chatTemplateBytes, Buffer.byteLength(template, 'utf8'));

  console.log('[真实 GGUF]', JSON.stringify({
    file: REAL_MODEL,
    version: r.version,
    tensorCount: r.tensorCount,
    kvCount: r.kvCount,
    metaBytes: r.metaBytes,
    parseMs: Number(elapsed.toFixed(1)),
    arch: d.arch,
    ctxTrain: d.ctxTrain,
    blockCount: d.blockCount,
    experts: d.experts,
    headCount: d.headCount,
    headCountKv: d.headCountKv,
    embeddingLength: d.embeddingLength,
    thinking: d.thinking,
    chatTemplateBytes: d.chatTemplateBytes,
    sizeBytes: d.sizeBytes,
    truncatedKeys: r.truncatedKeys,
  }));
  t.diagnostic(`真实 GGUF 解析 ${elapsed.toFixed(1)}ms`);

  if (fs.existsSync(REAL_MMPROJ)) {
    const mm = gguf.describeGguf(REAL_MMPROJ);
    assert.equal(mm.ok, true, mm.error);
    assert.ok(mm.sizeBytes > 0);
    console.log('[真实 mmproj]', JSON.stringify({
      file: REAL_MMPROJ,
      arch: mm.arch,
      blockCount: mm.blockCount,
      sizeBytes: mm.sizeBytes,
      version: mm.version,
      tensorCount: mm.tensorCount,
    }));
  }
});
