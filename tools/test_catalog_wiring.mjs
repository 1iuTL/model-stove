// 目录接线测试：用 electron 桩 + 假 spawn 验证
// “合成 GGUF → 扫描 → catalogue IPC → startServer → stopServer”这条链。
//
// 覆盖点：
//   1. models 目录里的 scan-only 模型被扫到，meta（arch/ctx/层数/专家）正确；
//   2. 同目录 mmproj-Q8_0.gguf 自动配对（只给路径，不读内容）；
//   3. 没有 overrides.bin 时，从 MODEL_STOVE_BUILDS 指向的构建根里找到
//      llama-server.exe（根目录或一层子目录）—— 这是 scan-only 能启动的关键；
//   4. legacy（config.js）条目仍然全部在，id 保持旧值；
//   5. startServer(scanId) 用动态端口 + 假 spawn 成功，argv 的 -m 指向扫描文件；
//   6. stopServer 收干净、台账清空；refreshCatalog 可重扫。
//   7. P4：catalogue 新增 modelRoots/suggestedModelRoot/buildRoots/buildBinary，
//      以及 index.html/preload/main 的静态接线（徽章、引导面板、重新扫描）。
//
// 全部在独立临时目录里跑，结束时恢复环境变量并删目录。
//
// 用法：node tools/test_catalog_wiring.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'model-stove-catalog-'));

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};

// ---------------------------------------------------------------- 合成文件

const MODELS_DIR = path.join(TMP, 'models');
const BUILD_DIR = path.join(TMP, 'build');
fs.mkdirSync(MODELS_DIR, { recursive: true });
fs.mkdirSync(BUILD_DIR, { recursive: true });

const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
};
const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const ggufString = (s) => {
  const body = Buffer.from(s, 'utf8');
  return Buffer.concat([u64(body.length), body]);
};
/** type=8 (string) */
const kvStr = (key, value) => Buffer.concat([ggufString(key), u32(8), ggufString(value)]);
/** type=4 (uint32) */
const kvU32 = (key, value) => Buffer.concat([ggufString(key), u32(4), u32(value)]);

/**
 * 最小 GGUF v3：magic/version/tensor_count=0/kv_count，只有 metadata。
 * 解析器读完 metadata 就返回，不需要张量信息或权重。
 */
function buildSyntheticGguf() {
  const kvs = [
    kvStr('general.architecture', 'qwen35moe'),
    kvU32('qwen35moe.context_length', 262144),
    kvU32('qwen35moe.block_count', 40),
    kvU32('qwen35moe.expert_count', 256),
    kvU32('qwen35moe.expert_used_count', 8),
  ];
  return Buffer.concat([
    Buffer.from('GGUF', 'latin1'),
    u32(3),
    u64(0),            // tensor_count：不需要张量数据
    u64(kvs.length),
    ...kvs,
  ]);
}

const gguf = buildSyntheticGguf();
const scanFile = path.join(MODELS_DIR, 'scan-model.gguf');
const mmprojFile = path.join(MODELS_DIR, 'mmproj-Q8_0.gguf');
const buildExe = path.join(BUILD_DIR, 'llama-server.exe');
fs.writeFileSync(scanFile, gguf);
// mmproj 只做同目录配对，不解析；文本假文件足够。
fs.writeFileSync(mmprojFile, 'fake mmproj binary', 'utf8');
// 假构建：探测（--version/--help）会失败并走兼容模式；spawn 已被下面替换。
fs.writeFileSync(buildExe, 'fake llama-server binary', 'utf8');
// 关掉启动速度探针，避免向假 URL 发长超时请求。
fs.writeFileSync(path.join(TMP, 'settings.json'),
  JSON.stringify({ version: 2, apiKey: '', probe: false }), 'utf8');

// ---------------------------------------------------------------- 假进程

const FAKE_PID = 98654;
let fakeAlive = true;
let spawned = null;

const ports = require('../src/core/ports.js');
const basePort = await ports.findFreePort({ start: 18391, count: 100, host: '127.0.0.1' });

