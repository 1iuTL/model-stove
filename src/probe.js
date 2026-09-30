// 启动速度探针:判断 KV cache 有没有被挤到主机内存里。
//
// 单独成模块而不是留在 main.js 里,是为了**能被真实服务器测**。
// main.js 依赖 electron,一旦 import 就跑不起来;而这段逻辑恰恰是
// "只有对着真 llama-server 才验证得了"的那一类 —— 阈值定得对不对,
// 只能拿满速和溢出两种真实配置各跑一遍才知道。
//
// 为什么必须靠测速、不能看显存 —— 本机实测这两行:
//
//     三元版 @64K + q8_0 : 7869 MiB,只有  4.9 tok/s   (已溢出)
//     三元版 @96K + q4_0 : 7869 MiB,却有 31.8 tok/s   (满速)
//
// 显存读数**一模一样**。KV 漏到主机内存时,llama.cpp 仍会把显存分配到接近
// 上限 —— 读数反映的是"分配了多少",不是"KV 在不在设备上"。
const http = require('http');

/** 发一个 POST JSON。不抛异常,失败收敛成 { ok:false }。 */
function httpPostJson(base, pathname, payload, timeoutMs = 2500, apiKey = '') {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(pathname, base); } catch { return resolve({ ok: false, status: 0, body: '' }); }
    const data = Buffer.from(JSON.stringify(payload), 'utf8');
    // ⚠ 2026-09-30:上游开了 --api-key 时探针也必须带 key,否则一律 401 ——
    //   表现就是界面上「实测速度 未取得」,而模型其实跑得好好的。
    const headers = { 'Content-Type': 'application/json', 'Content-Length': data.length };
    if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
    const req = http.request(
      url,
      { method: 'POST', timeout: timeoutMs, headers },
      (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode, body }));
      },
    );
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, body: '' }); });
    req.on('error', () => resolve({ ok: false, status: 0, body: '' }));
    req.write(data);
    req.end();
  });
}

// 每次探测生成多少 token。太小会被单 token 抖动放大,太大又白费时间 ——
// 24 个在 30-40 tok/s 下约 0.6 秒,足够稳定。
const PROBE_TOKENS = 24;

// 判定阈值:低于基线的 60% 就算溢出。
// 满速与溢出之间差 6-8 倍,中间没有灰色地带,所以这条线不敏感 ——
// 功耗/温度/桌面上别的程序带来的波动远到不了这里。
const SPILL_RATIO = 0.6;

/**
 * 跑一次探针。
 *
 * @param {string} base    llama-server 根地址,如 http://127.0.0.1:8091
 * @param {object} model   需要 model.probeTps(该模型的实测基线 tok/s)
 * @param {object} [opts]  { tokens, timeoutMs, alive, apiKey } —— alive() 返回 false 则中止
 * @returns {Promise<object|null>} { tps, expected, ratio, spilled, at } 或 null
 *
 * 跑两次是**必须**的:模型加载后的第一次推理要建 CUDA 图,能吃掉二三十秒。
 * 直接测会得到 2-5 tok/s 的假结果 —— README 第 525-533 行专门警告过这个坑,
 * 而写这个探针的第一版仍然栽了进去。所以第一次只当预热,结果丢弃。
 *
 * 顺带一提,用户的第一条消息本来也要付这次 CUDA 图的钱,所以净成本是零,
 * 只是把它提前到了启动阶段。
 */
async function probeSpeed(base, model, opts = {}) {
  if (!model || !model.probeTps) return null;
  const tokens = opts.tokens || PROBE_TOKENS;
  const timeoutMs = opts.timeoutMs || 300000;
  const alive = opts.alive || (() => true);

  const apiKey = String(opts.apiKey || '');
  const body = { prompt: 'Hello', n_predict: tokens, stream: false, cache_prompt: false };

  // 第一次:预热。它会建 CUDA 图,耗时可观,结果直接丢弃。
  await httpPostJson(base, '/completion', body, timeoutMs, apiKey);
  if (!alive()) return null;

  const r = await httpPostJson(base, '/completion', body, timeoutMs, apiKey);
  if (!r.ok) return null;

  let tps = null;
  try {
    const j = JSON.parse(r.body);
    tps = Number(j.timings && j.timings.predicted_per_second);
  } catch { return null; }
  if (!Number.isFinite(tps) || tps <= 0) return null;

  return {
    tps: Math.round(tps * 10) / 10,
    expected: model.probeTps,
    ratio: Math.round((tps / model.probeTps) * 100) / 100,
    spilled: tps < model.probeTps * SPILL_RATIO,
    at: new Date().toISOString(),
  };
}

module.exports = { probeSpeed, httpPostJson, PROBE_TOKENS, SPILL_RATIO };
