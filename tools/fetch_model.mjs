// 分段并发下载器(带断点续传)。
//
// 为什么不用一次拉完:这条网络不稳定,6.67 GB 单连接一旦中断就白费。
// 切成小块逐个下载并落盘,中断后重跑只补缺失的块。
//
// 用法:node tools/fetch_model.mjs <url> <输出文件> [块大小MB]
import { openSync, closeSync, writeSync, readSync, readFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const url = process.argv[2]
const outFile = process.argv[3]
const CHUNK_MB = Number(process.argv[4] || 8)
if (!url || !outFile) {
  console.error('用法: node tools/fetch_model.mjs <url> <输出文件> [块大小MB]')
  process.exit(2)
}

// ---------------------------------------------------------------- 并发写者防护
//
// 为什么必须有这一层:两个进程写**同一个 parts 目录**时,会竞争同一批分块号并
// **并发写同一个 part 文件**。两边都写满 8MB,于是 `size === want` 校验通过、
// 最终文件大小正确、GGUF 头也合法 —— 但内容是交错的。这是**静默损坏**:
// 模型能加载、能跑,权重却是垃圾,而且常规校验全都看不出来。
// (2026-09-29 实际差点踩上:并行下载时才发现队列里排着同一个文件。)
//
// 用 PID 锁文件挡住。陈旧锁(进程已死,或超过 6 小时)自动接管。
const lockFile = `${outFile}.lock`
if (existsSync(lockFile)) {
  let info = null
  try { info = JSON.parse(readFileSync(lockFile, 'utf8')) } catch { /* 损坏的锁当陈旧处理 */ }
  const ageH = info && info.t ? (Date.now() - info.t) / 3600000 : 99
  let alive = false
  if (info && info.pid) { try { process.kill(info.pid, 0); alive = true } catch { /* 进程不在了 */ } }
  if (alive && ageH < 6) {
    console.error(`✗ 已有进程在下载同一个文件(pid=${info.pid},${ageH.toFixed(1)} 小时前启动)。`)
    console.error('  并发写同一个 parts 目录会造成静默损坏,拒绝启动。')
    process.exit(3)
  }
  console.warn(`  发现陈旧锁(pid=${info ? info.pid : '?'},无活动进程),接管。`)
}
writeFileSync(lockFile, JSON.stringify({ pid: process.pid, t: Date.now() }), 'utf8')
process.on('exit', () => { try { rmSync(lockFile, { force: true }) } catch { /* 忽略 */ } })

const partDir = `${outFile}.parts`
if (!existsSync(partDir)) mkdirSync(partDir, { recursive: true })
const CHUNK = CHUNK_MB * 1024 * 1024

/** 带超时与停滞检测的 fetch。卡住时中止并抛错,交给上层重试。 */
async function fetchWithStall(url, init, timeoutMs = 120000, stallMs = 45000) {
  const ac = new AbortController()
  let last = Date.now()
  const timer = setInterval(() => {
    if (Date.now() - last > stallMs) ac.abort(new Error('传输停滞'))
  }, 5000)
  const hard = setTimeout(() => ac.abort(new Error('超时')), timeoutMs)
  try {
    const r = await fetch(url, { ...init, signal: ac.signal })
    // 手动读流以便更新 last
    if (!r.body) { last = Date.now(); return { status: r.status, headers: r.headers, buf: Buffer.from(await r.arrayBuffer()) } }
    const chunks = []
    const reader = r.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      last = Date.now()
      chunks.push(Buffer.from(value))
    }
    return { status: r.status, headers: r.headers, buf: Buffer.concat(chunks) }
  } finally {
    clearInterval(timer)
    clearTimeout(hard)
  }
}

