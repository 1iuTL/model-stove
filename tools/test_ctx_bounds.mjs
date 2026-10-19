// 上下文滑块 + KV 精度的边界测试。
//
// 为什么值得单独测:`-c` 一旦越界,llama.cpp **不报错**,只是把 KV cache 挪到
// 主机内存、速度掉约 6-8 倍。没有异常、没有非零退出码、日志只有一行 warning ——
// 靠运行时是发现不了的,只能在参数生成这一层卡死。
//
// 跑法:node tools/test_ctx_bounds.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { MODELS, CTX_STEPS, VRAM_CEILING_MIB, KV_TYPES, DEFAULT_KV,
        snapCtx, safeCtxFor, resolveKv, buildArgs } = require('../src/config.js');

let fail = 0;
const ok = (cond, msg) => {
  if (cond) { console.log('  PASS  ' + msg); }
  else { console.error('  FAIL  ' + msg); fail++; }
};

const ctxOf = (args) => {
  const i = args.indexOf('-c');
  return i >= 0 ? Number(args[i + 1]) : null;
};
const kvOf = (args) => {
  const i = args.indexOf('-ctk');
  return i >= 0 ? args[i + 1] : null;
};

console.log(`CTX_STEPS = ${CTX_STEPS.join(', ')}`);
console.log(`VRAM_CEILING_MIB = ${VRAM_CEILING_MIB}`);
console.log(`KV_TYPES = ${KV_TYPES.map((k) => k.key).join(', ')} (default ${DEFAULT_KV})\n`);

for (const m of MODELS) {
  console.log(`--- ${m.name} (maxCtx=${m.maxCtx}, probeTps=${m.probeTps}) ---`);
  const steps = CTX_STEPS.filter((s) => s <= m.maxCtx);
  ok(steps.length > 0, '至少有一个可用档位');
  ok(steps[steps.length - 1] <= m.maxCtx, '档位不超过 maxCtx');

  // 每个 KV 精度都要有独立的安全上限,且必须是合法档位
  for (const k of KV_TYPES) {
    const safe = safeCtxFor(m, k.key);
    ok(typeof safe === 'number' && safe > 0, `${k.key}: safeCtx = ${safe}`);
    ok(steps.includes(safe), `${k.key}: safeCtx 本身是合法档位`);
    ok(safe <= m.maxCtx, `${k.key}: safeCtx <= maxCtx`);
  }
  // 精度越高 KV 越大 => 安全上限必须更小(或相等),不能反过来
  ok(safeCtxFor(m, 'q8_0') <= safeCtxFor(m, 'q4_0'),
     `q8_0 的上限(${safeCtxFor(m, 'q8_0')}) 不大于 q4_0 的(${safeCtxFor(m, 'q4_0')})`);

  // 每个「档位 × KV」组合都要能安全生成参数
  for (const s of steps) {
    for (const k of KV_TYPES) {
      const a = buildArgs(m, 'text-64k', 8091, null, false, '', null, { ctx: s, kv: k.key });
      ok(ctxOf(a) === s && kvOf(a) === k.key,
         `${k.key} @ ${s} -> -c ${ctxOf(a)} -ctk ${kvOf(a)}`);
    }
  }

  // 越界输入必须被夹住,而不是原样透传
  ok(ctxOf(buildArgs(m, 'text-64k', 8091, null, false, '', null, { ctx: m.maxCtx * 4 })) <= m.maxCtx,
     '超上限输入被夹到 maxCtx');
  ok(ctxOf(buildArgs(m, 'text-64k', 8091, null, false, '', null, { ctx: 1 })) >= CTX_STEPS[0],
     '过小输入被抬到最小档');

  // 不传 overrides => 必须完全保持旧行为
  ok(ctxOf(buildArgs(m, 'text-64k', 8091, null, false, '', null)) === 65536,
     '不传 overrides 时沿用预设 -> -c 65536');
  ok(kvOf(buildArgs(m, 'text-64k', 8091, null, false, '', null)) === DEFAULT_KV,
     `不传 overrides 时 KV 用默认 -> -ctk ${DEFAULT_KV}`);
  ok(ctxOf(buildArgs(m, 'quick-8k', 8091, null, false, '', null, null)) === 8192,
     '预设 quick-8k 沿用它自己的 ctx');
  console.log('');
}

// 视觉预设必须是 64K —— 32K 是实测前的旧值,视觉并不额外吃显存
console.log('--- 视觉预设 ---');
const vision = Object.entries(require('../src/config.js').PRESETS)
  .filter(([, v]) => v.vision);
ok(vision.length === 1, `只有一个视觉预设 -> ${vision.map(([k]) => k).join(',')}`);
ok(vision[0][1].ctx === 65536, `视觉预设上下文 = ${vision[0][1].ctx} (期望 65536)`);
console.log('');

// 非数字输入不能变成 NaN 写进命令行
console.log('--- 脏输入 ---');
for (const bad of ['abc', {}, [], NaN, null, undefined, '']) {
  const a = buildArgs(MODELS[0], 'text-64k', 8091, null, false, '', null, { ctx: bad });
  const c = ctxOf(a);
  ok(Number.isFinite(c) && c > 0, `ctx=${JSON.stringify(bad) ?? String(bad)} -> -c ${c}`);
}
console.log('--- 非法 KV 键名 ---');
for (const bad of ['', 'f16', 'q4_k', null, undefined, 42, {}]) {
  const a = buildArgs(MODELS[0], 'text-64k', 8091, null, false, '', null, { ctx: 65536, kv: bad });
  ok(kvOf(a) === DEFAULT_KV, `kv=${JSON.stringify(bad) ?? String(bad)} -> -ctk ${kvOf(a)}`);
}
ok(resolveKv('q8_0') === 'q8_0', "resolveKv('q8_0') 原样返回");
ok(resolveKv('nope') === DEFAULT_KV, "resolveKv('nope') 回落到默认");
console.log('');

// flash attention 与 KV 量化必须成对出现
console.log('--- -fa 与 -ctk/-ctv 的配对 ---');
for (const m of MODELS) {
  const a = buildArgs(m, 'text-64k', 8091, null, false, '', null, { ctx: 65536, kv: 'q8_0' });
  ok(a.includes('-fa') && a[a.indexOf('-fa') + 1] === 'on', '-fa on 存在');
  ok(a.includes('-ctk') && a.includes('-ctv'), '-ctk/-ctv 存在');
  ok(a[a.indexOf('-ctk') + 1] === a[a.indexOf('-ctv') + 1], 'K 与 V 用同一精度');
}

console.log('');
if (fail) { console.error(`✗ ${fail} 项失败`); process.exit(1); }
console.log('✓ 全部通过');
