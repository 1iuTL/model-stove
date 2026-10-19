// GGUF 元数据只读解析层。
//
// 目标：给模型目录（src/core/catalog.js）提供“这个 GGUF 是什么架构、上下文多大、
// 多少层、多少专家、有没有聊天模板”的摘要，而不把 13 GiB 的权重读进内存。
//
// 格式（GGUF v2/v3）：
//   0  u32  magic "GGUF"
//   4  u32  version（2 或 3）
//   8  u64  tensor_count
//   16 u64  metadata_kv_count
//   24 ...  metadata_kv_count 个键值对：
//            key:   u64 长度 + UTF-8 字节
//            type:  u32（0..12）
//            value: 见 VALUE_NAMES
//   metadata 之后才是 tensor 信息与权重；本模块**不读**那一段。
//
// 关键约束：
//   - 只用 fs.openSync/readSync 按需读取，默认 1 MiB 缓冲区；绝不整文件读；
//   - 所有长度都做上界检查，坏文件只会返回 { ok:false, error }，不会让进程崩；
//   - metadata 里的大数组（tokenizer tokens / merges 等动辄几十万条）默认只保留
//     前 MAX_ARRAY_ITEMS 项，并在 truncated / truncatedKeys 里标记；剩余元素
//     只做结构跳过，不分配内存；
//   - 整个 metadata 段（从偏移 24 到读完）默认有 64 MiB 上限。超过时直接报
//     “元数据过大”而不是继续扫 —— 这是防止恶意/损坏文件拖死进程的硬边界。
//     正常模型（本机 248k token 的 13.65 GiB GGUF）metadata 约 10.4 MiB。
//
// 派生 helper 的键名兼容三种常见写法：
//   <arch>.context_length / llama.context_length / general.context_length，
//   以及（最后兜底）任意 *.<suffix>。这样上游 llama.cpp、个别 fork 和手工
//   转换出来的文件都能读。
//
// 本文件纯 CommonJS、无第三方依赖；fs 可通过 options.fs 注入，便于测试。
const fsDefault = require('fs');

const MAGIC = 'GGUF';
const HEADER_BYTES = 24;
const SUPPORTED_VERSIONS = new Set([2, 3]);

const VALUE_NAMES = Object.freeze([
  'uint8', 'int8', 'uint16', 'int16', 'uint32', 'int32', 'float32',
  'bool', 'string', 'array', 'uint64', 'int64', 'float64',
]);

// 固定长度类型的字节数；string(8) / array(9) 单独处理。
const FIXED_SIZES = Object.freeze({
  0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8,
});

/** 编码一个值至少需要的字节数（用于在进入循环前估算是否必然超限）。 */
function minEncodedSize(type) {
  if (FIXED_SIZES[type]) return FIXED_SIZES[type];
  if (type === 8) return 8;  // u64 长度（内容可以为 0）
  if (type === 9) return 12; // u32 元素类型 + u64 长度
  return 0;
}

const DEFAULTS = Object.freeze({
  chunkSize: 1024 * 1024,            // 1 MiB 顺序缓冲
  maxMetaBytes: 64 * 1024 * 1024,    // metadata 段上限（同时约束内存与扫描量）
  maxStringBytes: 16 * 1024 * 1024,  // 单个字符串值上限
  maxKeyBytes: 64 * 1024,            // 单个键名上限
  maxArrayItems: 4096,               // 单个数组成员最多保留多少项
  maxKvCount: 1000 * 1000,           // 文件头声称的 KV 数上限，防死循环
});

const MAX_ARRAY_DEPTH = 4;

/** 解析层自己的错误类型；与 fs 错误区分开，便于上层给出可读文案。 */
class GgufError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GgufError';
    this.code = 'GGUF_PARSE';
  }
}

