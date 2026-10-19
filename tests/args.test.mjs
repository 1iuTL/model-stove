// 参数门控 / 启动失败分类 / 一次降级（src/core/args.js）的单元测试。
//
// 最关键的是第一组：用 tests/fixtures/argv-baseline.json 的 90 个用例，
// 在“构建支持全部参数”的前提下逐字节比对 buildStartArgs() 与基线。
// caps 即使全支持也必须原样通过，这是 P1 的硬约束。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cfg = require('../src/config.js');
const argsMod = require('../src/core/args.js');
const capsMod = require('../src/core/capabilities.js');

const fixture = JSON.parse(
  fs.readFileSync(new URL('./fixtures/argv-baseline.json', import.meta.url), 'utf8'),
);
const DEFAULT_PORT = 8091;

/** 与 tests/argv-cases.mjs 相同的 15 类输入 × 6 个模型，但保留完整参数。 */
function enumerateCases() {
  const cases = [];
  const mk = (id, model, opts = {}) => {
    const presetKey = opts.preset ?? model.defaultPreset;
    const port = opts.port ?? DEFAULT_PORT;
    const reasoningKey = opts.reasoning ?? null;
    const lanMode = opts.lanMode ?? false;
    const apiKey = opts.apiKey ?? '';
    const budgetKey = opts.budgetKey ?? null;
    const overrides = opts.overrides ?? null;
    const legacy = cfg.buildArgs(model, presetKey, port, reasoningKey, lanMode, apiKey, budgetKey, overrides);
    cases.push({
      id,
      model,
      presetKey,
      port,
      reasoningKey,
      lanMode,
      apiKey,
      budgetKey,
      overrides,
      legacy,
    });
  };

  for (const model of cfg.MODELS) {
    const p = `model=${model.id}`;
    mk(`${p} default`, model);
    mk(`${p} lan`, model, { lanMode: true });
    mk(`${p} preset-quick8k`, model, { preset: 'quick-8k' });
    mk(`${p} preset-vision64k`, model, { preset: 'vision-64k' });
    mk(`${p} reasoning-off-unlimited`, model, { reasoning: 'off', budgetKey: 'unlimited' });
    mk(`${p} reasoning-high-budget8192`, model, { reasoning: 'high', budgetKey: '8192' });
    mk(`${p} reasoning-server-default`, model, { reasoning: 'server-default', budgetKey: '32768' });
    mk(`${p} kv-q8_0`, model, { overrides: { kv: 'q8_0' } });
    mk(`${p} ctx-49152`, model, { overrides: { ctx: 49152 } });
    mk(`${p} ctx-above-max`, model, { overrides: { ctx: 300000 } });
    mk(`${p} ctx-below-min`, model, { overrides: { ctx: 5000 } });
    mk(`${p} ctx-invalid-and-kv-invalid`, model, { overrides: { ctx: 'abc', kv: 'bogus' } });
    mk(`${p} api-key`, model, { apiKey: 'k-3f9a2c7d81b4' });
    mk(`${p} port-18091`, model, { port: 18091 });
    mk(`${p} budget-unlimited-with-reasoning-low`, model, { reasoning: 'low', budgetKey: 'unlimited' });
  }
  return cases;
}

const cases = enumerateCases();

/** 构造“支持全部参数”的 caps：把 90 例里出现过的所有开关并起来。 */
function fullCaps() {
  const flags = new Set();
  for (const c of cases) {
    for (const token of c.legacy) {
      if (typeof token === 'string' && token.startsWith('-')) flags.add(token);
    }
  }
  for (const f of capsMod.REQUIRED_FLAGS) flags.add(f);
  return { exe: 'C:\\fake\\llama-server.exe', ok: true, version: '0.0.0', build: 1, flags, probedAt: null, error: null };
}

const ALL_CAPS = fullCaps();

function capsWithout(...omit) {
  const flags = new Set(ALL_CAPS.flags);
  for (const f of omit) flags.delete(f);
  return { ...ALL_CAPS, flags };
}

function paramsFor(c, caps) {
  return {
    model: c.model,
    presetKey: c.presetKey,
    port: c.port,
    reasoningKey: c.reasoningKey,
    lanMode: c.lanMode,
    apiKey: c.apiKey,
    budgetKey: c.budgetKey,
    overrides: c.overrides,
    caps,
  };
}

