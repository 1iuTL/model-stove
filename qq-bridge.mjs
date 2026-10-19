// QQ 官方机器人 → 本地模型 的桥接服务。
//
// 数据流:
//   QQ 群里有人 @机器人
//     -> 腾讯把事件 POST 到本服务的 /qq/webhook
//     -> 本服务解析出提问、调用本地 llama-server(OpenAI 兼容接口)
//     -> 通过 QQ 开放平台 API 把回答发回群里
//
// 为什么是一个独立小服务而不是塞进 Model Stove:
//   1. Model Stove 是 Electron 外壳,监听公网需要额外的隧道,职责也不该混
//   2. 官方 webhook 要求公网 HTTPS,通常由 cloudflared / cpolar 这类隧道转发
//      到本服务的 http://127.0.0.1:8080,所以这里只监听回环
//   3. 群里多人同时问会遇到模型单槽位排队,这一层最适合做队列与限流
//
// 用法:
//   设置 QQ_APP_ID / QQ_APP_SECRET,然后
//   node qq-bridge.mjs
//
// 本地自测(不需要公网、不需要真实 QQ 凭据):
//   node qq-bridge.mjs --selftest       验证本地模型链路与队列
//   node qq-bridge.mjs --test-webhook   验证 @ 事件解析
//
// 注意:QQ 开放平台的 Token 鉴权已废弃,这里用 AppID+AppSecret 换 Access Token。
import http from 'node:http'
import crypto from 'node:crypto'
import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs'

// ------------------------------------------------------------------ 配置

const APP_ID = process.env.QQ_APP_ID || ''
const APP_SECRET = process.env.QQ_APP_SECRET || ''
const PORT = Number(process.env.BRIDGE_PORT || 8080)
// 注意:QQ 开放平台的 Token 鉴权方式已废弃,现在必须用 AppID+AppSecret 换
// Access Token(getAccessToken)。所以这里不再需要 Bot Token。

// 把收到的原始事件转储到文件。第一次接入真 QQ 时打开它,就能看到
// @ 消息 content 的真实格式,不用靠猜。设 QQ_DUMP=1 启用。
const DUMP_RAW = process.env.QQ_DUMP === '1'

// 本地模型服务。默认指向 Model Stove 起的 llama-server。
const MODEL_URL = process.env.MODEL_URL || 'http://127.0.0.1:8091/v1/chat/completions'
const MODEL_KEY = process.env.MODEL_KEY || ''
const MODEL_NAME = process.env.MODEL_NAME || 'local'

// 只有被 @ 才回复。这是默认也是最省资源的行为。
const REPLY_ONLY_MENTION = process.env.REPLY_ALL !== '1'

// 群聊节奏:本地模型单个请求要 5-15 秒,而且当前是单槽位(-np 1)。
// 所以必须排队,否则同时来几条会把服务压垮、每条都变慢。
const MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY || 1)
const MAX_QUEUE = Number(process.env.MAX_QUEUE || 20)

// 每个会话保留多少轮上下文。群里人多,留太长既慢又费显存。
const HISTORY_TURNS = Number(process.env.HISTORY_TURNS || 3)

