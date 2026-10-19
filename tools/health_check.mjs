// 健康检测(被 Cordis 的 stove_health 工具调用)。
//
// 针对的都是**实际踩过或差点踩到**的问题:
//
//   1. "进程活着但服务不可达"。我判断错过两次,而且两次原因不同:
//        - 一次是残留的僵尸进程占着显存,新实例起不来
//        - 一次是沙箱遮蔽了连接信息,让我误以为端口没监听
//      所以检测要分开三件事:**有没有进程**、**端口通不通**、**有没有响应** ——
//      这三者可以互相矛盾,不能只看一个。
//
//   2. 日志里反复刷同一种错误。那个每分钟一次的 `unauthorized: Invalid API Key`
//      是我翻日志碰巧看到的 —— 68 行里夹在其他输出中间,很容易漏掉。
//      这里做"同一模式重复次数"统计。
//
//   3. 显存余量。之前两个 llama-server 抢 8GB 显存,生成速度从 43 t/s
//      掉到 3.5 t/s,而当时并没有任何报错。
//
// 用法:node health_check.mjs <请求文件.json> <输出文件.json>
import { readFileSync, writeFileSync, existsSync, statSync, openSync, closeSync, mkdtempSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const [, , specArg, outPath] = process.argv
if (!specArg || !outPath) {
  console.error('用法: node health_check.mjs <请求文件.json | base64:...> <输出文件.json>')
  process.exit(2)
}

/**
 * 参数既可以是文件路径,也可以是 `base64:...` 内联内容。
 * 支持内联的原因同 probe_runner:从 Cordis 插件调用时写参数文件会被沙箱拒。
 */
function loadSpec(arg) {
  if (arg.startsWith('base64:')) {
    return JSON.parse(Buffer.from(arg.slice(7), 'base64').toString('utf8'))
  }
  return JSON.parse(readFileSync(arg, 'utf8'))
}

const spec = loadSpec(specArg)
const write = (obj) => writeFileSync(outPath, JSON.stringify(obj, null, 2), 'utf8')

const workDir = mkdtempSync(join(tmpdir(), 'stove-health-'))

/**
 * 跑一个命令并把输出写进文件。
 *
 * **不能用 execFile/execSync**:它们的 stdout 是管道,而沙箱禁止命名管道,
 * 会直接报 `spawn EPERM`(实测踩到 —— 一开始进程检测和 nvidia-smi 全因此失败)。
 * 用文件描述符接 stdio 就没这个问题,这也是本仓库其它脚本一贯的做法。
 */
function runToFile(cmd, args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const out = join(workDir, `${cmd}-${Date.now()}-${Math.random().toString(36).slice(2)}.out`)
    let fd
    try {
      fd = openSync(out, 'w')
    } catch (e) {
      resolve({ error: `无法创建临时文件: ${e.message}` })
      return
    }
    let child
    const done = (err, code) => {
      try { closeSync(fd) } catch { /* 已关 */ }
      let stdout = ''
      try { stdout = readFileSync(out, 'utf8') } catch { /* 读不到就算了 */ }
      resolve({ error: err ? (err.code || err.message) : null, code, stdout })
    }
    try {
      child = spawn(cmd, args, { stdio: ['ignore', fd, 'ignore'], windowsHide: true })
    } catch (e) {
      done(e, null)
      return
    }
    const t = setTimeout(() => { try { child.kill() } catch { /* 已退出 */ } ; done(new Error('超时'), null) }, timeoutMs)
    child.on('error', (err) => { clearTimeout(t); done(err, null) })
    child.on('close', (code) => { clearTimeout(t); done(null, code) })
  })
}

const checks = []
function add(name, status, detail) {
  // status: 'ok' | 'warn' | 'fail'
  checks.push({ name, status, detail })
}

// ─────────────────────────────────────────────── 1. llama-server
const serverUrl = spec.serverUrl || 'http://127.0.0.1:8091'

function parsePort(u) {
  try {
    const x = new URL(u)
    return { host: x.hostname, port: Number(x.port || (x.protocol === 'https:' ? 443 : 80)) }
  } catch {
    return { host: '127.0.0.1', port: 8091 }
  }
}
const target = parsePort(serverUrl)

/**
 * 1a. 端口监听状态 —— 用 netstat,不用进程枚举。
 *
 * 为什么换掉 tasklist:在这个沙箱里 **tasklist 一律 Access denied**
 * (`cmd /c`、`Start-Process` 也一并被拒),但 `netstat -ano` 能正常跑。
 * 而且"端口有人在听"本身就是进程存在的可靠证据,比进程名匹配还准 ——
 * 它连 PID 一起给了,还能顺手看出是否有多个 PID 抢同一个端口。
 *
 * 这个区分很重要:我之前因为 tasklist 看不到进程,误判过服务已经卡死,
 * 实际它一直正常响应。教训是**不能把"看不见"当成"不存在"**。
 */
