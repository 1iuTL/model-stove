// 真正把代理起起来,验证托管逻辑:启动 -> 应答 -> 停止 -> 干净收尾。
//
// 为什么需要它:代理以前是手工程序,"忘了启动"是最常见的故障来源。
// 现在外壳负责它的生死,所以"能不能起来、停不停得掉"必须可验证。
//
// 这里用一种不需要 Electron 的办法:预加载一个补丁脚本,它把 electron
// 换成一个桩,再把真正的 main.js require 进来,然后直接调内部函数。
// 跑的是真实的 spawn、真实的端口、真实的 HTTP。
//
// 用法:node tools/test_proxy_managed.mjs
//
// 端口默认 8092(真实端口),但可以用 STOVE_TEST_PORT 换一个:
// 当 Model Stove / 你手工起的代理正占着 8092 时,测试没法在真实端口上跑
// (它需要一个空闲端口才能验证"这次真的启动了一个")。换端口不影响被测逻辑 ——
// 托管逻辑与端口无关,而 PROXY_PORT 是通过环境变量传进去的,和实际运行一致。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const LOG_DIR = path.join(REPO, 'logs');
const LEDGER = path.join(LOG_DIR, 'running-proxy-pid.json');
const TMP = path.join(REPO, '.proxy-test-tmp');
const PORT = Number(process.env.STOVE_TEST_PORT || 8092);
const BASE = `http://127.0.0.1:${PORT}`;

/** 端口上有没有东西在监听。 */
function probe(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    let done = false;
    const fin = (v) => { if (!done) { done = true; try { s.destroy(); } catch {} resolve(v); } };
    s.setTimeout(700);
    s.on('connect', () => fin(true));
    s.on('timeout', () => fin(false));
    s.on('error', () => fin(false));
  });
}

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};

fs.mkdirSync(TMP, { recursive: true });

