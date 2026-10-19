// 通过 GitHub 的 git smart 协议推送,完全绕开 git 的 HTTPS 传输。
//
// 为什么不直接 `git push`:这台机器上 git 与 PowerShell 都走 schannel,
// 向 GitHub 发 HTTPS 一律报 `schannel: AcquireCredentialsHandle failed:
// SEC_E_NO_CREDENTIALS (0x8009030e)`。而 Node 自带 OpenSSL,不碰 schannel,
// 实测 fetch 到 api.github.com 与 github.com 都是 200。
//
// 做法:
//   1. git pack-objects 从源仓库打出 pack(对象按普通文件写)
//   2. 按 receive-pack 协议拼一个 pkt-line 请求体:
//         <len><old-sha> <new-sha> <ref>\0<caps>
//         0000
//         <PACK 二进制>
//   3. Node fetch POST 到 /git-receive-pack,解析 report-status 回包
//
// pkt-line 的长度是 **4 位十六进制,含这 4 字节自身**。
// token 从 GH_TOKEN 环境变量读(不用管道问 credential-manager —— 沙箱禁止命名管道)。
import { spawn } from 'node:child_process'
import { openSync, closeSync, mkdirSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const OWNER = '1iuTL'
const REPO = 'model-stove'
const BRANCH = process.argv[2] || 'main'
const SRC = process.argv[3] || 'C:\\deepseek harness\\model-stove'
const TMP = `${SRC}\\.push-tmp`

const token = process.env.GH_TOKEN
if (!token) { console.error('缺少 GH_TOKEN 环境变量'); process.exit(2) }

mkdirSync(TMP, { recursive: true })

/** 跑命令,stdin/stdout/stderr 用文件描述符(不用管道)。 */
function run(argv, { cwd, stdinFile, stdoutFile, stderrFile } = {}) {
  return new Promise((resolve, reject) => {
    const fds = []
    const pick = (file, mode, fallback) => {
      if (!file) return fallback
      const fd = openSync(file, mode)
      fds.push(fd)
      return fd
    }
    const opts = {
      cwd,
      stdio: [
        pick(stdinFile, 'r', 'ignore'),
        pick(stdoutFile, 'w', 'ignore'),
        pick(stderrFile, 'w', 'ignore'),
      ],
    }
    const p = spawn(argv[0], argv.slice(1), opts)
    p.on('error', (e) => { fds.forEach((f) => { try { closeSync(f) } catch {} }); reject(e) })
    p.on('close', (code) => {
      fds.forEach((f) => { try { closeSync(f) } catch {} })
      resolve(code ?? 0)
    })
  })
}

async function capture(argv, cwd, tag) {
  const out = `${TMP}\\${tag}.out`
  const err = `${TMP}\\${tag}.err`
  const code = await run(argv, { cwd, stdoutFile: out, stderrFile: err })
  return { code, stdout: readFileSync(out, 'utf8'), stderr: readFileSync(err, 'utf8') }
}

// ---------------------------------------------------------------- pkt-line

/** 组装一个 pkt-line 帧。长度必须包含那 4 个长度字节自身。 */
function pktLine(payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8')
  const len = body.length + 4
  if (len > 0xffff) throw new Error('pkt-line 超过 65519 字节')
  const header = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii')
  return Buffer.concat([header, body])
}
const FLUSH = Buffer.from('0000', 'ascii')

/**
 * 解析回包里的 pkt-line,返回文本行。
 *
 * 协商 side-band-64k 后是**两层**分帧,这点很反直觉:
 *
 *   0013                       <- 外层长度
 *     01                       <- side-band 通道字节(1=状态, 2=进度, 3=致命)
 *       000e                   <- 内层长度,又一层 pkt-line!
 *         unpack ok\n
 *
 * 只剥通道字节会留下内层长度头,得到 "000eunpack ok" 这种字符串,
 * 于是 `unpack ok` 判定永远匹配不上(踩过 —— 明明推成功却报失败)。
 */
function parsePktLines(buf) {
  const lines = []
  let i = 0
  while (i + 4 <= buf.length) {
    const len = parseInt(buf.slice(i, i + 4).toString('ascii'), 16)
    if (Number.isNaN(len)) break
    if (len === 0) { i += 4; continue }
    if (len < 4 || i + len > buf.length) break

    let payload = buf.slice(i + 4, i + len)
    i += len

    // 第一层:side-band 通道字节
    if (payload.length > 0 && payload[0] >= 1 && payload[0] <= 3) {
      payload = payload.slice(1)
      // 第二层:内层 pkt-line 长度头。进度帧和内层长度头不一定同时存在,
      // 所以先判断这 4 个字符是不是合法十六进制长度。
      if (payload.length >= 4) {
        const innerHex = payload.slice(0, 4).toString('ascii')
        const innerLen = parseInt(innerHex, 16)
        if (/^[0-9a-f]{4}$/i.test(innerHex) && !Number.isNaN(innerLen) && innerLen >= 4 && innerLen <= payload.length + 4) {
          payload = payload.slice(4)
        }
      }
    }
    lines.push(payload.toString('utf8'))
  }
  return lines
}

// ---------------------------------------------------------------- 1. pack

const head = (await capture(['git', 'rev-parse', 'HEAD'], SRC, 'head')).stdout.trim()
console.log(`源 HEAD: ${head.slice(0, 7)}`)

// 用 GitHub API 先问远程 ref,决定是否需要干净的全量推送
async function api(path) {
  const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'model-stove-push',
    },
  })
  const text = await r.text()
  let body = null
  try { body = JSON.parse(text) } catch { body = text }
  return { status: r.status, body }
}

