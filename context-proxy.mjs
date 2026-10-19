// 上下文压缩代理:夹在浏览器界面与 llama-server 之间。
//
// 为什么需要这一层:llama.cpp 自带的 Web UI 每次把**完整对话历史**发给
// llama-server。聊得久了历史必然撑爆上下文(-c 65536),然后要么报错、
// 要么被静默截断。上游界面没有压缩功能,也不该去改它,所以在中间加一层。
//
// 数据流:
//   浏览器 → 本代理(:8092) → llama-server(:8091)
//                 │
//                 └─ 历史过长时,把较早的对话交给模型总结成一段,替换掉原文
//
// 为什么另起端口而不是顶替 8091:llama-server 留在原位,Model Stove 与桌面端
// 完全不受影响。代价是浏览器的 localStorage 按来源地址隔离,**换端口等于换
// 存储**,手机上原有的历史会话不会出现在新地址下(没有丢,只是不在那儿)。
//
// 用法:node context-proxy.mjs
//   PROXY_PORT      本代理端口,默认 8092
//   PROXY_TARGET    上游地址,默认 http://127.0.0.1:8091（llama 端口是动态的，
//                   由外壳通过这个变量传进来；UPSTREAM 是旧名字，仍兼容）
//   PROXY_ALLOW_LAN=1  显式允许绑定 0.0.0.0（由外壳在 LAN 模式 + 已设 API Key 时传）
//   PROXY_TOKEN     /_bridge 的会话 token；设置后所有 _bridge 请求必须带上
//   UPSTREAM_KEY    上游开了 --api-key 时，代理自己发起的请求要带它
//   COMPRESS=0      启动时关闭压缩(也可用 _bridge 接口在运行时切换)
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { injectPanel, PANEL_JS, PANEL_SCRIPT_PATH } from './ui-inject.mjs'

// 档位定义放在 src/profiles.js(CommonJS),这里借 createRequire 读它 ——
// 这样界面与代理共用同一份定义,不会各自漂移。
const require = createRequire(import.meta.url)
const { profiles: PROFILES, defaultProfile, resolve: resolveProfile } = require('./src/profiles.js')

// ------------------------------------------------------------------ 配置

const PROXY_PORT = Number(process.env.PROXY_PORT || 8092)

// ---- P0 安全默认 ----
//
// 绑定地址：以前恒为 0.0.0.0 —— 只要代理在跑，同网段任何人都能直接访问
// /_bridge（切档位、开关压缩）以及转发后的模型接口。现在默认只绑回环；
// 只有外壳在"用户明确开了局域网 + 已经设了 API Key"时才传 PROXY_ALLOW_LAN=1。
// 这里仍显式要求 1，避免 *任意* 环境变量值（比如 "true"）被误解成放行。
const PROXY_HOST = process.env.PROXY_ALLOW_LAN === '1' ? '0.0.0.0' : '127.0.0.1'

// 上游（llama-server）地址。端口是动态的，外壳通过 PROXY_TARGET 传；
// 默认沿用 8091 只是为了让"手工 node context-proxy.mjs"仍然能用。
const UPSTREAM = (process.env.PROXY_TARGET || process.env.UPSTREAM || 'http://127.0.0.1:8091').replace(/\/+$/, '')

// /_bridge 会话 token。空 = 不鉴权（本地开发/旧测试兼容）。
const BRIDGE_TOKEN = String(process.env.PROXY_TOKEN || '').trim()

// 请求体上限：8 MiB。模型的图片/长文本请求也够用；再大基本是误发或攻击。
const MAX_BODY_BYTES = Number(process.env.PROXY_MAX_BODY_BYTES || 8 * 1024 * 1024)
// 上游空闲超时：连接/等响应头/两个数据块之间，任一超过这个时间就 504。
// 默认 120 秒；测试可以用 PROXY_IDLE_TIMEOUT_MS 调小。
const IDLE_TIMEOUT_MS = Number(process.env.PROXY_IDLE_TIMEOUT_MS || 120000)
// ⚠ 2026-09-30:上游开了 --api-key 时,代理**自己发起的**请求也必须带 key。
//   以前只有"转发客户端请求"那条路带(那条原样透传客户端 headers),而代理自己发的
//   两类请求 —— ① 读 /props 拿 n_ctx  ② 压缩时调 chat/completions —— 都是裸请求,
//   于是全部 401。后果:
//     · 界面「上下文」永远显示 —(一直用 65536 兜底,压缩阈值跟着算错)
//     · 自动压缩直接失败
//   llama-server 日志里每 15 秒一条 `unauthorized: Invalid API Key` 就是它。
const UPSTREAM_KEY = (process.env.UPSTREAM_KEY || '').trim()
const upHeaders = (extra) => (UPSTREAM_KEY
  ? { ...(extra || {}), Authorization: `Bearer ${UPSTREAM_KEY}` }
  : (extra || {}))