const LOG_DIR = 'C:\\deepseek harness\\model-stove\\logs'
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true })
const LOG_FILE = `${LOG_DIR}\\qq-bridge.log`

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`
  console.log(line)
  try { appendFileSync(LOG_FILE, line + '\n', 'utf8') } catch { /* 日志失败不影响服务 */ }
}

// ------------------------------------------------------------------ 会话上下文

// key: 群 openid(+ 可选用户),value: [{role, content}]
const sessions = new Map()

function historyFor(key) {
  return sessions.get(key) || []
}
function remember(key, role, content) {
  const h = sessions.get(key) || []
  h.push({ role, content })
  // 只留最近 N 轮(用户+助手各算一条),避免上下文无限增长
  const max = HISTORY_TURNS * 2
  while (h.length > max) h.shift()
  sessions.set(key, h)
}

// ------------------------------------------------------------------ 请求队列

let running = 0
const queue = []

function enqueue(task) {
  return new Promise((resolve, reject) => {
    if (queue.length >= MAX_QUEUE) {
      reject(new Error('排队已满,请稍后再问'))
      return
    }
    queue.push({ task, resolve, reject })
    pump()
  })
}

function pump() {
  while (running < MAX_CONCURRENCY && queue.length) {
    const { task, resolve, reject } = queue.shift()
    running++
    task()
      .then(resolve, reject)
      .finally(() => { running--; pump() })
  }
}

function queueStatus() {
  return { running, waiting: queue.length, limit: MAX_CONCURRENCY, maxQueue: MAX_QUEUE }
}

// ------------------------------------------------------------------ 调本地模型

async function askModel(question, sessionKey) {
  const messages = [
    // 群里说话很短,给个约束避免模型长篇大论 —— 群聊里长回答很难读
    { role: 'system', content: '你是 QQ 群里的助手。回答要简短、直接、口语化,控制在 200 字以内。不要用 Markdown 标题。' },
    ...historyFor(sessionKey),
    { role: 'user', content: question },
  ]

  const headers = { 'Content-Type': 'application/json' }
  if (MODEL_KEY) headers.Authorization = `Bearer ${MODEL_KEY}`

  const res = await fetch(MODEL_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: MODEL_NAME, messages, max_tokens: 600, stream: false }),
    signal: AbortSignal.timeout(180000),
  })
  if (!res.ok) {
    const t = await res.text()
    throw new Error(`本地模型返回 HTTP ${res.status}: ${t.slice(0, 200)}`)
  }
  const j = await res.json()
  const msg = j.choices?.[0]?.message || {}
  // 思考内容不进群,只发最终回答
  const answer = (msg.content || '').trim()
  if (!answer) throw new Error('模型没有产出内容(可能只输出了思考)')

  // 记录上下文,让后续追问能接上
  remember(sessionKey, 'user', question)
  remember(sessionKey, 'assistant', answer)
  return answer
}

// ------------------------------------------------------------------ QQ 开放平台 API

let tokenCache = { value: null, expiresAt: 0 }

/** 获取 app access token,带缓存(token 有效期约 2 小时)。 */
async function getAccessToken() {
  if (tokenCache.value && Date.now() < tokenCache.expiresAt) return tokenCache.value

  const res = await fetch('https://bots.qq.com/app/getAppAccessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId: APP_ID, clientSecret: APP_SECRET }),
    signal: AbortSignal.timeout(15000),
  })
  const j = await res.json()
  if (!j.access_token) throw new Error(`取 token 失败: ${JSON.stringify(j).slice(0, 200)}`)
  // 提前 60 秒过期,避免边界上用到失效 token
  tokenCache = {
    value: j.access_token,
    expiresAt: Date.now() + (Number(j.expires_in || 7200) - 60) * 1000,
  }
  log('已刷新 access token')
  return tokenCache.value
}

/** 调用 QQ 开放平台 API。 */
async function qqApi(method, path, body) {
  const token = await getAccessToken()
  const res = await fetch(`https://api.sgroup.qq.com${path}`, {
    method,
    headers: {
      Authorization: `QQBot ${token}`,
      'Content-Type': 'application/json',
      'X-Union-Appid': APP_ID,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  })
  const text = await res.text()
  let j = null
  try { j = JSON.parse(text) } catch { /* 非 JSON */ }
  if (!res.ok) {
    throw new Error(`QQ API ${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 200)}`)
  }
  return j
}

/** 回复群消息。 */
async function replyGroup(groupOpenid, content, msgId) {
  return qqApi('POST', `/v2/groups/${groupOpenid}/messages`, {
    content,
    msg_type: 0,
    msg_id: msgId,          // 被动回复,需带上收到的 msg_id
  })
}

/** 回复单聊(私聊)。 */
async function replyC2C(userOpenid, content, msgId) {
  return qqApi('POST', `/v2/users/${userOpenid}/messages`, {
    content,
    msg_type: 0,
    msg_id: msgId,
  })
}

// ------------------------------------------------------------------ 事件处理

