// 6 个模型的启动 argv 用例矩阵。
//
// 这里只定义"要钉住哪些输入组合"，不定义期望输出：期望值来自
// tests/fixtures/argv-baseline.json，那份文件是在重构**之前**由
// tools/gen_argv_baseline.mjs 从 src/config.js 生成的。
//
// 覆盖到的分支（缺一个就可能让重构悄悄改变命令行）：
//   - 预设：默认（文本 64K）/ 轻量 8K / 视觉 64K
//   - 思考档位：不传 / server-default（不加 flag）/ off / high
//   - 思考预算：默认 / 不限（不加 flag）/ 8192
//   - 监听：回环 / 局域网（0.0.0.0 + --no-slots）
//   - API Key：有 / 无
//   - KV 精度：默认 q4_0 / q8_0（会触发 safeCtx 夹紧）
//   - 上下文覆盖：null / 49152 / 超上限 / 低于下限 / 非法值
//   - 端口参数化：8091 / 18091
//   - 逐模型字段：temp/topP/topK、extraArgs、per-model mmproj
//
// buildArgs(model, presetKey, port, reasoningKey, lanMode, apiKey, budgetKey, overrides)

const DEFAULT_PORT = 8091;

/** 造用例：返回 [{ id, args }]。cfg 是 src/config.js 的导出对象。 */
export function buildArgvCases(cfg) {
  const cases = [];

  const mk = (id, model, opts = {}) => {
    const args = cfg.buildArgs(
      model,
      opts.preset ?? model.defaultPreset,
      opts.port ?? DEFAULT_PORT,
      opts.reasoning ?? null,
      opts.lanMode ?? false,
      opts.apiKey ?? '',
      opts.budgetKey ?? null,
      opts.overrides ?? null,
    );
    cases.push({ id, args });
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

export { DEFAULT_PORT };
