// 端到端冒烟：Supervisor 拉一个假 llama-server → 代理转发 → 界面 HTML 可注入。
//
// 本机没有真实的 llama-server / GGUF，所以这里用一个 node 写的假服务代替：
// 它只做三件事 —— 打印 `listening on http://127.0.0.1:<port>`（Supervisor 的
// 就绪判据之一）、提供 /health、返回一个最小 HTML。这样能在不碰显卡/模型的前提
// 下验证"动态端口 → 代理目标 → 转发"这条链路。
//
// 用法：node tools/test_stack_smoke.mjs
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { Supervisor, STATE } = require('../src/core/supervisor.js');
const ports = require('../src/core/ports.js');

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'model-stove-stack-'));

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs = 10000, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { if (await fn()) return true; } catch { /* 继续等 */ }
    if (Date.now() > deadline) return false;
    await sleep(intervalMs);
  }
}

function request({ port, path: reqPath = '/', method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: reqPath, method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: text, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

// 假 llama-server 的源码：由 Supervisor 用 node 启动，端口通过 argv 传。
const FAKE_SERVER = `
const http = require('http');
const port = Number(process.argv[2]);
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  if (req.url === '/props') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ default_generation_settings: { n_ctx: 4096 } }));
    return;
  }
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><title>fake</title></head><body>fake llama ui</body></html>');
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end('{"error":"not found"}');
});
server.listen(port, '127.0.0.1', () => {
  console.log('listening on http://127.0.0.1:' + port);
});
`;

const fakeScript = path.join(TMP, 'fake-llama-server.cjs');
fs.writeFileSync(fakeScript, FAKE_SERVER, 'utf8');

let supervisor = null;
let proxy = null;
let proxyPort = null;

async function stopProxy() {
  if (!proxy) return;
  const p = proxy;
  proxy = null;
  if (p.exitCode !== null || p.signalCode) return;
  const exited = new Promise((resolve) => p.once('exit', resolve));
  try { p.kill(); } catch {}
  await Promise.race([exited, sleep(2000)]);
  try { p.kill('SIGKILL'); } catch {}
}

try {
  console.log('=== 端到端冒烟：Supervisor + 代理 ===');
  console.log(`  临时目录: ${TMP}`);

  const basePort = await ports.findFreePort({ start: 18191, count: 100, host: '127.0.0.1' });
  supervisor = new Supervisor({
    logDir: path.join(TMP, 'logs'),
    ledgerFile: path.join(TMP, 'running-pids.json'),
    basePort,
    scanRange: 16,
    readyTimeoutMs: 15000,
    readinessPollMs: 100,
    killGraceMs: 3000,
  });

  const crashes = [];
  supervisor.on('crash', (e) => crashes.push(e));

  console.log('\n--- 启动假 llama-server ---');
  const st = await supervisor.start({
    exe: process.execPath,
    modelId: 'smoke',
    preset: 'text-32k',
    argsForPort: (port) => [fakeScript, String(port)],
  });
  check('Supervisor 状态为 ready', st.state === STATE.READY, st.state);
  check('端口是动态选出来的', st.port === basePort && st.port > 0, String(st.port));
  check('URL 只绑回环', st.url === `http://127.0.0.1:${st.port}/`, st.url);
  check('进程真的活着', ports.pidAlive(st.pid), `pid=${st.pid}`);
  const hosts = ports.parseNetstat(ports.defaultRunNetstat({ dir: TMP }))
    .filter((r) => r.localPort === st.port && r.foreignPort === 0 && r.pid > 0)
    .map((r) => r.localHost);
  check('假服务只监听 127.0.0.1', hosts.length > 0 && hosts.every((h) => h === '127.0.0.1'), hosts.join(',') || '(netstat 查不到)');

  const direct = await request({ port: st.port, path: '/health' });
  check('假服务 /health 可用', direct.status === 200 && direct.body === 'ok', `HTTP ${direct.status}`);

  console.log('\n--- 代理指向当前动态端口 ---');
  proxyPort = await ports.findFreePort({ start: st.port + 1, count: 100, host: '127.0.0.1' });
  const logFile = path.join(TMP, 'proxy.log');
  const fd = fs.openSync(logFile, 'a');
  proxy = spawn(process.execPath, [path.join(REPO, 'context-proxy.mjs')], {
    cwd: REPO,
    windowsHide: true,
    env: {
      ...process.env,
      PROXY_PORT: String(proxyPort),
      PROXY_TARGET: st.url.replace(/\/+$/, ''),
      PROXY_STATE_DIR: TMP,
      PROXY_ALLOW_LAN: '0',
    },
    stdio: ['ignore', fd, fd],
  });
  fs.closeSync(fd);

  const up = await waitFor(async () => (await request({ port: proxyPort, path: '/_bridge/status' })).status === 200);
  check('代理已就绪', up, `端口 ${proxyPort}`);

  const viaProxy = await request({ port: proxyPort, path: '/health' });
  check('代理把请求转发到了假服务', viaProxy.status === 200 && viaProxy.body === 'ok', `HTTP ${viaProxy.status}`);

  const html = await request({ port: proxyPort, path: '/' });
  check('HTML 经过代理并被注入面板', html.body.includes('fake llama ui') && html.body.includes('id="stove-panel"'));

  const props = await request({ port: proxyPort, path: '/props' });
  let nCtx = null;
  try { nCtx = JSON.parse(props.body).default_generation_settings.n_ctx; } catch {}
  check('/props 也转发（代理拿得到真实上下文）', nCtx === 4096, `n_ctx=${nCtx}`);

  const bridge = await request({ port: proxyPort, path: '/_bridge/status' });
  check('/_bridge/status 可用', bridge.status === 200, `HTTP ${bridge.status}`);
  let upstream = null;
  try { upstream = JSON.parse(bridge.body).upstream; } catch {}
  check('代理上报的上游就是动态端口', upstream === st.url.replace(/\/+$/, ''), String(upstream));

  console.log('\n--- 收尾 ---');
  await stopProxy();
  const stopRes = await supervisor.stop();
  check('Supervisor 报告停掉了服务', stopRes.stopped.includes(st.pid), JSON.stringify(stopRes));
  check('进程确实已退出', !ports.pidAlive(st.pid), `pid=${st.pid}`);
  check('没有崩溃事件', crashes.length === 0, crashes.map((c) => c.code).join(',') || '');
  check('台账已清空', ports.readLedger(path.join(TMP, 'running-pids.json')).length === 0);
} catch (e) {
  check('测试执行无异常', false, e && e.message ? e.message : String(e));
  console.log(e && e.stack ? e.stack : e);
} finally {
  await stopProxy();
  if (supervisor) {
    try { await supervisor.stop(); } catch {}
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
}

console.log(failed === 0 ? '\n全部通过' : `\n有 ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
