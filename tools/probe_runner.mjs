// 采样参数对照实验跑手(被 Cordis 的 stove_probe_model 工具调用)。
//
// 为什么单独成一个脚本:Cordis 的 Host 执行环境**没有 fetch、也没有
// AbortController**(只有 ctx/harness/console/btoa/atob/TextEncoder/TextDecoder),
// 所以在插件里直接发 HTTP 会报 "AbortController is not defined"。
// 交给子进程跑 Node 就没这个限制,而且脚本可独立运行、便于检查。
//
// 三个设计要点都来自踩过的坑:
//   1. **强制预热** —— 模型加载后首次推理要建 CUDA 图,约 30s;不预热的话
//      第一个被测配置永远吃亏,结论会变成"谁先跑谁更差"。
//   2. **重复 + 顺序轮换** —— 同一进程里依次跑多个配置,后者天然更快。
//      第 r 轮把列表左移 r 位,消除位置偏差,最后取中位数。
//   3. **请求层传采样参数** —— 请求里的值会盖住服务端启动参数(已实测)。
//
// 用法:node probe_runner.mjs <请求文件.json> <输出文件.json>
import { readFileSync, writeFileSync } from 'node:fs'

const [, , specArg, outPath] = process.argv
if (!specArg || !outPath) {
  console.error('用法: node probe_runner.mjs <请求文件.json | base64:...> <输出文件.json>')
  process.exit(2)
}

/**
 * 参数既可以是文件路径,也可以是 `base64:...` 内联内容。
 *
 * 为什么支持内联:从 Cordis 插件调用时,写参数文件会撞上沙箱的写入策略
 * (`file access denied under workspace-write mode`),而把 JSON 做 base64
 * 直接放命令行就没这个问题 —— 也避开了引号转义。
 */
function loadSpec(arg) {
  if (arg.startsWith('base64:')) {
    return JSON.parse(Buffer.from(arg.slice(7), 'base64').toString('utf8'))
  }
  return JSON.parse(readFileSync(arg, 'utf8'))
}

const spec = loadSpec(specArg)
const { url, apiKey, prompt, system, maxTokens = 600, repeats = 2, configs = [] } = spec

function write(obj) {
  writeFileSync(outPath, JSON.stringify(obj, null, 2), 'utf8')
}

if (!url || !prompt || !configs.length) {
  write({ error: '缺少 url / prompt / configs' })
  process.exit(0)
}

const headers = { 'Content-Type': 'application/json' }
if (apiKey) headers.Authorization = `Bearer ${apiKey}`

/** 发一次请求并计时。超时用 AbortSignal.timeout(子进程里可用)。 */
async function once(body, timeoutMs) {
  const t0 = Date.now()
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* 非 JSON */ }
    return { status: res.status, json, raw: json ? undefined : text.slice(0, 200), ms: Date.now() - t0 }
  } catch (e) {
    const cause = e && e.cause ? (e.cause.code || e.cause.message) : e.message
    return { error: cause, ms: Date.now() - t0 }
  }
}

/** 最长连续重复字符 —— 斜杠/单字符塌缩的直接指标。 */
function longestRun(text) {
  const s = String(text || '')
  if (!s.length) return 0
  let best = 1, run = 1
  for (let i = 1; i < s.length; i++) {
    if (s[i] === s[i - 1]) { run++; if (run > best) best = run } else run = 1
  }
  return best
}

/**
 * 重复行 —— 对话/段落级退化(单字符指标抓不到)。
 *
 * 但要小心误报:markdown 的分隔线(---)、省略号、列表符号在正常输出里
 * 也会重复出现。所以只有"某一行重复 >= 4 次"才值得报,而且在调用方还要
 * 结合"是否占满输出"一起判断。
 */
function lineRepeat(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean)
  const counts = new Map()
  for (const l of lines) counts.set(l, (counts.get(l) || 0) + 1)
  let max = 0, line = ''
  for (const [l, c] of counts) if (c > max) { max = c; line = l }
  return { count: max, line: line.slice(0, 60), total: lines.length }
}

/**
 * 综合判定是否退化。
 *
 * 为什么要综合判断:单独看"最长连续重复字符"会误报 —— markdown 表格的
 * `-----` 分隔线、代码缩进、中文省略号都会产生长重复。所以要求重复**同时**
 * 占据相当比例的字符(>= 12%)才判为塌缩。
 */