// 1. 解析直链
//
// ⚠ 为什么必须能"重新解析":hf-mirror 的 resolve 会 302 到**带签名的 CAS 地址**
//   (cas-bridge.xethub.hf.co),而**签名是会过期的**。
//   实测(2026-09-29):一个 13.65 GB 的文件在 3.9 MB/s 下下了整整 60 分钟,
//   最后一块(第 1747/1748 块)拿到 HTTP 403,5 次重试**全是 403** ——
//   进程退出、合并从未发生,前面 1747 块虽然都在分块目录里,但没人知道。
//   所以把解析抽成函数,重试前重新解析一次,拿新的签名。
async function resolveTarget() {
  const head = await fetch(url, { method: 'GET', redirect: 'manual', headers: { 'User-Agent': 'model-stove' }, signal: AbortSignal.timeout(30000) })
  if (head.status >= 300 && head.status < 400) {
    // ⚠ Location 可能是**相对路径**:hf-mirror 对非 LFS 的小文件(如 README)会回
    //   `/api/resolve-cache/...`,直接丢给 fetch 会 ERR_INVALID_URL 崩溃。
    //   实测踩过。用 new URL(loc, url) 统一成绝对地址(绝对地址它会原样返回)。
    const loc = head.headers.get('location')
    const t = new URL(loc, url).href
    console.log(`  重定向 -> ${t.slice(0, 70)}...`)
    return t
  }
  if (head.status === 200) {
    console.log('  200,直链')
    return url
  }
  throw new Error(`意外状态 HTTP ${head.status}`)
}

console.log('解析下载地址 ...')
let target = await resolveTarget()

// 2. 探尺寸
const probe = await fetch(target, { headers: { 'User-Agent': 'model-stove', Range: 'bytes=0-0' }, signal: AbortSignal.timeout(30000) })
const cr = probe.headers.get('content-range')
const total = cr ? Number(cr.split('/')[1]) : Number(probe.headers.get('content-length'))
console.log(`  文件大小: ${total} 字节 (${(total / 1024 / 1024 / 1024).toFixed(2)} GiB)`)
if (!Number.isFinite(total) || total <= 0) {
  // ⚠ 2026-09-30:有些非 LFS 小文件(走 HF 的 resolve 缓存、或镜像不支持 Range)
  //   既不给 content-range 也不给 content-length,分块逻辑会直接崩在这里。
  //   以前是 `process.exit(1)` 报"取不到大小" —— 明明能下却退出。
  //   这种情况**不切块,整体下载**:小文件本来也不需要分块与断点续传。
  console.log('  取不到大小 —— 按整体下载处理(不切块)')
  await downloadWhole(target, outFile)
  process.exit(0)
}

/** 整体下载:取不到大小时的退路(非 LFS 小文件、不支持 Range 的镜像)。
 *  函数声明会被提升,所以定义在调用点之后也没问题。
 *  注意这会一次性把内容读进内存 —— 只该用在小文件上,而"没有大小"基本就是小文件。 */
async function downloadWhole(url, dest) {
  const t0 = Date.now()
  const r = await fetchWithStall(url, { headers: { 'User-Agent': 'model-stove' } })
  if (r.status !== 200 && r.status !== 206) throw new Error(`HTTP ${r.status}`)
  const fd = openSync(dest, 'w')
  try { writeSync(fd, r.buf) } finally { closeSync(fd) }
  const secs = (Date.now() - t0) / 1000
  const mb = r.buf.length / 1024 / 1024
  console.log(`  完成: ${r.buf.length} 字节 (${mb.toFixed(1)} MB)  用时 ${secs.toFixed(1)}s  平均 ${secs > 0 ? (mb / secs).toFixed(1) : '?'} MB/s`)
}

const nChunks = Math.ceil(total / CHUNK)
console.log(`  切分为 ${nChunks} 块 × ${CHUNK_MB} MB,并发 6\n`)

// 3. 逐块下载(已存在的跳过)
let done = 0
let reused = 0
let fetched = 0          // 只统计**本次真正下载**的块
const t0 = Date.now()

