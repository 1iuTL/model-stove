// 模型目录层：把“磁盘上的 GGUF”变成外壳可用的 catalog。
//
// 分工：
//   scanModelRoots(roots)  递归找 .gguf（默认 3 层），同目录 mmproj 自动配对，
//                          realpath 去重；坏目录只记 warning，不抛错。
//   buildCatalog(entries)  调 gguf.describeGguf() 读头，补 id/name/quantization，
//                          应用用户 overrides，输出统一条目结构。
//   importLegacyConfig()   把旧 src/config.js 的 MODELS 映射成条目；旧字段
//                          （safeCtx/probeTps/extraArgs/bin/temp/...）原样放进
//                          overrides，文件不存在也保留（available:false）。
//   mergeCatalog()         按 realpath 合并 scan 与 legacy；旧条目覆盖名字/字段，
//                          scan 没发现的旧条目保留，最后按 name 稳定排序。
//   discoverCatalog()      上面四步的组合，返回 { models, roots, warnings, scannedAt }。
//
// 设计约束：
//   - 纯 Node、无第三方依赖；fs 可注入，测试只碰临时目录；
//   - 单个坏文件不能影响整个目录列表：解析失败也保留条目（available:true），
//     附带 error 与 warning；
//   - id 用 sha1(规范化 realpath).slice(0,12)，同一文件在多次扫描中稳定；
//   - 排序不依赖 locale（localeCompare 的结果会随机器 ICU 变化），
//     统一按 name 小写、原文、id 依次比较。
const fsDefault = require('fs');
const path = require('path');
const crypto = require('crypto');
const gguf = require('./gguf');

const DEFAULT_MAX_DEPTH = 3;
const IGNORED_DIRS = new Set(['.parts', '.tmp']);
const MMPROJ_RE = /^mmproj.*\.gguf$/i;
const Q8_0_RE = /q8_0/i;

// 旧配置里要保留为用户覆盖的字段。顺序仅用于文档，实际按对象键写入。
const LEGACY_OVERRIDE_FIELDS = Object.freeze([
  'safeCtx', 'maxCtx', 'probeTps', 'bin', 'extraArgs', 'temp', 'topP', 'topK',
  'mmproj', 'kvLayers', 'defaultPreset', 'name', 'note',
]);