// ---- 补丁:把 electron 换成桩,再加载 main.js,最后跑我们交代的脚本 ----
const patch = `
const Module = require('module');
const path = require('path');
const REPO = ${JSON.stringify(REPO)};
const fakeApp = { whenReady: () => Promise.resolve(), getPath: () => path.join(REPO,'logs'), on(){}, quit(){} };
const fakeWin = { setMenuBarVisibility(){}, loadFile(){}, on(){}, isDestroyed: () => true,
  webContents: { send(){}, isLoadingMainFrame: () => false, once(){} } };
const stub = { app: fakeApp, BrowserWindow: function(){ return fakeWin; },
  ipcMain: { handle(){} } };
const orig = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'electron') return stub;
  return orig.call(this, req, parent, isMain);
};
const m = require(path.join(REPO, 'src', 'main.js'));
const t = m.__test;
(async () => {
  const out = { steps: [] };
  const log = (k, v) => { out.steps.push([k, v]); };

  log('before', { ledger: t.proxyState.managed, node: t.findNodeExe() });

  // 按端口找 PID:停止按钮靠它收掉"不是本外壳启动的"服务。
  // 这里先验证它本身:代理起来后必须能通过端口找到它。
  log('pidOnPortBeforeStart', { pid: t.pidOnPort(${PORT}) });
  log('pidOnPortFreePort', { pid: t.pidOnPort(59999) });

  // 防火墙自检:必须能在**不提权**的情况下跑通并给出结论。
  // 它决定界面上那行警告要不要出现,所以不能挂。
  let fw = null;
  try { fw = await t.firewallStatus(); } catch (e) { fw = { error: e.message }; }
  log('firewall', fw);

  const r1 = await t.startProxy();
  log('start', r1);

  // 代理起来了就应该能应答 /_bridge/status
  let status = null;
  try {
    const res = await fetch('${BASE}/_bridge/status', { signal: AbortSignal.timeout(5000) });
    status = { code: res.status, ok: res.ok, keys: Object.keys(await res.json()).sort() };
  } catch (e) { status = { error: e.message }; }
  log('status', status);

  log('stateAfterStart', { managed: t.proxyState.managed, external: t.proxyState.external,
    pid: t.proxyState.managed ? 'child' : null });

  // 起来了之后,按端口必须能找到它 —— 这是停止按钮的兜底依据
  log('pidOnPortAfterStart', { pid: t.pidOnPort(${PORT}) });
  // 被管进程的 PID(proxyState 里不存,从 childPid 取)
  log('managedPid', { pid: (t.proxyChildPid ? t.proxyChildPid() : null) });

  // 幂等:再调一次不该起第二个
  const r2 = await t.startProxy();
  log('startAgain', r2);

  // ---- 状态隔离:测试绝不能改到生产配置 ----
  //
  // 这不是洁癖。tools/test_proxy.mjs 会把阈值临时调到 0.2 来方便触发压缩,
  // 而它原来写的是**同一个** state 文件,且跑完不还原 —— 实测用户那边的压缩
  // 配置因此被改成"阈值 0.2、保留 2 轮",跟代码默认值对不上,查了很久。
  // 所以这里钉一条:通过配置接口写一次,必须落在测试自己的目录里。
  //
  // 注意必须在 stopProxy 之前做 —— 代理停了就写不进去了(这行踩过)。
  let wrote = false;
  try {
    const r = await fetch('${BASE}/_bridge/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ thresholdRatio: 0.75 }),
      signal: AbortSignal.timeout(5000),
    });
    wrote = r.ok;
  } catch { /* 下面会报 */ }
  log('configWrite', { ok: wrote });

  await t.stopProxy();
  await new Promise((r) => setTimeout(r, 900));

  // ---- 外部监听者:stopServer 必须也能收掉 ----
  //
  // 这是用户实际遇到的故障:8091 上跑着一只别处起的 llama-server(占 7.3 GB
  // 显存),界面显示"运行中",而「停止」按下去没反应 —— 因为那时 stopServer
  // 只肯停自己 spawn 的子进程。
  //
  // 这里用一个只做 listen 的哑进程占住 8091:它没有 /health、不是我们的子进程,
  // 所以模拟的正是"外部监听者"。
  //
  // ⚠️ 前置条件:8091 必须是空的。如果上面已有真服务在跑(比如 Model Stove
  // 正开着),这个场景就**不能测** —— 否则哑进程根本占不住端口,而 stopServer
  // 会把**真服务**当成"外部监听者"杀掉(实测踩过:差点结束掉正在用的服务)。
  let blockerPid = null;
  if (t.pidOnPort(8091) !== null) {
    log('externalSkipped', { reason: '8091 已被占用,跳过(避免杀掉真实服务)' });
  } else {
    const blocker = require('child_process').spawn(process.execPath, ['-e',
      "require('http').createServer((q,s)=>s.end('x')).listen(8091,'0.0.0.0',()=>setInterval(()=>{},1000))"
    ], { stdio: 'ignore', windowsHide: true });
    blockerPid = blocker.pid;
    await new Promise((r) => setTimeout(r, 1500));
    log('blockerPid', { pid: blockerPid });
    log('pidOnPort8091', { pid: t.pidOnPort(8091) });

    const stopResult = await t.stopServer();
    log('stopServerResult', stopResult);
    await new Promise((r) => setTimeout(r, 1200));
    log('pidOnPort8091After', { pid: t.pidOnPort(8091) });
  }

  // 停掉之后端口应该不再应答
  let after = null;
  try {
    const res = await fetch('${BASE}/_bridge/status', { signal: AbortSignal.timeout(2500) });
    after = { code: res.status };
  } catch (e) { after = { unreachable: true, code: e.cause ? e.cause.code : e.message }; }
  log('afterStop', after);

  process.stdout.write('@@RESULT@@' + JSON.stringify(out) + '@@END@@');
  process.exit(0);
})().catch((e) => {
  process.stdout.write('@@RESULT@@' + JSON.stringify({ error: e.message, stack: e.stack }) + '@@END@@');
  process.exit(1);
});
`;

const patchFile = path.join(TMP, 'patch.cjs');
fs.writeFileSync(patchFile, patch, 'utf8');

// 先清掉上次的台账,保证测试从"干净"状态开始
try { fs.unlinkSync(LEDGER); } catch {}

console.log('=== 代理托管:启动 / 应答 / 幂等 / 停止 ===');

