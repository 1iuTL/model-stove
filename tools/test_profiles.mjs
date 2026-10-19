// 验证档位是否真的生效。
//
// 关键:必须走**代理端口**(8092)且**不传采样参数** —— 档位是在代理里
// 按请求层覆盖的。如果直接打 8091 并自带 temperature,就把档位盖掉了。
//
// 判据:
//   - 推理档开思考 -> reasoning_content 非空
//   - 写作/通用/代码关思考 -> reasoning_content 为空
//
// 代理由本脚本自己拉起、结束时收掉。原因:用 Start-Process / 后台命令起它
// 会随父命令结束被回收(实测第一次就因此 ECONNREFUSED),而脚本内 spawn
// 的生命周期可控。
import { spawn } from 'node:child_process'
import { openSync, closeSync, mkdirSync, rmSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const APP = 'C:\\deepseek harness\\model-stove'
const TMP = `${APP}\\.profiles-test`
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

const KEY = process.env.STOVE_KEY
if (!KEY) { console.error('需要 STOVE_KEY'); process.exit(2) }
const PROXY = 'http://127.0.0.1:8092'

// 拉起代理
const pxLog = openSync(`${TMP}\\proxy.log`, 'w')
const proxy = spawn(process.execPath, [`${APP}\\context-proxy.mjs`], {
  cwd: APP,
  env: { ...process.env, PROXY_PORT: '8092' ,
    // 状态写到测试自己的临时目录,别碰生产的 context-proxy-state.json
    PROXY_STATE_DIR: TMP},
  stdio: ['ignore', pxLog, pxLog],
  windowsHide: true,
})
closeSync(pxLog)

let proxyUp = false
for (let i = 0; i < 30; i++) {
  await sleep(500)
  try {
    const r = await fetch(`${PROXY}/_bridge/status`, { signal: AbortSignal.timeout(3000) })
    if (r.status === 200) { proxyUp = true; break }
  } catch { /* 还没起来 */ }
}
if (!proxyUp) {
  console.error('代理未就绪,日志:')
  try {
    const { readFileSync } = await import('node:fs')
    console.error(readFileSync(`${TMP}\\proxy.log`, 'utf8').slice(-600))
  } catch { /* 没日志 */ }
  proxy.kill()
  process.exit(1)
}
console.log('代理已就绪\n')

async function setProfile(key) {
  const r = await fetch(`${PROXY}/_bridge/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile: key }),
  })
  const j = await r.json()
  return j
}

async function ask(prompt, maxTokens = 400) {
  const t0 = Date.now()
  const r = await fetch(`${PROXY}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: 'local',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      stream: false,
      // 刻意不传 temperature/top_p 等 —— 交给档位决定
    }),
    signal: AbortSignal.timeout(300000),
  })
  const j = await r.json()
  const m = j.choices?.[0]?.message || {}
  return {
    ms: Date.now() - t0,
    content: m.content || '',
    reasoning: m.reasoning_content || '',
    completion: j.usage?.completion_tokens || 0,
  }
}

const PROMPT = '一个水池甲管6小时注满,乙管4小时注满,两管同开多久注满?'

console.log('提示词: ' + PROMPT)
console.log('走代理 8092,不带任何采样参数(交给档位)\n')

const rows = []
for (const key of ['reason', 'chat', 'write', 'code']) {
  const s = await setProfile(key)
  console.log('='.repeat(70))
  console.log(`档位 ${s.profile}`)
  console.log('='.repeat(70))
  const r = await ask(PROMPT)
  const thinkOn = r.reasoning.trim().length > 0
  console.log(`  耗时 ${(r.ms / 1000).toFixed(1)}s  completion=${r.completion}`)
  console.log(`  思考内容: ${thinkOn ? r.reasoning.length + ' 字(思考开)' : '无(思考关)'}`)
  console.log(`  回答: ${JSON.stringify(r.content.slice(0, 120))}`)
  console.log('')
  rows.push({ key, thinkOn, thinkChars: r.reasoning.length, chars: r.content.length, secs: (r.ms / 1000).toFixed(1) })
}

console.log('='.repeat(70))
console.log('汇总')
console.log('='.repeat(70))
console.log('档位'.padEnd(10) + '思考   思考字数  回答字数  耗时')
for (const r of rows) {
  console.log(
    r.key.padEnd(10) +
    (r.thinkOn ? '开' : '关').padEnd(7) +
    String(r.thinkChars).padStart(8) +
    String(r.chars).padStart(10) +
    String(r.secs + 's').padStart(9),
  )
}
console.log('\n判据:推理档应“思考开”,其余三档应“思考关”。')

// 收尾:恢复默认档并关掉代理
try {
  await setProfile('chat')
} catch { /* 无所谓 */ }
proxy.kill()
await sleep(1500)
console.log('代理已关闭。')
