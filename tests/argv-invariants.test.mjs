// 启动 argv 的语义不变量。
//
// 快照测试管"一字不差"，这里管"这些字必须表达同一件事"：
// 就算有人把基线文件一起重新生成了，破坏下面任何一条也会被拦住。
//
// 跑法：node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { buildArgvCases } from './argv-cases.mjs';

const require = createRequire(import.meta.url);
const cfg = require('../src/config.js');
const cases = buildArgvCases(cfg);
const byId = new Map(cases.map((c) => [c.id, c.args]));
const models = new Map(cfg.MODELS.map((m) => [m.id, m]));

const get = (id) => {
  const args = byId.get(id);
  assert.ok(args, `缺少用例 ${id}`);
  return args;
};
const valueOf = (args, flag) => {
  const i = args.indexOf(flag);
  assert.ok(i >= 0, `缺少参数 ${flag}`);
  assert.ok(i + 1 < args.length, `${flag} 没有值`);
  return args[i + 1];
};

test('每个模型的默认用例：路径、上下文、KV、采样都对得上模型定义', () => {
  for (const model of cfg.MODELS) {
    const args = get(`model=${model.id} default`);
    assert.equal(valueOf(args, '-m'), model.file);
    assert.equal(valueOf(args, '-ngl'), '99');
    assert.equal(valueOf(args, '-fa'), 'on');
    assert.equal(valueOf(args, '-np'), '1');
    assert.equal(valueOf(args, '-ctk'), 'q4_0');
    assert.equal(valueOf(args, '-ctv'), 'q4_0');
    assert.ok(args.includes('--jinja'), '必须启用 jinja 模板');
    assert.equal(valueOf(args, '--temp'), String(model.temp ?? 0.7));
    assert.equal(valueOf(args, '--top-p'), String(model.topP ?? 0.95));
    assert.equal(valueOf(args, '--top-k'), String(model.topK ?? 20));
    assert.equal(valueOf(args, '--host'), '127.0.0.1', '默认必须只监听回环');
    assert.equal(valueOf(args, '--port'), '8091');
    assert.equal(valueOf(args, '-c'), String(cfg.safeCtxFor(model, 'q4_0') < 65536 ? cfg.safeCtxFor(model, 'q4_0') : 65536),
      '默认预设 64K 必须被该 KV 精度的 safeCtx 夹住');
  }
});

test('局域网用例：只多出 0.0.0.0 与 --no-slots，其余参数不动', () => {
  for (const model of cfg.MODELS) {
    const loopback = get(`model=${model.id} default`);
    const lan = get(`model=${model.id} lan`);
    assert.equal(valueOf(lan, '--host'), '0.0.0.0');
    assert.ok(lan.includes('--no-slots'), '局域网模式必须关掉 /slots');
    // 去掉 --host/--port 及其值、以及 --no-slots 后，其余逐项相同
    const strip = (args) => {
      const out = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--host' || args[i] === '--port') { i++; continue; }
        if (args[i] === '--no-slots') continue;
        out.push(args[i]);
      }
      return out;
    };
    assert.deepEqual(strip(lan), strip(loopback));
  }
});

test('默认回环模式不允许出现 --no-slots 以外的对外暴露', () => {
  for (const model of cfg.MODELS) {
    const args = get(`model=${model.id} default`);
    assert.ok(!args.includes('0.0.0.0'), '默认模式不得绑定 0.0.0.0');
    assert.ok(!args.includes('--no-slots'), '回环模式保持原有行为（由 P0 安全层再收紧）');
  }
});

test('思考档位与预算的映射', () => {
  const model = cfg.MODELS[0];
  assert.equal(get(`model=${model.id} reasoning-off-unlimited`).includes('--reasoning-effort'), true);
  assert.equal(valueOf(get(`model=${model.id} reasoning-off-unlimited`), '--reasoning-effort'), 'none');
  assert.ok(!get(`model=${model.id} reasoning-off-unlimited`).includes('--reasoning-budget'),
    'off 档不加预算');
  assert.equal(valueOf(get(`model=${model.id} reasoning-high-budget8192`), '--reasoning-effort'), 'high');
  assert.equal(valueOf(get(`model=${model.id} reasoning-high-budget8192`), '--reasoning-budget'), '8192');
  assert.ok(!get(`model=${model.id} reasoning-server-default`).includes('--reasoning-effort'),
    'server-default 不加 flag');
  assert.ok(!get(`model=${model.id} budget-unlimited-with-reasoning-low`).includes('--reasoning-budget'),
    '不限预算不加 flag');
});

test('视觉预设：mmproj 配对正确（逐模型优先于全局）', () => {
  for (const model of cfg.MODELS) {
    const args = get(`model=${model.id} preset-vision64k`);
    assert.equal(valueOf(args, '--mmproj'), model.mmproj || cfg.MMPROJ);
    assert.ok(args.includes('--no-mmproj-offload'));
    assert.equal(valueOf(args, '--image-max-tokens'), '1024');
  }
});

test('上下文覆盖必须吸附档位并夹进 [8192, maxCtx]', () => {
  const model = cfg.MODELS[0];
  assert.equal(valueOf(get(`model=${model.id} ctx-49152`), '-c'), '49152');
  assert.equal(valueOf(get(`model=${model.id} ctx-above-max`), '-c'), String(model.maxCtx));
  assert.equal(valueOf(get(`model=${model.id} ctx-below-min`), '-c'), String(cfg.CTX_STEPS[0]));
});

test('KV 精度覆盖会重新夹紧预设上下文', () => {
  for (const model of cfg.MODELS) {
    const q8 = get(`model=${model.id} kv-q8_0`);
    assert.equal(valueOf(q8, '-ctk'), 'q8_0');
    assert.equal(valueOf(q8, '-ctv'), 'q8_0');
    const safe = cfg.safeCtxFor(model, 'q8_0');
    const expected = safe && 65536 > safe ? safe : 65536;
    assert.equal(valueOf(q8, '-c'), String(expected), `${model.id}: q8_0 下 64K 预设应被夹到 ${expected}`);
  }
});

test('API Key 只影响 --api-key 一项', () => {
  for (const model of cfg.MODELS) {
    const base = get(`model=${model.id} default`);
    const keyed = get(`model=${model.id} api-key`);
    assert.equal(valueOf(keyed, '--api-key'), 'k-3f9a2c7d81b4');
    assert.deepEqual(keyed.filter((a) => a !== '--api-key' && a !== 'k-3f9a2c7d81b4'), base);
  }
});

test('逐模型字段：extraArgs 追加在最后，端口可参数化', () => {
  for (const model of cfg.MODELS) {
    const args = get(`model=${model.id} default`);
    if (Array.isArray(model.extraArgs) && model.extraArgs.length) {
      assert.deepEqual(args.slice(-model.extraArgs.length), model.extraArgs, 'extraArgs 必须是最后几项');
    }
    assert.equal(valueOf(get(`model=${model.id} port-18091`), '--port'), '18091');
  }
});