function hasOwn(obj, key) {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

/** 安全地写一个可能来自文件的键（防止 __proto__ 污染）。 */
function setOwn(obj, key, value) {
  Object.defineProperty(obj, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function positiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.floor(n));
}

// ---------------------------------------------------------------- 分块读取器

/**
 * 只读、按偏移取字节的读取器。
 *
 * 内部维护一个 chunk 大小的缓存；顺序解析时绝大多数读取都命中缓存。
 * 对于超过 chunk 的字符串，直接开临时 Buffer 读取（但仍受 maxStringBytes 限制）。
 * 每个读取入口都先检查文件边界，越界统一报“遇到 EOF”。
 */
class ByteReader {
  constructor(fsImpl, fd, fileSize, options) {
    this.fs = fsImpl;
    this.fd = fd;
    this.fileSize = fileSize;
    this.chunkSize = options.chunkSize;
    this.cache = Buffer.allocUnsafe(this.chunkSize);
    this.cacheStart = 0;
    this.cacheLen = 0;
    this.storedBytes = 0; // 已保留在内存里的元数据近似字节数
  }

  _ensureBounds(offset, length) {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length)
      || offset < 0 || length < 0) {
      throw new GgufError(`GGUF 读取位置非法: offset=${offset} length=${length}`);
    }
    if (offset + length > this.fileSize) {
      throw new GgufError(
        `读取 GGUF 时遇到 EOF: 偏移 ${offset} 需要 ${length} 字节，`
        + `文件大小 ${this.fileSize}（文件被截断或长度字段损坏）`,
      );
    }
  }

  _readExact(target, targetOffset, length, position) {
    let done = 0;
    while (done < length) {
      const n = this.fs.readSync(this.fd, target, targetOffset + done, length - done, position + done);
      if (!n) {
        throw new GgufError(
          `读取 GGUF 时遇到 EOF: 偏移 ${position + done} 没有更多数据`
          + `（文件大小 ${this.fileSize}）`,
        );
      }
      done += n;
    }
  }

  /** 返回覆盖 [offset, offset+length) 的 Buffer 视图；调用方应在下次读取前消费完。 */
  bytes(offset, length) {
    this._ensureBounds(offset, length);
    if (length === 0) return Buffer.alloc(0);
    if (length > this.chunkSize) {
      const buf = Buffer.allocUnsafe(length);
      this._readExact(buf, 0, length, offset);
      return buf;
    }
    const rel = offset - this.cacheStart;
    if (rel >= 0 && rel + length <= this.cacheLen) {
      return this.cache.subarray(rel, rel + length);
    }
    const toRead = Math.min(this.chunkSize, this.fileSize - offset);
    if (toRead < length) {
      throw new GgufError(
        `读取 GGUF 时遇到 EOF: 偏移 ${offset} 需要 ${length} 字节，`
        + `文件大小 ${this.fileSize}`,
      );
    }
    this._readExact(this.cache, 0, toRead, offset);
    this.cacheStart = offset;
    this.cacheLen = toRead;
    return this.cache.subarray(0, length);
  }

  u8(offset) { return this.bytes(offset, 1)[0]; }
  i8(offset) { return this.bytes(offset, 1).readInt8(0); }
  u16(offset) { return this.bytes(offset, 2).readUInt16LE(0); }
  i16(offset) { return this.bytes(offset, 2).readInt16LE(0); }
  u32(offset) { return this.bytes(offset, 4).readUInt32LE(0); }
  i32(offset) { return this.bytes(offset, 4).readInt32LE(0); }
  f32(offset) { return this.bytes(offset, 4).readFloatLE(0); }
  u64(offset) { return this.bytes(offset, 8).readBigUInt64LE(0); }
  i64(offset) { return this.bytes(offset, 8).readBigInt64LE(0); }
  f64(offset) { return this.bytes(offset, 8).readDoubleLE(0); }

  u64Number(offset, what) {
    const big = this.u64(offset);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new GgufError(`GGUF ${what} 数值过大，超出 JavaScript 安全整数: ${big}`);
    }
    return Number(big);
  }

  /** 读 u64 长度 + UTF-8 内容。返回 { value, next, bytes }。 */
  string(offset, maxBytes, what) {
    const length = this.u64Number(offset, `${what}长度`);
    if (length > maxBytes) {
      throw new GgufError(
        `GGUF ${what}过大: ${length} 字节（上限 ${maxBytes} 字节）`,
      );
    }
    this._ensureBounds(offset + 8, length);
    if (length === 0) return { value: '', next: offset + 8, bytes: 0 };
    const view = this.bytes(offset + 8, length);
    return { value: view.toString('utf8'), next: offset + 8 + length, bytes: length };
  }

  /** 只读 u64 长度并跳过内容，不分配字符串。 */
  skipString(offset, maxMetaOffset) {
    const length = this.u64Number(offset, '数组字符串元素长度');
    const next = offset + 8 + length;
    if (next > maxMetaOffset) {
      throw new GgufError(
        `GGUF 元数据过大: 数组元素在偏移 ${next} 超出上限 ${maxMetaOffset}`,
      );
    }
    this._ensureBounds(offset + 8, length);
    return next;
  }

  addStored(bytes) {
    if (Number.isFinite(bytes) && bytes > 0) this.storedBytes += bytes;
  }
}