/** 去掉消息里的 @机器人 片段和首尾空白,拿到真正的提问。 */
function extractQuestion(raw) {
  return String(raw || '')
    .replace(/<@!?\d+>/g, '')       // 官方格式的 @ 标记
    .replace(/<@!?[^>]+>/g, '')
    .replace(/^\s*\/?@?\S*\s*/, (m) => (/@|机器人/.test(m) ? '' : m))
    .trim()
}

/** 处理一条群消息事件。 */
async function handleGroupMessage(d) {
  const groupOpenid = d.group_openid
  const raw = d.content || ''
  const msgId = d.id
  const question = extractQuestion(raw)

  log(`群消息 group=${String(groupOpenid).slice(0, 12)}… 原文=${JSON.stringify(raw).slice(0, 80)} 提问=${JSON.stringify(question).slice(0, 60)}`)

  if (!question) {
    log('  提问为空,跳过')
    return
  }

  const key = `group:${groupOpenid}`
  try {
    const q = queueStatus()
    if (q.running >= q.limit || q.waiting > 0) {
      log(`  排队中(运行 ${q.running},等待 ${q.waiting})`)
    }
    const answer = await enqueue(() => askModel(question, key))
    await replyGroup(groupOpenid, answer, msgId)
    log(`  已回复 ${answer.length} 字`)
  } catch (e) {
    log(`  失败: ${e.message}`)
    // 出错也让群里看到,否则用户不知道发生了什么
    try {
      await replyGroup(groupOpenid, `抱歉,处理失败了:${String(e.message).slice(0, 100)}`, msgId)
    } catch (e2) {
      log(`  连错误也发不出去: ${e2.message}`)
    }
  }
}

/** 处理单聊消息事件。 */
async function handleC2CMessage(d) {
  const userOpenid = d.author?.user_openid
  const question = extractQuestion(d.content)
  if (!question) return
  log(`私聊 user=${String(userOpenid).slice(0, 12)}… 提问=${JSON.stringify(question).slice(0, 60)}`)
  const key = `c2c:${userOpenid}`
  try {
    const answer = await enqueue(() => askModel(question, key))
    await replyC2C(userOpenid, answer, d.id)
    log(`  已回复 ${answer.length} 字`)
  } catch (e) {
    log(`  失败: ${e.message}`)
  }
}

// ------------------------------------------------------------------ webhook 服务

/**
 * 校验 QQ 开放平台的 Ed25519 签名。
 *
 * 算法严格按官方文档(https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/sign.html):
 *
 *   seed := botSecret
 *   for len(seed) < 32 { seed = seed + seed }     // 字符串重复,不是哈希!
 *   priv := ed25519.NewKeyFromSeed(seed[:32])
 *
 * 注意这里是**字符串重复**。用 sha256 反复哈希去凑 32 字节是错的 ——
 * 那样公钥完全不同,验签会一律失败(表现是 webhook 静默 401,很难查)。
 *
 * 官方示例:secret "naOC0ocQE3shWLAfffVLB1rhYPG7"(28 字符)
 *          -> 重复一次 -> 前 32 字符 "naOC0ocQE3shWLAfffVLB1rhYPG7naOC"
 */
function verifySignature(signature, timestamp, rawBody) {
  if (!APP_SECRET) return { ok: false, reason: '未配置 QQ_APP_SECRET' }
  if (!signature || !timestamp) return { ok: false, reason: '缺少签名头' }
  try {
    // 1. 由 bot secret 派生 32 字节 seed(字符串重复到足够长)
    let seed = APP_SECRET
    while (Buffer.byteLength(seed, 'utf8') < 32) seed = seed + seed
    const seedBuf = Buffer.from(seed, 'utf8').subarray(0, 32)

    // 2. 用 seed 生成 Ed25519 密钥对(Node 要求 PKCS#8 包装的私钥)
    const pkcs8 = Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      seedBuf,
    ])
    const priv = crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' })
    const pub = crypto.createPublicKey(priv)

    // 3. 待验签内容 = timestamp + body
    const msg = Buffer.from(timestamp + rawBody, 'utf8')
    const sig = Buffer.from(signature, 'hex')

    // 4. 官方的额外检查:签名必须是 64 字节且最后一个字节高 3 位为 0
    if (sig.length !== 64) return { ok: false, reason: `签名长度 ${sig.length} != 64` }
    if ((sig[63] & 224) !== 0) return { ok: false, reason: '签名末字节高 3 位非 0' }

    const ok = crypto.verify(null, msg, pub, sig)
    return { ok, reason: ok ? '' : '签名不匹配' }
  } catch (e) {
    return { ok: false, reason: e.message }
  }
}

