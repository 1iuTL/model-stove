// 端到端测试上下文压缩代理。
//
// 难点:压缩只在"历史超过阈值"时触发,而 64K 上下文很难在测试里凑满。
// 解法:用很小的 -c(2048)起 upstream,并把阈值调低,这样一段中等长度的
// 对话就能触发压缩。这样测的是**真实链路**,不是打桩。
import { spawn } from 'node:child_process'
import { openSync, closeSync, mkdirSync, rmSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const SRC = 'C:\\deepseek harness\\model-stove'
const TMP = `${SRC}\\.proxy-test`
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

const BIN = 'C:\\deepseek harness\\models\\llama-prism\\llama-server.exe'
const MODEL = 'F:\\models-archive\\Ternary-Bonsai-2-27B-PTQ1_0.gguf'
const MODEL_PORT = 8096
const PROXY_PORT = 8095

// ---- 1. 起上游(小上下文,便于触发压缩)----
console.log('=== 启动上游(小上下文 2048,便于触发压缩)===' )
const srvOut = openSync(`${TMP}\\srv.log`, 'w')
const srv = spawn(BIN, [
  '-m', MODEL, '-c', '2048', '-ngl', '99', '-fa', 'on', '-np', '1',
  '-ctk', 'q4_0', '-ctv', 'q4_0', '--jinja',
  '--host', '127.0.0.1', '--port', String(MODEL_PORT),
  '--reasoning-budget', '512',
], { stdio: ['ignore', srvOut, srvOut], windowsHide: true })
closeSync(srvOut)

let up = false
for (let i = 0; i < 200; i++) {
  await sleep(1000)
  try { const r = await fetch(`http://127.0.0.1:${MODEL_PORT}/health`); if (r.status === 200) { up = true; break } } catch {}
}
if (!up) { console.log('上游未就绪'); srv.kill(); process.exit(1) }
console.log('  上游就绪\n')

// ---- 2. 起代理 ----
console.log('=== 启动代理 ===')
const pxOut = openSync(`${TMP}\\proxy.log`, 'w')
const proxy = spawn(process.execPath, [`${SRC}\\context-proxy.mjs`], {
  env: {
    ...process.env,
    PROXY_PORT: String(PROXY_PORT),
    UPSTREAM: `http://127.0.0.1:${MODEL_PORT}`,
    COMPRESS: '1',
    // 把状态写到测试自己的临时目录。
    //
    // 不隔离的话这个测试会改**生产**状态文件:下面它把阈值调到 0.2、
    // 保留 2 轮,而且跑完不还原 —— 实测用户那边的压缩配置就这么被改成了
    // 0.2 / 2 轮,界面显示的默认值(0.6 / 4)对不上,查了很久。
    PROXY_STATE_DIR: TMP,
  },
  stdio: ['ignore', pxOut, pxOut],
  windowsHide: true,
})
closeSync(pxOut)

let pxUp = false
for (let i = 0; i < 30; i++) {
  await sleep(500)
  try { const r = await fetch(`http://127.0.0.1:${PROXY_PORT}/_bridge/status`); if (r.status === 200) { pxUp = true; break } } catch {}
}
if (!pxUp) { console.log('代理未就绪'); srv.kill(); proxy.kill(); process.exit(1) }

// ---- 3. 看初始状态 ----
console.log('=== 初始状态 ===')
let st = await (await fetch(`http://127.0.0.1:${PROXY_PORT}/_bridge/status`)).json()
console.log('  ' + JSON.stringify(st, null, 2).replace(/\n/g, '\n  '))

// 把阈值调低,让中等长度的对话就能触发
await fetch(`http://127.0.0.1:${PROXY_PORT}/_bridge/config`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ enabled: true, thresholdRatio: 0.2, keepRecentTurns: 2 }),
})
console.log('\n  已把阈值调到 0.2、保留 2 轮(便于触发)\n')

// ---- 4. 构造一段长对话并请求 ----
console.log('=== 发送一段较长对话 ===')
const filler = '这是用于填充上下文的历史内容,目的是让估算的 token 数超过阈值,从而触发压缩逻辑。'
const messages = [
  { role: 'system', content: '你是有用的助手。' },
]
// 造 6 轮,每轮内容较长
for (let i = 1; i <= 6; i++) {
  messages.push({ role: 'user', content: `第 ${i} 个问题:${filler.repeat(3)}` })
  messages.push({ role: 'assistant', content: `第 ${i} 个回答:${filler.repeat(3)}` })
}
messages.push({ role: 'user', content: '请用一句话总结我们之前聊了什么。' })

const approx = messages.reduce((a, m) => a + Math.ceil(m.content.length * 0.6) + 4, 0)
console.log(`  消息 ${messages.length} 条,估算约 ${approx} token(上下文 2048,阈值 0.2 -> 409)`)

const t0 = Date.now()
try {
  const r = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'local', messages, max_tokens: 200, stream: false }),
    signal: AbortSignal.timeout(300000),
  })
  const j = await r.json()
  const usage = j.usage || {}
  console.log(`  HTTP ${r.status}  用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  console.log(`  usage: prompt=${usage.prompt_tokens} completion=${usage.completion_tokens}`)
  console.log(`  回答: ${JSON.stringify((j.choices?.[0]?.message?.content || '(空)').slice(0, 200))}`)
} catch (e) {
  console.log(`  请求失败: ${e.message}`)
}

// ---- 5. 看压缩统计 ----
console.log('\n=== 压缩后状态 ===')
st = await (await fetch(`http://127.0.0.1:${PROXY_PORT}/_bridge/status`)).json()
console.log('  ' + JSON.stringify(st.stats, null, 2).replace(/\n/g, '\n  '))

// ---- 6. 关掉压缩再发一次,对比 ----
console.log('\n=== 关闭压缩后再发一次同样的请求 ===')
await fetch(`http://127.0.0.1:${PROXY_PORT}/_bridge/config`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ enabled: false }),
})
try {
  const r = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'local', messages, max_tokens: 200, stream: false }),
    signal: AbortSignal.timeout(300000),
  })
  const j = await r.json()
  console.log(`  HTTP ${r.status}  usage: prompt=${j.usage?.prompt_tokens}`)
  const before = (await (await fetch(`http://127.0.0.1:${PROXY_PORT}/_bridge/status`)).json()).stats
  console.log(`  压缩次数(应仍为 1):${before.compressCount}`)
} catch (e) {
  console.log(`  失败: ${e.message}`)
}

// ---- 7. 清理 ----
console.log('\n=== 清理 ===')
proxy.kill()
srv.kill()
await sleep(3000)
console.log('代理日志末尾:')
try {
  const { readFileSync } = await import('node:fs')
  console.log(readFileSync(`${TMP}\\proxy.log`, 'utf8').split('\n').slice(-14).join('\n'))
} catch { /* 日志没了 */ }
console.log('\n完成。')