// ---------------------------------------------------------------- 值解析

function isKnownValueType(type) {
  return Number.isInteger(type) && type >= 0 && type <= 12;
}

function scalarValue(reader, offset, type) {
  switch (type) {
    case 0: return { value: reader.u8(offset), next: offset + 1, stored: 1 };
    case 1: return { value: reader.i8(offset), next: offset + 1, stored: 1 };
    case 2: return { value: reader.u16(offset), next: offset + 2, stored: 2 };
    case 3: return { value: reader.i16(offset), next: offset + 2, stored: 2 };
    case 4: return { value: reader.u32(offset), next: offset + 4, stored: 4 };
    case 5: return { value: reader.i32(offset), next: offset + 4, stored: 4 };
    case 6: return { value: reader.f32(offset), next: offset + 4, stored: 4 };
    case 7: return { value: reader.u8(offset) !== 0, next: offset + 1, stored: 1 };
    case 10: return { value: reader.u64(offset), next: offset + 8, stored: 8 };
    case 11: return { value: reader.i64(offset), next: offset + 8, stored: 8 };
    case 12: return { value: reader.f64(offset), next: offset + 8, stored: 8 };
    default:
      throw new GgufError(`GGUF 标量类型未知: ${type}`);
  }
}

function markTruncated(reader, key, elemType, count, kept) {
  reader.truncated = true;
  if (!reader.truncatedKeys.includes(key)) reader.truncatedKeys.push(key);
  setOwn(reader.truncatedInfo, key, {
    type: VALUE_NAMES[elemType] || String(elemType),
    count,
    kept,
  });
}

/**
 * 跳过一个值的全部内容（不构造 JS 值）。
 *
 * 固定长度数组可以一次算总字节；字符串数组必须逐个读长度。所有路径都检查
 * metadata 段上限，因此超大数组最多扫到上限就报错，不会无限读。
 */
function skipValue(reader, offset, type, depth, maxMetaOffset) {
  if (depth > MAX_ARRAY_DEPTH) {
    throw new GgufError(`GGUF 数组嵌套过深（上限 ${MAX_ARRAY_DEPTH} 层）`);
  }
  if (!isKnownValueType(type)) {
    throw new GgufError(`GGUF 元数据值类型未知: ${type}`);
  }
  if (type === 8) return reader.skipString(offset, maxMetaOffset);
  if (type === 9) {
    const elemType = reader.u32(offset);
    if (!isKnownValueType(elemType)) {
      throw new GgufError(`GGUF 数组元素类型未知: ${elemType}`);
    }
    const count = reader.u64Number(offset + 4, '数组长度');
    let p = offset + 12;
    if (count === 0) return p;
    // 先按“最小编码长度”估算：即使每个元素都是空字符串，也至少 8 字节。
    // 这样 10 亿元素的损坏文件会在进入循环前直接报“元数据过大”。
    const minSize = minEncodedSize(elemType);
    if (minSize > 0) {
      const minNext = BigInt(p) + BigInt(count) * BigInt(minSize);
      if (minNext > BigInt(maxMetaOffset)) {
        throw new GgufError(
          `GGUF 元数据过大: 数组在偏移 ${minNext} 超出上限 ${maxMetaOffset}`,
        );
      }
    }
    if (FIXED_SIZES[elemType]) {
      const total = BigInt(count) * BigInt(FIXED_SIZES[elemType]);
      const next = BigInt(p) + total;
      reader._ensureBounds(p, Number(total));
      return Number(next);
    }
    for (let i = 0; i < count; i++) {
      if (p > maxMetaOffset) {
        throw new GgufError(`GGUF 元数据过大: 数组在偏移 ${p} 超出上限 ${maxMetaOffset}`);
      }
      p = skipValue(reader, p, elemType, depth + 1, maxMetaOffset);
    }
    return p;
  }
  const size = FIXED_SIZES[type];
  if (!size) throw new GgufError(`GGUF 元数据值类型未知: ${type}`);
  const next = offset + size;
  if (next > maxMetaOffset) {
    throw new GgufError(`GGUF 元数据过大: 值在偏移 ${next} 超出上限 ${maxMetaOffset}`);
  }
  return next;
}

