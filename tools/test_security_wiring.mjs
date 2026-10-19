// P1 安全接线的集成测试：真正起 context-proxy.mjs 子进程来验证。
//
// 为什么是集成测试：设备鉴权、配对、429、审计都发生在 HTTP 层，单测模块证明
// 不了"真正跑起来时是这样"。本机没有 llama-server，所以用假上游代替。
//
// 覆盖（对应任务里的 1-8 项）：
//   1. /_security/pairing 需要 bridge token；200 返回 6 位 code；审计 pair_create
//   2. /_pair 公开兑换（单次）；成功/失败都写审计，失败响应统一 401
//   3. /v1 设备鉴权：无 key 401、x-device-key/Bearer 200、错误 key 401；
//      上游只看到 UPSTREAM_KEY，看不到设备 key
//   4. 非 strict 时回环豁免（不要求设备 key）
//   5. 按 IP 限流：容量 3 时第 4 次 429 + Retry-After + 审计节流
//   6. 吊销/轮换：revoke 后立即 401，rotate 返回一次性新 key
//   7. 原有安全项不回归：/slots /metrics 404、8 MiB 413、bridge 401、HTML 注入
//   8. 审计不含请求体/提示词/设备 key
//
// 用法：node tools/test_security_wiring.mjs
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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'model-stove-security-wiring-'));
const TOKEN = 'test-bridge-token-p1-0123456789abcdef';
const UPSTREAM_KEY = 'upstream-llama-key-p1-do-not-leak';
const CHAT_BODY = {
  model: 'local',
  messages: [{ role: 'user', content: '你好' }],
  max_tokens: 16,
  stream: false,
};

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs = 10000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await fn()) return true;
    } catch { /* 继续等 */ }
    if (Date.now() > deadline) return false;
    await sleep(intervalMs);
  }
}

/** 取一个本机空闲端口（只测回环，与 Supervisor 的做法一致）。 */
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

/** POST JSON（body 为字符串时原样发送，用于非法 JSON 用例）。 */
function postJson({ port, path: reqPath, headers = {}, body }) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body == null ? {} : body);
  return request({
    port,
    method: 'POST',
    path: reqPath,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: payload,
  });
}

function jsonOf(res) {
  try { return JSON.parse(res.body); } catch { return null; }
}

/** 假上游：代理需要什么就提供什么，并记录每次请求的头。 */
function createUpstream() {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push({ url: req.url, method: req.method, headers: req.headers });
    if (req.url === '/props') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ default_generation_settings: { n_ctx: 8192 } }));
      return;
    }
    if (req.url === '/v1/chat/completions') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-test',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
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
      try { server.closeAllConnections?.(); } catch {}
      server.close(() => resolve());
    }),
  };
}

/** 启动一个真实代理子进程；每个用例用独立 PROXY_STATE_DIR，互不污染。 */
function startProxy({ name, port, target, token = '', env = {} }) {
  const stateDir = path.join(TMP, name);
  const logFile = path.join(TMP, `${name}.log`);
  const childEnv = { ...process.env };
  // 清掉宿主可能已经设置的 P1 变量，保证"没显式传就是默认值"。
  for (const key of [
    'PROXY_DEVICE_AUTH', 'PROXY_DEVICE_AUTH_STRICT',
    'PROXY_RATE_CAPACITY', 'PROXY_RATE_REFILL_PER_SEC',
    'PROXY_TOKEN', 'UPSTREAM_KEY', 'PROXY_ALLOW_LAN', 'PROXY_IDLE_TIMEOUT_MS',
  ]) {
    delete childEnv[key];
  }
  Object.assign(childEnv, {
    PROXY_PORT: String(port),
    PROXY_TARGET: target,
    PROXY_STATE_DIR: stateDir,
    PROXY_ALLOW_LAN: '0',
  }, env);
  if (token) childEnv.PROXY_TOKEN = token;

  const fd = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [path.join(REPO, 'context-proxy.mjs')], {
    cwd: REPO,
    windowsHide: true,
    env: childEnv,
    stdio: ['ignore', fd, fd],
  });
  fs.closeSync(fd);
  return { child, stateDir, logFile };
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

