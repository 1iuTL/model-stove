// 真实热接管测试：Supervisor#1 拉起真实 llama-server，Supervisor#2（新实例）
// 通过台账 + /health 认领它，然后用 #2 的 stop() 收掉真实进程。
//
// 前置（与 tools/smoke_real.mjs 相同，见 docs/P0-进度.md 第九节）：
//   - D:\Qwen3.8-35B-A3B-Distill-Abl\...gguf
//   - C:\deepseek harness\models\llama-cpp\llama-server.exe
// 两者任一不存在就打印 SKIP 并 exit 0（明确跳过，不算通过）。
//
// 用法：
//   node tools/test_adoption_real.mjs
//   SMOKE_PORT=18291 node tools/test_adoption_real.mjs
//   SMOKE_EXE=D:\...\llama-server.exe node tools/test_adoption_real.mjs
//
// 退出码：0 = 真实跑通（或前置缺失 skip）；1 = 断言失败。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const REPO = path.resolve(import.meta.dirname, '..');
const cfg = require(path.join(REPO, 'src', 'config.js'));
const ports = require(path.join(REPO, 'src', 'core', 'ports.js'));
const { Supervisor, STATE } = require(path.join(REPO, 'src', 'core', 'supervisor.js'));
const { loadCapabilities } = require(path.join(REPO, 'src', 'core', 'capabilities.js'));
const { buildStartArgs, classifyStartupError } = require(path.join(REPO, 'src', 'core', 'args.js'));

const MODEL_DIR = 'D:\\Qwen3.8-35B-A3B-Distill-Abl';
const EXE = process.env.SMOKE_EXE
  ? path.resolve(process.env.SMOKE_EXE)
  : 'C:\\deepseek harness\\models\\llama-cpp\\llama-server.exe';
const model = cfg.MODELS.find((m) => m.id === 'qwen38distill-abl')
  || cfg.MODELS.find((m) => m.file && fs.existsSync(m.file));

const missing = [];
if (!fs.existsSync(MODEL_DIR)) missing.push(MODEL_DIR);
if (!fs.existsSync(EXE)) missing.push(EXE);
if (!model) missing.push('config.js 里没有可用模型条目');
else if (!fs.existsSync(model.file)) missing.push(model.file);

if (missing.length) {
  console.log('SKIP 真实热接管测试：前置文件缺失，未执行任何真实推理/进程操作。');
  for (const f of missing) console.log('  缺失:', f);
  process.exit(0);
}

const basePort = Number(process.env.SMOKE_PORT || 18291);
const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-stove-adopt-real-'));
const ledgerFile = path.join(logDir, 'running-pids.json');

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};

let sup1 = null;
let sup2 = null;
let stopped = false;
const totalT0 = Date.now();

