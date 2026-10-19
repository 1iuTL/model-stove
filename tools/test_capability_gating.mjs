// 能力门控的集成测试：假 llama-server + 真 Supervisor + buildStartArgs。
//
// 本机没有真实 llama-server / GGUF，所以这里写一个 node 假服务：
//   - `--version` / `--help` 输出一个**受限**的 flags 集合（故意没有 -fa、
//     --reasoning-*、--mmproj / --no-mmproj-offload / --image-max-tokens）；
//   - 正常启动时只读 --port，提供 /health 与最小 HTML；
//   - 由 Supervisor 真的 spawn / 等就绪 / kill，验证 argv 与收尸。
//
// 做法上的一个取舍：Windows 上不能直接 spawn 一个 .mjs 脚本（Supervisor 不用
// shell），所以 exe 用 node.exe，并把假脚本放在 argv 第一位；探测侧通过注入的
// execFileSync 用同样的方式执行脚本。这样仍是“真的跑 fake llama-server 的
// --version/--help”，只是比真实 llama-server.exe 多一层 node 宿主。
//
// 用法：node tools/test_capability_gating.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawn as nodeSpawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Supervisor, STATE } = require('../src/core/supervisor.js');
const ports = require('../src/core/ports.js');
const capsMod = require('../src/core/capabilities.js');
const argsMod = require('../src/core/args.js');
const cfg = require('../src/config.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'model-stove-caps-int-'));

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};

function request({ port, path: reqPath = '/' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: reqPath, method: 'GET' }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: text }));
    });
    req.on('error', reject);
    req.end();
  });
}

// 受限构建的 --help：只列出它真的认识的参数。
const HELP_TEXT = `
usage: llama-server [options]

 -m, --model PATH
 -c, --ctx-size N
 -ngl, --n-gpu-layers N
 -np, --parallel N
 -ctk, --cache-type-k TYPE
 -ctv, --cache-type-v TYPE
 --temp N
 --top-p N
 --top-k N
 --host HOST
 --port PORT
 --jinja
 --api-key KEY
 --no-slots
`;

