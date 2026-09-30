// model-stove —— 一个围绕 llama-server 的极简 Electron 外壳。
//
// 职责:
//   1. 选一个模型 + 预设(以及思考强度)
//   2. 用正确的参数拉起对应的 llama-server 构建
//   3. 轮询 /health,等它返回 200
//   4. 在主区域加载服务自带的 Web UI
//   5. 停止 / 切换 / 退出时把子进程收干净
//
// 聊天界面本身来自 llama.cpp;这个外壳只负责管理它。
const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');

const { MODELS, PRESETS, REASONING, REASONING_BUDGETS, DEFAULT_REASONING_BUDGET, buildArgs, PROXY_PORT, PROXY_BASE, CTX_STEPS, VRAM_CEILING_MIB, KV_TYPES, DEFAULT_KV, safeCtxFor, resolveKv } = require('./config');
const { probeSpeed } = require('./probe');
const settings = require('./settings');

const PORT = 8091;
const BASE = `http://127.0.0.1:${PORT}`;

const REPO_ROOT = path.join(__dirname, '..');
const PROXY_SCRIPT = path.join(REPO_ROOT, 'context-proxy.mjs');

let win = null;
let child = null;
// 未运行时的状态。收成一个常量,免得三处各写一份、改漏一处。
const EMPTY_CURRENT = { modelId: null, preset: null, reasoning: null, budget: null, ctx: null, kv: null, speed: null, lanMode: false, startedAt: null };
let current = { ...EMPTY_CURRENT };
let logFile = null;

// 子进程的输出写进文件,而不是管道。
// Node 默认的管道 stdio 会打开匿名管道,某些沙箱会拒绝;而管道一旦失败,
// 整个 Electron 主进程会被原生崩溃带走。重定向没有这两个问题,
// 而且我们仍然可以读取这个文件来喂日志面板。
const LOG_DIR = path.join(__dirname, '..', 'logs');

// ---------------------------------------------------------------- 工具函数

/** 读取日志文件末尾若干行。 */
function readLogTail(maxLines = 250) {
  if (!logFile) return [];
  try {
    const text = fs.readFileSync(logFile, 'utf8');
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}

/** 发一个 GET,把结果收敛成 { ok, status, body } —— 连不上不抛异常。 */
function httpGet(url, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode, body }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, body: '' }); });
    req.on('error', () => resolve({ ok: false, status: 0, body: '' }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询 /health 直到就绪。模型加载通常 30-60 秒,给足 5 分钟。 */
async function waitForHealth(timeoutMs = 300000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (!child) return false;
    const r = await httpGet(`${BASE}/health`, 2000);
    if (r.ok) return true;
    await sleep(1200);
  }
  return false;
}

function modelExists(model) {
  try { return fs.existsSync(model.file); } catch { return false; }
}

function binExists(model) {
  try { return fs.existsSync(model.bin); } catch { return false; }
}

// ------------------------------------------------------------ 启动速度探针
//
// 实现搬到了 src/probe.js —— 那边不依赖 electron,可以被真实服务器测到。
// 这里只负责"什么时候跑、结果放哪、界面怎么知道"。
//
// 探针跑在后台,不阻塞 startServer() 返回:界面先显示"运行中",几秒后状态栏
// 再补上速度与结论。探测期间会占用那唯一的槽位(-np 1),但用户的第一条消息
// 本来也要付这次 CUDA 图构建的钱,所以净成本是零。
//
// 用户可以在设置里关掉(settings.probe === false)。
function runProbe(model) {
  const s = settings.readSettings();
  if (s.probe === false) return;
  current.speed = { pending: true };
  notifyRenderer();
  // apiKey:上游开了鉴权时探针也要带,否则 401 → 界面「实测速度 未取得」
  probeSpeed(BASE, model, { alive: () => !!child, apiKey: (settings.readSettings().apiKey || '').trim() })
    .then((res) => {
      if (!child) return;                       // 服务已经停了,别乱写状态
      current.speed = res || { failed: true };
      try {
        fs.appendFileSync(logFile,
          `[shell] 速度探针:${res ? res.tps + ' tok/s (基线 ' + res.expected +
            (res.spilled ? ',判定溢出)' : ',正常)') : '未取得结果'}\n`);
      } catch {}
      notifyRenderer();
    })
    .catch(() => { if (child) { current.speed = { failed: true }; notifyRenderer(); } });
}

/**
 * 判断一个地址是不是"手机热点"的网卡。
 *
 * Windows 自带移动热点固定用 192.168.137.0/24 这一段,网卡名通常形如
 * "本地连接* N"。命中它就几乎可以确定:手机连上热点后正是走这个地址。
 */
function looksLikeHotspot(name, address) {
  if (/^192\.168\.137\./.test(address)) return true;
  // 中文系统的热点虚拟网卡名;也认一下英文的
  return /本地连接\s*\*|Local Area Connection\s*\*|Microsoft Wi-Fi Direct/i.test(name);
}

/**
 * 列出本机可用的 IPv4 地址,给「手机怎么连」那块界面用。
 *
 * 会同时给出好几个,因为这台机器经常同时挂着 WiFi、有线、以及热点虚拟网卡,
 * 而**哪个能通取决于手机连的是哪个网络** —— 光看名字猜不出来,所以全列出来
 * 让用户自己试。跳过回环地址(手机连不上 127.0.0.1)和已断开的网卡。
 *
 * 但**顺序很重要**:界面上第一个地址会被编进二维码,而手机大概率是连热点。
 * 所以热点网卡必须排在前面,否则二维码会指到校园网那个地址上 —— 手机
 * 在热点上根本连不到,表现就是一直转圈。
 *
 * 返回项里的 recommended 供界面打标,别让用户自己猜该扫哪个。
 */
function localAddresses(port) {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs || []) {
      // Node 18+ 的 family 是数字 4,老版本是字符串 'IPv4'。两种都认。
      const isV4 = a.family === 4 || a.family === 'IPv4';
      if (!isV4 || a.internal) continue;
      out.push({
        name,
        address: a.address,
        url: `http://${a.address}:${port}/`,
        recommended: looksLikeHotspot(name, a.address),
      });
    }
  }
  // recommended 排前面。同组内保持系统给的顺序,行为可预期。
  out.sort((x, y) => (y.recommended ? 1 : 0) - (x.recommended ? 1 : 0));
  return out;
}