const childProcess = require('node:child_process');
const realSpawn = childProcess.spawn;
childProcess.spawn = function fakeSpawn(exe, args, opts) {
  const child = new EventEmitter();
  spawned = { exe, args, opts, child };
  child.pid = FAKE_PID;
  child.unref = () => {};
  // Supervisor 把 stdout/stderr 接到同一个文件 fd；写一行就绪日志。
  try {
    const fd = opts && opts.stdio && opts.stdio[1];
    if (fd != null) fs.writeSync(fd, 'main: server is listening on http://127.0.0.1:0\n');
  } catch { /* 忽略 */ }
  return child;
};
const realKill = process.kill;
process.kill = function fakeKill(pid, signal) {
  if (pid === FAKE_PID) {
    if (signal === 0) {
      if (!fakeAlive) {
        const err = new Error('fake process gone');
        err.code = 'ESRCH';
        throw err;
      }
      return true;
    }
    fakeAlive = false;
    const c = spawned && spawned.child;
    if (c) setImmediate(() => c.emit('exit', 0, null));
    return true;
  }
  return realKill.call(process, pid, signal);
};

// ---------------------------------------------------------------- Electron 桩

const handlers = new Map();
const fakeApp = {
  whenReady: () => Promise.resolve(),
  getPath: () => TMP,
  on: () => {},
  quit: () => {},
};
const fakeWin = {
  setMenuBarVisibility() {}, loadFile() {}, on() {}, isDestroyed: () => true,
  webContents: { send() {}, isLoadingMainFrame: () => false, once() {} },
};
const electronStub = {
  app: fakeApp,
  BrowserWindow: function BrowserWindow() { return fakeWin; },
  ipcMain: {
    handle: (channel, fn) => {
      if (handlers.has(channel)) throw new Error(`IPC 通道重复注册: ${channel}`);
      handlers.set(channel, fn);
    },
  },
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub;
  return origLoad.call(this, request, parent, isMain);
};

// ---------------------------------------------------------------- 环境

const ENV_KEYS = [
  'MODEL_STOVE_MODELS', 'MODEL_STOVE_BUILDS', 'MODEL_STOVE_HOME',
  'MODEL_STOVE_SETTINGS_DIR', 'MODEL_STOVE_NO_AUTO_PROXY', 'MODEL_STOVE_QUIET',
  'MODEL_STOVE_PORT',
];
const savedEnv = {};
for (const key of ENV_KEYS) savedEnv[key] = process.env[key];

process.env.MODEL_STOVE_MODELS = MODELS_DIR;
process.env.MODEL_STOVE_BUILDS = BUILD_DIR;
process.env.MODEL_STOVE_HOME = TMP;
process.env.MODEL_STOVE_SETTINGS_DIR = TMP;
process.env.MODEL_STOVE_NO_AUTO_PROXY = '1';
process.env.MODEL_STOVE_QUIET = '1';
process.env.MODEL_STOVE_PORT = String(basePort);

/** 大小写无关的路径比较（Windows realpath/大小写不保证一致）。 */
const samePath = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