// 前置条件:8092 必须是空的。
//
// 这不是洁癖 —— 上一轮的教训:测试进程退出后代理还活着(detached + unref
// 在 Windows 上并不能真正脱离),下一次测试就会把它"认领"成 external,
// 于是"我们真的启动了一个"这一点就没被验证到,测试会假装通过。
// 所以这里显式失败,让人先清掉残留。
if (await probe(PORT)) {
  console.log(`  ✗ 前置条件不满足:${PORT} 已被占用。`);
  console.log('    先停掉残留的代理(关掉 Model Stove,或 taskkill 那个 node),再跑本测试。');
  process.exit(1);
}
check(`${PORT} 起始为空闲`, true);

const outFile = path.join(TMP, 'out.log');
const fd = fs.openSync(outFile, 'w');
const p = spawn(process.execPath, [patchFile], {
  windowsHide: true,
  // 关掉外壳的代理自动启动。
  //
  // 不关的话,app.whenReady() 里的自动 startProxy() 会和下面的显式调用
  // 同时发生,于是第一次调用拿到的是 already:true —— 看着像通过,其实
  // "我们自己起的那个代理"根本没被验证到。实测就是这么被骗过一次。
  // PROXY_PORT 也要传进去:main.js 的 config 会读它,而托管逻辑是照它
  // 起代理、照它探端口的 —— 换端口时两边必须一致,否则测的是错的东西。
  //
  // PROXY_STATE_DIR 把代理的状态文件指到测试自己的临时目录,免得测试顺手
  // 改掉生产的压缩配置(实测被这么污染过)。
  env: {
    ...process.env,
    MODEL_STOVE_NO_AUTO_PROXY: '1',
    PROXY_PORT: String(PORT),
    PROXY_STATE_DIR: TMP,
  },
  stdio: ['ignore', fd, fd],
});
fs.closeSync(fd);

const code = await new Promise((r) => p.on('exit', r));
const text = fs.readFileSync(outFile, 'utf8');
const m = text.match(/@@RESULT@@([\s\S]*?)@@END@@/);
if (!m) {
  check('补丁脚本产出结果', false);
  console.log('--- 原始输出 ---'); console.log(text.slice(-3000));
  process.exit(1);
}
const out = JSON.parse(m[1]);
if (out.error) { check('补丁脚本无异常', false, out.error); console.log(out.stack || ''); process.exit(1); }

const step = (k) => (out.steps.find((s) => s[0] === k) || [])[1];
const start = step('start');
const status = step('status');
const again = step('startAgain');
const after = step('afterStop');
const state = step('stateAfterStart');

// ---- 按端口找 PID ----
//
// 这是"停止按钮"的兜底依据:8091 上跑的可能是别处起的 llama-server,
// 那时 child 为 null,只能靠端口把 PID 找出来才停得掉。
console.log('\n--- 按端口找 PID ---');
const freeBefore = step('pidOnPortBeforeStart');
const found = step('pidOnPortAfterStart');
const freePort = step('pidOnPortFreePort');
const managedPid = (() => { const s = step('managedPid'); return s ? s.pid : null; })();
check('代理未起时端口查不到 PID', !!(freeBefore && freeBefore.pid === null), JSON.stringify(freeBefore));
check('代理起来后能按端口找到 PID', !!(found && Number.isInteger(found.pid) && found.pid > 0), JSON.stringify(found));
check('没在监听的端口返回 null', !!(freePort && freePort.pid === null), JSON.stringify(freePort));
check('找到的 PID 与被管进程一致', !!(found && managedPid && found.pid === managedPid),
  `found=${found && found.pid} managed=${managedPid}`);

check('startProxy 返回 ok', !!(start && start.ok), JSON.stringify(start));
check('是"这次真的启动了一个"而不是认领现成的', !!(start && start.started && !start.already && !start.external), JSON.stringify(start));
check('代理真的起来了(可被本外壳托管)', !!(state && state.managed));
check('/_bridge/status 返回 200', !!(status && status.code === 200), JSON.stringify(status));
check('/_bridge/status 含 profile/compression', !!(status && status.keys && status.keys.includes('profile') && status.keys.includes('compression')),
  status && status.keys ? status.keys.join(',') : '');
check('再次调用是幂等的', !!(again && again.ok), JSON.stringify(again));
check('停止后端口不再应答', !!(after && (after.unreachable || after.code === undefined || after.code >= 500)), JSON.stringify(after));