/**
 * 找出正在监听某个端口的进程 PID。
 *
 * 为什么需要它:停止按钮原来只能停掉"本外壳 spawn 过的"那个子进程。可现实里
 * 8091 上跑的可能是**别的来源**起的 llama-server(手动起的、脚本起的、
 * 调试时起的)——这时点「停止」是空操作,界面却还显示"运行中",因为
 * `/health` 确实能通。实测就这么留下一只占着 7.3 GB 显存的幽灵服务,
 * 关掉软件再打开也照样"运行中"。
 *
 * 用 netstat 而不是 PowerShell 的 Get-NetTCPConnection:后者在非提权下会被拒。
 * stdio 接文件 —— 这个仓库里所有子进程调用都不能用管道。
 */
function pidOnPort(port) {
  const tmp = path.join(LOG_DIR, `_netstat-${process.pid}.txt`);
  let fd;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fd = fs.openSync(tmp, 'w');
  } catch { return null; }
  try {
    execFileSync('netstat', ['-ano', '-p', 'TCP'], {
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      timeout: 15000,
    });
  } catch { /* 命令失败时按"查不到"处理 */ }
  try { fs.closeSync(fd); } catch { /* 已关 */ }
  let text = '';
  try { text = fs.readFileSync(tmp, 'utf8'); } catch { /* 没读到 */ }
  try { fs.unlinkSync(tmp); } catch { /* 删不掉无所谓 */ }

  // 只认 LISTENING 那一行。TIME_WAIT 的本地地址也带端口,但 PID 是 0。
  const re = new RegExp(`^\\s*TCP\\s+\\S+:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)\\s*$`, 'i');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(re);
    if (m) return Number(m[1]);
  }
  return null;
}

/** 温和停掉一个进程:先 kill,8 秒不退就强杀。 */
function killPid(pid, graceMs = 8000) {
  return new Promise((resolve) => {
    let dead = false;
    const done = () => { if (!dead) { dead = true; resolve(); } };
    try { process.kill(pid); } catch { return done(); }   // 已经没了
    const t = setTimeout(() => {
      try { process.kill(pid, 'SIGKILL'); } catch { /* 已经没了 */ }
      done();
    }, graceMs);
    // 轮询确认它真的走了;process.kill(pid, 0) 只是探活,不会真的发信号
    const tick = setInterval(() => {
      try {
        process.kill(pid, 0);
      } catch {
        clearInterval(tick);
        clearTimeout(t);
        done();
      }
    }, 250);
  });
}

// ------------------------------------------------------------------ 进程

/**
 * 停掉当前服务。
 *
 * 两个来源都要覆盖:
 *   1. `child` —— 本外壳 spawn 的(正常路径)
 *   2. 端口上实际监听的那个 —— 可能是外部起的(`child` 为 null 时)
 * 少任何一个,都会出现"点了停止但服务还在跑"。
 */
function stopServer() {
  return new Promise((resolve) => {
    const tracked = child;
    child = null;
    current = { ...EMPTY_CURRENT };

    // 先把可能的外部监听者也找出来。注意要在动手杀之前查,否则端口一空就查不到了。
    const adopted = tracked ? null : pidOnPort(PORT);

    const pids = [];
    if (tracked && tracked.pid) pids.push(tracked.pid);
    if (adopted) pids.push(adopted);

    // 台账只留仍然活着的;这样万一外壳中途退出,下次启动还能收掉它们。
    writeLedger(pids);

    if (!pids.length) return resolve({ stopped: [] });

    if (tracked) { try { tracked.kill(); } catch { /* 已经没了 */ } }

    Promise.all(pids.map((pid) => killPid(pid))).then(() => {
      writeLedger([]);
      if (adopted) {
        console.log(`[shell] 停止:8091 上的监听者不是本外壳启动的,PID ${adopted} 已结束`);
      }
      resolve({ stopped: pids, adopted: !!adopted });
    });
  });
}

/**
 * 外壳自己 spawn 过的服务进程的 PID 台账。
 *
 * 为什么需要:子进程用 detached 启动(外壳崩了它也能活,这是有意的),
 * 但外壳重启后 `child` 变量是 null,stopServer() 就成了空操作 ——
 * 旧进程永远留着。实测后果很严重:两个 llama-server 同时抢 8 GB 显存,
 * 第二个被挤到系统内存,生成速度从 43 t/s 掉到 3.5 t/s;而且旧的那个会
 * 变成"进程活着但不监听端口"的僵尸,手机连上去只会一直转圈。
 *
 * 为什么用台账而不是查进程表:查进程表要么依赖 WMI(受限环境里查不到),
 * 要么按进程名匹配 —— 那就可能连**用户自己在别的端口上手动跑的服务**一起
 * 杀掉。台账只记录我们自己启动过的 PID,精确且不会误伤。
 * PID 会被系统复用,但配合"启动时清理"这个时机,风险可以忽略。
 */
function ledgerPath() {
  return path.join(LOG_DIR, 'running-pids.json');
}

function readLedger() {
  try {
    const v = JSON.parse(fs.readFileSync(ledgerPath(), 'utf8'));
    return Array.isArray(v) ? v.filter((n) => Number.isInteger(n) && n > 0) : [];
  } catch {
    return [];
  }
}

function writeLedger(pids) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.writeFileSync(ledgerPath(), JSON.stringify(pids), 'utf8');
  } catch { /* 台账写不了也不该阻断服务 */ }
}

/**
 * 清掉外壳上次遗留的服务进程。
 * 只看台账里记过的 PID,因此绝不会碰到用户手动启动的 llama-server。
 */
function killLeftoverServers() {
  const pids = readLedger();
  const killed = [];
  for (const pid of pids) {
    try {
      process.kill(pid);
      killed.push(pid);
    } catch { /* 已经不在了,正常 */ }
  }
  writeLedger([]);
  if (killed.length) console.log(`[shell] 清掉了 ${killed.length} 个上次遗留的服务进程: ${killed.join(', ')}`);
  return killed;
}

/** 拉起服务并等它就绪。
 *  reasoningKey 为 null/空时**不传** --reasoning-effort,由模型模板或界面自行决定。
 *  lanMode 为 true 时监听 0.0.0.0,手机等其它设备才能连上。
 *  apiKey 从本地设置里读,非空则加 --api-key 给所有接口上锁。
 *  ctx 是上下文滑块的取值(token)。null/空 => 用预设自带的 ctx。
 *  kv 是 KV cache 精度键名('q4_0' / 'q8_0'),非法值回落到默认。
 *  两者的合法性都由 config.js 的 buildArgs() 统一裁决 —— 界面只是提出意向,
 *  不做为最终决定,免得"漏校验一次 = 静默慢 8 倍"。 */