const UPSTREAM_URL = new URL(UPSTREAM)

// 日志与状态文件的位置。
//
// PROXY_STATE_DIR 是给测试用的隔离开关。为什么需要它:
// tools/test_proxy.mjs 会把阈值临时调到 0.2 来方便触发压缩,而它写的是
// **同一个** state 文件 —— 于是测试一跑,生产的压缩配置就被改成
// "阈值 0.2、保留 2 轮"并且**不会还原**。实测就这么被污染过:
// 界面显示压缩阈值 0.2,而代码默认是 0.6,查了半天才发现是测试干的。
//
// 测试必须能把状态写到别处,不能有"跑个测试顺手改了用户配置"这种事。
const LOG_DIR = process.env.PROXY_STATE_DIR || fileURLToPath(new URL('./logs', import.meta.url))
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true })
const LOG_FILE = path.join(LOG_DIR, 'context-proxy.log')
const STATE_FILE = path.join(LOG_DIR, 'context-proxy-state.json')

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`
  console.log(line)
  try { appendFileSync(LOG_FILE, line + '\n', 'utf8') } catch { /* 日志失败不影响服务 */ }
}

/**
 * 运行时状态(可热切换,不用重启)。
 *
 * 压缩默认**开启** —— 它的目的是防止上下文溢出,属于"应该有"的保护;
 * 想验证模型原始行为时可以关掉对比。
 */
const state = {
  enabled: process.env.COMPRESS !== '0',
  // 触发阈值:占上下文的比例。
  //
  // 75% 是权衡出来的:低一点(比如 60%)会压缩得太频繁 —— 每次压缩都要让模型
  // 读一遍旧对话再写摘要,既花时间又容易把还有用的细节抹掉;高一点则风险在于
  // 压缩本身要花时间,卡到 90% 以上可能出现"刚要压缩却已经溢出"。
  //
  // 32K 上下文下 75% ≈ 24576 token 触发,留给本轮提问和回答约 8K,够用。
  thresholdRatio: 0.75,
  // 至少保留最近几轮原文,保证近期对话不失真。
  // 取 6 而不是 4:压缩最怕的不是"留太多",而是把还有用的细节抹掉。
  keepRecentTurns: 6,
  // 压缩后的摘要最多保留多少 token
  summaryMaxTokens: 800,
  // 当前任务档位。见 src/profiles.js —— 它决定采样参数与是否开思考。
  profile: process.env.PROFILE || defaultProfile,
  // 统计
  compressCount: 0,
  lastCompressAt: null,
  lastReason: null,
}

function loadState() {
  try {
    const saved = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    // ⚠ 2026-09-30:环境变量以前是**失效**的 —— 这行在 state 初始化之后执行,
    //   会把 `enabled: process.env.COMPRESS !== '0'` 的结果盖回来,于是
    //   `COMPRESS=0` 明明设了却不生效(又一个"声明了但不生效"的配置)。
    //   现在:显式设了 COMPRESS 就以它为准,没设才用状态文件里的值。
    if (typeof saved.enabled === 'boolean' && process.env.COMPRESS === undefined) state.enabled = saved.enabled
    if (typeof saved.thresholdRatio === 'number') state.thresholdRatio = saved.thresholdRatio
    if (Number.isInteger(saved.keepRecentTurns)) state.keepRecentTurns = saved.keepRecentTurns
    if (typeof saved.profile === 'string' && PROFILES.some((p) => p.key === saved.profile)) {
      state.profile = saved.profile
    }
  } catch { /* 首次运行没有状态文件 */ }
}
function saveState() {
  try {
    writeFileSync(STATE_FILE, JSON.stringify({
      enabled: state.enabled,
      thresholdRatio: state.thresholdRatio,
      keepRecentTurns: state.keepRecentTurns,
      profile: state.profile,
    }, null, 2), 'utf8')
  } catch { /* 保存失败不影响运行 */ }
}
loadState()

// ------------------------------------------------------------------ token 估算

/**
 * 估算一段文本的 token 数。
 *
 * 实测(见 tools/probe_tokenize.mjs):
 *   中文约 1.7 字符/token,英文约 3.2 字符/token
 * 所以按"每个字符最多贡献多少 token"取上界:中文最紧,约 0.59 token/字符。
 * 这里用 0.6 作为保守上界 —— 宁可高估(早点压缩),不要低估(溢出)。
 */
function estimateTokens(text) {
  if (!text) return 0
  return Math.ceil(String(text).length * 0.6)
}

function estimateMessagesTokens(messages) {
  let n = 0
  for (const m of messages) {
    n += estimateTokens(m.content) + 4   // 每条消息的固定开销
  }
  return n + 8                            // 模板本身的开销
}

// ------------------------------------------------------------------ 与上游通信

/** 读取上游 /props,拿到真实的 n_ctx。缓存一份,失败时用兜底值。 */
let ctxCache = { value: null, at: 0 }
// 这个数是不是**兜底值**。必须让面板能区分 —— 否则拿不到 /props 时,
// 面板会把 65536 当成真实读数;而真实 ctx 可能是 32768,
// 那样压缩阈值(65536 × 0.75 = 49152)永远触发不了,长对话直接顶到上下文上限。
let ctxFallback = false
async function getContextSize() {
  if (ctxCache.value && Date.now() - ctxCache.at < 60000) return ctxCache.value
  try {
    const r = await fetch(`${UPSTREAM}/props`, { headers: upHeaders(), signal: AbortSignal.timeout(8000) })
    const j = await r.json()
    const n = j.default_generation_settings?.n_ctx
    if (Number.isInteger(n) && n > 0) {
      ctxCache = { value: n, at: Date.now() }
      ctxFallback = false
      return n
    }
  } catch { /* 上游没起来 */ }
  ctxFallback = true
  log('警告:拿不到上游 n_ctx,暂用 65536 兜底(状态接口会标 fallback,面板上显示"(兜底值)")')
  return ctxCache.value || 65536
}

/** 调上游做一次非流式补全(压缩时总结用)。 */
async function upstreamComplete(messages, maxTokens) {
  const r = await fetch(`${UPSTREAM}/v1/chat/completions`, {
    method: 'POST',
    // 带 key:上游开鉴权时,这条"压缩总结"用的补全请求同样要过锁
    headers: upHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      model: 'local',
      messages,
      max_tokens: maxTokens,
      stream: false,
      // 总结任务不需要思考,关掉它。
      //
      // ⚠ 2026-09-29:删掉了这里原本的 `reasoning_budget: 0` —— 字段名是错的
      // (正确名是 `reasoning_budget_tokens`,服务端不加别名),它从来没生效过。
      // 真正让总结不思考的是下面那行 `enable_thinking: false`(合法 kwarg),
      // 所以删掉**不会有任何行为变化**,只是不再在代码里留一个假机制。
      //
      // 下面这条教训保留,它是个好教训:
      // 曾经误以为该参数把总结从 35s 降到 3s,后来用连发三次的对照实验证明,
      // 真正的差异来自**首次请求预热**(模型加载后第一次推理要建 CUDA 图、
      // 分配 KV cache,约 32s),第二次起就只要 0.8-2.9s。
      // 教训:同一进程里先后跑多个配置,后者天然更快,很容易把预热误当成
      // 参数效果 —— 对比时必须重复或打乱顺序。
      chat_template_kwargs: { enable_thinking: false },
    }),
    signal: AbortSignal.timeout(300000),
  })
  if (!r.ok) throw new Error(`上游 HTTP ${r.status}`)
  const j = await r.json()
  const msg = j.choices?.[0]?.message || {}
  // 只要最终答案,丢掉思考内容
  return (msg.content || '').trim()
}

// ------------------------------------------------------------------ 压缩逻辑

/**
 * 需要压缩时,把较早的对话总结成一段,替换掉原文。
 *
 * 结构:保留 system 提示 → 插入一条"前情提要" → 保留最近 N 轮原文。
 * 摘要作为 system 消息插入,而不是伪装成用户发言,避免污染对话结构。
 */
async function maybeCompress(messages) {
  if (!state.enabled) return { messages, compressed: false }

  const nCtx = await getContextSize()
  const budget = Math.floor(nCtx * state.thresholdRatio)
  const used = estimateMessagesTokens(messages)

  if (used <= budget) {
    return { messages, compressed: false, used, budget, nCtx }
  }

  // 至少要有 system + 若干轮才值得压缩
  const SYSTEMS = messages.filter((m) => m.role === 'system')
  const convo = messages.filter((m) => m.role !== 'system')

  // 保留最近 keepRecentTurns 轮(一轮≈提问+回答两条)
  const keepCount = state.keepRecentTurns * 2
  if (convo.length <= keepCount + 2) {
    log(`历史超预算但条数不足以压缩(共 ${convo.length} 条),本轮不做压缩`)
    return { messages, compressed: false, used, budget, nCtx }
  }

  const older = convo.slice(0, convo.length - keepCount)
  const recent = convo.slice(convo.length - keepCount)

  log(`触发压缩:估算 ${used} token > 预算 ${budget}(上下文 ${nCtx})`)
  log(`  将总结较早的 ${older.length} 条,保留最近 ${recent.length} 条原文`)

  // 把待总结的对话铺成纯文本。注意丢掉 reasoning —— 思考内容对"前情"没用,
  // 留着只会让摘要更啰嗦。
  const transcript = older
    .map((m) => {
      const who = m.role === 'user' ? '用户' : '助手'
      return `${who}:${String(m.content || '').slice(0, 2000)}`
    })
    .join('\n')

  const t0 = Date.now()
  let summary = ''
  try {
    summary = await upstreamComplete([
      {
        role: 'system',
        content: '你是对话摘要器。把下面的对话压缩成简洁的中文要点,保留:用户的目标、已确认的事实与结论、待办事项、以及重要的具体数值或名称。不要加入新信息,不要评论,直接输出要点。',
      },
      { role: 'user', content: transcript },
    ], state.summaryMaxTokens)
    state.lastSummaryMs = Date.now() - t0
  } catch (e) {
    // 压缩失败不能让整轮对话失败 —— 退化成本轮不压缩,让上游按原样处理
    log(`压缩失败(${e.message}),本轮按原文发送`)
    return { messages, compressed: false, used, budget, nCtx, error: e.message }
  }

  if (!summary) {
    log('压缩返回空内容,本轮按原文发送')
    return { messages, compressed: false, used, budget, nCtx }
  }

  const brief = '以下是此前对话的摘要(较早的内容已被压缩):\n\n' + summary

  // 关键:模型的聊天模板要求 **system 消息必须位于最前**,而且通常只允许
  // 一条。所以不能简单地在原 system 之后插入一条新的 system —— 那会直接
  // 报 "System message must be at the beginning"(实测踩过)。
  // 正确做法是把摘要**并入**原有 system 内容。
  const mergedSystem = {
    role: 'system',
    content: SYSTEMS.length
      ? `${SYSTEMS.map((m) => m.content).join('\n\n')}\n\n${brief}`
      : brief,
  }
  const next = [mergedSystem, ...recent]

  const newUsed = estimateMessagesTokens(next)
  state.compressCount++
  state.lastCompressAt = new Date().toISOString()
  state.lastReason = `${used} -> ${newUsed} token`

  log(`  压缩完成:${older.length} 条 -> 摘要 ${summary.length} 字`)
  log(`  估算 token:${used} -> ${newUsed},总结耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  return { messages: next, compressed: true, used, budget, nCtx, newUsed, summary }
}