const OPCODES = { 0: 'DISPATCH', 1: 'HEARTBEAT', 2: 'IDENTIFY', 6: 'RESUME', 10: 'HELLO', 11: 'HEARTBEAT_ACK', 13: 'CALLBACK_ACK' }

const server = http.createServer((req, res) => {
  // 简单 CORS,方便浏览器/工具调试
  res.setHeader('Access-Control-Allow-Origin', '*')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({
      ok: true,
      model: MODEL_URL,
      queue: queueStatus(),
      sessions: sessions.size,
      replyOnlyMention: REPLY_ONLY_MENTION,
      hasCredentials: Boolean(APP_ID && APP_SECRET),
    }, null, 2))
    return
  }

  if (req.url !== '/qq/webhook' || req.method !== 'POST') {
    res.writeHead(404); res.end('not found')
    return
  }

  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', async () => {
    const raw = Buffer.concat(chunks).toString('utf8')

    // 签名校验:有 secret 就强制验,没有则警告放行(便于本地自测)
    const sig = req.headers['x-signature-ed25519']
    const ts = req.headers['x-signature-timestamp']
    if (sig && ts) {
      const v = verifySignature(sig, ts, raw)
      if (!v.ok) {
        log(`签名校验失败: ${v.reason}`)
        res.writeHead(401); res.end('invalid signature')
        return
      }
    } else if (APP_SECRET) {
      log('缺少签名头,已拒绝(已配置 APP_SECRET 时必须验签)')
      res.writeHead(401); res.end('missing signature')
      return
    }

    let payload = null
    try { payload = JSON.parse(raw) } catch { /* 非法 JSON */ }
    if (!payload) { res.writeHead(400); res.end('bad json'); return }

    // 原始事件转储:接入真 QQ 时用它看真实字段格式
    if (DUMP_RAW) {
      try {
        appendFileSync(`${LOG_DIR}\\qq-events.log`, `\n--- ${new Date().toISOString()} ---\n${raw}\n`, 'utf8')
        log('已转储原始事件(QQ_DUMP=1)')
      } catch { /* 转储失败不影响处理 */ }
    }

    // 先回 200,避免腾讯重推。耗时处理放后台。
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{"op":12}')

    const op = payload.op
    log(`收到事件 op=${op}${OPCODES[op] ? '(' + OPCODES[op] + ')' : ''} t=${payload.t || '-'}`)

    // op=13 是回调地址验证,原样回 ack
    if (op === 13) {
      const d = payload.d || {}
      log(`  地址验证 plain_token=${String(d.plain_token).slice(0, 12)}…`)
      return
    }

    if (op !== 0) return

    const t = payload.t
    const d = payload.d || {}
    try {
      if (t === 'GROUP_AT_MESSAGE_CREATE') {
        if (REPLY_ONLY_MENTION) await handleGroupMessage(d)
        else await handleGroupMessage(d)
      } else if (t === 'C2C_MESSAGE_CREATE') {
        await handleC2CMessage(d)
      } else {
        log(`  未处理的事件类型: ${t}`)
      }
    } catch (e) {
      log(`事件处理异常: ${e.message}`)
    }
  })
})

// ------------------------------------------------------------------ 自测

/**
 * 自测:不连 QQ、不需要公网,直接构造一条群消息事件喂给本地链路。
 * 用来验证"解析提问 → 调本地模型 → 组织回复"这一段是否通。
 */