function removeArgs(args, flags) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (flags.includes(args[i])) {
      if (argsMod.VALUE_FLAGS.has(args[i]) && i + 1 < args.length) i++;
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

function byId(id) {
  const hit = cases.find((c) => c.id === id);
  assert.ok(hit, `找不到用例 ${id}`);
  return hit;
}

// ---------------------------------------------------------------- 90 例快照

test('用例集合与基线文件一一对应（90 例）', () => {
  assert.equal(cases.length, 90);
  assert.deepEqual(cases.map((c) => c.id).sort(), Object.keys(fixture.cases).sort());
});

for (const c of cases) {
  test(`全支持 caps 下与基线逐字节一致：${c.id}`, () => {
    const built = argsMod.buildStartArgs(paramsFor(c, ALL_CAPS));
    assert.deepEqual(built.args, fixture.cases[c.id]);
    assert.deepEqual(built.dropped, []);
    assert.deepEqual(built.unsupportedRequired, []);
  });
}

// ---------------------------------------------------------------- 单项删除

test('caps 缺 -fa：只删 -fa 并联动删 -ctk/-ctv', () => {
  const c = byId('model=onbit default');
  const gated = argsMod.gateArgs(c.legacy, capsWithout('-fa'));
  assert.deepEqual(gated.args, removeArgs(c.legacy, ['-fa', '-ctk', '-ctv']));
  assert.deepEqual(gated.dropped.map((d) => d.flag), ['-fa', '-ctk', '-ctv']);
  assert.equal(gated.dropped[0].value, 'on');
  assert.equal(gated.dropped[1].value, 'q4_0');
  assert.equal(gated.dropped[2].value, 'q4_0');
  assert.ok(!gated.args.includes('on'), '-fa 的值不能残留');
  assert.ok(!gated.args.includes('-ctk'));
  assert.ok(!gated.args.includes('-ctv'));
  assert.deepEqual(gated.unsupportedRequired, []);
});

test('caps 缺 --mmproj：连同 --no-mmproj-offload / --image-max-tokens 一起删', () => {
  const c = byId('model=onbit preset-vision64k');
  assert.ok(c.legacy.includes('--mmproj'));
  const gated = argsMod.gateArgs(c.legacy, capsWithout('--mmproj'));
  assert.ok(!gated.args.includes('--mmproj'));
  assert.ok(!gated.args.includes('--no-mmproj-offload'));
  assert.ok(!gated.args.includes('--image-max-tokens'));
  assert.ok(!gated.args.includes('1024'), '--image-max-tokens 的值不能残留');
  const droppedFlags = gated.dropped.map((d) => d.flag);
  for (const f of ['--mmproj', '--no-mmproj-offload', '--image-max-tokens']) {
    assert.ok(droppedFlags.includes(f), `dropped 缺少 ${f}`);
  }
});

test('caps 缺 --jinja：明确保留，不静默删（交给分类/降级层处理）', () => {
  const c = byId('model=onbit default');
  const gated = argsMod.gateArgs(c.legacy, capsWithout('--jinja'));
  assert.ok(gated.args.includes('--jinja'));
  assert.ok(!gated.dropped.some((d) => d.flag === '--jinja'));
});

test('caps 未知/探测失败：原样返回', () => {
  const c = byId('model=onbit default');
  for (const caps of [null, undefined, { ok: false, flags: new Set() }, { ok: true }]) {
    const gated = argsMod.gateArgs(c.legacy, caps);
    assert.deepEqual(gated.args, c.legacy);
    assert.deepEqual(gated.dropped, []);
    assert.deepEqual(gated.unsupportedRequired, []);
  }
});

test('值开关：删 --reasoning-budget 时只删参数和它的值，不吞后面的 --api-key', () => {
  const c = byId('model=onbit api-key');
  assert.ok(c.legacy.includes('--reasoning-budget'));
  assert.ok(c.legacy.includes('32768'));
  const gated = argsMod.gateArgs(c.legacy, capsWithout('--reasoning-budget'));
  assert.ok(!gated.args.includes('--reasoning-budget'));
  assert.ok(!gated.args.includes('32768'));
  assert.ok(gated.args.includes('--api-key'));
  assert.ok(gated.args.includes('k-3f9a2c7d81b4'));
  assert.deepEqual(gated.dropped, [{ flag: '--reasoning-budget', value: '32768' }]);
});

test('布尔开关：删 --no-slots 只删它自己', () => {
  const c = byId('model=onbit lan');
  const gated = argsMod.gateArgs(c.legacy, capsWithout('--no-slots'));
  assert.deepEqual(gated.args, removeArgs(c.legacy, ['--no-slots']));
  assert.deepEqual(gated.dropped, [{ flag: '--no-slots', value: null }]);
});

// ---------------------------------------------------------------- 核心参数

test('核心参数缺失：不静默删，返回 unsupportedRequired，buildStartArgs 明确报错', () => {
  const c = byId('model=onbit default');
  const gated = argsMod.gateArgs(c.legacy, capsWithout('-m'));
  assert.deepEqual(gated.unsupportedRequired, ['-m']);
  assert.ok(gated.args.includes('-m'), '核心参数不能删掉后继续跑');
  assert.throws(() => argsMod.buildStartArgs(paramsFor(c, capsWithout('-m'))),
    /缺少外壳必需的核心参数|不是 llama-server|构建太旧/);
});

test('核心参数只有长别名时按支持处理', () => {
  const flags = new Set(ALL_CAPS.flags);
  for (const f of ['-m', '-c', '-ngl', '-np']) flags.delete(f);
  for (const f of ['--model', '--ctx-size', '--n-gpu-layers', '--parallel']) flags.add(f);
  const c = byId('model=onbit default');
  const gated = argsMod.gateArgs(c.legacy, { ...ALL_CAPS, flags });
  assert.deepEqual(gated.unsupportedRequired, []);
  assert.deepEqual(gated.args, c.legacy);
});

// ---------------------------------------------------------------- 失败分类

test('classifyStartupError：unknown-argument', () => {
  for (const line of [
    'error: unknown argument: --foo',
    'error: unrecognized option --bar',
    'option --baz not recognized',
  ]) {
    const r = argsMod.classifyStartupError([line]);
    assert.equal(r.kind, 'unknown-argument');
    assert.ok(r.evidence.includes(line.split(' ')[2] || ''));
  }
});

test('classifyStartupError：unsupported-quantization', () => {
  for (const line of [
    'invalid ggml type 143',
    'unsupported ggml type 42',
    'error: unknown model architecture: qwen35',
    'unknown quantization type',
  ]) {
    assert.equal(argsMod.classifyStartupError([line]).kind, 'unsupported-quantization');
  }
});

test('classifyStartupError：missing-chat-template', () => {
  for (const line of [
    'failed to apply chat template: template not found',
    'Jinja Exception: chat_template missing',
    'error: apply template failed',
  ]) {
    assert.equal(argsMod.classifyStartupError([line]).kind, 'missing-chat-template');
  }
});

test('classifyStartupError：oom（数组与整段字符串都支持）', () => {
  const lines = [
    'llama_model_load: loading model',
    'ggml_backend_cuda_buffer_type_alloc_buffer: failed to allocate 1024 MiB',
  ];
  const r = argsMod.classifyStartupError(lines);
  assert.equal(r.kind, 'oom');
  assert.match(r.evidence, /failed to allocate/);
  assert.equal(argsMod.classifyStartupError('CUDA error: out of memory').kind, 'oom');
});

test('classifyStartupError：未知错误保留最后一行作为证据', () => {
  const r = argsMod.classifyStartupError(['line one', 'boom: something exploded']);
  assert.equal(r.kind, 'unknown');
  assert.equal(r.evidence, 'boom: something exploded');
  assert.equal(argsMod.classifyStartupError([]).kind, 'unknown');
});

test('classifyStartupError：分类优先级（unknown-argument 先于 oom）', () => {
  const r = argsMod.classifyStartupError([
    'error: unknown argument: --foo',
    'CUDA error: out of memory',
  ]);
  assert.equal(r.kind, 'unknown-argument');
});

// ---------------------------------------------------------------- 降级计划

test('planRetry unknown-argument：按 caps 过滤，changed=true', () => {
  const c = byId('model=onbit default');
  const plan = argsMod.planRetry(c.legacy, capsWithout('-fa'), 'unknown-argument');
  assert.equal(plan.changed, true);
  assert.ok(!plan.args.includes('-fa'));
  assert.ok(!plan.args.includes('-ctk'));
  assert.match(plan.action, /-fa/);
});

test('planRetry unknown-argument：全支持时无计可施（changed=false）', () => {
  const c = byId('model=onbit default');
  const plan = argsMod.planRetry(c.legacy, ALL_CAPS, 'unknown-argument');
  assert.equal(plan.changed, false);
  assert.deepEqual(plan.args, c.legacy);
});

test('planRetry unsupported-quantization：不改 argv，只给换构建/换量化的建议', () => {
  const c = byId('model=ternary default');
  const plan = argsMod.planRetry(c.legacy, ALL_CAPS, 'unsupported-quantization');
  assert.equal(plan.changed, false);
  assert.deepEqual(plan.args, c.legacy);
  assert.match(plan.action, /构建|量化/);
});

test('planRetry missing-chat-template：去掉 --jinja，并提示只能纯补全', () => {
  const c = byId('model=onbit default');
  const plan = argsMod.planRetry(c.legacy, ALL_CAPS, 'missing-chat-template');
  assert.equal(plan.changed, true);
  assert.ok(!plan.args.includes('--jinja'));
  assert.deepEqual(plan.args, c.legacy.filter((a) => a !== '--jinja'));
  assert.match(plan.action, /补全/);
  // 再规划一次不应该再变（只降一次）
  const again = argsMod.planRetry(plan.args, ALL_CAPS, 'missing-chat-template');
  assert.equal(again.changed, false);
});

test('missing-chat-template 的降级结果必须仍经过 gateArgs（否则会复活不支持参数）', () => {
  const c = byId('model=onbit preset-vision64k');
  const broken = capsWithout('-fa', '--reasoning-budget', '--mmproj');
  const plan = argsMod.planRetry(c.legacy, broken, 'missing-chat-template');
  assert.ok(!plan.args.includes('--jinja'));
  const gated = argsMod.gateArgs(plan.args, broken);
  for (const f of ['-fa', '-ctk', '-ctv', '--reasoning-budget', '--mmproj',
    '--no-mmproj-offload', '--image-max-tokens']) {
    assert.ok(!gated.args.includes(f), `重试 argv 里仍残留 ${f}`);
  }
  assert.ok(gated.args.includes('-m') && gated.args.includes('--port'));
});

test('planRetry oom：不改 argv，建议降 ctx / 换 KV 精度', () => {
  const c = byId('model=onbit default');
  const plan = argsMod.planRetry(c.legacy, ALL_CAPS, 'oom');
  assert.equal(plan.changed, false);
  assert.deepEqual(plan.args, c.legacy);
  assert.match(plan.action, /上下文|KV/);
});

test('planRetry unknown：不改 argv', () => {
  const c = byId('model=onbit default');
  const plan = argsMod.planRetry(c.legacy, ALL_CAPS, 'unknown');
  assert.equal(plan.changed, false);
  assert.deepEqual(plan.args, c.legacy);
  assert.match(plan.action, /日志/);
});

// ---------------------------------------------------------------- 语义不变量

test('buildStartArgs 返回独立数组，不修改 config.buildArgs 的结果', () => {
  const c = byId('model=onbit default');
  const original = c.legacy.slice();
  const built = argsMod.buildStartArgs(paramsFor(c, capsWithout('-fa')));
  assert.deepEqual(c.legacy, original);
  assert.notEqual(built.args, c.legacy);
});

test('参数顺序不变：门控只删除、不重排', () => {
  const c = byId('model=onbit preset-vision64k');
  const gated = argsMod.gateArgs(c.legacy, capsWithout('-fa', '--mmproj'));
  const kept = c.legacy.filter((t) => gated.args.includes(t));
  // 用子序列的方式验证：每个保留项在原数组里的出现顺序一致
  let cursor = 0;
  for (const token of gated.args) {
    const idx = c.legacy.indexOf(token, cursor);
    assert.ok(idx >= cursor, `参数 ${token} 顺序被改变或凭空出现`);
    cursor = idx + 1;
  }
  assert.ok(kept.length >= gated.args.length);
});

// ------------------------------------------- P1 安全护栏：局域网模式必须有鉴权

function capsWith(...flags) {
  return { ok: true, flags: new Set(flags) };
}

test('assertLanSafety：回环模式不需要 Key', () => {
  assert.deepEqual(
    argsMod.assertLanSafety({ lanMode: false, apiKey: '', caps: capsWith() }),
    { ok: true },
  );
});

test('assertLanSafety：局域网模式没有 Key 必须拒绝', () => {
  assert.throws(
    () => argsMod.assertLanSafety({ lanMode: true, apiKey: '', caps: capsWith('--api-key', '--no-slots') }),
    /API Key/,
  );
  // 纯空白也当没设置
  assert.throws(
    () => argsMod.assertLanSafety({ lanMode: true, apiKey: '   ', caps: null }),
    /API Key/,
  );
});

test('assertLanSafety：构建不支持 --api-key 时拒绝 LAN（否则等于裸奔）', () => {
  assert.throws(
    () => argsMod.assertLanSafety({ lanMode: true, apiKey: 'k', caps: capsWith('--no-slots') }),
    /不支持 --api-key/,
  );
});

test('assertLanSafety：构建不支持 --no-slots 时拒绝 LAN（防对话槽位泄露）', () => {
  assert.throws(
    () => argsMod.assertLanSafety({ lanMode: true, apiKey: 'k', caps: capsWith('--api-key') }),
    /不支持 --no-slots/,
  );
});

test('assertLanSafety：caps 未知时只要求 Key（兼容模式不额外阻断）', () => {
  assert.deepEqual(
    argsMod.assertLanSafety({ lanMode: true, apiKey: 'k', caps: null }),
    { ok: true },
  );
  assert.deepEqual(
    argsMod.assertLanSafety({ lanMode: true, apiKey: 'k', caps: { ok: false, error: 'probe failed' } }),
    { ok: true },
  );
});