async function startServer(modelId, presetKey, reasoningKey, lanMode, budgetKey, ctx, kv) {
  await stopServer();

  const model = MODELS.find((m) => m.id === modelId);
  if (!model) throw new Error(`未知的模型标识: ${modelId}`);
  if (!modelExists(model)) throw new Error(`模型文件不存在:\n${model.file}`);
  if (!binExists(model)) throw new Error(`llama-server 不存在:\n${model.bin}`);

  // 外壳重启后 stopServer() 是空操作,先按台账清掉上次遗留的进程再占显存。
  killLeftoverServers();

  const apiKey = (settings.readSettings().apiKey || '').trim();
  const args = buildArgs(model, presetKey, PORT, reasoningKey, lanMode, apiKey, budgetKey, { ctx, kv });

  fs.mkdirSync(LOG_DIR, { recursive: true });
  logFile = path.join(LOG_DIR, `shell-${modelId}.log`);
  // 日志要能给人看,但 Key 不该留在磁盘上明晃晃摆着。
  // 只替换显示用的这一份,真正传给进程的 argv 不动。
  const shown = args.map((a, i) => (i > 0 && args[i - 1] === '--api-key' ? '<已隐藏>' : a));
  const banner = `[shell] ${new Date().toISOString()}\n[shell] ${model.bin}\n[shell] ${shown.join(' ')}\n`;
  fs.writeFileSync(logFile, banner, 'utf8');
  const out = fs.openSync(logFile, 'a');

  // detached: 外壳崩了子进程也能活,而不是被一起带走。
  // stdio 走文件,永远不走管道。
  child = spawn(model.bin, args, {
    windowsHide: true,
    detached: true,
    stdio: ['ignore', out, out],
  });
  // 记进 current 的是**真正生效**的值,不是界面传进来的意向值 ——
  // buildArgs() 可能把它吸附到了别的档位、或把非法 KV 键名回落成了默认,
  // 状态栏必须显示实际值。
  const ctxIdx = args.indexOf('-c');
  const effectiveCtx = ctxIdx >= 0 ? Number(args[ctxIdx + 1]) : null;
  const kIdx = args.indexOf('-ctk');
  const effectiveKv = kIdx >= 0 ? args[kIdx + 1] : null;
  current = { modelId, preset: presetKey, reasoning: reasoningKey || null, budget: budgetKey || null, ctx: effectiveCtx, kv: effectiveKv, speed: null, lanMode: !!lanMode, startedAt: Date.now() };

  // 记进台账:万一外壳非正常退出,下次启动能靠它把这个进程收掉。
  if (child.pid) writeLedger([child.pid]);

  // 子进程已经有自己的句柄了;我们继续持有会每次启动漏一个 fd。
  try { fs.closeSync(out); } catch {}
  try { child.unref(); } catch {}

  child.on('error', (err) => {
    try { fs.appendFileSync(logFile, `[shell] 启动子进程失败: ${err.message}\n`); } catch {}
  });

  child.on('exit', (code) => {
    try { fs.appendFileSync(logFile, `[shell] 服务退出,code=${code}\n`); } catch {}
    writeLedger([]);
    if (child) { child = null; current = { ...EMPTY_CURRENT }; }
    notifyRenderer();
  });

  const ok = await waitForHealth();
  if (!ok) {
    const tail = readLogTail(14).join('\n');
    await stopServer();
    throw new Error(`服务启动失败或超时。日志末尾:\n${tail}`);
  }
  try { fs.appendFileSync(logFile, '[shell] 服务就绪\n'); } catch {}

  // 局域网模式下顺手确保代理也在跑。
  //
  // 不做成"代理跟着服务一起停":代理很轻,而且停掉它只会让手机连到
  // 一个没有档位/没有压缩的地址。让它活着,服务不在时它会如实返回 502。
  if (lanMode) {
    try {
      const pr = await startProxy();
      if (!pr.ok) {
        // 代理起不来不能让整个服务启动失败 —— 8051 本身是可用的。
        try { fs.appendFileSync(logFile, `[shell] 代理未能启动:${pr.error || '(未知)'}\n`); } catch {}
      }
    } catch (e) {
      try { fs.appendFileSync(logFile, `[shell] 代理启动异常:${e.message}\n`); } catch {}
    }
  }

  // 探针放最后、且不 await —— 它要花二三十秒建 CUDA 图,不该拖住"启动完成"。
  // 界面先显示运行中,结果出来后再由 notifyRenderer 补上速度那一行。
  runProbe(model);

  return { url: `${BASE}/`, modelId, preset: presetKey, reasoning: current.reasoning, budget: current.budget, ctx: current.ctx, kv: current.kv, lanMode: current.lanMode };
}

// ------------------------------------------------------------------ 渲染层

function notifyRenderer() {
  if (win && !win.isDestroyed()) win.webContents.send('state-changed');
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 940,
    minHeight: 620,
    backgroundColor: '#14161a',
    title: 'Model Stove · 模型灶台',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,      // 右侧主区域是一个指向 llama-server 的 <webview>
      spellcheck: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'index.html'));
  win.on('closed', () => { win = null; });
}

// --------------------------------------------------------------------- IPC

ipcMain.handle('catalogue', () => ({
  models: MODELS.map((m) => ({
    id: m.id,
    name: m.name,
    note: m.note,
    file: m.file,
    defaultPreset: m.defaultPreset,
    present: modelExists(m),
    binPresent: binExists(m),
    warn: m.warn || null,
    // 上下文滑块的边界,按 KV 精度分别给:
    //   safeCtx  { q4_0: N, q8_0: M } —— 本机实测"不会溢出"的值(见 config.js)
    //   maxCtx   模型自身声明的上限
    // safeCtx 比 maxCtx 小,而且随 KV 精度变化(精度越高 KV 越大、装得越少),
    // 所以整对象传过去,由界面按当前选中的 KV 精度取值 —— 这样拖动 KV 选择器
    // 时安全区能立刻联动,不需要再走一次 IPC。
    safeCtx: m.safeCtx || null,
    maxCtx: m.maxCtx || null,
    probeTps: m.probeTps || null,
    // 混合注意力里"多少层带 KV cache" —— 界面用它生成解释文案,
    // 而不是把某一种模型的层数写死在 HTML 里(那已经错过一次了)。
    kvLayers: m.kvLayers || null,
  })),
  presets: Object.entries(PRESETS).map(([k, v]) => ({
    key: k, label: v.label, hint: v.hint, ctx: v.ctx, vision: v.vision,
  })),
  ctxSteps: CTX_STEPS,
  kvTypes: KV_TYPES,
  defaultKv: DEFAULT_KV,
  // 仅作参考信息:本机观测到的显存分配天花板。**不要**拿它当溢出判据 ——
  // 溢出的配置和满速的配置显存读数可以完全一样(见 config.js 的说明)。
  vramCeilingMiB: VRAM_CEILING_MIB,
  reasoning: Object.entries(REASONING).map(([k, v]) => ({
    key: k, label: v.label, hint: v.hint, flag: v.flag,
  })),
  budgets: REASONING_BUDGETS.map((b) => ({
    key: b.key, label: b.label, hint: b.hint, value: b.value,
  })),
  defaultBudget: DEFAULT_REASONING_BUDGET,
  port: PORT,
}));