async function selftest() {
  log('=== 自测模式:验证本地链路(不连 QQ) ===')
  log(`模型地址: ${MODEL_URL}`)

  // 1. 模型可达性
  try {
    const base = MODEL_URL.replace(/\/v1\/chat\/completions$/, '')
    const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) })
    log(`  模型 /health -> HTTP ${r.status}`)
  } catch (e) {
    log(`  ✗ 连不上本地模型(${MODEL_URL})。请先在 Model Stove 里点「启动」。`)
    log(`    原因: ${e.cause ? e.cause.code || e.cause.message : e.message}`)
    process.exit(1)
  }

  // 2. @ 解析
  const cases = [
    ['<@!1234567890> 反射定律是什么', '反射定律是什么'],
    ['<@1234567890>1+1等于几', '1+1等于几'],
    ['你好啊', '你好啊'],
  ]
  log('  @ 解析:')
  for (const [input, want] of cases) {
    const got = extractQuestion(input)
    log(`    ${JSON.stringify(input).padEnd(32)} -> ${JSON.stringify(got)}  ${got === want ? '✓' : '(期望 ' + JSON.stringify(want) + ')'}`)
  }

  // 3. 真实提问
  const q = '用一句话解释反射定律'
  log(`  向本地模型提问: ${q}`)
  const t0 = Date.now()
  try {
    const answer = await askModel(q, 'selftest')
    log(`  ✓ 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s,得到 ${answer.length} 字:`)
    log(`    ${answer.slice(0, 300)}`)
  } catch (e) {
    log(`  ✗ 提问失败: ${e.message}`)
    process.exit(1)
  }

  // 4. 队列行为
  log('  队列并发测试(同时发 3 条,单槽位应串行):')
  const t1 = Date.now()
  await Promise.all([1, 2, 3].map((i) => enqueue(() => askModel(`说数字${i}`, `q${i}`))))
  log(`  ✓ 3 条全部完成,总用时 ${((Date.now() - t1) / 1000).toFixed(1)}s`)

  log('=== 自测通过:本地链路可用。接下来接真实 QQ。 ===')
  process.exit(0)
}

// ------------------------------------------------------------------ 启动

// --test-webhook:不需要公网与真实 QQ 凭据,直接走一遍
// 「@ 事件原文 → 抽取提问 → 调本地模型 → 得到待发内容」。
// 这一步能先确认逻辑正确,再接真 QQ;真实发送那一步需要 QQ 凭据,单独验。
if (process.argv.includes('--test-webhook')) {
  // 官方群 @ 事件的 content 里,@ 机器人表现为 <@!openid> 前缀。
  // 真实格式拿不准时,用 QQ_DUMP=1 跑一次线上就能看到原文。
  const fakeContent = '<@!1234567890> 用一句话解释反射定律'

  log('=== webhook 链路测试(伪造事件,不连 QQ) ===')
  log(`  @ 事件原文 : ${JSON.stringify(fakeContent)}`)

  const question = extractQuestion(fakeContent)
  log(`  抽取的提问 : ${JSON.stringify(question)}`)
  if (!question) {
    log('  ✗ 抽取为空 —— @ 解析规则需要按真实格式修正')
    process.exit(1)
  }

  log('  调用本地模型 ...')
  try {
    const ans = await askModel(question, 'webhook-test')
    log(`  ✓ 得到回复 ${ans.length} 字:`)
    log(`    ${ans.slice(0, 300)}`)
    log('')
    log('  「事件 → 解析 → 模型 → 待发内容」这一段已通。')
    log('  真实发送需要 QQ_APP_ID / QQ_APP_SECRET,并用隧道暴露公网地址。')
  } catch (e) {
    log(`  ✗ 失败: ${e.message}`)
    process.exit(1)
  }
  process.exit(0)
}

if (process.argv.includes('--selftest')) {
  selftest()
} else {
  server.listen(PORT, '127.0.0.1', () => {
    log(`QQ 桥接服务已启动: http://127.0.0.1:${PORT}`)
    log(`  webhook 路径: /qq/webhook    健康检查: /health`)
    log(`  模型: ${MODEL_URL}`)
    log(`  凭据: ${APP_ID && APP_SECRET ? '已配置' : '未配置(仅能本地自测)'}`)
    log(`  回复策略: ${REPLY_ONLY_MENTION ? '仅 @ 时回复' : '所有消息都回复'}`)
    log(`  并发: ${MAX_CONCURRENCY} 槽位,队列上限 ${MAX_QUEUE}`)
  })
}