// ------------------------------------------------------------------ 请求转发

/**
 * 把上游响应回给客户端(支持流式)。
 *
 * watchdog 由 forward() 创建，负责"上游空闲超时"：每收到一块数据就重新计时，
 * 超时后 abort 上游 fetch，这里收敛成 504（还没发响应头时）。
 */
async function pipeResponse(upstreamRes, res, watchdog) {
  const headers = {}
  for (const [k, v] of upstreamRes.headers) {
    // 去掉会与实际内容不符的头:长度可能变了,编码也已由 fetch 解开
    if (['content-length', 'content-encoding', 'transfer-encoding'].includes(k.toLowerCase())) continue
    headers[k] = v
  }

  try {
    // ---- HTML 响应:注入档位面板 ----
    //
    // 为什么要在这一层做:llama.cpp 的 Web UI 是预压缩的 Svelte 包,改它要反编译
    // 重建,而且一升级就白改;代理夹在中间,在返回 HTML 时追加一段自己的脚本最省事。
    //
    // 注入之后 content-length 必然变化,所以上面统一丢掉了它,由 Node 用 chunked
    // 重新计算 —— 这也是"无论如何都不转发 content-length"的原因(编解码后它的
    // 长度本来就不可信)。
    const ctype = String(upstreamRes.headers.get('content-type') || '')
    const isHtml = ctype.includes('text/html')
    if (isHtml && upstreamRes.body) {
      // HTML 是我们改写过的,必须禁止缓存。
      //
      // 为什么:上游给的是 no-cache + ETag,而正文已经被我们改过,ETag 不再
      // 对应实际内容。实测后果是手机上一直拿到旧版本的页面 —— 面板改了也看不到,
      // 看起来像"改动没生效"。
      headers['cache-control'] = 'no-store, must-revalidate'
      let html
      try {
        html = await upstreamRes.text()
      } catch {
        // 读失败就退回流式,不让注入影响可用性
        res.writeHead(upstreamRes.status, headers)
        res.end()
        return
      }
      watchdog && watchdog.disarm()
      if (html.includes('id="stove-panel"')) {
        // 已经注入过(理论上不该发生,HTML 只回一次);原样返回,避免叠加两份。
        res.writeHead(upstreamRes.status, headers)
        res.end(html)
        return
      }
      res.writeHead(upstreamRes.status, headers)
      // token 只注入到 HTML：面板脚本会把它放进 /_bridge 请求头。
      res.end(injectPanel(html, { token: BRIDGE_TOKEN }))
      return
    }

    res.writeHead(upstreamRes.status, headers)
    if (!upstreamRes.body) { res.end(); return }
    const reader = upstreamRes.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      watchdog && watchdog.arm()
      res.write(Buffer.from(value))
    }
    res.end()
  } catch (e) {
    // 上游中途断掉 / 空闲超时：响应头还没发就回 504/502，否则只能断开。
    const timedOut = !!(watchdog && watchdog.timedOut())
    log(`上游响应中断${timedOut ? '(空闲超时)' : ''}: ${e.message}`)
    if (!res.headersSent) {
      sendJson(res, timedOut ? 504 : 502, {
        error: { message: timedOut ? '上游空闲超时' : '上游响应中断', type: timedOut ? 'upstream_timeout' : 'upstream_error' },
      })
    } else {
      try { res.destroy() } catch { /* 已经断了 */ }
    }
  } finally {
    watchdog && watchdog.disarm()
  }
}