// ------------------------------------------------------------------ 设置 / 局域网

/**
 * 设置面板与「手机访问」面板需要的全部东西。
 *
 * 刻意把 API Key **明文**回传给界面:用户要把它念给/粘到手机上,
 * 遮起来就没法用了。这是本机自己的界面,不存在"泄露给第三方"。
 */
ipcMain.handle('settings:get', () => {
  const s = settings.readSettings();
  return {
    apiKey: s.apiKey || '',
    lanMode: !!s.lanMode,
    // 启动速度探针的开关。默认开 —— 它是唯一能抓出"KV 溢出到内存"的手段,
    // 而那个故障是静默的。关掉只影响"要不要花几十秒探测",不影响使用。
    probe: s.probe !== false,
    addresses: localAddresses(PORT),
  };
});

ipcMain.handle('settings:set', (_e, patch) => {
  const clean = {};
  if (typeof patch?.apiKey === 'string') clean.apiKey = patch.apiKey.trim();
  if (typeof patch?.lanMode === 'boolean') clean.lanMode = patch.lanMode;
  if (typeof patch?.probe === 'boolean') clean.probe = patch.probe;
  settings.writeSettings(clean);
  const s = settings.readSettings();
  return { ok: true, apiKey: s.apiKey || '', lanMode: !!s.lanMode, probe: s.probe !== false };
});

ipcMain.handle('settings:genkey', () => {
  const key = settings.generateApiKey();
  settings.writeSettings({ apiKey: key });
  return { ok: true, apiKey: key };
});

/** 网卡可能中途插拔(开热点就会多一个),所以地址要能刷新。 */
ipcMain.handle('net:addresses', () => localAddresses(PORT));