/** 读审计 JSONL（不存在 = 空），坏行跳过。 */
function readAudit(stateDir) {
  const file = path.join(stateDir, 'audit.jsonl');
  try {
    return fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function auditEvents(stateDir) {
  return readAudit(stateDir).map((entry) => entry.event);
}

function countAuditEvents(stateDir, event) {
  return auditEvents(stateDir).filter((name) => name === event).length;
}

function waitAuditEvent(stateDir, event, timeoutMs = 3000) {
  return waitFor(() => auditEvents(stateDir).includes(event), timeoutMs, 50);
}

const upstream = createUpstream();
const started = [];

console.log('=== P1 安全接线集成测试 ===');
console.log(`  临时目录: ${TMP}`);

try {
  const upstreamPort = await upstream.listen();
  const target = `http://127.0.0.1:${upstreamPort}`;
  console.log(`  假上游: ${target}`);

  // ================================================================ A: strict
  console.log('\n--- A. 严格设备鉴权 + 配对 + 审计 ---');
  const portA = await freePort(19201);
  const a = startProxy({
    name: 'a',
    port: portA,
    target,
    token: TOKEN,
    env: {
      PROXY_DEVICE_AUTH: '1',
      PROXY_DEVICE_AUTH_STRICT: '1',
      UPSTREAM_KEY,
    },
  });
  started.push(a.child);
  check('A 代理已就绪', await waitProxy(portA, TOKEN), `端口 ${portA}`);

  const bridgeHeaders = { 'x-bridge-token': TOKEN };

  // ---- 1. 管理端创建配对码 ----
  const noToken = await postJson({ port: portA, path: '/_security/pairing', body: {} });
  const noTokenBody = jsonOf(noToken);
  check('无 bridge token 创建配对码 → 401', noToken.status === 401, `HTTP ${noToken.status}`);
  check('401 响应体统一且不泄露细节',
    !!noTokenBody && noTokenBody.ok === false && noTokenBody.error === 'unauthorized'
    && Object.keys(noTokenBody).sort().join(',') === 'error,ok',
    noToken.body.slice(0, 120));
  check('安全端点 401 带 no-store', noToken.headers['cache-control'] === 'no-store',
    String(noToken.headers['cache-control']));

  const created = await postJson({ port: portA, path: '/_security/pairing', headers: bridgeHeaders, body: {} });
  const createdBody = jsonOf(created);
  check('带 token 创建配对码 → 200', created.status === 200, `HTTP ${created.status}`);
  check('返回 6 位数字 code',
    !!createdBody && typeof createdBody.code === 'string' && /^\d{6}$/.test(createdBody.code),
    createdBody ? createdBody.code : created.body.slice(0, 80));
  check('返回未来的 expiresAt',
    !!createdBody && Number(createdBody.expiresAt) > Date.now(),
    createdBody ? String(createdBody.expiresAt) : '');
  check('安全端点 200 带 no-store', created.headers['cache-control'] === 'no-store',
    String(created.headers['cache-control']));
  check('审计出现 pair_create', await waitAuditEvent(a.stateDir, 'pair_create'));

  const badJsonAdmin = await postJson({
    port: portA, path: '/_security/revoke', headers: bridgeHeaders, body: '{oops',
  });
  check('管理端点 JSON 解析失败 → 400',
    badJsonAdmin.status === 400 && jsonOf(badJsonAdmin)?.error === 'invalid_json',
    `HTTP ${badJsonAdmin.status} ${badJsonAdmin.body.slice(0, 80)}`);

  // ---- 2. 公开兑换（单次）----
  const redeemed = await postJson({
    port: portA,
    path: '/_pair',
    body: { code: createdBody.code, name: '测试手机' },
  });
  const redeemedBody = jsonOf(redeemed);
  check('公开 /_pair 兑换 → 200', redeemed.status === 200, `HTTP ${redeemed.status}`);
  check('返回 deviceId + 64 位 hex key + name',
    !!redeemedBody
    && /^dev_[0-9a-f]+$/.test(redeemedBody.deviceId)
    && /^[0-9a-f]{64}$/.test(redeemedBody.key)
    && redeemedBody.name === '测试手机',
    redeemedBody ? redeemedBody.deviceId : redeemed.body.slice(0, 80));
  const device1 = redeemedBody.deviceId;
  const key1 = redeemedBody.key;
  check('审计出现 pair_redeem_ok', await waitAuditEvent(a.stateDir, 'pair_redeem_ok'));

  const reused = await postJson({ port: portA, path: '/_pair', body: { code: createdBody.code } });
  const reusedBody = jsonOf(reused);
  check('同一个 code 第二次兑换 → 401',
    reused.status === 401 && reusedBody?.ok === false && reusedBody?.error === 'unauthorized',
    `HTTP ${reused.status} ${reused.body.slice(0, 80)}`);
  check('审计出现 pair_redeem_fail', await waitAuditEvent(a.stateDir, 'pair_redeem_fail'));

  const malformedPair = await postJson({ port: portA, path: '/_pair', body: {} });
  check('格式非法/无配对码同样是 401 统一体',
    malformedPair.status === 401 && jsonOf(malformedPair)?.error === 'unauthorized');
  const badJsonPair = await postJson({ port: portA, path: '/_pair', body: '{oops' });
  check('/_pair JSON 解析失败 → 400',
    badJsonPair.status === 400 && jsonOf(badJsonPair)?.error === 'invalid_json');

  const list1 = await request({ port: portA, path: '/_security/devices', headers: bridgeHeaders });
  const list1Body = jsonOf(list1);
  const listed1 = (list1Body?.devices || []).find((d) => d.id === device1);
  check('设备列表可见且不含明文 key/hash',
    list1.status === 200 && !!listed1
    && listed1.prefix === key1.slice(0, 8)
    && !('key' in listed1) && !('hash' in listed1)
    && !JSON.stringify(list1Body).includes(key1),
    `HTTP ${list1.status}`);

  // ---- 3. /v1 设备鉴权 ----
  const htmlA = await request({ port: portA, path: '/' });
  check('静态页面不需要设备 key（strict 下也 200）',
    htmlA.status === 200 && htmlA.body.includes('id="stove-panel"'),
    `HTTP ${htmlA.status}`);

  const beforeAuthHits = upstream.hits.length;
  const noKey = await postJson({ port: portA, path: '/v1/chat/completions', body: CHAT_BODY });
  const noKeyBody = jsonOf(noKey);
  check('无设备 key 访问 /v1 → 401',
    noKey.status === 401 && noKeyBody?.ok === false && noKeyBody?.error === 'unauthorized',
    `HTTP ${noKey.status}`);
  check('401 不回显 UPSTREAM_KEY', !noKey.body.includes(UPSTREAM_KEY));
  check('未鉴权请求没有到达上游', upstream.hits.length === beforeAuthHits,
    `新增 ${upstream.hits.length - beforeAuthHits} 条`);

  const withXKey = await postJson({
    port: portA, path: '/v1/chat/completions', headers: { 'x-device-key': key1 }, body: CHAT_BODY,
  });
  check('x-device-key 访问 /v1 → 200', withXKey.status === 200, `HTTP ${withXKey.status}`);
  let lastHit = upstream.hits[upstream.hits.length - 1];
  check('上游收到的 Authorization 是 UPSTREAM_KEY',
    lastHit?.headers?.authorization === `Bearer ${UPSTREAM_KEY}`,
    String(lastHit?.headers?.authorization || '(无)'));
  check('上游收不到 x-device-key 头',
    lastHit?.headers?.['x-device-key'] === undefined
    && !JSON.stringify(lastHit?.headers || {}).includes(key1));

  const wrongKey = await postJson({
    port: portA, path: '/v1/chat/completions', headers: { 'x-device-key': 'a'.repeat(64) }, body: CHAT_BODY,
  });
  check('错误设备 key → 401', wrongKey.status === 401, `HTTP ${wrongKey.status}`);

  const withBearer = await postJson({
    port: portA,
    path: '/v1/chat/completions',
    headers: { Authorization: `Bearer ${key1}` },
    body: CHAT_BODY,
  });
  check('Authorization: Bearer 设备 key → 200', withBearer.status === 200, `HTTP ${withBearer.status}`);
  lastHit = upstream.hits[upstream.hits.length - 1];
  check('Bearer 路径同样替换为 UPSTREAM_KEY',
    lastHit?.headers?.authorization === `Bearer ${UPSTREAM_KEY}`,
    String(lastHit?.headers?.authorization || '(无)'));

  check('审计有 auth_ok', countAuditEvents(a.stateDir, 'auth_ok') >= 2,
    String(countAuditEvents(a.stateDir, 'auth_ok')));
  check('审计有 auth_fail', countAuditEvents(a.stateDir, 'auth_fail') >= 2,
    String(countAuditEvents(a.stateDir, 'auth_fail')));

  // ---- 6. 轮换与吊销 ----
  const created2 = await postJson({ port: portA, path: '/_security/pairing', headers: bridgeHeaders, body: {} });
  const code2 = jsonOf(created2).code;
  const redeemed2 = await postJson({ port: portA, path: '/_pair', body: { code: code2, name: '待轮换设备' } });
  const device2 = jsonOf(redeemed2).deviceId;
  const key2 = jsonOf(redeemed2).key;

  const rotate = await postJson({
    port: portA, path: '/_security/rotate', headers: bridgeHeaders, body: { id: device2 },
  });
  const rotateBody = jsonOf(rotate);
  check('rotate → 200 且返回一次性新 key',
    rotate.status === 200 && !!rotateBody
    && rotateBody.ok === true && /^[0-9a-f]{64}$/.test(rotateBody.key)
    && rotateBody.key !== key2,
    `HTTP ${rotate.status}`);

  const oldKey = await postJson({
    port: portA, path: '/v1/chat/completions', headers: { 'x-device-key': key2 }, body: CHAT_BODY,
  });
  check('轮换后旧 key 立即 401', oldKey.status === 401, `HTTP ${oldKey.status}`);
  const newKey = await postJson({
    port: portA, path: '/v1/chat/completions', headers: { 'x-device-key': rotateBody.key }, body: CHAT_BODY,
  });
  check('轮换后新 key 可用', newKey.status === 200, `HTTP ${newKey.status}`);

  const revoke = await postJson({
    port: portA, path: '/_security/revoke', headers: bridgeHeaders, body: { id: device2 },
  });
  check('revoke → 200', revoke.status === 200 && jsonOf(revoke)?.ok === true, `HTTP ${revoke.status}`);
  check('审计出现 revoke', await waitAuditEvent(a.stateDir, 'revoke'));
  const revokedKey = await postJson({
    port: portA, path: '/v1/chat/completions', headers: { 'x-device-key': rotateBody.key }, body: CHAT_BODY,
  });
  check('吊销后该 key 立即 401', revokedKey.status === 401, `HTTP ${revokedKey.status}`);

  const list2 = await request({ port: portA, path: '/_security/devices', headers: bridgeHeaders });
  const listed2 = (jsonOf(list2)?.devices || []).find((d) => d.id === device2);
  check('设备列表标记已吊销', !!listed2 && listed2.revokedAt != null);
  const revokeUnknown = await postJson({
    port: portA, path: '/_security/revoke', headers: bridgeHeaders, body: { id: 'dev_not_exist' },
  });
  check('吊销未知设备 → 404 not_found',
    revokeUnknown.status === 404 && jsonOf(revokeUnknown)?.error === 'not_found');

  // ---- 8. 审计不含请求体/提示词/key ----
  const secretRes = await postJson({
    port: portA,
    path: '/v1/chat/completions',
    headers: { 'x-device-key': key1 },
    body: {
      model: 'local',
      messages: [{ role: 'user', content: 'SECRET_PROMPT 这段内容绝不能写进审计文件' }],
      max_tokens: 8,
    },
  });
  check('含敏感内容的正常请求 → 200', secretRes.status === 200, `HTTP ${secretRes.status}`);
  const auditText = fs.readFileSync(path.join(a.stateDir, 'audit.jsonl'), 'utf8');
  check('审计不含请求体/提示词',
    !auditText.includes('SECRET_PROMPT') && !auditText.includes('这段内容绝不能写进审计文件'));
  check('审计不含设备 key / 上游 key',
    !auditText.includes(key1) && !auditText.includes(UPSTREAM_KEY));
  check('审计还包含预期事件',
    ['pair_create', 'pair_redeem_ok', 'pair_redeem_fail', 'auth_ok', 'auth_fail', 'revoke']
      .every((name) => auditEvents(a.stateDir).includes(name)));

  await stopChild(a.child);

  // ============================================================ B: 回环豁免
  console.log('\n--- B. 非 strict：回环豁免 ---');
  const portB = await freePort(portA + 1);
  const b = startProxy({
    name: 'b', port: portB, target, token: TOKEN,
    env: { PROXY_DEVICE_AUTH: '1' },
  });
  started.push(b.child);
  check('B 代理已就绪', await waitProxy(portB, TOKEN), `端口 ${portB}`);
  const loopbackChat = await postJson({ port: portB, path: '/v1/chat/completions', body: CHAT_BODY });
  check('PROXY_DEVICE_AUTH=1 且非 strict 时 127.0.0.1 直接 200',
    loopbackChat.status === 200, `HTTP ${loopbackChat.status}`);
  const loopbackProps = await request({ port: portB, path: '/props' });
  check('回环 /props 也豁免', loopbackProps.status === 200, `HTTP ${loopbackProps.status}`);
  const pageB = await request({ port: portB, path: '/' });
  check('页面/面板脚本不要求设备 key',
    pageB.status === 200 && pageB.body.includes('id="stove-panel"'), `HTTP ${pageB.status}`);
  await stopChild(b.child);

  // ================================================================ C: 限流
  console.log('\n--- C. 按 IP 限流 ---');
  const portC = await freePort(portB + 1);
  const c = startProxy({
    name: 'c', port: portC, target,
    env: { PROXY_RATE_CAPACITY: '3', PROXY_RATE_REFILL_PER_SEC: '0.001' },
  });
  started.push(c.child);
  check('C 代理已就绪', await waitProxy(portC), `端口 ${portC}`);

  const firstThree = [];
  for (let i = 0; i < 3; i++) {
    const r = await postJson({ port: portC, path: '/v1/chat/completions', body: CHAT_BODY });
    firstThree.push(r.status);
  }
  check('容量 3 内的前 3 次 → 200', firstThree.every((s) => s === 200), firstThree.join(','));
  const limited = await postJson({ port: portC, path: '/v1/chat/completions', body: CHAT_BODY });
  const limitedBody = jsonOf(limited);
  check('第 4 次 → 429 rate_limited',
    limited.status === 429 && limitedBody?.ok === false && limitedBody?.error === 'rate_limited',
    `HTTP ${limited.status} ${limited.body.slice(0, 80)}`);
  const retryAfter = limited.headers['retry-after'];
  check('429 带 Retry-After（秒，≥1）',
    /^\d+$/.test(String(retryAfter)) && Number(retryAfter) >= 1,
    `Retry-After=${retryAfter}`);
  const limitedAgain = await postJson({ port: portC, path: '/v1/chat/completions', body: CHAT_BODY });
  check('持续超限仍是 429', limitedAgain.status === 429, `HTTP ${limitedAgain.status}`);
  check('rate_limited 审计 5 秒内最多一条',
    countAuditEvents(c.stateDir, 'rate_limited') === 1,
    String(countAuditEvents(c.stateDir, 'rate_limited')));
  await stopChild(c.child);

  // ==================================================== D: 原有安全项不回归
  console.log('\n--- D. 原有安全项不回归（默认配置）---');
  const portD = await freePort(portC + 1);
  const d = startProxy({ name: 'd', port: portD, target, token: TOKEN });
  started.push(d.child);
  check('D 代理已就绪', await waitProxy(portD, TOKEN), `端口 ${portD}`);

  const slots = await request({ port: portD, path: '/slots' });
  check('/slots 仍 404', slots.status === 404, `HTTP ${slots.status}`);
  const metrics = await request({ port: portD, path: '/metrics?x=1' });
  check('/metrics 仍 404', metrics.status === 404, `HTTP ${metrics.status}`);

  const tooBig = Buffer.alloc(8 * 1024 * 1024 + 1, 0x61);
  const beforeBigHits = upstream.hits.length;
  const big = await request({
    port: portD,
    method: 'POST',
    path: '/v1/chat/completions',
    headers: { 'Content-Type': 'application/json' },
    body: tooBig,
  });
  check('超过 8 MiB 仍 413', big.status === 413, `HTTP ${big.status}`);
  check('超限请求没有转发到上游', upstream.hits.length === beforeBigHits);

  const noBridgeToken = await request({ port: portD, path: '/_bridge/status' });
  check('/_bridge 无 token 仍 401', noBridgeToken.status === 401, `HTTP ${noBridgeToken.status}`);

  const htmlD = await request({ port: portD, path: '/' });
  check('HTML 注入面板与 token',
    htmlD.status === 200
    && htmlD.body.includes('id="stove-panel"')
    && htmlD.body.includes('window.__STOVE_BRIDGE_TOKEN__')
    && htmlD.body.includes(TOKEN),
    `HTTP ${htmlD.status}`);

  const legacyChat = await postJson({ port: portD, path: '/v1/chat/completions', body: CHAT_BODY });
  check('未开设备鉴权时 /v1 不需要设备 key', legacyChat.status === 200, `HTTP ${legacyChat.status}`);
  await stopChild(d.child);

  // ============================================ E: UPSTREAM_KEY 为空时删除头
  console.log('\n--- E. 上游无 API key 时不泄露设备 key ---');
  const portE = await freePort(portD + 1);
  const e = startProxy({
    name: 'e', port: portE, target, token: TOKEN,
    env: { PROXY_DEVICE_AUTH: '1', PROXY_DEVICE_AUTH_STRICT: '1' },
  });
  started.push(e.child);
  check('E 代理已就绪', await waitProxy(portE, TOKEN), `端口 ${portE}`);
  const eVars = { headers: { 'x-bridge-token': TOKEN } };
  const ePairing = await postJson({
    port: portE, path: '/_security/pairing', ...eVars, body: {},
  });
  const eCode = jsonOf(ePairing).code;
  const eRedeem = await postJson({ port: portE, path: '/_pair', body: { code: eCode, name: '无上游 key' } });
  const eKey = jsonOf(eRedeem).key;
  const eChat = await postJson({
    port: portE, path: '/v1/chat/completions', headers: { 'x-device-key': eKey }, body: CHAT_BODY,
  });
  check('使用设备 key 请求 → 200', eChat.status === 200, `HTTP ${eChat.status}`);
  const eLastHit = upstream.hits[upstream.hits.length - 1];
  check('UPSTREAM_KEY 为空时 Authorization 被删除',
    eLastHit?.headers?.authorization === undefined,
    String(eLastHit?.headers?.authorization || '(无)'));
  check('上游仍收不到设备 key', !JSON.stringify(eLastHit?.headers || {}).includes(eKey));
  await stopChild(e.child);
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