const FAKE_SERVER = `
const http = require('http');
const HELP = ${JSON.stringify(HELP_TEXT)};
const argv = process.argv.slice(2);

if (argv.includes('--version')) {
  console.log('llama-server version: 0.0.0 (build: b4242)');
  process.exit(0);
}
if (argv.includes('--help')) {
  console.log(HELP);
  process.exit(0);
}

const pi = argv.indexOf('--port');
const port = Number(pi >= 0 ? argv[pi + 1] : 0);
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><body>fake llama ui</body></html>');
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
const modelFile = path.join(TMP, 'fake.gguf');
const mmprojFile = path.join(TMP, 'fake-mmproj.gguf');
fs.writeFileSync(modelFile, 'fake gguf', 'utf8');
fs.writeFileSync(mmprojFile, 'fake mmproj', 'utf8');

const baseModel = cfg.MODELS.find((m) => m.id === 'onbit');
const model = {
  ...baseModel,
  id: '__caps_gating__',
  name: 'caps gating fake',
  file: modelFile,
  bin: fakeScript,
  mmproj: mmprojFile,
  defaultPreset: 'vision-64k',
};

let supervisor = null;

try {
  console.log('=== 能力门控集成：假 llama-server + Supervisor ===');
  console.log(`  临时目录: ${TMP}`);

  // ------------------------------------------------------------ 探测
  console.log('\n--- 探测受限构建 ---');
  const probeExec = (exe, args, opts) => execFileSync(process.execPath, [fakeScript, ...args], opts);
  const caps = capsMod.loadCapabilities(fakeScript, {
    cache: false,
    cacheFile: path.join(TMP, 'cache', 'capabilities.json'),
    execFileSync: probeExec,
    tmpDir: path.join(TMP, 'probe'),
  });
  check('探测成功', caps.ok === true, caps.error || '');
  check('解析到版本与 build', caps.version === '0.0.0' && caps.build === 4242,
    `version=${caps.version} build=${caps.build}`);
  check('flags 里没有 -fa', !caps.flags.has('-fa'));
  check('flags 里没有 --reasoning-budget', !caps.flags.has('--reasoning-budget'));
  check('flags 里没有 --mmproj', !caps.flags.has('--mmproj'));
  check('核心参数齐全', capsMod.missingRequired(caps).length === 0,
    capsMod.missingRequired(caps).join(',') || '');
  check('多字母短参数 -ctk 被识别', caps.flags.has('-ctk'));

  // ------------------------------------------------------------ 启动
  console.log('\n--- 用门控后的 argv 拉起 ---');
  const basePort = await ports.findFreePort({ start: 18491, count: 100, host: '127.0.0.1' });
  const seen = [];
  supervisor = new Supervisor({
    logDir: path.join(TMP, 'logs'),
    ledgerFile: path.join(TMP, 'running-pids.json'),
    basePort,
    scanRange: 16,
    readyTimeoutMs: 15000,
    readinessPollMs: 100,
    killGraceMs: 3000,
    spawn: (exe, args, opts) => {
      seen.push({ exe, args: args.slice() });
      return nodeSpawn(exe, args, opts);
    },
  });

  let gated = null;
  const st = await supervisor.start({
    exe: process.execPath,
    modelId: model.id,
    preset: 'vision-64k',
    argsForPort: (port) => {
      gated = argsMod.buildStartArgs({
        model,
        presetKey: 'vision-64k',
        port,
        reasoningKey: null,
        lanMode: false,
        apiKey: '',
        budgetKey: null,
        overrides: null,
        caps,
      });
      // 假服务需要 node 宿主：脚本路径放第一位，其余仍是门控后的 llama argv。
      return [fakeScript, ...gated.args];
    },
  });

  check('Supervisor 状态为 ready', st.state === STATE.READY, st.state);
  check('确实 spawn 了一次', seen.length === 1, String(seen.length));
  const argv = seen.length ? seen[0].args : [];
  check('argv 用 node 拉起假脚本', argv[0] === fakeScript, String(argv[0]));
  check('保留核心参数 -m/-c/-ngl/-np/--host/--port',
    argv.includes('-m') && argv.includes('-c') && argv.includes('-ngl')
    && argv.includes('-np') && argv.includes('--host') && argv.includes('--port'));
  check('--port 是 Supervisor 动态选出来的',
    argv[argv.indexOf('--port') + 1] === String(st.port), `${argv[argv.indexOf('--port') + 1]} / ${st.port}`);
  check('被砍的 -fa 不在 argv 里', !argv.includes('-fa'));
  check('-ctk/-ctv 随 -fa 联动删除',
    !argv.includes('-ctk') && !argv.includes('-ctv'));
  check('--reasoning-budget 及其值不在 argv 里',
    !argv.includes('--reasoning-budget') && !argv.includes('32768'));
  check('--mmproj 及其联动参数不在 argv 里',
    !argv.includes('--mmproj') && !argv.includes('--no-mmproj-offload') && !argv.includes('--image-max-tokens'));
  check('--jinja 保留（模板是界面必需）', argv.includes('--jinja'));
  const droppedFlags = gated ? gated.dropped.map((d) => d.flag) : [];
  for (const f of ['-fa', '-ctk', '-ctv', '--reasoning-budget', '--mmproj',
    '--no-mmproj-offload', '--image-max-tokens']) {
    check(`dropped 记录了 ${f}`, droppedFlags.includes(f), droppedFlags.join(','));
  }

  const health = await request({ port: st.port, path: '/health' });
  check('假服务 /health 可用（服务确实起来了）', health.status === 200 && health.body === 'ok',
    `HTTP ${health.status}`);

  // ------------------------------------------------------------ 收尸
  console.log('\n--- 停止与收尸 ---');
  const stopRes = await supervisor.stop();
  check('stop 报告停掉了这个 PID', stopRes.stopped.includes(st.pid), JSON.stringify(stopRes));
  check('进程确实已退出', !ports.pidAlive(st.pid), `pid=${st.pid}`);
  check('台账已清空', ports.readLedger(path.join(TMP, 'running-pids.json')).length === 0);
} catch (e) {
  check('测试执行无异常', false, e && e.message ? e.message : String(e));
  console.log(e && e.stack ? e.stack : e);
} finally {
  if (supervisor) {
    try { await supervisor.stop(); } catch {}
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
}

console.log(failed === 0 ? '\n全部通过' : `\n有 ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