/**
 * 解析一个 metadata 值。
 * 返回 { value, next, stored }；stored 是已计入 reader.storedBytes 的近似字节数。
 */
function readValue(reader, offset, type, depth, key, limits, maxMetaOffset) {
  if (depth > MAX_ARRAY_DEPTH) {
    throw new GgufError(`GGUF 数组嵌套过深（上限 ${MAX_ARRAY_DEPTH} 层）`);
  }
  if (!isKnownValueType(type)) {
    throw new GgufError(`GGUF 元数据值类型未知: ${type}（键 ${JSON.stringify(key)}）`);
  }
  if (type === 8) {
    const r = reader.string(offset, limits.maxStringBytes, `元数据字符串 ${key}`);
    reader.addStored(r.bytes);
    return { value: r.value, next: r.next, stored: r.bytes };
  }
  if (type === 9) {
    const elemType = reader.u32(offset);
    if (!isKnownValueType(elemType)) {
      throw new GgufError(
        `GGUF 数组元素类型未知: ${elemType}（键 ${JSON.stringify(key)}）`,
      );
    }
    const count = reader.u64Number(offset + 4, `数组长度（${key}）`);
    let p = offset + 12;
    const keepLimit = Math.min(count, limits.maxArrayItems);
    const items = [];
    let kept = 0;
    for (; kept < keepLimit; kept++) {
      // 内存预算到顶后不再保留后续元素，但仍要结构化跳过去。
      if (reader.storedBytes >= limits.maxMetaBytes) break;
      const item = readValue(reader, p, elemType, depth + 1, key, limits, maxMetaOffset);
      items.push(item.value);
      p = item.next;
      if (p > maxMetaOffset) {
        throw new GgufError(
          `GGUF 元数据过大: 数组 ${JSON.stringify(key)} 在偏移 ${p} 超出上限 ${maxMetaOffset}`,
        );
      }
    }
    if (kept < count) {
      // 从当前位置跳过剩余 count-kept 项：固定长度一次算总字节，
      // 字符串/嵌套数组逐项走 skipValue。
      p = skipRemaining(reader, p, elemType, count - kept, depth + 1, maxMetaOffset);
      markTruncated(reader, key, elemType, count, kept);
    }
    return { value: items, next: p, stored: 0 };
  }
  const r = scalarValue(reader, offset, type);
  reader.addStored(r.stored);
  return { value: r.value, next: r.next, stored: r.stored };
}

/** 跳过 count 个指定类型的元素（从元素内容起点开始）。 */
function skipRemaining(reader, offset, elemType, count, depth, maxMetaOffset) {
  const minSize = minEncodedSize(elemType);
  if (minSize > 0) {
    const minNext = BigInt(offset) + BigInt(count) * BigInt(minSize);
    if (minNext > BigInt(maxMetaOffset)) {
      throw new GgufError(
        `GGUF 元数据过大: 数组在偏移 ${minNext} 超出上限 ${maxMetaOffset}`,
      );
    }
    if (FIXED_SIZES[elemType]) {
      reader._ensureBounds(offset, Number(BigInt(count) * BigInt(FIXED_SIZES[elemType])));
      return Number(minNext);
    }
  }
  let p = offset;
  for (let i = 0; i < count; i++) {
    if (p > maxMetaOffset) {
      throw new GgufError(`GGUF 元数据过大: 数组在偏移 ${p} 超出上限 ${maxMetaOffset}`);
    }
    p = skipValue(reader, p, elemType, depth, maxMetaOffset);
  }
  return p;
}

// ---------------------------------------------------------------- 主解析入口

/** 统一的失败结果，字段齐全，便于调用方无脑解构。 */
function failResult(message) {
  return {
    ok: false,
    version: null,
    tensorCount: null,
    kvCount: null,
    metadata: null,
    architecture: null,
    error: message,
    truncated: false,
    truncatedKeys: [],
    truncatedInfo: {},
    metaBytes: 0,
    fileSize: null,
  };
}