let listenPids = []
let established = 0
const ns = await runToFile('netstat', ['-ano'])
if (ns.error) {
  add('端口监听', 'warn', `netstat 查询失败(${ns.error}) —— 无法判断监听状态`)
} else {
  const lines = ns.stdout.split(/\r?\n/)
  const needle = ':' + target.port
  for (const l of lines) {
    if (!l.includes(needle)) continue
    const cols = l.trim().split(/\s+/)
    // 形如: TCP  0.0.0.0:8091  0.0.0.0:0  LISTENING  35224
    if (cols.length >= 5 && cols[3] === 'LISTENING') {
      const local = cols[1]
      if (local.endsWith(needle)) {
        const pid = Number(cols[4])
        if (!listenPids.includes(pid)) listenPids.push(pid)
      }
    } else if (cols.length >= 5 && cols[3] === 'ESTABLISHED') {
      established++
    }
  }
  if (listenPids.length === 0) {
    add('端口监听', 'warn', `没有人监听 ${target.port} —— 服务应当没在运行`)
  } else if (listenPids.length === 1) {
    add('端口监听', 'ok', `${target.port} 正在监听,PID ${listenPids[0]}`)
  } else {
    // 多个 PID 抢同一端口几乎不可能,但真出现就说明有异常(例如 SO_REUSEADDR 下的多实例)
    add('端口监听', 'warn', `${target.port} 有多个 PID 在监听: ${listenPids.join(', ')}`)
  }
  if (established > 0) {
    add('活跃连接', 'ok', `当前有 ${established} 条已建立连接`)
  }
}

// 1b. 服务是否响应 —— 以真实响应为准
let serverOk = false
let serverInfo = null
try {
  const t0 = Date.now()
  const r = await fetch(`${serverUrl}/health`, { signal: AbortSignal.timeout(6000) })
  const body = await r.text()
  const ms = Date.now() - t0
  if (r.status === 200) {
    serverOk = true
    add('服务响应', 'ok', `HTTP 200,${ms}ms,${body.slice(0, 60)}`)
  } else {
    add('服务响应', 'fail', `HTTP ${r.status}: ${body.slice(0, 80)}`)
  }
} catch (e) {
  const cause = e?.cause ? (e.cause.code || e.cause.message) : e.message
  add('服务响应', 'fail', `连不上 ${serverUrl}: ${cause}`)
}

// 1c. 监听与响应是否自相矛盾 —— 这类矛盾最值得报出来
if (listenPids.length > 0 && !serverOk) {
  add('监听/响应一致性', 'fail',
    `端口在监听(PID ${listenPids.join(', ')})但 HTTP 不响应 —— 服务可能已卡死,建议重启`)
} else if (listenPids.length === 0 && serverOk) {
  add('监听/响应一致性', 'warn',
    '服务在响应但 netstat 没看到监听项 —— 罕见情况,以响应为准')
}

// 1d. 读出上下文与槽位
//
// 注意 /props 是**需要鉴权**的(与 /health 不同)。漏带 Key 会拿不到 n_ctx,
// 而 n_ctx 是判断压缩阈值的基础,所以这里单独处理鉴权失败的情况。
if (serverOk) {
  const key = typeof spec.apiKey === 'string' ? spec.apiKey.trim() : ''
  const authHeaders = key ? { Authorization: `Bearer ${key}` } : {}
  // 把"到底带没带 Key"如实反映出来 —— 之前这里报 401 而我以为是服务问题,
  // 实际是参数没传进来,白查一轮。
  add('鉴权参数', key ? 'ok' : 'warn',
    key ? `已收到 API Key(${key.length} 字符)` : '没有收到 API Key,无法读 /props')
  try {
    const r = await fetch(`${serverUrl}/props`, { headers: authHeaders, signal: AbortSignal.timeout(8000) })
    if (r.status === 401 || r.status === 403) {
      add('运行配置', 'warn', `/props 返回 HTTP ${r.status}${key ? '(已带 Key,可能 Key 不对)' : '(未带 Key)'}`)
    } else {
      const j = await r.json()
      const nCtx = j?.default_generation_settings?.n_ctx
      const slots = j?.total_slots ?? j?.default_generation_settings?.n_slots ?? null
      serverInfo = { nCtx, slots, isSleeping: j?.is_sleeping }
      const parts = []
      if (nCtx != null) parts.push(`上下文 ${nCtx}`)
      if (slots != null) parts.push(`槽位 ${slots}`)
      if (j?.is_sleeping) parts.push('模型已休眠')
      add('运行配置', parts.length ? 'ok' : 'warn',
        parts.length ? parts.join(',') : '/props 里没找到 n_ctx / total_slots 字段')
    }
  } catch (e) {
    add('运行配置', 'warn', `读 /props 失败: ${e.message}`)
  }
}