/** 统一的 JSON 响应（401 不泄露细节）。 */
function sendJson(res, status, payload, extraHeaders) {
  if (res.headersSent) return
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...(extraHeaders || {}) })
  res.end(JSON.stringify(payload))
}

/**
 * 统一的 401。
 *
 * 刻意只有 ok/error 两个字段：不回显期望的 header 名、不回显 token 前缀、
 * 也不说明"是头缺失还是值不匹配"。攻击者拿不到任何可用于区分的线索。
 */
function sendUnauthorized(res) {
  sendJson(res, 401, { ok: false, error: 'unauthorized' })
}

/** 常数时间比较，避免按字节提前返回。 */
function tokenEquals(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8')
  const y = Buffer.from(String(b || ''), 'utf8')
  if (x.length !== y.length) return false
  let diff = 0
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i]
  return diff === 0
}

/** /_bridge 鉴权：未设置 token 时保持旧行为（免鉴权）。 */
function bridgeAuthorized(req) {
  if (!BRIDGE_TOKEN) return true
  const header = String(req.headers['x-bridge-token'] || '')
  const auth = String(req.headers.authorization || '')
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  return tokenEquals(header, BRIDGE_TOKEN) || tokenEquals(bearer, BRIDGE_TOKEN)
}

/**
 * 读取请求体，超过上限立即拒绝（code = BODY_TOO_LARGE）。
 *
 * 不在 reject 里直接 destroy socket：调用方还要把 413 写回去。继续消费剩余的
 * 数据只会被丢弃，不会进内存 —— 上限的意义就是不让 9 MiB 变成 900 MiB。
 */