/**
 * 只读 GGUF 文件头与 metadata。
 *
 * options:
 *   fs            注入的 fs（默认 require('fs')）
 *   chunkSize     读缓冲大小（默认 1 MiB）
 *   maxMetaBytes  metadata 段上限（默认 64 MiB）
 *   maxStringBytes 单个字符串上限（默认 16 MiB）
 *   maxKeyBytes   单个键名上限（默认 64 KiB）
 *   maxArrayItems 大数组保留项数（默认 4096）
 *   maxKvCount    KV 数量上限（默认 1e6）
 *
 * 返回 { ok, version, tensorCount, kvCount, metadata, architecture, error,
 *        truncated, truncatedKeys, truncatedInfo, metaBytes, fileSize }。
 * metadata 里 u64/i64 返回 BigInt（不丢精度）；大数组只保留前缀，
 * truncatedKeys / truncatedInfo 记录哪些键被截断以及原始长度。
 */
function readGgufMetadata(filePath, options = {}) {
  const fsImpl = options.fs || fsDefault;
  const limits = {
    chunkSize: positiveInt(options.chunkSize, DEFAULTS.chunkSize),
    maxMetaBytes: positiveInt(options.maxMetaBytes, DEFAULTS.maxMetaBytes),
    maxStringBytes: positiveInt(options.maxStringBytes, DEFAULTS.maxStringBytes),
    maxKeyBytes: positiveInt(options.maxKeyBytes, DEFAULTS.maxKeyBytes),
    maxArrayItems: positiveInt(options.maxArrayItems, DEFAULTS.maxArrayItems),
    maxKvCount: positiveInt(options.maxKvCount, DEFAULTS.maxKvCount),
  };

  let fd = null;
  let version = null;
  let tensorCount = null;
  let kvCount = null;
  let fileSize = null;

  try {
    try {
      fd = fsImpl.openSync(filePath, 'r');
    } catch (e) {
      return failResult(`无法打开 GGUF 文件: ${filePath}（${e.message}）`);
    }
    const stat = fsImpl.fstatSync ? fsImpl.fstatSync(fd) : fsImpl.statSync(filePath);
    fileSize = Number(stat && stat.size);
    if (!Number.isSafeInteger(fileSize) || fileSize < 0) {
      throw new GgufError('无法读取 GGUF 文件大小');
    }
    if (fileSize < HEADER_BYTES) {
      throw new GgufError(
        `GGUF 文件头不完整: 文件只有 ${fileSize} 字节，至少需要 ${HEADER_BYTES} 字节`,
      );
    }

    const reader = new ByteReader(fsImpl, fd, fileSize, limits);
    reader.truncated = false;
    reader.truncatedKeys = [];
    reader.truncatedInfo = {};

    const magic = reader.bytes(0, 4).toString('latin1');
    if (magic !== MAGIC) {
      throw new GgufError(
        `不是 GGUF 文件: magic=${JSON.stringify(magic)}（应以 "GGUF" 开头）`,
      );
    }
    version = reader.u32(4);
    if (!SUPPORTED_VERSIONS.has(version)) {
      throw new GgufError(
        `不支持的 GGUF 版本: ${version}（本工具仅支持 v2/v3）`,
      );
    }
    tensorCount = reader.u64Number(8, 'tensor_count');
    kvCount = reader.u64Number(16, 'metadata_kv_count');
    if (kvCount > limits.maxKvCount) {
      throw new GgufError(
        `GGUF 元数据项数异常: ${kvCount}（上限 ${limits.maxKvCount}）`,
      );
    }

    const metaStart = HEADER_BYTES;
    const maxMetaOffset = metaStart + limits.maxMetaBytes;
    const metadata = {};
    let offset = metaStart;

    for (let i = 0; i < kvCount; i++) {
      if (offset - metaStart > limits.maxMetaBytes) {
        throw new GgufError(
          `GGUF 元数据过大: 已扫描 ${offset - metaStart} 字节（上限 ${limits.maxMetaBytes} 字节）`,
        );
      }
      const keyRes = reader.string(offset, limits.maxKeyBytes, '元数据键名');
      const key = keyRes.value;
      reader.addStored(keyRes.bytes);
      offset = keyRes.next;

      const type = reader.u32(offset);
      offset += 4;
      const value = readValue(reader, offset, type, 0, key, limits, maxMetaOffset);
      offset = value.next;
      setOwn(metadata, key, value.value);
    }

    if (offset - metaStart > limits.maxMetaBytes) {
      throw new GgufError(
        `GGUF 元数据过大: 已扫描 ${offset - metaStart} 字节（上限 ${limits.maxMetaBytes} 字节）`,
      );
    }

    return {
      ok: true,
      version,
      tensorCount,
      kvCount,
      metadata,
      architecture: getArchitecture(metadata),
      error: null,
      truncated: !!reader.truncated,
      truncatedKeys: reader.truncatedKeys.slice(),
      truncatedInfo: reader.truncatedInfo,
      metaBytes: offset - metaStart,
      fileSize,
    };
  } catch (e) {
    return {
      ok: false,
      version,
      tensorCount,
      kvCount,
      metadata: null,
      architecture: null,
      error: e && e.message ? e.message : String(e),
      truncated: false,
      truncatedKeys: [],
      truncatedInfo: {},
      metaBytes: 0,
      fileSize,
    };
  } finally {
    if (fd != null) {
      try { fsImpl.closeSync(fd); } catch { /* 关闭失败不影响解析结果 */ }
    }
  }
}