// ─────────────────────────────────────────────── 2. 显存
const smi = await runToFile('nvidia-smi', ['--query-gpu=memory.total,memory.used,memory.free', '--format=csv,noheader,nounits'])
if (smi.error) {
  add('显存余量', 'warn', `nvidia-smi 查询失败(${smi.error})`)
} else {
  const line = smi.stdout.trim().split('\n')[0] || ''
  const [total, used, free] = line.split(',').map((x) => Number(x.trim()))
  if (!Number.isFinite(total)) {
    add('显存余量', 'warn', `nvidia-smi 输出无法解析: ${line.slice(0, 80)}`)
  } else {
    const freePct = free / total
    const detail = `已用 ${used} MiB / 共 ${total} MiB,余 ${free} MiB`
    if (freePct < 0.05) add('显存余量', 'fail', detail + ' —— 几乎没余量,推理会溢出到内存而极慢')
    else if (freePct < 0.15) add('显存余量', 'warn', detail + ' —— 余量偏低')
    else add('显存余量', 'ok', detail)
  }
}

// ─────────────────────────────────────────────── 3. 压缩代理
if (spec.proxyUrl) {
  try {
    const r = await fetch(`${spec.proxyUrl}/_bridge/status`, { signal: AbortSignal.timeout(6000) })
    const j = await r.json()
    add('压缩代理', 'ok',
      `${spec.proxyUrl} 在线,档位 ${j?.profile?.current ?? '?'},压缩${j?.compression?.enabled ? '开' : '关'},已压缩 ${j?.stats?.compressCount ?? 0} 次`)
  } catch (e) {
    const cause = e?.cause ? (e.cause.code || e.cause.message) : e.message
    add('压缩代理', 'warn', `${spec.proxyUrl} 不可达(${cause}) —— 档位与自动压缩不可用,手机需直连 8091`)
  }
}

// ─────────────────────────────────────────────── 4. 日志异常聚集
if (spec.logPath && existsSync(spec.logPath)) {
  try {
    const text = readFileSync(spec.logPath, 'utf8')
    const lines = text.split(/\r?\n/)
    const tailN = spec.tailLines || 600
    const slice = lines.slice(Math.max(0, lines.length - tailN))

    // 4a. 明确是错误/警告的行
    const errLines = slice.filter((l) => /\b(error|unauthorized|failed|exception|invalid api key)\b/i.test(l))
    if (!errLines.length) {
      add('日志错误', 'ok', `最近 ${slice.length} 行没有错误关键字`)
    } else {
      // 4b. 同一"形状"重复多少次 —— 把数字/时间戳抹掉后再比,否则每行都不同
      const shape = (l) => l.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 90)
      const counts = new Map()
      for (const l of errLines) {
        const s = shape(l)
        counts.set(s, (counts.get(s) || 0) + 1)
      }
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1])
      const [shapeStr, n] = top[0]
      if (n >= 3) {
        add('日志错误', 'warn',
          `最近 ${slice.length} 行里有 ${errLines.length} 条错误,其中同一种重复 ${n} 次: ${shapeStr}`)
      } else {
        add('日志错误', 'warn', `最近 ${slice.length} 行里有 ${errLines.length} 条错误: ${errLines[0].slice(0, 100)}`)
      }
    }

    // 4c. 生成速度 —— 掉速是显存不足最先表现出来的信号
    const tgs = [...text.matchAll(/tg\s*=\s*([\d.]+)\s*t\/s/g)].map((m) => Number(m[1]))
    if (tgs.length >= 3) {
      const recent = tgs.slice(-5)
      const avg = recent.reduce((a, b) => a + b, 0) / recent.length
      add('生成速度', avg < 10 ? 'warn' : 'ok',
        `最近 5 次记录平均 ${avg.toFixed(1)} t/s${avg < 10 ? ' —— 明显低于正常值(30-40),检查是否显存争抢' : ''}`)
    }

    add('日志文件', 'ok', `${spec.logPath}(${(statSync(spec.logPath).size / 1024).toFixed(0)} KB,扫描末尾 ${slice.length} 行)`)
  } catch (e) {
    add('日志错误', 'warn', `读日志失败: ${e.message}`)
  }
} else if (spec.logPath) {
  add('日志文件', 'warn', `文件不存在: ${spec.logPath}`)
}

// ─────────────────────────────────────────────── 汇总
const fails = checks.filter((c) => c.status === 'fail')
const warns = checks.filter((c) => c.status === 'warn')
const overall = fails.length ? 'fail' : (warns.length ? 'warn' : 'ok')

write({
  overall,
  summary: `${checks.length} 项检查:${checks.filter((c) => c.status === 'ok').length} 正常,${warns.length} 警告,${fails.length} 失败`,
  checks,
})

// 清理临时目录(结果已经写进 outPath,这里的东西没用了)
try { rmSync(workDir, { recursive: true, force: true }) } catch { /* 清不掉也不影响 */ }