function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let tooLarge = false
    req.on('data', (c) => {
      if (tooLarge) return
      size += c.length
      if (size > limit) {
        tooLarge = true
        chunks.length = 0
        const err = new Error(`请求体超过 ${limit} 字节上限`)
        err.code = 'BODY_TOO_LARGE'
        reject(err)
        return
      }
      chunks.push(c)
    })
    req.on('end', () => { if (!tooLarge) resolve(Buffer.concat(chunks)) })
    req.on('error', (e) => { if (!tooLarge) reject(e) })
  })
}

const server = http.createServer(async (req, res) => {
  try {
    await handleRequest(req, res)
  } catch (e) {
    // 请求体超限：在还没有转发之前就拒绝，并让剩余字节自然被丢弃。
    if (e && e.code === 'BODY_TOO_LARGE') {
      log(`拒绝过大的请求体: ${req.method} ${req.url}`)
      if (!res.headersSent) {
        sendJson(res, 413, { error: { message: 'request body too large', type: 'payload_too_large' } })
      } else {
        try { res.destroy() } catch {}
      }
      try { req.resume() } catch {}
      return
    }
    log(`处理请求异常 ${req.method} ${req.url}: ${e && e.message}`)
    if (!res.headersSent) {
      sendJson(res, 500, { error: { message: 'internal error' } })
    } else {
      try { res.destroy() } catch {}
    }
  }
})