// ---------------------------------------------------------------- 派生 helper
//
// 下面这些函数都只读 metadata 对象，不碰文件。任何字段缺失/类型不对都返回 null
// 或 false，不抛异常 —— 目录扫描时一个字段怪异的模型不该让整页列表消失。

function asString(value) {
  return typeof value === 'string' && value.trim() ? value : null;
}

function asNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(value)
      : null;
  }
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function metaGet(meta, keys) {
  if (!meta || typeof meta !== 'object') return undefined;
  for (const key of keys) {
    if (hasOwn(meta, key)) return meta[key];
  }
  return undefined;
}

/** 取 <arch>.<suffix>，兼容 llama./general. 前缀，最后兜底任意 *.suffix。 */
function metaGetSuffix(meta, suffix, arch) {
  if (!meta || typeof meta !== 'object') return undefined;
  const candidates = [];
  if (arch) {
    candidates.push(`${arch}.${suffix}`, `llama.${arch}.${suffix}`, `general.${arch}.${suffix}`);
  }
  candidates.push(`llama.${suffix}`, `general.${suffix}`, suffix);
  for (const key of candidates) {
    if (hasOwn(meta, key)) return meta[key];
  }
  const tail = `.${suffix}`;
  for (const key of Object.keys(meta)) {
    if (key.endsWith(tail)) return meta[key];
  }
  return undefined;
}

const GENERIC_ARCH_PREFIXES = new Set(['general', 'tokenizer', 'llama', 'quantize', 'split', 'clip']);

/**
 * general.architecture；缺失时从 <arch>.context_length / block_count /
 * embedding_length 这类典型键反推。
 */
function getArchitecture(meta) {
  const direct = metaGet(meta, [
    'general.architecture', 'llama.architecture', 'architecture',
    'general.model.architecture',
  ]);
  if (asString(direct)) return direct.trim();
  if (!meta || typeof meta !== 'object') return null;

  const suffixRe = /\.(?:context_length|block_count|embedding_length)$/;
  for (const key of Object.keys(meta)) {
    if (!suffixRe.test(key)) continue;
    const parts = key.split('.');
    if (parts.length === 2) {
      const prefix = parts[0].toLowerCase();
      if (!GENERIC_ARCH_PREFIXES.has(prefix)) return parts[0];
    } else if (parts.length === 3 && parts[0] === 'llama') {
      const prefix = parts[1].toLowerCase();
      if (!GENERIC_ARCH_PREFIXES.has(prefix)) return parts[1];
    }
  }
  return null;
}

function getContextTrain(meta, arch = getArchitecture(meta)) {
  const value = metaGetSuffix(meta, 'context_length', arch);
  return asNumber(value);
}

function getBlockCount(meta, arch = getArchitecture(meta)) {
  const value = metaGetSuffix(meta, 'block_count', arch);
  return asNumber(value);
}

function getEmbeddingLength(meta, arch = getArchitecture(meta)) {
  const value = metaGetSuffix(meta, 'embedding_length', arch);
  return asNumber(value);
}

/**
 * 注意力头数。which='head' 取 attention.head_count，which='kv' 取
 * attention.head_count_kv。值是数组时取最大值（混合注意力模型会按层给数组，
 * 目录摘要只需要一个上界）；需要完整数组用 getHeadCountValues。
 */
