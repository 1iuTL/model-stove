// 起临时服务 + 代理,逐字节对比静态资源。
//
// 疑点:context-proxy.mjs 剥掉了响应的 content-encoding,而 Node 的 fetch
// 默认就发 accept-encoding: gzip, deflate。如果上游返回压缩内容,代理就会把
// 压缩字节当普通文本转发给浏览器 —— 界面永远初始化不完,表现是"卡在加载"。
//
// 之前的验证只覆盖 /_bridge/status 与 /v1/chat/completions,**从没测过静态资源**。
import { spawn } from 'node:child_process'
import { openSync, closeSync, mkdirSync, rmSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import crypto from 'node:crypto'

const APP = 'C:\\deepseek harness\\model-stove'
const TMP = `${APP}\\.asset-test`
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

const BIN = 'C:\\deepseek harness\\models\\llama-prism\\llama-server.exe'
const MODEL = 'F:\\models-archive\\Ternary-Bonsai-2-27B-PTQ1_0.gguf'
const DIR = 8091
const PX = 8094

console.log('启动临时服务(小上下文,只为提供静态资源)...')
const srvOut = openSync(`${TMP}\\srv.log`, 'w')
const srv = spawn(BIN, [
  '-m', MODEL, '-c', '2048', '-ngl', '99', '-fa', 'on', '-np', '1',
  '-ctk', 'q4_0', '-ctv', 'q4_0', '--jinja',
  '--host', '127.0.0.1', '--port', String(DIR),
], { stdio: ['ignore', srvOut, srvOut], windowsHide: true })
closeSync(srvOut)

let srvUp = false
for (let i = 0; i < 150; i++) {
  await sleep(1000)
  try {
    const r = await fetch(`http://127.0.0.1:${DIR}/health`, { signal: AbortSignal.timeout(2000) })
    if (r.status === 200) { srvUp = true; break }
  } catch { /* 还在加载 */ }
}
if (!srvUp) {
  // 即使模型没加载完,静态资源也可能已经可服务,继续试
  console.log('  服务未在 150 秒内就绪,仍然尝试取静态资源')
} else {
  console.log('  服务就绪')
}

console.log('启动代理...')
const pxOut = openSync(`${TMP}\\proxy.log`, 'w')
const proxy = spawn(process.execPath, [`${APP}\\context-proxy.mjs`], {
  cwd: APP,
  env: { ...process.env, PROXY_PORT: String(PX),
    // 状态写到测试自己的临时目录,别碰生产的 context-proxy-state.json
    PROXY_STATE_DIR: TMP, UPSTREAM: `http://127.0.0.1:${DIR}` },
  stdio: ['ignore', pxOut, pxOut],
  windowsHide: true,
})
closeSync(pxOut)

let pxUp = false
for (let i = 0; i < 30; i++) {
  await sleep(500)
  try {
    const r = await fetch(`http://127.0.0.1:${PX}/_bridge/status`, { signal: AbortSignal.timeout(3000) })
    if (r.status === 200) { pxUp = true; break }
  } catch { /* 还没起来 */ }
}
console.log(pxUp ? '  代理就绪\n' : '  代理未就绪\n')

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 12)

async function probe(base, path) {
  try {
    const r = await fetch(`${base}${path}`, {
      headers: { 'User-Agent': 'asset-test' },
      signal: AbortSignal.timeout(15000),
    })
    const buf = Buffer.from(await r.arrayBuffer())
    return {
      status: r.status, len: buf.length, hash: sha(buf),
      ce: r.headers.get('content-encoding'),
      ct: r.headers.get('content-type'),
      head: buf.slice(0, 50).toString('utf8'),
      buf,
    }
  } catch (e) {
    return { error: e?.cause ? (e.cause.code || e.cause.message) : e.message }
  }
}

const root = await probe(`http://127.0.0.1:${DIR}`, '/')
if (root.error) {
  console.log(`直连根页面失败: ${root.error}`)
  console.log('(静态资源由 llama-server 自己提供,加载完前可能不可用)')
  proxy.kill(); srv.kill()
  await sleep(1500)
  process.exit(0)
}

// 收集资源路径
const paths = new Set(['/'])
for (const m of root.buf.toString('utf8').matchAll(/(?:src|href)="([^"]+\.(?:js|css|webmanifest))"/g)) {
  let p = m[1]
  if (p.startsWith('./')) p = p.slice(1)
  else if (!p.startsWith('/')) p = '/' + p
  paths.add(p)
}

console.log('=== 逐字节对比:直连 vs 经代理 ===')
console.log('路径'.padEnd(42) + '直连(状态/长度/哈希)'.padEnd(26) + '代理(状态/长度/哈希)'.padEnd(26) + '一致')
let bad = 0
for (const p of [...paths].slice(0, 8)) {
  const a = await probe(`http://127.0.0.1:${DIR}`, p)
  const b = await probe(`http://127.0.0.1:${PX}`, p)
  if (a.error || b.error) {
    bad++
    console.log(`${p.slice(0, 40).padEnd(42)}${(a.error || 'ok').slice(0, 24).padEnd(26)}${(b.error || 'ok').slice(0, 24).padEnd(26)}ERR`)
    continue
  }
  const same = a.hash === b.hash
  if (!same) bad++
  console.log(
    p.slice(0, 40).padEnd(42) +
    `${a.status}/${a.len}/${a.hash}`.padEnd(26) +
    `${b.status}/${b.len}/${b.hash}`.padEnd(26) +
    (same ? '✓' : '✗'),
  )
  if (!same) {
    console.log(`    ^ 直连 content-encoding=${a.ce} 类型=${a.ct}`)
    console.log(`      代理 content-encoding=${b.ce} 类型=${b.ct}`)
    console.log(`      直连开头: ${JSON.stringify(a.head.slice(0, 34))}`)
    console.log(`      代理开头: ${JSON.stringify(b.head.slice(0, 34))}`)
  }
}

console.log('\n=== 结论 ===')
if (bad === 0) {
  console.log('  ✓ 静态资源经代理后与直连逐字节一致 —— 代理没损坏资源')
} else {
  console.log(`  ✗ ${bad} 个资源不一致 —— 这就是"界面卡在加载"的原因`)
}

proxy.kill(); srv.kill()
await sleep(2000)
console.log('\n已清理。')