async function handleRequest(req, res) {
  // /slots 与 /metrics 在代理层常关。
  //
  // 为什么不给 llama 加 --no-slots：argv 必须逐字节保持不变（90 例快照），
  // 而且 /slots 只在"绑到局域网"时才是泄露面；代理层统一 404 既不动 argv，
  // 也覆盖了所有访问路径（包括手机走 :8092 的情况）。
  const urlPath = String(req.url || '').split('?')[0]
  if (urlPath === '/slots' || urlPath === '/metrics') {
    sendJson(res, 404, { error: { message: 'not found' } })
    return
  }

  // /_bridge/* 统一鉴权（token 未设置时保持免鉴权，兼容本地开发/旧测试）。
  if (urlPath === '/_bridge' || urlPath.startsWith('/_bridge/')) {
    if (!bridgeAuthorized(req)) { sendUnauthorized(res); return }
  }

  // ---- 面板脚本(外链资源)----
  //
  // 单独一个路径而不是内联进 HTML,原因见 ui-inject.mjs 的说明:
  // 内联脚本可能被 CSP 或某些拦截策略挡掉,而元素照旧渲染 ——
  // 表现就是"面板在,但点不动、拖不动"。外链不受内联策略影响。
  // 另外这里显式 no-store,免得手机上一直用缓存里的旧面板。
  // 用 startsWith 而不是全等:脚本 URL 上带了 ?v=N 做缓存失效,
  // 全等匹配会因为查询串而漏掉。
  if (req.url === PANEL_SCRIPT_PATH || req.url.startsWith(PANEL_SCRIPT_PATH + '?')) {
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store, must-revalidate',
    })
    res.end(PANEL_JS)
    return
  }

  // ---- 控制接口:手机/浏览器上开关压缩 ----
  if (req.url === '/_bridge/status' || req.url === '/_bridge/config') {
    if (req.method === 'GET') {
      let nCtx = null
      try { nCtx = await getContextSize() } catch { /* 上游可能没起来 */ }
      const cur = resolveProfile(state.profile)
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify({
        compression: {
          enabled: state.enabled,
          thresholdRatio: state.thresholdRatio,
          keepRecentTurns: state.keepRecentTurns,
          summaryMaxTokens: state.summaryMaxTokens,
        },
        profile: {
          current: state.profile,
          label: cur.label,
          hint: cur.hint,
          thinking: cur.thinking,
          params: cur.params,
          // 界面要据此显示"本档是否加了输出约束",所以必须一并返回
          systemAdd: cur.systemAdd || null,
          available: PROFILES.map((p) => ({ key: p.key, label: p.label, hint: p.hint })),
        },
        context: {
          nCtx,
          triggerAt: nCtx ? Math.floor(nCtx * state.thresholdRatio) : null,
          // true = 这个 nCtx 是拿不到 /props 时的兜底值,不是真实读数(见 getContextSize)
          fallback: ctxFallback,
        },
        stats: { compressCount: state.compressCount, lastCompressAt: state.lastCompressAt, lastReason: state.lastReason },
        upstream: UPSTREAM,
      }, null, 2))
      return
    }
    if (req.method === 'POST') {
      try {
        const patch = JSON.parse((await readBody(req)).toString('utf8') || '{}')
        if (typeof patch.enabled === 'boolean') state.enabled = patch.enabled
        if (typeof patch.thresholdRatio === 'number' && patch.thresholdRatio > 0.1 && patch.thresholdRatio < 0.95) {
          state.thresholdRatio = patch.thresholdRatio
        }
        if (Number.isInteger(patch.keepRecentTurns) && patch.keepRecentTurns >= 1 && patch.keepRecentTurns <= 20) {
          state.keepRecentTurns = patch.keepRecentTurns
        }
        // 切档位:采样参数在请求层覆盖,所以这里只需要记住选择,下个请求即生效
        if (typeof patch.profile === 'string') {
          if (PROFILES.some((p) => p.key === patch.profile)) {
            state.profile = patch.profile
            const p = resolveProfile(state.profile)
            log(`档位切换 -> ${p.label}(${p.key}):temp=${p.params.temperature} 思考=${p.thinking ? '开' : '关'}`)
          } else {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, error: `未知档位: ${patch.profile}` }))
            return
          }
        }
        saveState()
        if (patch.profile === undefined) {
          log(`配置已更新: 压缩=${state.enabled ? '开' : '关'} 阈值=${state.thresholdRatio} 保留${state.keepRecentTurns}轮`)
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' })
        res.end(JSON.stringify({ ok: true, profile: state.profile, compression: { enabled: state.enabled, thresholdRatio: state.thresholdRatio, keepRecentTurns: state.keepRecentTurns } }))
      } catch (e) {
        // 请求体超限必须交给最外层统一回 413，不能被这里吞成 400。
        if (e && e.code === 'BODY_TOO_LARGE') throw e
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: e.message }))
      }
      return
    }
    res.writeHead(405); res.end('method not allowed')
    return
  }

  // ---- 核心:拦截对话补全,做压缩 ----
  const isChat = req.url === '/v1/chat/completions' && req.method === 'POST'

  if (isChat) {
    let body
    try {
      body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
    } catch (e) {
      if (e && e.code === 'BODY_TOO_LARGE') throw e
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'invalid JSON' } }))
      return
    }

    // ---- 1. 应用任务档位 ----
    //
    // 必须在这里覆盖,因为请求级采样参数优先于服务端启动参数(已实测)。
    // 界面上那个按对话的设置控件也会带参数,同样被这里盖住 —— 这是有意的:
    // 档位的意义就是"我说了算",否则界面上随手一改就废了档位。
    try {
      const p = resolveProfile(state.profile)
      Object.assign(body, p.params)
      // 思考开关走模板参数 —— 这条是**有效**的:enable_thinking 是合法的
      // chat_template_kwargs,关思考靠的就是它。
      body.chat_template_kwargs = {
        ...(body.chat_template_kwargs || {}),
        enable_thinking: p.thinking,
      }
      // 输出约束(可选,定义见 src/profiles.js 的 systemAdd)。
      // 为什么放在这里:Model Stove 原本**完全不注入系统提示词** —— Web UI 发什么
      // 就转发什么。而实测三个模型都会在产物结束后追加说明文字(见 profiles.js 注释)。
      // 已有系统提示时**追加**而不是覆盖,免得把用户自己的系统提示顶掉。
      // 注意:这会改变请求前缀,所以切换档位时首轮会丢一次前缀缓存 —— 可接受。
      if (p.systemAdd && Array.isArray(body.messages)) {
        const sysMsgs = body.messages.filter((m) => m.role === 'system')
        if (sysMsgs.length) {
          sysMsgs.forEach((m) => { m.content = String(m.content || '') + '\n\n' + p.systemAdd })
        } else {
          body.messages.unshift({ role: 'system', content: p.systemAdd })
        }
      }
      // ⚠ 2026-09-29 删掉两行**从来没生效过**的预算写入。原文是:
      //     if (p.thinking && body.reasoning_budget === undefined) body.reasoning_budget = 4096
      //     else if (!p.thinking) body.reasoning_budget = 0
      //   注释声称"免得又出现思考吃光整个输出预算、正文为空的情况"。但从服务端源码
      //   与两个内核二进制的精确字面量核对下来,这两行是空写:
      //     - 请求级字段名是 `reasoning_budget_tokens`,**不存在** `reasoning_budget`
      //       (llama.cpp tools/server/server-schema.cpp 只声明前者,没有加别名)
      //     - server-common.cpp:1354 的取值逻辑是 `json_value(body,
      //       "reasoning_budget_tokens", -1)`,只有拿到 -1 才回落到服务端
      //       `--reasoning-budget`
      //   所以护栏从未生效,真正生效的一直是服务端启动参数 —— 也就是
      //   src/config.js 里侧栏选的那个档位,即**侧栏才是权威**。
      //   "思考吃光预算"这个风险是真的,但不该在这里偷偷钉一个 4096:
      //   正确位置是界面上"预算 vs 上下文"的一致性检查(见 src/index.html
      //   的 budgetHint()),这样既补上漏洞,又不牺牲长思考的质量。
    } catch (e) {
      log(`应用档位失败(${e.message}),按原请求转发`)
    }

    // ---- 2. 按需压缩历史 ----
    if (Array.isArray(body.messages)) {
      try {
        const r = await maybeCompress(body.messages)
        if (r.compressed) {
          body.messages = r.messages
          // 摘要变长了,原本的 max_tokens 可能不合适;保持不变由上游决定
        }
      } catch (e) {
        log(`压缩阶段异常(${e.message}),按原文转发`)
      }
    }

    const out = await forward(JSON.stringify(body), req, res)
    if (out) await pipeResponse(out.upstreamRes, res, out.watchdog)
    return
  }

  // ---- 其余一律透明转发 ----
  const buf = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req)
  const out = await forward(buf, req, res)
  if (out) await pipeResponse(out.upstreamRes, res, out.watchdog)
}