function getHeadCountValues(meta, which = 'head', arch = getArchitecture(meta)) {
  const suffix = which === 'kv' || which === 'head_count_kv'
    ? 'attention.head_count_kv'
    : 'attention.head_count';
  const value = metaGetSuffix(meta, suffix, arch);
  if (Array.isArray(value)) {
    const nums = value.map(asNumber).filter((n) => n != null);
    return nums.length ? nums : null;
  }
  const n = asNumber(value);
  return n == null ? null : [n];
}

function getHeadCount(meta, which = 'head', arch = getArchitecture(meta)) {
  const values = getHeadCountValues(meta, which, arch);
  if (!values || !values.length) return null;
  let max = values[0];
  for (let i = 1; i < values.length; i++) {
    if (values[i] > max) max = values[i];
  }
  return max;
}

function getHeadCountKv(meta, arch = getArchitecture(meta)) {
  return getHeadCount(meta, 'kv', arch);
}

/** MoE 专家信息：expert_count / expert_used_count / expert_shared_count。 */
function getExpertInfo(meta, arch = getArchitecture(meta)) {
  const count = asNumber(metaGetSuffix(meta, 'expert_count', arch));
  const used = asNumber(metaGetSuffix(meta, 'expert_used_count', arch));
  const shared = asNumber(metaGetSuffix(meta, 'expert_shared_count', arch));
  if (count == null && used == null && shared == null) return null;
  return { count, used, shared };
}

/** tokenizer.chat_template；没有就返回 null。 */
function getChatTemplate(meta) {
  const direct = metaGet(meta, [
    'tokenizer.chat_template', 'llama.chat_template', 'chat_template',
  ]);
  if (typeof direct === 'string' && direct.length) return direct;
  if (!meta || typeof meta !== 'object') return null;
  for (const key of Object.keys(meta)) {
    if (key.endsWith('.chat_template') && typeof meta[key] === 'string') {
      return meta[key];
    }
  }
  return null;
}

/**
 * 模板里是否有思考/推理标记。这是启发式判断：目录里显示一个“思考”徽章，
 * 不参与任何启动决策。匹配 think / thinking / reasoning / <|think|> 等写法。
 */
function isThinkingTemplate(template) {
  if (typeof template !== 'string' || !template) return false;
  return /<\|think\|>|enable_thinking|reasoning_content|reasoning_effort|\bthink(?:ing)?\b|\breasoning\b/i
    .test(template);
}

function emptySummary(error, sizeBytes) {
  return {
    ok: false,
    arch: null,
    ctxTrain: null,
    blockCount: null,
    experts: null,
    headCount: null,
    headCountKv: null,
    embeddingLength: null,
    thinking: false,
    chatTemplateBytes: 0,
    sizeBytes: sizeBytes == null ? null : sizeBytes,
    version: null,
    tensorCount: null,
    kvCount: null,
    truncated: false,
    error: error || '未知错误',
  };
}

/**
 * 目录条目用的摘要。失败时也返回字段齐全的对象（ok:false），不抛异常。
 * 不返回完整 metadata —— 那可能包含几十万 tokenizer 词条，不该进 IPC。
 */
function describeGguf(filePath, options = {}) {
  const result = readGgufMetadata(filePath, options);
  const sizeBytes = result.fileSize;
  if (!result.ok) return emptySummary(result.error, sizeBytes);

  const meta = result.metadata;
  const arch = getArchitecture(meta);
  const template = getChatTemplate(meta);
  return {
    ok: true,
    arch,
    ctxTrain: getContextTrain(meta, arch),
    blockCount: getBlockCount(meta, arch),
    experts: getExpertInfo(meta, arch),
    headCount: getHeadCount(meta, 'head', arch),
    headCountKv: getHeadCountKv(meta, arch),
    embeddingLength: getEmbeddingLength(meta, arch),
    thinking: isThinkingTemplate(template),
    chatTemplateBytes: template ? Buffer.byteLength(template, 'utf8') : 0,
    sizeBytes,
    version: result.version,
    tensorCount: result.tensorCount,
    kvCount: result.kvCount,
    truncated: !!result.truncated,
    error: null,
  };
}

module.exports = {
  GgufError,
  DEFAULTS,
  VALUE_NAMES,
  readGgufMetadata,
  describeGguf,
  getArchitecture,
  getContextTrain,
  getBlockCount,
  getHeadCount,
  getHeadCountKv,
  getHeadCountValues,
  getEmbeddingLength,
  getExpertInfo,
  getChatTemplate,
  isThinkingTemplate,
};