let main = null;
try {
  console.log('=== 目录接线（合成 GGUF + 假 spawn）===');
  console.log(`  临时目录: ${TMP}  起始端口: ${basePort}`);

  const cfg = require('../src/config.js');
  main = require('../src/main.js');
  // 让 whenReady().then 的微任务跑完（initRuntime 在这里扫描目录）。
  await new Promise((r) => setImmediate(r));

  // ---- 目录摘要 -----------------------------------------------------------
  const summary = main.__test.catalog();
  const expectedLegacyMissing = cfg.MODELS.filter((m) => !fs.existsSync(m.file)).length;
  check('目录摘要：扫描根就是环境变量指定的目录',
    summary.roots.length === 1 && samePath(summary.roots[0], MODELS_DIR), JSON.stringify(summary.roots));
  check('目录摘要：扫描模型 + legacy 合并后条数正确',
    summary.models === cfg.MODELS.length + 1, `${summary.models} vs ${cfg.MODELS.length + 1}`);
  check('目录摘要：有可启动模型', summary.startable >= 1, String(summary.startable));
  check('目录摘要：legacy 缺失计数正确',
    summary.legacyMissing === expectedLegacyMissing,
    `${summary.legacyMissing} vs ${expectedLegacyMissing}`);
  check('目录摘要：没有触发 fallback', summary.fallback === false);

  // ---- catalogue IPC ------------------------------------------------------
  const cat = await handlers.get('catalogue')();
  check('catalogue 返回了 models', Array.isArray(cat.models) && cat.models.length === summary.models,
    `${cat.models && cat.models.length}`);
  // IPC 会 JSON 序列化：这里先自己 stringify 一遍，确保没有 BigInt 漏进去。
  let catJson = '';
  try { catJson = JSON.stringify(cat); } catch (e) { catJson = ''; }
  check('catalogue 可 JSON 序列化（无 BigInt）', catJson.length > 0);

  // ---- P4：目录/构建摘要 -------------------------------------------------
  check('catalogue.modelRoots 含扫描根',
    Array.isArray(cat.modelRoots)
      && cat.modelRoots.some((r) => samePath(r, MODELS_DIR)),
    JSON.stringify(cat.modelRoots));
  check('catalogue.buildRoots 是数组且含构建根',
    Array.isArray(cat.buildRoots)
      && cat.buildRoots.some((r) => samePath(r, BUILD_DIR)),
    JSON.stringify(cat.buildRoots));
  const suggested = cat.suggestedModelRoot;
  check('catalogue.suggestedModelRoot 形状正确（root/source/candidates 数量）',
    !!suggested
      && typeof suggested.root === 'string' && suggested.root.length > 0
      && typeof suggested.source === 'string'
      && Number.isInteger(suggested.candidates) && suggested.candidates >= 0
      && !Array.isArray(suggested.candidates),
    suggested ? JSON.stringify(suggested) : '(null)');
  const buildBinary = cat.buildBinary;
  check('catalogue.buildBinary 形状正确（path:string|null / present:boolean）',
    !!buildBinary
      && (buildBinary.path === null || typeof buildBinary.path === 'string')
      && typeof buildBinary.present === 'boolean',
    buildBinary ? JSON.stringify(buildBinary) : '(null)');
  check('catalogue.buildBinary.present 为 true 时 path 真实存在',
    !!buildBinary && (!buildBinary.present
      || (typeof buildBinary.path === 'string' && fs.existsSync(buildBinary.path))),
    buildBinary ? String(buildBinary.path) : '(null)');

  const scan = cat.models.find((m) => samePath(m.file, scanFile));
  check('catalogue 里出现 scan 条目', !!scan, scan ? scan.id : '(没找到)');
  if (scan) {
    check('scan 条目 source=scan', scan.source === 'scan', String(scan.source));
    check('scan 条目 id 是 sha1(12 位)，不是 legacy id',
      /^[0-9a-f]{12}$/.test(scan.id) && !cfg.MODELS.some((m) => m.id === scan.id), scan.id);
    check('scan 条目 present/binPresent 均为 true',
      scan.present === true && scan.binPresent === true,
      `present=${scan.present} binPresent=${scan.binPresent}`);
    check('scan 条目 meta.arch 解析正确', scan.meta && scan.meta.arch === 'qwen35moe',
      scan.meta ? String(scan.meta.arch) : '(无 meta)');
    check('scan 条目 meta 上下文/层数正确',
      scan.meta && scan.meta.ctxTrain === 262144 && scan.meta.blockCount === 40,
      scan.meta ? `${scan.meta.ctxTrain}/${scan.meta.blockCount}` : '');
    check('scan 条目 meta 专家信息正确',
      scan.meta && scan.meta.experts
      && scan.meta.experts.count === 256 && scan.meta.experts.used === 8,
      scan.meta && scan.meta.experts ? JSON.stringify(scan.meta.experts) : '');
    check('scan 条目 meta 只含安全字段',
      scan.meta && Object.keys(scan.meta).sort().join(',') ===
        'arch,blockCount,chatTemplateBytes,ctxTrain,experts,thinking',
      scan.meta ? Object.keys(scan.meta).sort().join(',') : '');
    check('scan 条目 mmproj 已配对', samePath(scan.mmproj, mmprojFile), String(scan.mmproj));
    check('scan 条目 sizeBytes 正确', scan.sizeBytes === gguf.length,
      `${scan.sizeBytes} vs ${gguf.length}`);
    check('scan 条目默认预设是 text-64k', scan.defaultPreset === 'text-64k', String(scan.defaultPreset));
    check('scan 条目没有 warning', scan.warn === null, String(scan.warn));
  }

  // 现有响应字段一个都不能少（旧界面依赖）。
  const oldKeys = ['id', 'name', 'note', 'file', 'defaultPreset', 'present', 'binPresent',
    'warn', 'safeCtx', 'maxCtx', 'probeTps', 'kvLayers'];
  const newKeys = ['source', 'meta', 'sizeBytes', 'mmproj'];
  check('catalogue 每条都带齐旧字段', cat.models.every((m) => oldKeys.every((k) => k in m)));
  check('catalogue 每条都带齐 P2 新字段', cat.models.every((m) => newKeys.every((k) => k in m)));

  // ---- legacy 条目 --------------------------------------------------------
  const ids = new Set(cat.models.map((m) => m.id));
  const missingLegacy = cfg.MODELS.filter((m) => !ids.has(m.id));
  check('legacy 条目全部保留且 id 不变', missingLegacy.length === 0,
    missingLegacy.map((m) => m.id).join(','));
  const legacy = cat.models.find((m) => m.id === 'qwen38distill-abl');
  check('qwen38distill-abl 仍用旧 id 且 source=legacy',
    !!legacy && legacy.source === 'legacy', legacy ? `${legacy.id}/${legacy.source}` : '(缺失)');

  // ---- 运行时模型对象 -----------------------------------------------------
  const runtime = main.__test.runtimeModels();
  const rtScan = runtime.find((m) => samePath(m.file, scanFile));
  check('runtimeModels：scan 模型解析出构建根里的 llama-server',
    !!rtScan && samePath(rtScan.bin, buildExe), rtScan ? String(rtScan.bin) : '(缺失)');
  check('runtimeModels：scan 模型没有 legacy 字段，safeCtx/maxCtx 为 null（交给 UI 回落）',
    !!rtScan && rtScan.legacyId === null && rtScan.safeCtx === null && rtScan.maxCtx === null);
  const rtLegacy = runtime.find((m) => m.id === 'qwen38distill-abl');
  check('runtimeModels：legacy 模型保留旧 id 与 legacyId',
    !!rtLegacy && rtLegacy.legacyId === 'qwen38distill-abl',
    rtLegacy ? String(rtLegacy.legacyId) : '(缺失)');
  // 用 config.js 里的值做基准，不写死 ncm 档位：档位会随实测调整
  //（2026-10-19 因 b11669 下 160K 溢出，ncm 从 23 改成了 24）。
  const cfgLegacy = cfg.MODELS.find((m) => m.id === 'qwen38distill-abl');
  check('runtimeModels：legacy 的 extraArgs/probeTps 从 overrides 取',
    !!rtLegacy && Array.isArray(rtLegacy.extraArgs)
      && JSON.stringify(rtLegacy.extraArgs) === JSON.stringify(cfgLegacy.extraArgs)
      && rtLegacy.probeTps === cfgLegacy.probeTps,
    rtLegacy ? `${JSON.stringify(rtLegacy.extraArgs)} probeTps=${rtLegacy.probeTps}` : '');

  // ---- 启动 / 停止 --------------------------------------------------------
  const result = await main.__test.startServer(scan.id, 'text-32k', null, false, null, null, 'q4_0');
  check('startServer 返回 URL', /^http:\/\/127\.0\.0\.1:\d+\/$/.test(result.url), result.url);
  check('端口来自 Supervisor（不是写死的 8091）',
    Number.isInteger(result.port) && result.port === basePort, String(result.port));
  check('scan 模型用的是构建根里的假 llama-server',
    !!spawned && samePath(spawned.exe, buildExe), spawned ? spawned.exe : '');
  const argv = spawned ? spawned.args : [];
  check('argv 的 -m 指向扫描到的 GGUF',
    argv[argv.indexOf('-m') + 1] === scanFile, argv[argv.indexOf('-m') + 1]);
  check('argv 的 --port 与 Supervisor 选中端口一致',
    argv[argv.indexOf('--port') + 1] === String(result.port), String(argv[argv.indexOf('--port') + 1]));
  check('默认只绑 127.0.0.1', argv[argv.indexOf('--host') + 1] === '127.0.0.1',
    argv[argv.indexOf('--host') + 1]);
  check('startServer 返回运行时 id', result.modelId === scan.id, String(result.modelId));

  // status 里 modelId 继续用运行时 id，并带上 meta。
  const status = await handlers.get('status')();
  check('status.modelId 是运行时 id', status.modelId === scan.id, String(status.modelId));
  check('status.modelName 来自扫描名', status.modelName === 'scan-model', String(status.modelName));
  check('status.meta.arch 正确', status.meta && status.meta.arch === 'qwen35moe',
    status.meta ? String(status.meta.arch) : '(无 meta)');

  const stopped = await main.__test.stopServer();
  check('stopServer 停掉了假进程', stopped.stopped.includes(FAKE_PID), JSON.stringify(stopped));
  check('停止后 Supervisor 回到 idle', main.__test.runtime().supervisor.state === 'idle',
    main.__test.runtime().supervisor.state);
  check('进程确实被标记为退出', fakeAlive === false);
  const ledger = ports.readLedger(path.join(TMP, 'logs', 'running-pids.json'));
  check('台账已清空', ledger.length === 0, JSON.stringify(ledger));

  // ---- 刷新 / 未知 id -----------------------------------------------------
  check('__test.refreshCatalog 是函数', typeof main.__test.refreshCatalog === 'function');
  const refreshed = await handlers.get('catalogue:refresh')();
  check('catalogue:refresh 返回摘要且仍发现同一模型',
    refreshed.models === summary.models && refreshed.startable >= 1,
    `${refreshed.models} / ${refreshed.startable}`);

  // ---- P4：UI / preload / main 静态接线 ---------------------------------
  const html = fs.readFileSync(path.join(REPO, 'src', 'index.html'), 'utf8');
  const guideIds = ['modelGuide', 'guideStats', 'guideMissing', 'guideRoot', 'guideBuild', 'btnRescan'];
  const absentGuideIds = guideIds.filter((id) => !html.includes(`id="${id}"`));
  check('index.html 包含缺失引导面板的全部 id',
    absentGuideIds.length === 0, absentGuideIds.join(','));

  const inlineScript = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1]).join('\n');
  const badgeHooks = ['modelBadgeItems', 'appendModelBadges', 'renderGuide', 'rescanCatalogue'];
  check('index.html 内联脚本包含徽章/引导渲染函数',
    badgeHooks.every((name) => inlineScript.includes(`function ${name}`)),
    badgeHooks.filter((name) => !inlineScript.includes(`function ${name}`)).join(','));
  check('index.html 有徽章样式与徽章容器',
    html.includes('.badge {') && inlineScript.includes("wrap.className = 'badges'"));
  const referenced = new Set([...inlineScript.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
  const missingRefs = [...referenced].filter((id) => !html.includes(`id="${id}"`));
  check('内联脚本 $(id) 引用的元素都存在',
    missingRefs.length === 0, missingRefs.join(','));

  const preloadSrc = fs.readFileSync(path.join(REPO, 'src', 'preload.js'), 'utf8');
  check('preload 暴露 refreshCatalogue → catalogue:refresh',
    /refreshCatalogue\s*:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('catalogue:refresh'\)/.test(preloadSrc));
  const mainSrc = fs.readFileSync(path.join(REPO, 'src', 'main.js'), 'utf8');
  check('main.js 注册 catalogue:refresh IPC',
    /ipcMain\.handle\('catalogue:refresh'/.test(mainSrc));
  check('main.js catalogue 返回 P4 四个新字段',
    ['modelRoots', 'suggestedModelRoot', 'buildRoots', 'buildBinary']
      .every((key) => new RegExp(`\\b${key}\\s*:`).test(mainSrc)));

  let unknownErr = null;
  const spawnedBeforeUnknown = spawned;
  try {
    await main.__test.startServer('__no_such_model__', 'text-32k');
  } catch (e) {
    unknownErr = e;
  }
  check('未知模型 id 报错且不 spawn',
    !!unknownErr && /未知的模型标识/.test(unknownErr.message) && spawned === spawnedBeforeUnknown,
    unknownErr ? unknownErr.message : '(没有报错)');
} catch (e) {
  check('测试执行无异常', false, e && e.message ? e.message : String(e));
  console.log(e && e.stack ? e.stack : e);
} finally {
  try { await main?.__test.stopServer(); } catch {}
  childProcess.spawn = realSpawn;
  process.kill = realKill;
  Module._load = origLoad;
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
}

console.log(failed === 0 ? '\n全部通过' : `\n有 ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