ipcMain.handle('start', async (_e, { modelId, preset, reasoning, lanMode, budget, ctx, kv }) => {
  try {
    const r = await startServer(modelId, preset, reasoning, lanMode, budget, ctx, kv);
    return { ok: true, ...r };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('stop', async () => {
  const r = await stopServer();
  return { ok: true, ...r };
});

ipcMain.handle('status', async () => {
  const health = await httpGet(`${BASE}/health`, 1500);
  const slots = await httpGet(`${BASE}/slots`, 1500);
  let ctx = null;
  if (slots.ok) {
    try { ctx = JSON.parse(slots.body)[0]?.n_ctx ?? null; } catch {}
  }
  const model = MODELS.find((m) => m.id === current.modelId) || null;
  // health.ok 只说明"8091 上有东西在应答",不代表它是本外壳管的。
  // 这两件事必须分开,否则会出现"界面显示运行中,但停止按钮点不动" ——
  // 实测就是这么留下一只占着 7.3 GB 显存的幽灵服务。
  const managed = !!child;
  return {
    running: health.ok,
    managed,
    // 在跑但不是我们管的时候,如实报出来,界面才能提示"点停止会一并收掉它"
    external: health.ok && !managed,
    modelId: current.modelId,
    modelName: model ? model.name : null,
    preset: current.preset,
    reasoning: current.reasoning,
    budget: current.budget,
    lanMode: current.lanMode,
    ctx,
    kv: current.kv,
    speed: current.speed,
    uptimeSec: current.startedAt ? Math.floor((Date.now() - current.startedAt) / 1000) : 0,
    url: health.ok ? `${BASE}/` : null,
  };
});

ipcMain.handle('logs', () => readLogTail(250));

// ------------------------------------------------------------------ 代理(档位 / 压缩)

/**
 * 与压缩代理通信。
 *
 * 代理是独立进程 —— 它必须在**请求层**改写采样参数,而外壳不该去碰
 * llama.cpp 的界面逻辑。所以这里只做一件事:代界面转发 /_bridge 的读写。
 *
 * 代理没起来时必须明确区分"没在跑"和"出错",否则界面只能干瞪眼。
 */
async function proxyRequest(method, path, body) {
  const url = `${PROXY_BASE}${path}`;
  try {
    const init = { method, signal: AbortSignal.timeout(6000) };
    if (body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    const r = await fetch(url, init);
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    return { ok: r.ok, status: r.status, data: json, raw: json ? undefined : text.slice(0, 300) };
  } catch (e) {
    const cause = e.cause ? (e.cause.code || e.cause.message) : e.message;
    // 连不上就是"代理没启动",这是最常见的状态,单独标出来
    return { ok: false, offline: true, error: cause };
  }
}

ipcMain.handle('proxy:status', async () => {
  // 代理进程的生命周期信息也一并带回去:界面要据此显示"启动/停止代理"
  // 按钮,以及"防火墙可能没放行"这个提示。
  const r = await proxyRequest('GET', '/_bridge/status');
  const lifecycle = {
    managed: proxyState.managed,
    external: proxyState.external,
    childPid: proxyChild ? proxyChild.pid : null,
    restarts: proxyState.restarts,
    lastExitCode: proxyState.lastExitCode,
    lastError: proxyState.lastError,
    startedAt: proxyState.startedAt,
    node: proxyNodeExe || findNodeExe(),
  };
  return { ...r, port: PROXY_PORT, lifecycle };
});

ipcMain.handle('proxy:start', async () => {
  try { return await startProxy(); } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('proxy:stop', async () => {
  try { const r = await stopProxy(); return { ok: true, ...r }; } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('proxy:firewallStatus', () => firewallStatus());

ipcMain.handle('proxy:allowFirewall', () => {
  try { return launchFirewallHelper(); } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('proxy:setProfile', async (_e, key) => {
  const r = await proxyRequest('POST', '/_bridge/config', { profile: key });
  if (r.offline) return { ok: false, offline: true, error: r.error };
  return r.ok ? { ok: true, ...r.data } : { ok: false, error: r.data?.error || r.raw || `HTTP ${r.status}` };
});

ipcMain.handle('proxy:setCompression', async (_e, enabled) => {
  const r = await proxyRequest('POST', '/_bridge/config', { enabled: !!enabled });
  if (r.offline) return { ok: false, offline: true, error: r.error };
  return r.ok ? { ok: true, ...r.data } : { ok: false, error: r.data?.error || r.raw || `HTTP ${r.status}` };
});

// ------------------------------------------------- 代理进程的托管(起停/重启/放行)

/**
 * 为什么外壳要管代理的生死。
 *
 * 代理原先是纯手工程序(`node context-proxy.mjs`),结果是三类故障反复出现:
 *   1. 忘了启动 -> 界面显示"代理未启动",二维码退回 8091,档位与压缩静默失效
 *   2. 代理崩了没人管 -> 手机连 8092 一直转圈
 *   3. 端口进不来 -> 防火墙的入站允许规则**按配置文件生效**,而防火墙默认
 *      BlockInbound。手机热点时段本机被判为 Public,这时能不能连进来取决于
 *      对应程序有没有 Public 入站规则。加规则只能提权,所以给一个按钮。
 *
 * 这里要留一条纠错记录:我曾经断言"node.exe 一条入站规则都没有",并据此把
 * "手机卡在加载"归因于防火墙。**那是错的** —— 它来自解析 netsh 的本地化输出
 * (中文 Windows 上是"规则名称:"而不是 "Rule Name",永远匹配不上)。查注册表
 * 才知道 node.exe 早有 2 条 Node.js JavaScript Runtime 规则。真正的直接原因
 * 是服务当时根本没在监听。详见 tools/firewall-rules.ps1 的说明。
 *
 * 注意代理仍然是**独立进程**,不是塞进外壳:档位要在请求层改写采样参数,
 * 而外壳不该去碰 llama.cpp 的界面逻辑。这里只是替用户记住它的生命周期。
 */
let proxyChild = null;
let proxyIntentionalStop = false;
let proxyNodeExe = null;
// 正在进行中的启动。见 startProxy 开头的说明:没有它,两处并发调用会各起一个。
let proxyStartInFlight = null;
const proxyState = {
  // true 表示这个代理是本外壳拉起来的,因而也由本外壳负责停掉
  managed: false,
  // 是否有一个**非本外壳启动**的代理正在服务(例如你手动跑的)
  external: false,
  restarts: 0,
  windowStart: Date.now(),
  lastExitCode: null,
  lastError: null,
  startedAt: null,
};

function proxyLedgerPath() {
  return path.join(LOG_DIR, 'running-proxy-pid.json');
}

function readProxyLedger() {
  try {
    const v = JSON.parse(fs.readFileSync(proxyLedgerPath(), 'utf8'));
    return Array.isArray(v) ? v.filter((n) => Number.isInteger(n) && n > 0) : [];
  } catch {
    return [];
  }
}

function writeProxyLedger(pids) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.writeFileSync(proxyLedgerPath(), JSON.stringify(pids), 'utf8');
  } catch { /* 台账写不了不该阻断代理 */ }
}

/**
 * 清掉外壳上次遗留的代理进程。
 *
 * 单独一份台账文件(而不是和 llama-server 共用 running-pids.json):
 * 共用的话,startServer() 里的 killLeftoverServers() 顺手就把代理杀了 ——
 * 那正是要避免的互相误伤。
 */
function killLeftoverProxy() {
  const killed = [];
  for (const pid of readProxyLedger()) {
    try { process.kill(pid); killed.push(pid); } catch { /* 已经不在了 */ }
  }
  writeProxyLedger([]);
  if (killed.length) console.log(`[shell] 清掉了 ${killed.length} 个上次遗留的代理进程: ${killed.join(', ')}`);
  return killed;
}

/** 端口上是否真的有东西在监听。用来区分"代理没起"和"端口被占"。 */
function tcpProbe(port, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; try { s.destroy(); } catch {} resolve(v); } };
    s.setTimeout(timeoutMs);
    s.on('connect', () => done(true));
    s.on('timeout', () => done(false));
    s.on('error', () => done(false));
  });
}

/** 找 node.exe。代理是 .mjs,只能用 node 跑(不是 Electron 的进程内模块)。 */
function findNodeExe() {
  const cands = [];
  if (process.env.MODEL_STOVE_NODE) cands.push(process.env.MODEL_STOVE_NODE);
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const lad = process.env.LOCALAPPDATA;
  cands.push(path.join(pf, 'nodejs', 'node.exe'));
  cands.push(path.join(pf86, 'nodejs', 'node.exe'));
  if (lad) cands.push(path.join(lad, 'Programs', 'nodejs', 'node.exe'));
  if (lad) cands.push(path.join(lad, 'Programs', 'node', 'node.exe'));
  for (const c of cands) {
    try { if (c && fs.existsSync(c)) return c; } catch { /* 继续找 */ }
  }
  return null;
}

/** 跑一个外部命令并把输出收进临时文件(不用管道)。 */
function runCapture(exe, args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let out;
    try {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      out = path.join(LOG_DIR, `_run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.log`);
    } catch { return resolve({ ok: false, text: '' }); }
    let fd;
    try { fd = fs.openSync(out, 'w'); } catch { return resolve({ ok: false, text: '' }); }
    let p;
    try {
      p = spawn(exe, args, { windowsHide: true, stdio: ['ignore', fd, fd] });
    } catch (e) {
      try { fs.closeSync(fd); } catch {}
      return resolve({ ok: false, text: '', error: e.message });
    }
    try { fs.closeSync(fd); } catch {}
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      let text = '';
      try { text = fs.readFileSync(out, 'utf8'); } catch {}
      try { fs.unlinkSync(out); } catch {}
      resolve({ ...r, text });
    };
    const t = setTimeout(() => { try { p.kill(); } catch {} ; finish({ ok: false, error: 'timeout' }); }, timeoutMs);
    p.on('error', (e) => { clearTimeout(t); finish({ ok: false, error: e.message }); });
    p.on('exit', (code) => { clearTimeout(t); finish({ ok: code === 0 }); });
  });
}

/**
 * 查防火墙里有没有放行我们需要的入站规则。
 *
 * 读**注册表**,而不是解析 netsh 的输出。这不是洁癖,是踩出来的:
 *
 *   1. netsh 的输出是**本地化**的。中文 Windows 上字段标签是
 *      "规则名称:"/"已启用:"/"操作:",所以任何匹配 "Rule Name" 的代码
 *      永远不命中,会把"规则存在"误判成"不存在"。这个错误导致我一度
 *      给出了错误的故障结论,所以判据本身必须可靠。
 *   2. 这台机器上 netsh 的查询**自相矛盾**:`show rule name="X"` 能查到,
 *      而 `show rule name=all` 里数不到它(实测 node.exe:按名字查到,
 *      按 all 数到 0 行)。连个数都不能信。
 *   3. PowerShell 的 `Get-NetFirewallRule` 在**非提权**环境下返回 0 条规则,
 *      所以它也不能用来给界面做自检。
 *
 * 注册表则稳定:语言无关、非提权可读、内容就是规则的权威定义。
 * 规则值形如 `v2.33|Action=Allow|Active=TRUE|Dir=In|App=C:\...|Name=X|`,
 * 注意**没有 Profile 段就表示三个配置文件全适用**。
 *
 * 这个查询**不需要管理员**,所以界面可以随时自检。
 */
const FW_RULE_KEYS = [
  'HKLM\\SYSTEM\\CurrentControlSet\\Services\\SharedAccess\\Parameters\\FirewallPolicy\\FirewallRules',
];

/** 我们要检查的两个程序。名字只用于展示,判据是 program 路径。 */
const FW_RULES = [
  { key: 'node', name: 'Model Stove proxy (node)', program: 'C:\\Program Files\\nodejs\\node.exe' },
  {
    key: 'app',
    name: 'Model Stove app (electron)',
    program: path.join(REPO_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
  },
];

/** 读出所有防火墙规则条目(不筛选),返回字符串数组。 */
function readFirewallRuleValues() {
  const out = [];
  const tmp = path.join(LOG_DIR, `_fwrules-${process.pid}.txt`);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch { /* 目录建不了就直接放弃 */ }

  for (const key of FW_RULE_KEYS) {
    let fd;
    try { fd = fs.openSync(tmp, 'w'); } catch { return out; }
    try {
      // 必须把 stdout 接**文件**。
      //
      // Node 的 execFile/execFileSync 默认用管道,而受限环境里打开匿名管道
      // 会被拒(实测 `spawnSync reg EPERM`)。所以这里显式把 fd 传进 stdio ——
      // 这样既保住了同步语义(启动路径上的自检不该让主进程异步等待),
      // 又不碰管道。这个仓库里所有子进程调用都是因此改成文件重定向的。
      execFileSync('reg', ['query', key], {
        stdio: ['ignore', fd, fd],
        windowsHide: true,
        timeout: 20000,
      });
    } catch { /* 读不到就当查不出来 */ }
    try { fs.closeSync(fd); } catch { /* 已经关了 */ }

    let text = '';
    try { text = fs.readFileSync(tmp, 'utf8'); } catch { /* 没读到就当空 */ }
    try { fs.unlinkSync(tmp); } catch { /* 删不掉无所谓 */ }

    for (const line of text.split(/\r?\n/)) {
      // reg query 的输出形如(`·` 表示空格):
      //   ····{GUID}····REG_SZ····v2.33|Action=Allow|...
      //   ····Model·Stove·proxy·(node)····REG_SZ····v2.33|...
      //
      // 这里有个坑:不能用 `\s{2,}` 当分隔符,因为 `\s` 包含换行符,
      // 而 `.*?` 遇到换行就停 —— 结果是整个正则一条都匹配不上(实测解析出 0 条)。
      // 值名和类型之间固定是 4 个空格,直接写死。
      const m = line.match(/^\s{4}(.+?)\s{4}REG_SZ\s{4}(.*)$/);
      if (m) out.push(m[2].trim());
    }
  }
  return out;
}

/** 按需要检查的程序列表,判断每个是否已被入站放行。 */
async function firewallStatus() {
  const values = readFirewallRuleValues();
  const out = {};
  for (const r of FW_RULES) {
    // 只认"入站 + 允许 + 已启用"的规则 —— 这才是"能不能连进来"的判据
    //
    // ⚠️ 路径比较必须**忽略大小写**。Windows 路径本身不区分大小写,而注册表里
    // 存的大小写并不统一 —— 实测原有的两条 Node.js 规则写的是
    // `C:\program files\nodejs\node.exe`(小写 p),而我们的配置是
    // `C:\Program Files\...`。用区分大小写的 includes 会把它们判成"不存在",
    // 这正是当初"node.exe 一条规则都没有"那个错误结论的来源之一。
    const needle = r.program.toLowerCase();
    const hit = values.filter((v) => {
      const f = {};
      for (const seg of v.split('|')) {
        const m = seg.match(/^([A-Za-z]+)=(.*)$/);
        if (m) f[m[1]] = m[2];
      }
      if (!f.App || !f.App.toLowerCase().includes(needle)) return false;
      return f.Dir === 'In' && f.Action === 'Allow' && f.Active === 'TRUE';
    });
    out[r.key] = {
      name: r.name,
      program: r.program,
      present: hit.length > 0,
      count: hit.length,
      // 把命中的规则名一并带回去:界面想说清"是靠哪条规则放行的"
      rules: hit.map((v) => {
        const m = v.match(/\|Name=([^|]*)/);
        return m ? m[1] : '(未命名)';
      }),
    };
  }
  out._source = values.length ? 'registry' : 'unavailable';
  return out;
}

/**
 * 拉起代理(幂等)。已经有一个能应答的代理就直接认领,不再重复起。
 *
 * 三种情形必须区分开,否则界面只能说"连不上":
 *   端口空闲            -> 自己起一个
 *   端口有东西且能应答  -> 认领为 external(可能是你手动跑的),可用
 *   端口有东西但不能应答-> 端口冲突,明确报错
 *
 * 关于 proxyStartInFlight:函数中间有 await(探端口、等就绪),所以**两次
 * 并发调用会双双通过"端口空闲"检查**,然后各 spawn 一个 —— 后一个抢不到
 * 8092 会 EADDRINUSE 退出,又触发自动重起,日志里看着像代理在反复崩。
 * 实测就是这么发现的:测试脚本的显式调用和 app.whenReady() 里的自动调用
 * 同时发生,结果第一次调用的返回值变成 already:true。
 * 所以这里把"正在启动"这件事本身也做成可等待的。
 */
function startProxy() {
  if (proxyChild) return Promise.resolve({ ok: true, already: true, managed: true });
  if (proxyStartInFlight) return proxyStartInFlight;

  proxyStartInFlight = (async () => {
    // 先看端口上有没有现成的代理
    if (await tcpProbe(PROXY_PORT)) {
      const r = await proxyRequest('GET', '/_bridge/status');
      if (r.ok) {
        proxyState.external = true;
        proxyState.managed = false;
        proxyState.lastError = null;
        return { ok: true, external: true };
      }
      const msg = `端口 ${PROXY_PORT} 被占用,但应答的不是代理。请先关掉占用它的程序。`;
      proxyState.lastError = msg;
      return { ok: false, error: msg, portBusy: true };
    }

    if (!fs.existsSync(PROXY_SCRIPT)) {
      const msg = `找不到代理脚本:${PROXY_SCRIPT}`;
      proxyState.lastError = msg;
      return { ok: false, error: msg };
    }

    killLeftoverProxy();

    const nodeExe = findNodeExe();
    if (!nodeExe) {
      const msg = '没找到 node.exe。代理是 .mjs,需要 Node.js 才能跑 —— 装上 Node 或设置 MODEL_STOVE_NODE。';
      proxyState.lastError = msg;
      return { ok: false, error: msg };
    }
    proxyNodeExe = nodeExe;

    fs.mkdirSync(LOG_DIR, { recursive: true });
    const proxyLog = path.join(LOG_DIR, 'context-proxy.log');
    const fd = fs.openSync(proxyLog, 'a');
    proxyIntentionalStop = false;

    let p;
    try {
      p = spawn(nodeExe, [PROXY_SCRIPT], {
        windowsHide: true,
        detached: true,
        cwd: REPO_ROOT,
        // ⚠ 2026-09-30:必须把 API key 一起传给代理。代理**自己**会发起两类上游请求:
        //   ① 读 /props 拿真实 n_ctx  ② 开了自动压缩时调 /v1/chat/completions。
        //   以前只传了 UPSTREAM 地址,于是这两条全部 401:
        //     · 界面「上下文」永远显示 —(一直用 65536 兜底,压缩阈值跟着算错)
        //     · 自动压缩直接失败
        //   日志里每 15 秒一条 `unauthorized: Invalid API Key` 就是它。
        env: {
          ...process.env,
          PROXY_PORT: String(PROXY_PORT),
          UPSTREAM: BASE,
          UPSTREAM_KEY: (settings.readSettings().apiKey || '').trim(),
        },
        stdio: ['ignore', fd, fd],
      });
    } catch (e) {
      try { fs.closeSync(fd); } catch {}
      proxyState.lastError = e.message;
      return { ok: false, error: e.message };
    }
    try { fs.closeSync(fd); } catch {}
    proxyChild = p;
    proxyState.managed = true;
    proxyState.external = false;
    proxyState.startedAt = Date.now();
    if (p.pid) writeProxyLedger([p.pid]);
    try { p.unref(); } catch {}

    p.on('error', (e) => {
      proxyState.lastError = `代理启动失败:${e.message}`;
      notifyRenderer();
    });

    p.on('exit', (code) => {
      // 只有当前这个还是我们记着的那只时才清状态 —— 避免"新代理已起、
      // 旧代理的 exit 事件才到"把新代理的状态抹掉。
      proxyState.lastExitCode = code;
      if (proxyChild === p) { proxyChild = null; proxyState.managed = false; }
      writeProxyLedger([]);
      notifyRenderer();
      if (proxyIntentionalStop) return;

      // 崩溃自动重起,但要防止"起不来就疯狂重起"。1 分钟内超过 5 次就放弃,
      // 明确告诉用户去看日志,而不是无限刷屏。
      const now = Date.now();
      if (now - proxyState.windowStart > 60000) {
        proxyState.windowStart = now;
        proxyState.restarts = 0;
      }
      if (proxyState.restarts >= 5) {
        proxyState.lastError = `代理反复退出(1 分钟内 ${proxyState.restarts} 次),已停止自动重启。看日志末几行找原因。`;
        notifyRenderer();
        return;
      }
      proxyState.restarts++;
      const delay = Math.min(30000, 1000 * 2 ** (proxyState.restarts - 1));
      console.log(`[shell] 代理退出(code=${code}),${delay}ms 后第 ${proxyState.restarts} 次重起`);
      setTimeout(() => {
        if (!proxyChild && !proxyIntentionalStop) startProxy().then(() => notifyRenderer()).catch(() => {});
      }, delay);
    });

    // 等它就绪。代理启动很快(不到 1 秒),给 8 秒足够。
    //
    // 注意这里有竞态要绕开:p.on('exit') 里会把 proxyChild 置回 null。
    // 如果那个 exit 先到(代理启动后立刻崩),而我们又用 "proxyChild 为空"
    // 当作"还没起来"的判断,就会陷入等待。所以改成用 spawn 的 'spawn'
    // 事件确认"确实启动过",同时由 exit 事件来设置 exited 标志。
    let exited = false;
    p.once('exit', () => { exited = true; });

    const t0 = Date.now();
    for (;;) {
      const r = await proxyRequest('GET', '/_bridge/status');
      if (r.ok) return { ok: true, started: true, node: nodeExe };
      if (exited) {
        const msg = `代理启动后立刻退出了(退出码 ${proxyState.lastExitCode})。日志末几行在 logs\\context-proxy.log。`;
        proxyState.lastError = msg;
        return { ok: false, error: msg, exited: true };
      }
      if (Date.now() - t0 > 8000) {
        const msg = '代理启动超时(8 秒内没应答)。';
        proxyState.lastError = msg;
        return { ok: false, error: msg, timeout: true };
      }
      await sleep(400);
    }
  })();

  // 无论成败都要放开这个闩,否则一次失败会把后续所有启动请求都堵死。
  return proxyStartInFlight.finally(() => { proxyStartInFlight = null; });
}

/**
 * 停掉代理。
 *
 * 和 stopServer 同样的道理:除了本外壳拉起的那只和台账里记过的,还要覆盖
 * **端口上实际监听的那个** —— 否则手动起的代理(界面会认领成 external)
 * 点「停止」也是空操作。
 */
function stopProxy() {
  return new Promise((resolve) => {
    proxyIntentionalStop = true;
    proxyState.managed = false;
    proxyState.external = false;
    proxyState.startedAt = null;

    const tracked = proxyChild;
    proxyChild = null;

    // 杀之前先查端口(端口一空就查不到了)
    const adopted = tracked ? null : pidOnPort(PROXY_PORT);

    const pids = [];
    if (tracked && tracked.pid) pids.push(tracked.pid);
    for (const pid of readProxyLedger()) if (!pids.includes(pid)) pids.push(pid);
    if (adopted && !pids.includes(adopted)) pids.push(adopted);

    writeProxyLedger(pids);
    if (!pids.length) { writeProxyLedger([]); return resolve({ stopped: [] }); }

    for (const pid of pids) { try { process.kill(pid); } catch { /* 已经没了 */ } }

    Promise.all(pids.map((pid) => killPid(pid, 5000))).then(() => {
      writeProxyLedger([]);
      resolve({ stopped: pids, adopted: !!adopted });
    });
  });
}

/**
 * 生成一个提权的小工具调用,让用户在 UAC 弹窗里点一次「是」就能放行。
 *
 * 为什么必须提权:入站规则属于系统安全边界,普通权限改不了 ——
 * 实测 `netsh advfirewall firewall add rule` 直接返回
 * "The requested operation requires elevation"。这不是能绕过去的 bug,
 * 所以做成"点一下按钮 -> 弹 UAC -> 点是"，而不是让用户自己去翻控制面板。
 *
 * 不加 -Wait:提权出来的那个窗口会停住等用户看结果,我们不能跟着卡住 IPC。
 * 加没加上由界面稍后调 firewallStatus 自检(查询不需要管理员)。
 */
function launchFirewallHelper() {
  const script = path.join(REPO_ROOT, 'tools', 'allow-lan.ps1');
  if (!fs.existsSync(script)) return { ok: false, error: `找不到脚本:${script}` };
  const ps = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';
  if (!fs.existsSync(ps)) return { ok: false, error: `找不到 PowerShell:${ps}` };

  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const inner = `Start-Process -FilePath ${q(ps)} -Verb RunAs -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',${q(script)})`;

  fs.mkdirSync(LOG_DIR, { recursive: true });
  const fwLog = path.join(LOG_DIR, 'firewall.log');
  let fd;
  try { fd = fs.openSync(fwLog, 'a'); } catch { return { ok: false, error: '写不了日志文件' }; }
  fs.appendFileSync(fwLog, `\n[shell] ${new Date().toISOString()} 申请放行\n`);
  try {
    const p = spawn(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', inner], {
      windowsHide: true, stdio: ['ignore', fd, fd],
    });
    p.on('error', () => {});
    try { p.unref(); } catch {}
  } catch (e) {
    try { fs.closeSync(fd); } catch {}
    return { ok: false, error: e.message };
  }
  try { fs.closeSync(fd); } catch {}
  return { ok: true, note: '已发起授权请求。请在 UAC 弹窗里点「是」,然后在弹出的窗口里看结果。' };
}

// ------------------------------------------------------------------ 生命周期

// 单实例保护。没有它的时候,双击两次图标(或启动器多试一档)会起两个实例抢同一个
// Chromium profile:表现是"关掉又自己冒出来一个",日志里则是 Cache 报
// "Unable to move the cache"。拿到锁的实例正常跑;第二个实例只把已有窗口提到
// 前面,然后自己退出。
const gotTheLock = typeof app.requestSingleInstanceLock === 'function'
  ? app.requestSingleInstanceLock()
  : true;   // 测试用的 electron 桩没有这个方法,那时按"拿到锁"处理
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
}

