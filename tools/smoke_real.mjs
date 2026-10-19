// 真实端到端冒烟：能力探测 → 参数门控 → Supervisor 拉起真实 llama-server
// → /health → 一次真实推理 → 停止收尸。
//
// 这是唯一能把 core 层与真实 llama.cpp/GGUF 放在一起验证的脚本；其他测试都用假进程。
// 前置（见 docs/P0-进度.md 第九节）：
//   - 真实 llama-server.exe（当前用 llama.cpp b11669 Vulkan 构建）
//   - 真实 GGUF（当前用 qwen38distill-abl 条目指向的 Qwen3.8-35B-A3B-Distill）
//
// 用法：
//   node tools/smoke_real.mjs                       # 默认 qwen38distill-abl
//   MODEL_ID=qwen36-abl node tools/smoke_real.mjs   # 换模型条目
//   SMOKE_MAX_TOKENS=32 node tools/smoke_real.mjs   # 推理 token 上限（默认 64）
//   SMOKE_PORT=8091 node tools/smoke_real.mjs       # 起始端口
//
// 退出码：0 = 全链路通过；1 = 失败（会打印分类与日志尾巴）；2 = 前置文件缺失。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const REPO = path.resolve(import.meta.dirname, '..');
const cfg = require(path.join(REPO, 'src', 'config.js'));
const { Supervisor } = require(path.join(REPO, 'src', 'core', 'supervisor.js'));
const { loadCapabilities } = require(path.join(REPO, 'src', 'core', 'capabilities.js'));
const { buildStartArgs, classifyStartupError } = require(path.join(REPO, 'src', 'core', 'args.js'));

const modelId = process.env.MODEL_ID || 'qwen38distill-abl';
const maxTokens = Number(process.env.SMOKE_MAX_TOKENS || 64);
const basePort = Number(process.env.SMOKE_PORT || 8091);
const model = cfg.MODELS.find((m) => m.id === modelId);
if (!model) {
  console.error(`✗ 未知模型条目: ${modelId}（可选: ${cfg.MODELS.map((m) => m.id).join(', ')}）`);
  process.exit(2);
}
const missing = [model.bin, model.file].filter((f) => !fs.existsSync(f));
if (missing.length) {
  console.error('✗ 前置文件缺失：');
  for (const f of missing) console.error('   ', f);
  console.error('  先用 README 的 A/B 路子准备 llama-server 与 GGUF，或改 src/config.js 的路径。');
  process.exit(2);
}

console.log('== 前置 ==');
console.log('模型条目:', model.id, '|', model.name);
console.log('exe   :', model.bin);
console.log('model :', model.file, `(${(fs.statSync(model.file).size / 2 ** 30).toFixed(2)} GiB)`);

console.log('\n== 能力探测 ==');
const tProbe = Date.now();
const caps = loadCapabilities(model.bin, { cache: false });
console.log(`ok=${caps.ok} version=${caps.version || '?'} build=${caps.build || '?'} flags=${caps.flags ? caps.flags.size : 0} 用时 ${Date.now() - tProbe}ms`);
if (!caps.ok) console.log('探测失败，将走兼容模式（argv 原样）:', caps.error || '');

const logDir = path.join(REPO, 'logs', 'smoke-real');
const sup = new Supervisor({
  logDir,
  ledgerFile: path.join(logDir, 'running-pids.json'),
  basePort,
  scanRange: 16,
  readyTimeoutMs: 600000,
  readinessPollMs: 300,
});
sup.on('state', (s) => console.log('[state]', s.state, s.port || ''));

let st;
const t0 = Date.now();
try {
  st = await sup.start({
    exe: model.bin,
    modelId: model.id,
    preset: model.defaultPreset,
    argsForPort: (port) => {
      const gated = buildStartArgs({
        model,
        presetKey: model.defaultPreset,
        port,
        reasoningKey: null,
        lanMode: false,
        apiKey: '',
        budgetKey: '32768',
        overrides: null,
        caps,
      });
      console.log('argv:', gated.args.join(' '));
      console.log('gated:', gated.dropped.length ? JSON.stringify(gated.dropped) : '(无删除项 → 与旧版逐字节一致)');
      return gated.args;
    },
  });
} catch (e) {
  console.error('\n✗ 启动失败:', e.message);
  console.error('分类:', JSON.stringify(classifyStartupError(e.logTail || [])));
  try { await sup.stop(); } catch {}
  process.exit(1);
}

let failed = false;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed = true;
};

console.log(`\n== READY（外壳附加开销 ${((Date.now() - t0) / 1000).toFixed(1)}s） ==`);
check('Supervisor 状态 ready', st.state === 'ready', `pid=${st.pid} port=${st.port}`);
check('只监听回环', st.url === `http://127.0.0.1:${st.port}/`, st.url);

const getJson = async (url, init) => {
  const r = await fetch(url, init);
  const text = await r.text();
  return { status: r.status, text };
};

const health = await getJson(st.url + 'health');
check('/health 200', health.status === 200, health.text.slice(0, 80));
const models = await getJson(st.url + 'v1/models');
check('/v1/models 200', models.status === 200);

console.log(`\n== 真实推理（max_tokens=${maxTokens}） ==`);
const t1 = Date.now();
const chat = await getJson(st.url + 'v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ messages: [{ role: 'user', content: '用一句话介绍你自己。' }], max_tokens: maxTokens, temperature: 0.6 }),
});
const secs = ((Date.now() - t1) / 1000).toFixed(1);
check('/v1/chat/completions 200', chat.status === 200, `${secs}s`);
if (chat.status === 200) {
  try {
    const data = JSON.parse(chat.text);
    const msg = (data.choices && data.choices[0] && data.choices[0].message) || {};
    // 思考型模型可能把 32 个 token 全花在 reasoning_content 上，content 为空；
    // 两边任一有内容都算推理链路通了（这里验的是链路，不是输出质量）。
    const text = msg.content || '';
    const reasoning = msg.reasoning_content || '';
    check('返回了文本（content 或 reasoning）', !!(text || reasoning),
      JSON.stringify((text || reasoning).slice(0, 60)));
    if (text) console.log(`  content(${text.length} chars): ${JSON.stringify(text.slice(0, 80))}`);
    if (reasoning) console.log(`  reasoning(${reasoning.length} chars): ${JSON.stringify(reasoning.slice(0, 80))}`);
    if (data.timings) console.log(`  timings: prompt ${data.timings.prompt_per_second?.toFixed?.(1)} tok/s, predict ${data.timings.predicted_per_second?.toFixed?.(1)} tok/s`);
  } catch {
    check('响应是合法 JSON', false, chat.text.slice(0, 200));
  }
}

console.log('\n== 停止 ==');
const stopped = await sup.stop();
check('停止后回到 idle', sup.status().state === 'idle', JSON.stringify(stopped));
check('进程确实退出', !!stopped.dead, JSON.stringify(stopped));
check('台账已清空', !fs.existsSync(path.join(logDir, 'running-pids.json')) || fs.readFileSync(path.join(logDir, 'running-pids.json'), 'utf8').trim() === '[]');

console.log(failed ? '\n有检查项失败' : '\n全部通过（真实 llama-server + 真实 GGUF）');
process.exit(failed ? 1 : 0);