function degenerate(text) {
  const s = String(text || '')
  if (!s.length) return { bad: false, reason: 'empty' }
  const lr = longestRun(s)
  const lrRatio = lr / s.length
  const line = lineRepeat(s)
  // 单字符长龙:占 12% 以上且至少 40 个,基本只可能是塌缩
  if (lr >= 40 && lrRatio >= 0.12) {
    return { bad: true, reason: `连续重复 ${lr} 个字符(占 ${(lrRatio * 100).toFixed(0)}%)`, longestRun: lr }
  }
  // 同一行重复:至少 4 次且占据输出的一半以上
  if (line.count >= 4 && line.total > 0 && line.count / line.total >= 0.5) {
    return { bad: true, reason: `同一行重复 ${line.count} 次`, lineRepeat: line.count, sample: line.line }
  }
  return { bad: false, longestRun: lr, lineRepeat: line.count }
}

function median(nums) {
  const a = nums.filter((n) => typeof n === 'number').sort((x, y) => x - y)
  if (!a.length) return null
  const mid = Math.floor(a.length / 2)
  return a.length % 2 ? a[mid] : Math.round((a[mid - 1] + a[mid]) / 2)
}

// ── 1. 强制预热 ──
// 不预热的话,第一个配置会被 30 秒的初始化开销拖累,结论完全跑偏。
const warm = await once({
  model: 'local',
  messages: [{ role: 'user', content: 'hi' }],
  max_tokens: 4,
  stream: false,
}, 300000)
if (warm.error) {
  write({ error: `预热失败: ${warm.error} —— llama-server 在跑吗?` })
  process.exit(0)
}
const warmupMs = warm.ms

// ── 2. 逐轮跑,每轮左移顺序 ──
const buckets = new Map()
for (const c of configs) buckets.set(c.label, [])
const samples = []

for (let r = 0; r < repeats; r++) {
  const order = configs.map((_, i) => configs[(i + r) % configs.length])
  for (const c of order) {
    const body = {
      model: 'local',
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: prompt },
      ],
      max_tokens: maxTokens,
      stream: false,
      ...(c.params || {}),
    }
    const out = await once(body, 600000)
    if (out.error) {
      buckets.get(c.label).push({ error: out.error, ms: out.ms })
      continue
    }
    if (out.status !== 200) {
      buckets.get(c.label).push({ error: `HTTP ${out.status}: ${out.raw || ''}`, ms: out.ms })
      continue
    }
    const msg = (out.json?.choices?.[0]?.message) || {}
    const content = msg.content || ''
    const reasoning = msg.reasoning_content || ''
    const lr = lineRepeat(content)
    const deg = degenerate(content)
    buckets.get(c.label).push({
      ms: out.ms,
      completion: out.json?.usage?.completion_tokens || 0,
      chars: content.length,
      reasoningChars: reasoning.length,
      longestRun: longestRun(content),
      lineRepeat: lr.count,
      empty: content.trim().length === 0,
      degenerate: deg.bad,
      degenerateReason: deg.reason || null,
    })
    if (samples.length < 6) samples.push({ label: c.label, text: content, degenerate: deg })
  }
}

// ── 3. 汇总 ──
const results = configs.map((c) => {
  const runs = buckets.get(c.label) || []
  const ok = runs.filter((x) => !x.error)
  return {
    label: c.label,
    runs: runs.length,
    failed: runs.length - ok.length,
    errors: [...new Set(runs.filter((x) => x.error).map((x) => x.error))].slice(0, 3),
    medianMs: median(ok.map((x) => x.ms)),
    medianCompletion: median(ok.map((x) => x.completion)),
    medianChars: median(ok.map((x) => x.chars)),
    medianReasoningChars: median(ok.map((x) => x.reasoningChars)),
    medianLongestRun: median(ok.map((x) => x.longestRun)),
    medianLineRepeat: median(ok.map((x) => x.lineRepeat)),
    emptyCount: ok.filter((x) => x.empty).length,
    degenerateCount: ok.filter((x) => x.degenerate).length,
    degenerateReasons: [...new Set(ok.filter((x) => x.degenerate).map((x) => x.degenerateReason))],
  }
})

write({ warmupMs, repeats, configsUsed: configs.map((c) => c.label), results, samples })