async function getChunk(i, attempt = 1) {
  const start = i * CHUNK
  const end = Math.min(start + CHUNK, total) - 1
  const partFile = `${partDir}\\${String(i).padStart(5, '0')}.part`
  const want = end - start + 1

  if (existsSync(partFile) && statSync(partFile).size === want) {
    reused++
    done++
    return
  }

  try {
    const r = await fetchWithStall(target, {
      headers: { 'User-Agent': 'model-stove', Range: `bytes=${start}-${end}` },
    })
    if (r.status !== 206 && r.status !== 200) throw new Error(`HTTP ${r.status}`)
    if (r.buf.length !== want) throw new Error(`字节数不符: 期望 ${want} 实得 ${r.buf.length}`)
    const fd = openSync(partFile, 'w')
    try { writeSync(fd, r.buf) } finally { closeSync(fd) }
    done++
    fetched++
    const pct = ((done / nChunks) * 100).toFixed(1)
    const secs = (Date.now() - t0) / 1000
    // ⚠ 速率只能按 fetched 算。原来按 done 算(含续传复用的块)会在断点续传时
    //   严重虚高 —— 实测一个补下 175 块的进程显示"平均 19.9 MB/s",
    //   而当时真实速度约 3 MB/s,差 6 倍。数字骗人比没有数字更糟。
    const rate = secs > 0 ? ((fetched * CHUNK_MB) / secs).toFixed(1) : '?'
    if (done % 5 === 0 || done === nChunks) {
      console.log(`  进度 ${done}/${nChunks} (${pct}%)  本次下载 ${fetched * CHUNK_MB} MB / 累计 ${done * CHUNK_MB} MB  本次平均 ${rate} MB/s`)
    }
  } catch (e) {
    const msg = e.cause ? e.cause.message || e.cause.code : e.message
    if (attempt < 5) {
      // 401/403 = 签名大概率过期了。重试前**重新解析直链**拿新签名,
      // 否则 5 次重试会全是 403(这正是 2026-09-29 那次整文件失败的原因)。
      if (/HTTP (401|403)/.test(msg)) {
        try {
          target = await resolveTarget()
          console.log(`  块 ${i} 遇到 ${msg},已重新解析直链后重试`)
        } catch (e2) {
          console.log(`  块 ${i} 重新解析直链失败: ${e2.message}`)
        }
      }
      await sleep(2000 * attempt)
      return getChunk(i, attempt + 1)   // 失败重试,不放弃整块
    }
    throw new Error(`块 ${i} 下载失败(${attempt} 次): ${msg}`)
  }
}

// 并发调度
let next = 0
async function worker() {
  for (;;) {
    const i = next++
    if (i >= nChunks) return
    await getChunk(i)
  }
}
await Promise.all(new Array(6).fill(0).map(worker))

console.log(`\n全部块就绪(其中 ${reused} 块是续传复用)。开始合并 ...`)

// 4. 合并
const out = openSync(outFile, 'w')
let written = 0
for (let i = 0; i < nChunks; i++) {
  const partFile = `${partDir}\\${String(i).padStart(5, '0')}.part`
  const buf = readFileSync(partFile)
  writeSync(out, buf)
  written += buf.length
}
closeSync(out)

console.log(`  合并完成: ${written} 字节 -> ${outFile}`)
if (written !== total) {
  console.error(`  !! 大小不符: 期望 ${total}`)
  process.exit(1)
}

// 5. 校验文件头
const fd = openSync(outFile, 'r')
const magic = Buffer.alloc(4)
readSync(fd, magic, 0, 4, 0)
closeSync(fd)
const ok = magic.toString('ascii') === 'GGUF'
console.log(`  文件头: ${JSON.stringify(magic.toString('ascii'))} ${ok ? '✓' : '✗'}`)

if (ok) {
  rmSync(partDir, { recursive: true, force: true })
  console.log(`  已清理分块目录。用时 ${((Date.now() - t0) / 60000).toFixed(1)} 分钟。`)
}
