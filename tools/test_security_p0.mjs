// P0 安全默认的集成测试：真正起一个 context-proxy.mjs 子进程来验证。
//
// 为什么必须是集成测试：这些行为全在 HTTP 层（绑定地址、路由、请求体上限、
// 401 头、HTML 注入），单测拦模块证明不了"真正跑起来时是这样"。而本机没有
// llama-server，所以这里用一个假上游（node:http）代替，只关心代理自己的行为。
//
// 覆盖：
//   1. 默认只绑 127.0.0.1（PROXY_ALLOW_LAN 未设置）
//   2. PROXY_ALLOW_LAN=1 时才绑 0.0.0.0
//   3. /slots、/metrics 在代理层恒 404（不改 llama 的 argv）
//   4. 请求体超过 8 MiB → 413
//   5. PROXY_TOKEN 设置后：/_bridge/status 无 token 401、带 token 200
//   6. 注入的 HTML 里带 window.__STOVE_BRIDGE_TOKEN__
//   7. 上游空闲超时 → 504
//
// 用法：node tools/test_security_p0.mjs
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ports = require('../src/core/ports.js');

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'model-stove-security-'));
const TOKEN = 'test-bridge-token-0123456789abcdef';

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs = 10000, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await fn()) return true;
    } catch { /* 继续等 */ }
    if (Date.now() > deadline) return false;
    await sleep(intervalMs);
  }
}

/** 取一个本机空闲端口（只测回环，和 Supervisor 的做法一致）。 */
async function freePort(start) {
  return ports.findFreePort({ start, count: 100, host: '127.0.0.1' });
}

/** 发一个 HTTP 请求，返回 { status, body, headers }。 */
function request({ port, method = 'GET', path: reqPath = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (body != null) h['Content-Length'] = Buffer.byteLength(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: reqPath,
      headers: h,
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: text, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** 从 netstat 里找某个端口的监听地址（language-independent 的解析在 core/ports）。 */
function listenHosts(port) {
  const text = ports.defaultRunNetstat({ dir: TMP });
  return ports.parseNetstat(text)
    .filter((r) => r.localPort === Number(port) && r.foreignPort === 0 && r.pid > 0)
    .map((r) => r.localHost);
}

/** 假上游：代理需要什么就提供什么。 */
function createUpstream() {
  const hits = [];
  let hanging = null;
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url === '/slow') {
      // 故意不响应：代理应该在空闲超时后主动 abort 并回 504。
      hanging = res;
      return;
    }
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
    if (req.url === '/props') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ default_generation_settings: { n_ctx: 8192 } }));
      return;
    }
    if (req.url === '/slots' || req.url === '/metrics') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[]');
      return;
    }
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><head><title>fake llama</title></head><body>hello</body></html>');
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"error":"not found"}');
  });
  return {
    server,
    hits,
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise((resolve) => {
      try { if (hanging) hanging.destroy(); } catch {}
      try { server.closeAllConnections?.(); } catch {}
      server.close(() => resolve());
    }),
  };
}

/** 启动一个真实代理子进程。 */
function startProxy({ port, target, token = '', allowLan = false, idleTimeoutMs } = {}) {
  const logFile = path.join(TMP, `proxy-${port}.log`);
  const env = {
    ...process.env,
    PROXY_PORT: String(port),
    PROXY_TARGET: target,
    PROXY_STATE_DIR: TMP,
    PROXY_ALLOW_LAN: allowLan ? '1' : '0',
  };
  if (token) env.PROXY_TOKEN = token;
  else delete env.PROXY_TOKEN;
  if (idleTimeoutMs) env.PROXY_IDLE_TIMEOUT_MS = String(idleTimeoutMs);
  else delete env.PROXY_IDLE_TIMEOUT_MS;
  const fd = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [path.join(REPO, 'context-proxy.mjs')], {
    cwd: REPO,
    windowsHide: true,
    env,
    stdio: ['ignore', fd, fd],
  });
  fs.closeSync(fd);
  return { child, logFile };
}

async function waitProxy(port, token = '', timeoutMs = 10000) {
  return waitFor(async () => {
    const headers = token ? { 'x-bridge-token': token } : {};
    const r = await request({ port, path: '/_bridge/status', headers });
    return r.status === 200;
  }, timeoutMs);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  try { child.kill(); } catch { /* 已经没了 */ }
  await Promise.race([exited, sleep(3000)]);
  try { child.kill('SIGKILL'); } catch {}
}

const upstream = createUpstream();
const started = [];

console.log('=== P0 安全默认集成测试 ===');
console.log(`  临时目录: ${TMP}`);