try {
  console.log('=== 真实热接管（真实 llama-server + 真实 GGUF）===');
  console.log('模型条目:', model.id, '|', model.name);
  console.log('exe     :', EXE);
  console.log('model   :', model.file,
    `(${(fs.statSync(model.file).size / 2 ** 30).toFixed(2)} GiB)`);
  console.log('日志目录:', logDir);

  console.log('\n-- 能力探测 --');
  const tProbe = Date.now();
  const caps = loadCapabilities(EXE, { cache: false });
  console.log(`ok=${caps.ok} version=${caps.version || '?'} build=${caps.build || '?'}`
    + ` flags=${caps.flags ? caps.flags.size : 0} 用时 ${Date.now() - tProbe}ms`);

  // ---- Supervisor#1：真实拉起 ----
  sup1 = new Supervisor({
    logDir,
    ledgerFile,
    basePort,
    scanRange: 16,
    readyTimeoutMs: 600000,
    readinessPollMs: 300,
  });
  sup1.on('state', (s) => console.log('[sup1 state]', s.state, s.port || ''));

  const tStart = Date.now();
  const st1 = await sup1.start({
    exe: EXE,
    modelId: model.id,
    preset: model.defaultPreset,
    lanMode: false,
    argsForPort: (port) => buildStartArgs({
      model,
      presetKey: model.defaultPreset,
      port,
      reasoningKey: null,
      lanMode: false,
      apiKey: '',
      budgetKey: '32768',
      overrides: null,
      caps,
    }).args,
  });
  const startMs = Date.now() - tStart;
  console.log(`\n-- Supervisor#1 ready（真实启动 ${(startMs / 1000).toFixed(1)}s）--`);
  check('Supervisor#1 状态 ready', st1.state === STATE.READY, `pid=${st1.pid} port=${st1.port}`);
  check('启动时间已写入台账', Number.isFinite(st1.startedAt) && st1.startedAt > 0,
    String(st1.startedAt));
  const ledger1 = ports.readLedger(ledgerFile);
  check('台账记录 modelId/preset/lanMode',
    ledger1.length === 1 && ledger1[0].modelId === model.id
      && ledger1[0].preset === model.defaultPreset && ledger1[0].lanMode === false,
    JSON.stringify(ledger1[0]));

  // ---- Supervisor#2：同目录/同台账，热接管 ----
  sup2 = new Supervisor({
    logDir,
    ledgerFile,
    basePort,
    scanRange: 1,
    readyTimeoutMs: 5000,
    readinessPollMs: 100,
  });
  const adoptT0 = Date.now();
  const adopted = await sup2.tryAdopt({ timeoutMs: 2000 });
  const adoptMs = Date.now() - adoptT0;
  console.log(`\n-- Supervisor#2 tryAdopt --`);
  console.log('结果:', JSON.stringify({ adopted: adopted.adopted, reason: adopted.reason, identity: adopted.identity }));
  console.log(`接管耗时: ${adoptMs}ms`);

  check('tryAdopt 成功', adopted.adopted === true, adopted.reason || '');
  check('接管 identity 为 strong', adopted.identity === 'strong', String(adopted.identity));
  const st2 = sup2.status();
  check('Supervisor#2 状态 ready', st2.state === STATE.READY, st2.state);
  check('status().adopted === true', st2.adopted === true, String(st2.adopted));
  check('接管到同一个 PID', st2.pid === st1.pid, `${st2.pid} vs ${st1.pid}`);
  check('接管到同一个端口', st2.port === st1.port, `${st2.port} vs ${st1.port}`);
  check('模型信息随台账恢复', st2.modelId === model.id && st2.preset === model.defaultPreset,
    `${st2.modelId}/${st2.preset}`);
  check('接管耗时 < 2000ms', adoptMs < 2000, `${adoptMs}ms`);

  const health = await fetch(`${st2.url}health`);
  check('直接 GET /health 200', health.status === 200, `HTTP ${health.status}`);

  // ---- 用 Supervisor#2 收掉真实进程 ----
  const stopT0 = Date.now();
  const stoppedRes = await sup2.stop();
  stopped = true;
  const stopMs = Date.now() - stopT0;
  console.log(`\n-- Supervisor#2 stop（${stopMs}ms）--`);
  check('stop 返回 dead=true', stoppedRes.dead === true, JSON.stringify(stoppedRes));
  check('真实进程已退出', ports.pidAlive(st1.pid) === false, `pid=${st1.pid}`);
  check('Supervisor#2 回到 idle', sup2.status().state === STATE.IDLE, sup2.status().state);
  check('台账已清空', ports.readLedger(ledgerFile).length === 0,
    JSON.stringify(ports.readLedger(ledgerFile)));

  console.log(`\n总耗时: ${((Date.now() - totalT0) / 1000).toFixed(1)}s`
    + `（启动 ${(startMs / 1000).toFixed(1)}s + 接管 ${adoptMs}ms + 停止 ${stopMs}ms）`);
  console.log(failed ? '\n有检查项失败' : '\n全部通过（真实 llama-server 热接管 + 收尸）');
} catch (e) {
  check('测试执行无异常', false, e && e.message ? e.message : String(e));
  console.log(e && e.stack ? e.stack : e);
  if (sup2) {
    try { console.error('错误分类:', JSON.stringify(classifyStartupError(e.logTail || []))); } catch {}
  }
} finally {
  if (!stopped) {
    try { if (sup2) await sup2.stop(); } catch {}
    try { if (sup1) await sup1.stop(); } catch {}
  }
  try { fs.rmSync(logDir, { recursive: true, force: true }); } catch {}
}

process.exit(failed ? 1 : 0);
