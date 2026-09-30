// 决定性验证:用 PrismML **官方**预编译二进制跑三值模型,看是否还塌缩。
//
// 背景:Bonsai-demo README 说明 Bonsai 2(Ternary)需要 Hadamard 变换,
// 只在官方 fork 里;而且"每个版本只兼容特定 fork"。用户当前的三值模型
// 用的是社区 sudoingX fork 的构建(pr-ptq1-mmv),不是官方 fork ——
// 这很可能就是塌缩的真正原因,而不是模型本身有问题。
//
// 本脚本对同一批模型分别用官方构建与社区构建跑,直接对比。
import { spawn } from 'node:child_process'
import { openSync, closeSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const SRC = 'C:\\deepseek harness\\model-stove'
const TMP = `${SRC}\\.fork-compare`
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

const PORT = 8099
const PROMPT = '解释反射定律'
const TRIALS = 2

// 两个构建 × 两个三值模型
const BUILDS = [
  {
    label: 'PrismML 官方',
    bin: 'C:\\deepseek harness\\models\\llama-prism\\llama-server.exe',
  },
  {
    label: '社区 sudoingX',
    bin: 'C:\\deepseek harness\\llama-cpp-mmq\\build\\bin\\llama-server.exe',
  },
]
const MODELS = [
  { label: 'PTQ1_0', file: 'F:\\models-archive\\Ternary-Bonsai-2-27B-PTQ1_0.gguf' },
  { label: 'Heretic', file: 'D:\\Ternary-Bonsai-2-27B-Heretic-PTQ1_0.gguf' },
]

function analyse(text) {
  const chars = [...(text || '')]
  let run = 0, longest = 0
  for (const c of chars) {
    if (c === '/' || c === '\\') { run++; if (run > longest) longest = run }
    else run = 0
  }
  return { len: chars.length, longest }
}

async function startServer(bin, file, tag) {
  const args = [
    '-m', file, '-c', '32768', '-ngl', '99', '-fa', 'on', '-np', '1',
    '-ctk', 'q4_0', '-ctv', 'q4_0', '--jinja',
    '--temp', '0.7', '--top-p', '0.95', '--top-k', '20',
    '--host', '127.0.0.1', '--port', String(PORT), '--no-slots',
  ]
  const log = `${TMP}\\${tag}.log`
  const out = openSync(log, 'w')
  const child = spawn(bin, args, { stdio: ['ignore', out, out], detached: false, windowsHide: true })
  closeSync(out)
  for (let i = 0; i < 200; i++) {
    await sleep(1000)
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`)
      if (r.status === 200) return { child, log }
    } catch { /* 还没起来 */ }
  }
  // 起不来时把日志末尾带出来 —— "拒绝加载"本身也是结论
  child.kill()
  const { readFileSync } = await import('node:fs')
  const tail = readFileSync(log, 'utf8').split('\n').slice(-6).join('\n')
  throw new Error(`未就绪。日志末尾:\n${tail}`)
}

const summary = []
for (const b of BUILDS) {
  for (const m of MODELS) {
    const tag = `${b.label}-${m.label}`.replace(/[^a-z0-9\u4e00-\u9fa5]/gi, '_')
    console.log(`\n${'='.repeat(70)}`)
    console.log(`${b.label}  ×  ${m.label}`)
    console.log('='.repeat(70))
    let child = null
    const rows = []
    try {
      const s = await startServer(b.bin, m.file, tag)
      child = s.child
      for (let t = 1; t <= TRIALS; t++) {
        try {
          const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: 'local', messages: [{ role: 'user', content: PROMPT }],
              max_tokens: 800, stream: false,
            }),
          })
          const j = await res.json()
          const msg = j.choices?.[0]?.message || {}
          const r = analyse(msg.reasoning_content)
          const c = analyse(msg.content)
          const longest = Math.max(r.longest, c.longest)
          const ok = (msg.content || '').trim().length > 0 && longest < 50
          rows.push(ok)
          console.log(`  #${t}: completion=${String(j.usage?.completion_tokens ?? '?').padStart(4)}  ` +
            `reasoning ${String(r.len).padStart(4)}字  content ${String(c.len).padStart(4)}字  ` +
            `最长连续 ${String(longest).padStart(4)}  ${ok ? '✓正常' : '✗塌缩'}`)
          console.log(`       content 开头: ${JSON.stringify((msg.content || '(空)').slice(0, 80))}`)
          writeFileSync(`${TMP}\\${tag}-${t}.txt`,
            `reasoning:\n${msg.reasoning_content || ''}\n\ncontent:\n${msg.content || ''}\n`, 'utf8')
        } catch (e) {
          console.log(`  #${t}: 请求失败 ${e.message}`)
          rows.push(false)
        }
        await sleep(300)
      }
    } catch (e) {
      console.log(`  ✗ 启动失败: ${e.message}`)
    } finally {
      if (child) { try { child.kill() } catch {} }
      await sleep(4500)
    }
    summary.push({ build: b.label, model: m.label, total: rows.length, ok: rows.filter(Boolean).length })
  }
}

console.log(`\n${'='.repeat(70)}`)
console.log('汇总')
console.log('='.repeat(70))
console.log('构建'.padEnd(18) + '模型'.padEnd(12) + '成功/总')
for (const s of summary) {
  console.log(s.build.padEnd(18) + s.model.padEnd(12) + `${s.ok}/${s.total}`)
}
console.log(`\n原文留在 ${TMP}`)