/**
 * 向发上游发一次请求。
 *
 * 超时模型：空闲超时，而不是总时长。模型首 token 可能要几十秒，不能按总时长
 * 砍掉；但从连上、到响应头、再到每一块数据之间，只要 120 秒没有任何进展，
 * 就 abort 并回 504。watchdog 交给 pipeResponse 在流式读取时续期。
 */
async function forward(buf, req, res) {
  const headers = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (['host', 'connection', 'content-length', 'accept-encoding'].includes(k.toLowerCase())) continue
    headers[k] = v
  }
  headers.host = UPSTREAM_URL.host
  if (buf) headers['content-length'] = String(Buffer.byteLength(buf))

  const controller = new AbortController()
  let timedOut = false
  let timer = null
  const arm = () => {
    if (IDLE_TIMEOUT_MS <= 0) return
    clearTimeout(timer)
    timer = setTimeout(() => {
      timedOut = true
      try { controller.abort() } catch { /* 已经结束 */ }
    }, IDLE_TIMEOUT_MS)
    // 不拦住进程退出
    if (timer.unref) timer.unref()
  }
  const disarm = () => { clearTimeout(timer); timer = null }
  arm()

  try {
    const upstreamRes = await fetch(`${UPSTREAM}${req.url}`, {
      method: req.method,
      headers,
      body: buf,
      signal: controller.signal,
    })
    // 已拿到响应头，接下来由 pipeResponse 每块数据续期。
    arm()
    return { upstreamRes, watchdog: { arm, disarm, timedOut: () => timedOut } }
  } catch (e) {
    disarm()
    const msg = e.cause ? (e.cause.code || e.cause.message) : e.message
    if (timedOut) {
      log(`上游空闲超时 ${req.method} ${req.url} (${IDLE_TIMEOUT_MS}ms)`)
      if (!res.headersSent) {
        sendJson(res, 504, { error: { message: '上游空闲超时', type: 'upstream_timeout' } })
      }
      return null
    }
    log(`转发失败 ${req.method} ${req.url}: ${msg}`)
    if (!res.headersSent) {
      sendJson(res, 502, {
        error: { message: `连不上上游 ${UPSTREAM}:${msg}`, type: 'upstream_unreachable' },
      })
    }
    return null
  }
}

