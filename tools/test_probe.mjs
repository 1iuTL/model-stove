// 探针的端到端测试:对着**真实 llama-server** 验证它能不能分辨满速与溢出。
//
// 为什么非这样测不可:阈值定得对不对,拿假数据推是推不出来的。而且这段逻辑
// 的价值全在"溢出是静默的"这件事上 —— 只要它误报或漏报,整个功能就是负资产。
//
// 用同一个模型、同一个上下文,只换 KV 精度,构造出"满速"和"溢出"两种情况:
//     三元版 @64K + q4_0 -> 7319 MiB / 30-32 tok/s  (满速)
//     三元版 @64K + q8_0 -> 7869 MiB /  4-5  tok/s  (已溢出)
// 而这两者显存读数几乎一样,正是"不能靠显存判断"的实证。
//
// 跑法:node tools/test_probe.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { probeSpeed } = require('../src/probe.js');
const { MODELS } = require('../src/config.js');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = 'C:\\deepseek harness\\models\\llama-prism\\llama-server.exe';
const MODEL_FILE = 'F:\\models-archive\\Ternary-Bonsai-2-27B-Abliterated-PTQ1_0.gguf';
const PORT = 8099;
const BASE = `http://127.0.0.1:${PORT}`;
const LOG = path.join(ROOT, '_probe_test_server.log');

const model = MODELS.find((m) => m.id === 'ternary-abliterated');
if (!model) { console.error('找不到三元版模型定义'); process.exit(1); }

let fail = 0;
const ok = (cond, msg) => {
  if (cond) console.log('  PASS  ' + msg);
  else { console.error('  FAIL  ' + msg); fail++; }
};

function health() {
  return new Promise((resolve) => {
    const req = http.get(`${BASE}/health`, { timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startServer(kv) {
  const args = ['-m', MODEL_FILE, '-c', '65536', '-ngl', '99', '-fa', 'on', '-np', '1',
                '-ctk', kv, '-ctv', kv, '--port', String(PORT)];
  // Windows 沙箱禁止管道 stdio(Node 的 child_process 用默认 stdio:'pipe' 会
  // EPERM 崩掉)。必须把输出重定向到文件描述符 —— README 第 9.4 节记的就是这个。
  const fd = fs.openSync(LOG, 'a');
  const child = spawn(EXE, args, { stdio: ['ignore', fd, fd], windowsHide: true });
  fs.closeSync(fd);
  for (let i = 0; i < 150; i++) {
    await sleep(2000);
    if (child.exitCode !== null) throw new Error(`server 提前退出,code=${child.exitCode},见 ${LOG}`);
    if (await health()) return child;
  }
  child.kill();
  throw new Error('server 启动超时');
}

function stopServer(child) {
  try { child.kill('SIGKILL'); } catch {}
}

async function scenario(kv, expectSpilled) {
  console.log(`\n--- 三元版 @64K + ${kv} (期望 ${expectSpilled ? '判定溢出' : '满速'} ) ---`);
  fs.appendFileSync(LOG, `\n\n===== scenario kv=${kv} =====\n`);
  let child = null;
  try {
    child = await startServer(kv);
    const t0 = Date.now();
    const res = await probeSpeed(BASE, model, { alive: () => child.exitCode === null });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (!res) { ok(false, 'probeSpeed 返回了 null'); return; }
    console.log(`  实测 ${res.tps} tok/s (基线 ${res.expected},比值 ${res.ratio}) · 耗时 ${secs}s`);
    ok(res.spilled === expectSpilled,
       `spilled = ${res.spilled} (期望 ${expectSpilled})`);
    if (expectSpilled) {
      ok(res.tps < 12, `溢出时速度确实很低:${res.tps} tok/s`);
    } else {
      ok(res.tps > 20, `满速时速度确实正常:${res.tps} tok/s`);
    }
    ok(res.ratio > 0 && res.ratio < 3, `比值落在合理区间:${res.ratio}`);
  } catch (e) {
    ok(false, `场景异常:${e.message}`);
  } finally {
    if (child) stopServer(child);
    await sleep(6000);
  }
}

console.log(`模型基线 probeTps = ${model.probeTps}`);
console.log(`二进制 = ${EXE}`);
await scenario('q4_0', false);
await scenario('q8_0', true);

console.log('');
if (fail) { console.error(`✗ ${fail} 项失败`); process.exit(1); }
console.log('✓ 探针能正确区分满速与溢出');
