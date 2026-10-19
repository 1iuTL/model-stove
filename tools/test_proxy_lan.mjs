// 验证:代理是否监听在 0.0.0.0,也就是手机(走局域网地址)能否连上。
//
// 为什么单独测这一条:二维码现在指向代理端口,如果代理只监听 127.0.0.1,
// 手机扫码会连不上 —— 那就是把一个"功能少但能用"的地址换成了"完全用不了"的
// 地址,反而更糟。所以这个前提必须实测。
import { spawn } from 'node:child_process'
import { openSync, closeSync, mkdirSync, rmSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import os from 'node:os'

const APP = 'C:\\deepseek harness\\model-stove'
const TMP = `${APP}\\.proxy-lan`
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

const PORT = 8093

const out = openSync(`${TMP}\\proxy.log`, 'w')
const proxy = spawn(process.execPath, [`${APP}\\context-proxy.mjs`], {
  cwd: APP,
  env: { ...process.env, PROXY_PORT: String(PORT) ,
    // 状态写到测试自己的临时目录,别碰生产的 context-proxy-state.json
    PROXY_STATE_DIR: TMP},
  stdio: ['ignore', out, out],
  windowsHide: true,
})
closeSync(out)

// 等就绪
let up = false
for (let i = 0; i < 30; i++) {
  await sleep(500)
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/_bridge/status`, { signal: AbortSignal.timeout(3000) })
    if (r.status === 200) { up = true; break }
  } catch { /* 还没起来 */ }
}
if (!up) { console.log('代理未就绪'); proxy.kill(); process.exit(1) }
console.log(`代理已就绪(端口 ${PORT})\n`)

// 收集本机所有非回环 IPv4
const addrs = []
for (const [name, list] of Object.entries(os.networkInterfaces())) {
  for (const a of list || []) {
    if ((a.family === 4 || a.family === 'IPv4') && !a.internal) addrs.push({ name, address: a.address })
  }
}

console.log('=== 逐个局域网地址测试 ===')
let anyLanOk = false
for (const a of addrs) {
  const url = `http://${a.address}:${PORT}/_bridge/status`
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) })
    const j = await r.json()
    const ok = r.status === 200
    if (ok) anyLanOk = true
    console.log(`  ${ok ? '✓' : '✗'}  ${a.address.padEnd(16)} ${a.name.padEnd(14)} HTTP ${r.status}  档位=${j?.profile?.current ?? '?'}`)
  } catch (e) {
    const cause = e?.cause ? (e.cause.code || e.cause.message) : e.message
    console.log(`  ✗  ${a.address.padEnd(16)} ${a.name.padEnd(14)} 失败: ${cause}`)
  }
}

console.log('\n=== 结论 ===')
if (!addrs.length) {
  console.log('  没有非回环地址,无法判断 —— 请先连上 WiFi 或开热点')
} else if (anyLanOk) {
  console.log('  ✓ 代理监听在 0.0.0.0,手机可以连上 —— 二维码指向代理端口是可行的')
} else {
  console.log('  ✗ 所有局域网地址都连不上 —— 代理只监听了回环?那样手机扫码会失败')
}

proxy.kill()
await sleep(1500)
console.log('\n代理已关闭。')