server.listen(PROXY_PORT, PROXY_HOST, () => {
  const lan = PROXY_HOST === '0.0.0.0'
  log('=== 上下文压缩代理已启动 ===')
  // 如实打印绑定地址：这是"手机能不能连"最直接的证据，不能只写一个理想值。
  log(`  监听: http://${PROXY_HOST}:${PROXY_PORT}  ${lan ? '(局域网可访问)' : '(仅本机回环)'}`)
  log(`  上游: ${UPSTREAM}`)
  log(`  /_bridge: ${BRIDGE_TOKEN ? '已启用会话 token' : '未鉴权(未设置 PROXY_TOKEN)'}`)
  log(`  请求体上限: ${Math.round(MAX_BODY_BYTES / 1024 / 1024)} MiB  上游空闲超时: ${IDLE_TIMEOUT_MS}ms`)
  log(`  压缩: ${state.enabled ? '开启' : '关闭'}  阈值: 上下文的 ${state.thresholdRatio}`)
  log(`  保留最近 ${state.keepRecentTurns} 轮原文`)
  log(`  状态/开关: GET|POST http://127.0.0.1:${PROXY_PORT}/_bridge/status`)
  log('')
  log('提示:模型加载后的**第一次**对话会明显偏慢(约 30 秒量级),')
  log('      那是 CUDA 图初始化与 KV cache 分配的开销,与压缩无关 ——')
  log('      实测同一请求连发三次:32.5s / 1.3s / 0.8s。第二次起就正常了。')
})