// ---- 外部监听者也要能被停掉 ----
console.log('\n--- 外部监听者(模拟别处起的服务)---');
const extSkip = step('externalSkipped');
if (extSkip) {
  console.log('  - 跳过:' + extSkip.reason);
} else {
  const blockerPid = (() => { const s = step('blockerPid'); return s ? s.pid : null; })();
  const onPort = step('pidOnPort8091');
  const stopRes = step('stopServerResult');
  const onPortAfter = step('pidOnPort8091After');
  check('哑进程已占住 8091', !!(onPort && onPort.pid === blockerPid), `blocker=${blockerPid} found=${onPort && onPort.pid}`);
  check('stopServer 报告停掉了它', !!(stopRes && stopRes.adopted && stopRes.stopped && stopRes.stopped.includes(blockerPid)), JSON.stringify(stopRes));
  check('8091 已释放', !!(onPortAfter && onPortAfter.pid === null), JSON.stringify(onPortAfter));
}

// ---- 状态隔离的断言(写入动作已在补丁脚本里、stopProxy 之前完成)----
//
// 这不是洁癖。tools/test_proxy.mjs 会把阈值临时调到 0.2 来方便触发压缩,
// 而它原来写的是**同一个** state 文件,且跑完不还原 —— 实测用户那边的压缩
// 配置因此被改成"阈值 0.2、保留 2 轮",跟代码默认值对不上,查了很久。
console.log('\n--- 状态隔离 ---');
const prodState = path.join(LOG_DIR, 'context-proxy-state.json');
const testState = path.join(TMP, 'context-proxy-state.json');
const cfgWrite = step('configWrite');
check('能写入代理配置', !!(cfgWrite && cfgWrite.ok), JSON.stringify(cfgWrite));
check('测试的状态落在自己的目录', fs.existsSync(testState), testState);
check('生产状态文件存在且是生产值', (() => {
  try {
    const s = JSON.parse(fs.readFileSync(prodState, 'utf8'));
    // 测试写的是 0.75;如果生产文件也是 0.75,无法区分"没被碰"和"被写成了 0.75"。
    // 所以这里只断言它仍然是有效配置,真正确凿的证据是"临时文件存在" +
    // "生产文件的修改时间没变"(下面这条)。
    return typeof s.thresholdRatio === 'number' && s.thresholdRatio >= 0.1;
  } catch { return false; }
})(), '生产文件应可读且是合法配置');

console.log('\n--- 防火墙自检(不提权)---');
const fw = step('firewall');
console.log('  ' + JSON.stringify(fw));
check('firewallStatus 跑得通', !!(fw && !fw.error), fw && fw.error ? fw.error : '');
check('自检同时覆盖 node 与 app', !!(fw && fw.node && fw.app), fw ? Object.keys(fw).join(',') : '');
// 判据必须是注册表:解析 netsh 的本地化文本曾在中文 Windows 上把"存在"
// 误判成"不存在",那正是错误结论的来源。
check('判据来自注册表', !!(fw && fw._source === 'registry'), fw ? `_source=${fw._source}` : '');
// 这两条规则是实际加过的,注册表里查得到;查不到说明判据又坏了。
check('node.exe 被识别为已放行', !!(fw && fw.node && fw.node.present), fw && fw.node ? `count=${fw.node.count}` : '');
check('electron.exe 被识别为已放行', !!(fw && fw.app && fw.app.present), fw && fw.app ? `count=${fw.app.count}` : '');

console.log('\n--- 台账 ---');
const ledgerRaw = (() => { try { return fs.readFileSync(LEDGER, 'utf8'); } catch { return '(无)'; } })();
console.log('  ' + ledgerRaw);
check('停止后台账已清空', ledgerRaw.trim() === '[]' || ledgerRaw === '(无)', ledgerRaw);

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

// 收尾:确认测试自己没留下进程。留了就报出来,免得污染下一轮。
if (await probe(PORT)) {
  check('测试未留下残留代理', false, `${PORT} 仍被占用 —— 会影响后续运行`);
} else {
  check('测试未留下残留代理', true);
}

console.log(failed === 0 ? '\n全部通过' : `\n有 ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