app.whenReady().then(async () => {
  if (!gotTheLock) return;   // 第二个实例:不建窗口、不起服务,直接退出
  // 设置放在 userData 下:更新外壳不会把它冲掉,也不会跟着仓库被提交。
  // MODEL_STOVE_SETTINGS_DIR 是测试用的覆盖开关 —— 自动化测试需要一个
  // 可写、可丢弃的位置,不能去动用户真实的 %APPDATA% 设置。
  const settingsDir = process.env.MODEL_STOVE_SETTINGS_DIR || app.getPath('userData');
  settings.initSettings(settingsDir);
  createWindow();

  // 上次外壳非正常退出可能留下代理进程。按台账收掉,免得它占着 8092
  // 导致这次"端口被占用"。—— 只杀我们自己记过的 PID,不碰你手动跑的。
  killLeftoverProxy();

  // 代理默认拉起:它是"档位 + 自动压缩"的载体,没它二维码会退回 8091,
  // 那是一个功能不全的地址。失败也不弹窗,界面上的状态点会如实显示。
  //
  // MODEL_STOVE_NO_AUTO_PROXY=1 关掉这一步。给自动化测试用:否则测试自己的
  // startProxy() 和外壳的自动启动会同时发生,分不清代理到底是谁拉起来的,
  // 测试就失去了判别力(实测踩过)。
  if (process.env.MODEL_STOVE_NO_AUTO_PROXY === '1') {
    console.log('[shell] 已按 MODEL_STOVE_NO_AUTO_PROXY 跳过代理自动启动');
  } else {
    startProxy().then((r) => {
      if (!r.ok) console.log('[shell] 代理未启动:', r.error);
      notifyRenderer();
    }).catch(() => {});
  }

  // 自测开关:MODEL_STOVE_AUTOSTART="<模型id>:<预设>[:<思考强度>[:<思考预算>|lan]]"
  // 会在启动时立刻拉起一个服务,用来在不点任何按钮的情况下验证
  // 拉起→健康检查→界面 这条链路。不设这个变量时完全无副作用。
  const auto = process.env.MODEL_STOVE_AUTOSTART;
  if (auto) {
    const [modelId, preset, reasoning, fourth] = auto.split(':');
    await autoStart(modelId, preset, reasoning, fourth);
  }
});