try {
  const upstreamPort = await upstream.listen();
  console.log(`  假上游: http://127.0.0.1:${upstreamPort}`);

  // ---------------------------------------------------------- 默认回环 + 路由
  console.log('\n--- 默认绑定与代理层路由 ---');
  const portA = await freePort(18091);
  const a = startProxy({ port: portA, target: `http://127.0.0.1:${upstreamPort}` });
  started.push(a.child);
  check('代理已就绪', await waitProxy(portA), `端口 ${portA}`);

  const hosts = listenHosts(portA);
  check('默认只监听 127.0.0.1', hosts.length > 0 && hosts.every((h) => h === '127.0.0.1'),
    hosts.join(',') || '(netstat 查不到)');
  check('默认没有监听 0.0.0.0', !hosts.includes('0.0.0.0'), hosts.join(',') || '');

  const slots = await request({ port: portA, path: '/slots' });
  check('/slots 返回 404', slots.status === 404, `HTTP ${slots.status}`);
  const metrics = await request({ port: portA, path: '/metrics?x=1' });
  check('/metrics 返回 404', metrics.status === 404, `HTTP ${metrics.status}`);
  check('被关掉的路由没有到达上游', !upstream.hits.some((p) => p.startsWith('/slots') || p.startsWith('/metrics')),
    upstream.hits.filter((p) => p.startsWith('/slots') || p.startsWith('/metrics')).join(',') || '(未转发)');

  const health = await request({ port: portA, path: '/health' });
  check('普通路由照常转发', health.status === 200 && health.body === 'ok', `HTTP ${health.status}`);

  const htmlNoToken = await request({ port: portA, path: '/' });
  check('HTML 注入面板', htmlNoToken.body.includes('id="stove-panel"'));
  check('未设 token 时不注入 token', !htmlNoToken.body.includes('__STOVE_BRIDGE_TOKEN__'));

  // ---------------------------------------------------------- 请求体上限
  console.log('\n--- 请求体上限 ---');
  const tooBig = Buffer.alloc(8 * 1024 * 1024 + 1, 0x61);
  const beforeHits = upstream.hits.length;
  const big = await request({
    port: portA,
    method: 'POST',
    path: '/v1/chat/completions',
    headers: { 'Content-Type': 'application/json' },
    body: tooBig,
  });
  check('超过 8 MiB 返回 413', big.status === 413, `HTTP ${big.status}`);
  check('超限请求没有转发到上游', upstream.hits.length === beforeHits,
    `新增 ${upstream.hits.length - beforeHits} 条`);

  await stopChild(a.child);

  // ---------------------------------------------------------------- token
  console.log('\n--- /_bridge 会话 token ---');
  const portB = await freePort(portA + 1);
  const b = startProxy({ port: portB, target: `http://127.0.0.1:${upstreamPort}`, token: TOKEN });
  started.push(b.child);
  check('带 token 的代理已就绪', await waitProxy(portB, TOKEN), `端口 ${portB}`);

  const noToken = await request({ port: portB, path: '/_bridge/status' });
  check('无 token 返回 401', noToken.status === 401, `HTTP ${noToken.status}`);
  let unauthBody = null;
  try { unauthBody = JSON.parse(noToken.body); } catch {}
  check('401 响应体统一且不泄露细节',
    !!unauthBody && unauthBody.ok === false && unauthBody.error === 'unauthorized' &&
    Object.keys(unauthBody).sort().join(',') === 'error,ok' &&
    !noToken.body.includes(TOKEN),
    noToken.body.slice(0, 120));

  const headerToken = await request({
    port: portB, path: '/_bridge/status', headers: { 'x-bridge-token': TOKEN },
  });
  check('x-bridge-token 正确时返回 200', headerToken.status === 200, `HTTP ${headerToken.status}`);

  const bearerToken = await request({
    port: portB, path: '/_bridge/status', headers: { Authorization: `Bearer ${TOKEN}` },
  });
  check('Authorization: Bearer 也接受', bearerToken.status === 200, `HTTP ${bearerToken.status}`);

  const wrongToken = await request({
    port: portB, path: '/_bridge/status', headers: { 'x-bridge-token': TOKEN + 'x' },
  });
  check('错误 token 返回 401', wrongToken.status === 401, `HTTP ${wrongToken.status}`);

  const html = await request({ port: portB, path: '/' });
  check('HTML 里注入了 window.__STOVE_BRIDGE_TOKEN__',
    html.body.includes('window.__STOVE_BRIDGE_TOKEN__') && html.body.includes(TOKEN));
  check('面板脚本标签带 data-stove-token（CSP 兜底）',
    html.body.includes('data-stove-token="' + TOKEN + '"'));

  const bridgeConfig = await request({
    port: portB,
    method: 'POST',
    path: '/_bridge/config',
    headers: { 'Content-Type': 'application/json', 'x-bridge-token': TOKEN },
    body: JSON.stringify({ enabled: true }),
  });
  check('带 token 的 POST /_bridge/config 生效', bridgeConfig.status === 200, `HTTP ${bridgeConfig.status}`);

  await stopChild(b.child);

  // ------------------------------------------------------------ 上游超时
  console.log('\n--- 上游空闲超时 ---');
  const portC = await freePort(portB + 1);
  const c = startProxy({
    port: portC,
    target: `http://127.0.0.1:${upstreamPort}`,
    idleTimeoutMs: 350,
  });
  started.push(c.child);
  check('小超时代理已就绪', await waitProxy(portC), `端口 ${portC}`);
  const t0 = Date.now();
  let slow;
  try {
    slow = await request({ port: portC, path: '/slow' });
  } catch (e) {
    slow = { status: 0, body: e.message };
  }
  check('上游空闲超时返回 504', slow.status === 504, `HTTP ${slow.status} (${Date.now() - t0}ms)`);
  await stopChild(c.child);

  // ------------------------------------------------------ 显式 LAN 才绑 0.0.0.0
  console.log('\n--- 显式 PROXY_ALLOW_LAN 才放开绑定 ---');
  const portD = await freePort(portC + 1);
  const d = startProxy({
    port: portD,
    target: `http://127.0.0.1:${upstreamPort}`,
    allowLan: true,
  });
  started.push(d.child);
  check('LAN 代理已就绪', await waitProxy(portD), `端口 ${portD}`);
  const lanHosts = listenHosts(portD);
  check('PROXY_ALLOW_LAN=1 时监听 0.0.0.0', lanHosts.includes('0.0.0.0'),
    lanHosts.join(',') || '(netstat 查不到)');
  await stopChild(d.child);
} catch (e) {
  check('测试执行无异常', false, e && e.stack ? e.stack.split('\n')[0] : String(e));
  console.log(e && e.stack ? e.stack : e);
} finally {
  for (const child of started) await stopChild(child);
  try { await upstream.close(); } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
}

console.log(failed === 0 ? '\n全部通过' : `\n有 ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