// 文件名末尾的量化后缀：Model-Q4_K_M.gguf / Model.Q8_0.gguf / Model-IQ2_XXS.gguf
const QUANT_SUFFIX_RE = /[-_.](I?Q\d+(?:_[A-Z0-9]+)*|BF16|MXFP4|F16|F32|F64)$/i;

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function hasOwn(obj, key) {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

function toText(value) {
  return value == null ? '' : String(value).trim();
}

/** Windows 路径大小写不敏感；去重/哈希前统一。 */
function normalizeKey(filePath) {
  const abs = path.resolve(String(filePath || ''));
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

function safeRealpath(fsImpl, filePath) {
  try {
    return fsImpl.realpathSync(filePath);
  } catch {
    return null;
  }
}

/** 条目的规范化键：优先 realpath（同一文件经不同根/符号链接进来时才能合并）。 */
function entryKey(entry) {
  if (!entry) return '';
  return normalizeKey(entry.realPath || entry.file || '');
}

function hashId(entry) {
  return crypto.createHash('sha1').update(entryKey(entry)).digest('hex').slice(0, 12);
}

function compareText(a, b) {
  const sa = toText(a);
  const sb = toText(b);
  const la = sa.toLowerCase();
  const lb = sb.toLowerCase();
  if (la < lb) return -1;
  if (la > lb) return 1;
  if (sa < sb) return -1;
  if (sa > sb) return 1;
  return 0;
}

/** 稳定排序：先 name，再 id；与系统 locale 无关。 */
function sortModels(models) {
  return (models || []).slice().sort((a, b) => (
    compareText(a && a.name, b && b.name) || compareText(a && a.id, b && b.id)
  ));
}

function stripGgufExt(fileName) {
  return String(fileName || '').replace(/\.gguf$/i, '');
}

/** 去掉文件名末尾的量化后缀，得到更干净的显示名。 */
function stripQuantSuffix(name) {
  const base = stripGgufExt(name);
  const stripped = base.replace(QUANT_SUFFIX_RE, '');
  return stripped || base;
}

/** 从文件名提取量化标签（如 Q4_K_M / Q8_0 / F16）；没有就返回 null。 */
function detectQuantization(fileName) {
  const base = stripGgufExt(fileName);
  const match = QUANT_SUFFIX_RE.exec(base);
  return match ? match[1].toUpperCase() : null;
}

// ---------------------------------------------------------------- 覆盖项

/**
 * 在 options.overrides 里找某个条目的覆盖项。
 *
 * 支持两种写法：
 *   - 数组：[{ file|path|id: '...', name: '...', mmproj: '...' }, ...]
 *   - 映射：{ '<realpath 或 id>': { name, mmproj, ... }, ... }
 */
function matchOverrideTarget(target, info) {
  const text = toText(target);
  if (!text) return false;
  if (text === info.id) return true;
  if (info.file && text === info.file) return true;
  if (info.realPath && text === info.realPath) return true;
  try {
    const key = normalizeKey(text);
    if (key === info.key) return true;
    if (info.file && key === normalizeKey(info.file)) return true;
    if (info.realPath && key === normalizeKey(info.realPath)) return true;
  } catch {
    return false;
  }
  return false;
}

function normalizeOverride(value) {
  if (!isPlainObject(value)) return null;
  const out = { ...value };
  // 匹配用的字段不进 overrides，避免和业务字段混淆。
  delete out.file;
  delete out.path;
  delete out.id;
  return out;
}

function findOverride(overrides, info) {
  if (!overrides) return null;
  if (Array.isArray(overrides)) {
    for (const item of overrides) {
      if (!isPlainObject(item)) continue;
      const target = item.file || item.path || item.id;
      if (target && matchOverrideTarget(target, info)) return normalizeOverride(item);
    }
    return null;
  }
  if (isPlainObject(overrides)) {
    for (const [target, value] of Object.entries(overrides)) {
      if (matchOverrideTarget(target, info)) return normalizeOverride(value);
    }
  }
  return null;
}

/** options.nameOf 支持函数或“路径/id -> 名字”的映射。 */
function resolveCustomName(nameOf, info, fallback) {
  if (typeof nameOf === 'function') {
    try {
      const value = nameOf({ ...info, defaultName: fallback });
      if (typeof value === 'string' && value.trim()) return value.trim();
    } catch {
      // 用户回调抛错不应影响目录构建。
    }
    return fallback;
  }
  if (isPlainObject(nameOf)) {
    for (const [target, value] of Object.entries(nameOf)) {
      if (typeof value === 'string' && value.trim() && matchOverrideTarget(target, info)) {
        return value.trim();
      }
    }
  }
  return fallback;
}

function statFile(fsImpl, file) {
  try {
    return fsImpl.statSync(file);
  } catch {
    return null;
  }
}

function fileExists(fsImpl, file) {
  try {
    return typeof fsImpl.existsSync === 'function' ? !!fsImpl.existsSync(file) : true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- 扫描

function compareDirent(a, b) {
  return compareText(a && a.name, b && b.name);
}

/**
 * 递归扫描模型根。
 *
 * 深度语义：根目录里的文件算 0 层；子目录 1 层……默认 maxDepth=3 表示
 * 最多进到第 3 层子目录（第 4 层及更深不扫）。
 *
 * 忽略规则：
 *   - 名字以 . 开头的文件/目录（隐藏）；
 *   - 目录 .parts / .tmp；
 *   - 文件 *.part / *.tmp；
 *   - mmproj*.gguf：不作为独立模型，只作为同目录模型的视觉投影候选。
 *
 * 返回 { entries, roots, warnings }。entries 至少含
 * { file, dir, realPath, sizeBytes, mmproj }；metadata 留给 buildCatalog 解析。
 */
function scanModelRoots(roots, options = {}) {
  const fsImpl = options.fs || fsDefault;
  const maxDepth = Number.isInteger(options.maxDepth)
    ? Math.max(0, options.maxDepth)
    : DEFAULT_MAX_DEPTH;
  const warnings = Array.isArray(options.warnings) ? options.warnings : [];
  const warn = (warning) => {
    warnings.push(warning);
    if (typeof options.onWarning === 'function') {
      try { options.onWarning(warning); } catch { /* 回调错误忽略 */ }
    }
  };

  const rawRoots = Array.isArray(roots) ? roots : (roots == null ? [] : [roots]);
  const resolvedRoots = [];
  const seenRoots = new Set();
  const visitedDirs = new Set();
  const seenFiles = new Set();
  const entries = [];

  const pickMmproj = (list) => {
    if (!list.length) return null;
    const sorted = list.slice().sort(compareText);
    const chosen = sorted.find((p) => Q8_0_RE.test(path.basename(p))) || sorted[0];
    return safeRealpath(fsImpl, chosen) || chosen;
  };

  const addModel = (file, dir, mmprojCandidates) => {
    const realPath = safeRealpath(fsImpl, file);
    if (!realPath) {
      warn({
        code: 'file-unreadable',
        file,
        message: `无法解析模型文件路径（可能是坏符号链接）: ${file}`,
      });
      return;
    }
    const key = normalizeKey(realPath);
    if (seenFiles.has(key)) return; // 同一个文件经不同根/链接出现时只留一次
    const stat = statFile(fsImpl, file);
    if (!stat || (typeof stat.isFile === 'function' && !stat.isFile())) {
      warn({
        code: 'file-unreadable',
        file,
        message: `无法读取模型文件信息: ${file}`,
      });
      return;
    }
    seenFiles.add(key);
    entries.push({
      file,
      dir,
      realPath,
      sizeBytes: Number(stat.size) || 0,
      mmproj: pickMmproj(mmprojCandidates),
    });
  };

  const walk = (dir, depth) => {
    const dirKey = normalizeKey(safeRealpath(fsImpl, dir) || dir);
    if (visitedDirs.has(dirKey)) return; // 防符号链接环 + 重叠根重复扫描
    visitedDirs.add(dirKey);

    let dirents;
    try {
      dirents = fsImpl.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      warn({
        code: 'scan-error',
        dir,
        message: `无法读取模型目录 ${dir}: ${e.message}`,
      });
      return;
    }
    dirents = dirents.slice().sort(compareDirent);

    const modelFiles = [];
    const mmprojCandidates = [];
    const subdirs = [];

    for (const dirent of dirents) {
      const name = String(dirent && dirent.name || '');
      if (!name || name.startsWith('.')) continue; // hidden
      const full = path.join(dir, name);
      let isDir = typeof dirent.isDirectory === 'function' ? dirent.isDirectory() : false;
      let isFile = typeof dirent.isFile === 'function' ? dirent.isFile() : false;

      // 符号链接按目标类型处理；坏链接记 warning 后跳过。
      if (typeof dirent.isSymbolicLink === 'function' && dirent.isSymbolicLink()) {
        const st = statFile(fsImpl, full);
        if (!st) {
          warn({
            code: 'file-unreadable',
            file: full,
            message: `无法读取符号链接目标: ${full}`,
          });
          continue;
        }
        isDir = typeof st.isDirectory === 'function' ? st.isDirectory() : false;
        isFile = typeof st.isFile === 'function' ? st.isFile() : false;
      }

      if (isDir) {
        if (!IGNORED_DIRS.has(name.toLowerCase())) subdirs.push(full);
        continue;
      }
      if (!isFile) continue;

      const lower = name.toLowerCase();
      if (lower.endsWith('.part') || lower.endsWith('.tmp')) continue;
      if (MMPROJ_RE.test(name)) {
        mmprojCandidates.push(full);
        continue;
      }
      if (!lower.endsWith('.gguf')) continue;
      modelFiles.push(full);
    }

    for (const file of modelFiles) addModel(file, dir, mmprojCandidates);

    if (depth < maxDepth) {
      for (const subdir of subdirs) walk(subdir, depth + 1);
    }
  };

  for (const raw of rawRoots) {
    const text = toText(raw);
    if (!text) continue;
    const root = path.resolve(text);
    const rootKey = normalizeKey(root);
    if (seenRoots.has(rootKey)) continue;
    seenRoots.add(rootKey);
    resolvedRoots.push(root);

    const stat = statFile(fsImpl, root);
    if (!stat) {
      warn({
        code: 'root-missing',
        root,
        message: `模型根不存在或不可访问: ${root}`,
      });
      continue;
    }
    if (typeof stat.isDirectory === 'function' && !stat.isDirectory()) {
      warn({
        code: 'root-not-directory',
        root,
        message: `模型根不是目录: ${root}`,
      });
      continue;
    }
    walk(root, 0);
  }

  return { entries, roots: resolvedRoots, warnings };
}

// ---------------------------------------------------------------- 构建目录

function readOptionsFrom(options) {
  const out = { ...(options.ggufOptions || {}) };
  for (const key of ['chunkSize', 'maxMetaBytes', 'maxStringBytes', 'maxKeyBytes', 'maxArrayItems', 'maxKvCount']) {
    if (options[key] !== undefined && out[key] === undefined) out[key] = options[key];
  }
  return out;
}

/**
 * 把扫描条目补成统一 catalog 结构。
 *
 * 返回数组；坏文件的 metadata 解析失败不会丢条目：
 *   { ..., available:true, error:'...', arch:null, ... }
 * 同时向 options.warnings 里追加 { code:'metadata-error', file, message }。
 */
function buildCatalog(entries, options = {}) {
  const fsImpl = options.fs || fsDefault;
  const describe = typeof options.describe === 'function'
    ? options.describe
    : gguf.describeGguf;
  const warnings = Array.isArray(options.warnings) ? options.warnings : [];
  const warn = (warning) => {
    warnings.push(warning);
    if (typeof options.onWarning === 'function') {
      try { options.onWarning(warning); } catch { /* ignore */ }
    }
  };
  const readOptions = readOptionsFrom(options);
  const overrides = options.overrides;
  const nameOf = options.nameOf;
  const models = [];

  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || !entry.file) continue;
    const file = path.resolve(String(entry.file));
    const realPath = entry.realPath ? path.resolve(entry.realPath) : (safeRealpath(fsImpl, file) || file);
    const key = normalizeKey(realPath);
    const id = hashId({ realPath, file });
    const baseName = path.basename(file);
    const defaultName = stripQuantSuffix(baseName);
    const info = {
      key, id, file, realPath, baseName, defaultName,
      dir: entry.dir ? path.resolve(entry.dir) : path.dirname(file),
    };
    const override = findOverride(overrides, info);
    const name = resolveCustomName(
      nameOf,
      info,
      (override && typeof override.name === 'string' && override.name.trim())
        ? override.name.trim()
        : defaultName,
    );

    let sizeBytes = Number.isFinite(entry.sizeBytes) ? entry.sizeBytes : null;
    if (sizeBytes == null) {
      const st = statFile(fsImpl, file);
      sizeBytes = st && Number.isFinite(Number(st.size)) ? Number(st.size) : null;
    }
    const available = entry.available !== false && fileExists(fsImpl, file);

    let desc;
    try {
      desc = describe(file, readOptions);
    } catch (e) {
      desc = { ok: false, error: e && e.message ? e.message : String(e) };
    }
    if (!desc || typeof desc !== 'object') desc = { ok: false, error: '解析器未返回结果' };
    if (!desc.ok) {
      warn({
        code: 'metadata-error',
        file,
        message: `无法读取 GGUF 元数据: ${desc.error || '未知错误'}`,
      });
    }

    let mmproj = entry.mmproj ? path.resolve(String(entry.mmproj)) : null;
    if (override && override.mmproj) mmproj = path.resolve(String(override.mmproj));

    const catalogEntry = {
      id,
      name,
      file,
      dir: info.dir,
      realPath,
      sizeBytes,
      mmproj,
      arch: desc.ok ? (desc.arch || null) : null,
      ctxTrain: desc.ok ? (desc.ctxTrain == null ? null : desc.ctxTrain) : null,
      blockCount: desc.ok ? (desc.blockCount == null ? null : desc.blockCount) : null,
      experts: desc.ok ? (desc.experts || null) : null,
      thinking: !!(desc.ok && desc.thinking),
      quantization: detectQuantization(baseName),
      available,
      source: 'scan',
      overrides: override || {},
      // 以下字段不进任务指定的最小结构，但对界面/后续 P2 接线有用。
      headCount: desc.ok ? (desc.headCount == null ? null : desc.headCount) : null,
      headCountKv: desc.ok ? (desc.headCountKv == null ? null : desc.headCountKv) : null,
      embeddingLength: desc.ok ? (desc.embeddingLength == null ? null : desc.embeddingLength) : null,
      chatTemplateBytes: desc.ok ? (desc.chatTemplateBytes || 0) : 0,
      note: override && typeof override.note === 'string' ? override.note : null,
      error: desc.ok ? null : (desc.error || '未知错误'),
      gguf: desc.ok ? {
        version: desc.version,
        tensorCount: desc.tensorCount,
        kvCount: desc.kvCount,
        truncated: !!desc.truncated,
      } : null,
    };
    models.push(catalogEntry);
  }

  return sortModels(models);
}

// ---------------------------------------------------------------- 旧配置

/**
 * 把 src/config.js 的 MODELS 映射为 catalog 条目。
 *
 * 旧字段（safeCtx/maxCtx/probeTps/bin/extraArgs/temp/topP/topK/mmproj/
 * kvLayers/defaultPreset/name/note）全部保留在 overrides 里 —— 它们是用户
 * 实测出来的配置，不能因为文件暂时不在就丢掉。
 *
 * 文件不存在时 available:false，但条目仍然返回；旧 id 记在 overrides.legacyId。
 */
function importLegacyConfig(legacyModels, options = {}) {
  const fsImpl = options.fs || fsDefault;
  const out = [];

  for (const model of Array.isArray(legacyModels) ? legacyModels : []) {
    if (!isPlainObject(model)) continue;
    const rawFile = toText(model.file);
    if (!rawFile) continue; // 没有文件路径的条目无法展示
    const file = path.resolve(rawFile);

    let realPath = null;
    let sizeBytes = null;
    let available = false;
    if (fileExists(fsImpl, file)) {
      realPath = safeRealpath(fsImpl, file);
      const stat = statFile(fsImpl, file);
      if (stat && (typeof stat.isFile !== 'function' || stat.isFile())) {
        available = true;
        sizeBytes = Number.isFinite(Number(stat.size)) ? Number(stat.size) : null;
      }
    }

    const key = normalizeKey(realPath || file);
    const baseName = path.basename(file);
    const defaultName = stripQuantSuffix(baseName);
    const overrides = {};
    for (const field of LEGACY_OVERRIDE_FIELDS) {
      if (model[field] !== undefined) overrides[field] = model[field];
    }
    if (isPlainObject(overrides.safeCtx)) overrides.safeCtx = { ...overrides.safeCtx };
    if (isPlainObject(overrides.kvLayers)) overrides.kvLayers = { ...overrides.kvLayers };
    if (Array.isArray(overrides.extraArgs)) overrides.extraArgs = overrides.extraArgs.slice();
    if (model.id) overrides.legacyId = model.id;

    out.push({
      id: hashId({ file, realPath }),
      name: (typeof model.name === 'string' && model.name.trim())
        ? model.name.trim()
        : defaultName,
      file,
      dir: path.dirname(file),
      realPath: realPath || null,
      sizeBytes,
      mmproj: toText(model.mmproj) ? path.resolve(toText(model.mmproj)) : null,
      arch: null,
      ctxTrain: null,
      blockCount: null,
      experts: null,
      thinking: false,
      quantization: detectQuantization(baseName),
      available,
      source: 'legacy',
      legacy: true,
      legacyId: model.id || null,
      overrides,
      headCount: null,
      headCountKv: null,
      embeddingLength: null,
      chatTemplateBytes: 0,
      note: typeof model.note === 'string' ? model.note : null,
      error: available ? null : '文件不存在',
      gguf: null,
    });
  }

  return sortModels(out);
}

// ---------------------------------------------------------------- 合并

/**
 * 按 realpath 合并扫描结果与旧配置。
 *
 * 规则：
 *   - scan 命中的文件：保留 scan 的 id/元数据/available，legacy 的 name/note/
 *     mmproj 与全部 overrides 覆盖上去；source 仍是 'scan'，另标 legacy:true。
 *   - scan 没发现、legacy 仍存在的文件：保留 legacy 条目（available:false），
 *     绝不丢弃用户实测配置。
 *   - 排序按 name（小写→原文→id），结果确定。
 */
function mergeCatalog(scanEntries, legacyEntries, options = {}) {
  const merged = [];
  const index = new Map();

  const put = (entry) => {
    const key = entryKey(entry);
    if (!key) return;
    if (index.has(key)) {
      const at = index.get(key);
      const base = merged[at];
      const baseOverrides = isPlainObject(base.overrides) ? base.overrides : {};
      const legacyOverrides = isPlainObject(entry.overrides) ? entry.overrides : {};
      const nextOverrides = { ...legacyOverrides, ...baseOverrides };
      merged[at] = {
        ...base,
        name: (baseOverrides.name && String(baseOverrides.name).trim())
          || entry.name
          || base.name,
        note: entry.note || base.note || null,
        mmproj: baseOverrides.mmproj || legacyOverrides.mmproj || base.mmproj || entry.mmproj || null,
        overrides: nextOverrides,
        legacy: true,
        legacyId: legacyOverrides.legacyId || base.legacyId || null,
      };
      return;
    }
    index.set(key, merged.length);
    merged.push({ ...entry, overrides: { ...(isPlainObject(entry.overrides) ? entry.overrides : {}) } });
  };

  for (const entry of Array.isArray(scanEntries) ? scanEntries : []) put(entry);
  for (const entry of Array.isArray(legacyEntries) ? legacyEntries : []) {
    const key = entryKey(entry);
    if (index.has(key)) {
      put(entry); // 走上面的合并分支
      continue;
    }
    // scan 没发现：应用一次显式 overrides，然后原样保留（available:false 也保留）。
    const info = {
      key,
      id: entry.id,
      file: entry.file,
      realPath: entry.realPath || null,
      baseName: path.basename(entry.file || ''),
      defaultName: entry.name,
    };
    const override = findOverride(options.overrides, info);
    if (override) {
      const overrides = { ...(isPlainObject(entry.overrides) ? entry.overrides : {}), ...override };
      put({
        ...entry,
        name: (typeof override.name === 'string' && override.name.trim()) ? override.name.trim() : entry.name,
        mmproj: override.mmproj ? path.resolve(String(override.mmproj)) : entry.mmproj,
        overrides,
      });
    } else {
      put(entry);
    }
  }

  return sortModels(merged);
}

// ---------------------------------------------------------------- 一站式

function normalizeRoots(roots) {
  const list = Array.isArray(roots) ? roots : (roots == null ? [] : [roots]);
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const text = toText(raw);
    if (!text) continue;
    const abs = path.resolve(text);
    const key = normalizeKey(abs);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(abs);
  }
  return out;
}

function isoNow(now) {
  const date = now === undefined ? new Date() : new Date(now);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

/**
 * 扫描 + 解析 + 旧配置合并。永远不抛异常（意外错误进 warnings）。
 *
 * options:
 *   roots         模型根数组（字符串也接受）
 *   legacyModels  旧 config.MODELS
 *   overrides     显式覆盖（见 findOverride）
 *   nameOf        显示名覆盖（函数或映射）
 *   maxDepth      扫描深度（默认 3）
 *   maxMetaBytes / maxArrayItems / ...  透传给 gguf 解析器
 *   fs / describe  测试注入
 *   now           扫描时间（测试可注入固定值）
 *
 * 返回 { models, roots, warnings, scannedAt }。
 */
function discoverCatalog(options = {}) {
  const warnings = [];
  const roots = normalizeRoots(options.roots);
  const baseOptions = { ...options, warnings };
  let scan = { entries: [], roots, warnings };
  let scanModels = [];
  let legacyModels = [];
  let models = [];

  try {
    scan = scanModelRoots(roots, baseOptions);
  } catch (e) {
    warnings.push({
      code: 'scan-error',
      message: `扫描模型根时发生意外错误: ${e && e.message ? e.message : String(e)}`,
    });
  }

  try {
    scanModels = buildCatalog(scan.entries, baseOptions);
  } catch (e) {
    warnings.push({
      code: 'catalog-error',
      message: `构建模型目录时发生意外错误: ${e && e.message ? e.message : String(e)}`,
    });
  }

  try {
    legacyModels = importLegacyConfig(options.legacyModels, baseOptions);
  } catch (e) {
    warnings.push({
      code: 'legacy-error',
      message: `导入旧配置时发生意外错误: ${e && e.message ? e.message : String(e)}`,
    });
  }

  try {
    models = mergeCatalog(scanModels, legacyModels, baseOptions);
  } catch (e) {
    warnings.push({
      code: 'merge-error',
      message: `合并模型目录时发生意外错误: ${e && e.message ? e.message : String(e)}`,
    });
  }

  return {
    models,
    roots: Array.isArray(scan.roots) && scan.roots.length ? scan.roots : roots,
    warnings,
    scannedAt: isoNow(options.now),
  };
}

module.exports = {
  DEFAULT_MAX_DEPTH,
  LEGACY_OVERRIDE_FIELDS,
  scanModelRoots,
  buildCatalog,
  importLegacyConfig,
  mergeCatalog,
  discoverCatalog,
  // 下面这些导出主要给测试与后续接线复用。
  stripQuantSuffix,
  detectQuantization,
  normalizeKey,
  hashId,
};