/**
 * 自测启动。第四段兼容两种含义:老写法 'lan' 表示局域网,
 * 新写法可以是思考预算的键名(此时局域网关)。
 */
async function autoStart(modelId, preset, reasoning, fourth) {
  // 等窗口加载完,免得在渲染层还不存在时就发状态变更。
  try {
    await new Promise((r) => {
      if (!win || win.webContents.isLoadingMainFrame()) {
        win.webContents.once('did-finish-load', r);
      } else r();
    });
  } catch {}
  const lanMode = fourth === 'lan';
  const budgetKey = lanMode ? null : (fourth || null);
  console.log('[shell] 自测启动', modelId, preset, reasoning || '(默认思考强度)', budgetKey || '(默认预算)');
  try {
    await startServer(modelId, preset, reasoning, lanMode, budgetKey);
    console.log('[shell] 自测启动成功');
    notifyRenderer();
  } catch (e) {
    console.error('[shell] 自测启动失败:', e.message);
    if (win && !win.isDestroyed()) {
      win.webContents.executeJavaScript(
        `alert(${JSON.stringify('自测启动失败:\n\n' + e.message)})`).catch(() => {});
    }
  }
}

app.on('window-all-closed', async () => {
  await stopServer();
  await stopProxy();
  app.quit();
});

// 确保子进程不会比外壳活得更久。
app.on('before-quit', () => {
  if (child) { try { child.kill(); } catch {} }
  if (proxyChild) { try { proxyChild.kill(); } catch {} }
});

// 仅供 tools/test_shell_load.mjs 使用:把内部函数暴露出来,
// 让"用 electron 桩加载一遍"的测试能验证它们确实存在。
// Electron 应用本身不读这个导出,所以没有运行时影响。
module.exports.__test = {
  startProxy, stopProxy, firewallStatus, launchFirewallHelper,
  findNodeExe, killLeftoverProxy, proxyState, tcpProbe, localAddresses,
  // 停止逻辑的两个新依赖:按端口找 PID、温和杀进程。测试要直接验它们。
  pidOnPort, killPid, stopServer,
  // 取当前被管进程的 PID(测试用来核对按端口找到的是不是同一个)
  proxyChildPid: () => (proxyChild ? proxyChild.pid : null),
};