const refInfo = await api(`/git/ref/heads/${BRANCH}`)
const oldSha = refInfo.status === 200 ? refInfo.body.object.sha : '0'.repeat(40)
console.log(`远程 ${BRANCH}: ${oldSha === '0'.repeat(40) ? '(不存在,将创建)' : oldSha.slice(0, 7)}`)

if (oldSha === head) {
  console.log('远程已是最新,无需推送。')
  rmSync(TMP, { recursive: true, force: true })
  process.exit(0)
}

console.log('打包中 ...')
const packPrefix = `${TMP}\\pack`
const packPath = `${TMP}\\push.pack`
{
  // pack-objects 把 pack 写到 <prefix>-<hash>.pack,并把文件名打到 stdout
  const nameOut = await capture(
    ['git', 'pack-objects', packPrefix, '--all', '--revs'],
    SRC,
    'packname',
  )
  const name = nameOut.stdout.trim()
  if (!name) {
    console.error('pack-objects 没有输出文件名,stderr:', nameOut.stderr.slice(0, 400))
    process.exit(1)
  }
  const built = `${packPrefix}-${name}.pack`
  const size = statSync(built).size
  console.log(`pack: ${name}  ${(size / 1024).toFixed(1)} KB`)
  writeFileSync(packPath, readFileSync(built))
}

// ---------------------------------------------------------------- 2. 请求体

const caps = 'report-status side-band-64k object-format=sha1 agent=model-stove'
const command = `${oldSha} ${head} refs/heads/${BRANCH}\0 ${caps}\n`
const body = Buffer.concat([
  pktLine(command),
  FLUSH,
  readFileSync(packPath),
])

console.log(`请求体: ${(body.length / 1024).toFixed(1)} KB`)

// ---------------------------------------------------------------- 3. 上传

/**
 * 带重试的 POST。
 *
 * 国内直连 github.com:443 经常第一次握手就超时(undici 默认 10 秒),
 * 但重试往往就通了 —— 手动重跑整个脚本既慢又容易误判成败,所以内置重试。
 * 只重试**连接层**错误;HTTP 状态码返回什么就是什么,那是服务端的回答。
 */
async function postWithRetry(url, init, attempts = 4) {
  let lastErr = null
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fetch(url, init)
    } catch (e) {
      lastErr = e
      const cause = e && e.cause ? (e.cause.code || e.cause.message) : e.message
      console.log(`  第 ${i}/${attempts} 次失败: ${cause}`)
      if (i < attempts) {
        const waitMs = 2000 * i
        console.log(`  ${waitMs / 1000} 秒后重试 ...`)
        await sleep(waitMs)
      }
    }
  }
  throw lastErr
}

console.log('上传中 ...')
const url = `https://github.com/${OWNER}/${REPO}.git/git-receive-pack`
const auth = Buffer.from(`${OWNER}:${token}`, 'utf8').toString('base64')

const res = await postWithRetry(url, {
  method: 'POST',
  headers: {
    Authorization: `Basic ${auth}`,
    'Content-Type': 'application/x-git-receive-pack-request',
    Accept: 'application/x-git-receive-pack-result',
    'Content-Length': String(body.length),
    'User-Agent': 'git/2.55.0',
  },
  body,
})

console.log(`HTTP ${res.status} ${res.headers.get('content-type') || ''}`)
const resBuf = Buffer.from(await res.arrayBuffer())
const lines = parsePktLines(resBuf)
if (lines.length) {
  console.log('--- 服务端回包 ---')
  lines.forEach((l) => console.log('  ' + l.replace(/\n$/, '')))
} else {
  console.log('--- 原始回包(前 600 字节)---')
  console.log(resBuf.slice(0, 600).toString('utf8'))
}

// 判定成功与否。
//
// 不靠解析 receive-pack 回包 —— 它掺着 side-band 的进度输出,格式因服务端
// 而异,据它下结论容易误报(踩过:明明推成功了却报失败)。真正的权威信号是
// 推送后远程 ref 指到了哪里,所以下面直接用 API 核实。
const statusLine = lines.find((l) => l.startsWith('unpack ')) || ''
const refLine = lines.find((l) => /refs\/heads\//.test(l)) || ''
const unpackOk = /unpack ok/.test(statusLine.replace(/\n$/, ''))
const refRejected = /(^|\s)ng\s/.test(refLine)
const reported = res.status === 200 && unpackOk && !refRejected

console.log('--- 判定 ---')
console.log(`  HTTP ${res.status}   unpack: ${unpackOk ? 'ok' : (statusLine.trim() || '(未回报)')}   ref: ${refLine.trim() || '(未回报)'}`)

const after = await api(`/git/ref/heads/${BRANCH}`)
const now = after.status === 200 ? after.body.object.sha : null
const landed = now === head

if (landed) {
  console.log(`\n推送成功。远程 ${BRANCH} = ${now.slice(0, 7)}  (与本地 HEAD 一致)`)
} else if (reported) {
  console.log(`\n回包说成功,但远程 ${BRANCH} 仍是 ${now ? now.slice(0, 7) : '(不存在)'}。请稍后重查。`)
} else {
  console.log(`\n推送失败。远程 ${BRANCH} = ${now ? now.slice(0, 7) : '(不存在)'}`)
}

rmSync(TMP, { recursive: true, force: true })
process.exit(landed ? 0 : 1)
