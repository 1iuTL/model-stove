// Q2 实测:速度 + 质量,与用户现有的 PTQ1_0、Q1_0 对比。
//
// 为什么必须实测而不能只看官方分数:用户手上的 PTQ1_0 是 5.54 GB 的社区版,
// 而官方那个 5.9 GB "Ternary" 分数并不直接对应它。要回答"Q2 比 Q1 强多少",
// 得在同一台机器、同一套参数下量。
//
// 全部用 PrismML 官方构建(前一轮已证明三值模型必须用它)。
import { spawn } from 'node:child_process'
import { openSync, closeSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const SRC = 'C:\\deepseek harness\\model-stove'
const TMP = `${SRC}\\.q2-compare`
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

const PRISM = 'C:\\deepseek harness\\models\\llama-prism\\llama-server.exe'
const BENCH = 'C:\\deepseek harness\\models\\llama-prism\\llama-bench.exe'
const PORT = 8099

// 注意:必须用 PQ2_0,不能用同为"Q2"的 Q2_0。
// PrismML 官方构建读的是新版 group-64 布局,而 prism-ml/Ternary-Bonsai-27B-gguf
// (上一世代)里的 Q2_0 是 legacy group-128(id 42),会直接拒绝加载并提示改用 PQ2_0。
// 这正是"每个 gguf 只兼容特定 fork"那条规则。
const Q2_PATH = 'C:\\deepseek harness\\_pq2_0.gguf'

const MODELS = [
  { name: 'Q1_0 1-bit', file: 'F:\\models-archive\\Bonsai-27B-Q1_0.gguf', bin: 'C:\\deepseek harness\\models\\llama-cpp\\llama-server.exe', benchBin: 'C:\\deepseek harness\\models\\llama-cpp\\llama-bench.exe' },
  { name: 'PTQ1_0 三值(现有)', file: 'F:\\models-archive\\Ternary-Bonsai-2-27B-PTQ1_0.gguf', bin: PRISM, benchBin: BENCH },
  { name: 'PQ2_0 三值(新下)', file: Q2_PATH, bin: PRISM, benchBin: BENCH },
]

// 评测用问题:难度递增,覆盖简单事实、解释、推理
const PROMPTS = [
  '1+1等于几',
  '用一句话解释反射定律',
  '一个篮子里有5个苹果,拿走2个,又放进3个,现在有几个?',
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

/** llama-bench:量预填充与生成速度。 */
function runBench(benchBin, file, tag) {
  return new Promise((resolve) => {
    const out = `${TMP}\\bench-${tag}.txt`
    const fd = openSync(out, 'w')
    const args = ['-m', file, '-ngl', '99', '-fa', '1', '-p', '512', '-n', '128', '-r', '3']
    const p = spawn(benchBin, args, { stdio: ['ignore', fd, fd], windowsHide: true })
    p.on('error', () => { closeSync(fd); resolve(null) })
    p.on('close', () => {
      closeSync(fd)
      try { resolve(readFileSync(out, 'utf8')) } catch { resolve(null) }
    })
  })
}

async function startServer(bin, file, tag) {
  const args = [
    '-m', file, '-c', '32768', '-ngl', '99', '-fa', 'on', '-np', '1',
    '-ctk', 'q4_0', '-ctv', 'q4_0', '--jinja',
    '--temp', '0.7', '--top-p', '0.95', '--top-k', '20',
    '--host', '127.0.0.1', '--port', String(PORT), '--no-slots',
    '--reasoning-budget', '32768',
  ]
  const log = `${TMP}\\srv-${tag}.log`
  const out = openSync(log, 'w')
  const child = spawn(bin, args, { stdio: ['ignore', out, out], windowsHide: true })
  closeSync(out)
  for (let i = 0; i < 200; i++) {
    await sleep(1000)
    try { const r = await fetch(`http://127.0.0.1:${PORT}/health`); if (r.status === 200) return { child, log } } catch {}
  }
  child.kill()
  throw new Error(`未就绪:\n${readFileSync(log, 'utf8').split('\n').slice(-5).join('\n')}`)
}

console.log('Q2 vs 现有模型 实测\n')

const speed = []
const quality = []

for (const m of MODELS) {
  const tag = m.name.replace(/[^a-z0-9]/gi, '_')
  console.log('='.repeat(74))
  console.log(m.name)
  console.log('='.repeat(74))

  if (!existsSync(m.file)) {
    console.log(`  ✗ 文件不存在: ${m.file}`)
    continue
  }

  // ---- 速度 ----
  console.log('  测速(llama-bench,pp512 / tg128)...')
  const benchOut = await runBench(m.benchBin, m.file, tag)
  if (benchOut) {
    const pp = benchOut.match(/\|\s*pp512\s*\|\s*([\d.]+)\s*±/)
    const tg = benchOut.match(/\|\s*tg128\s*\|\s*([\d.]+)\s*±/)
    const ppv = pp ? Number(pp[1]) : null
    const tgv = tg ? Number(tg[1]) : null
    console.log(`    预填充 ${ppv ?? '?'} t/s    生成 ${tgv ?? '?'} t/s`)
    speed.push({ name: m.name, pp: ppv, tg: tgv })
  } else {
    console.log('    测速失败')
    speed.push({ name: m.name, pp: null, tg: null })
  }

  // ---- 质量 ----
  let child = null
  try {
    const s = await startServer(m.bin, m.file, tag)
    child = s.child
    for (const prompt of PROMPTS) {
      const t0 = Date.now()
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'local', messages: [{ role: 'user', content: prompt }],
            max_tokens: 900, stream: false,
          }),
        })
        const j = await res.json()
        const msg = j.choices?.[0]?.message || {}
        const r = analyse(msg.reasoning_content)
        const c = analyse(msg.content)
        const longest = Math.max(r.longest, c.longest)
        const ok = (msg.content || '').trim().length > 0 && longest < 50
        const secs = ((Date.now() - t0) / 1000).toFixed(1)
        quality.push({ model: m.name, prompt, ok, chars: c.len, think: r.len, longest, secs })
        console.log(`    "${prompt.slice(0, 16)}…" ${ok ? '✓' : '✗'}  ` +
          `思考 ${String(r.len).padStart(4)}字 回答 ${String(c.len).padStart(4)}字 ` +
          `最长重复 ${String(longest).padStart(3)} ${secs}s`)
        console.log(`        ${JSON.stringify((msg.content || '(空)').slice(0, 100))}`)
      } catch (e) {
        console.log(`    "${prompt.slice(0, 16)}…" 请求失败: ${e.message}`)
        quality.push({ model: m.name, prompt, ok: false, error: e.message })
      }
      await sleep(300)
    }
  } catch (e) {
    console.log(`  ✗ 启动失败: ${e.message}`)
  } finally {
    if (child) { try { child.kill() } catch {} }
    await sleep(4500)
  }
  console.log('')
}

// ---- 汇总 ----
console.log('='.repeat(74))
console.log('速度汇总')
console.log('='.repeat(74))
console.log('模型'.padEnd(24) + '预填充 t/s   生成 t/s')
for (const s of speed) {
  console.log(s.name.padEnd(24) + String(s.pp ?? '?').padStart(8) + String(s.tg ?? '?').padStart(12))
}

console.log(`\n${'='.repeat(74)}`)
console.log('质量汇总')
console.log('='.repeat(74))
const byModel = new Map()
for (const q of quality) {
  if (!byModel.has(q.model)) byModel.set(q.model, [])
  byModel.get(q.model).push(q)
}
console.log('模型'.padEnd(24) + '成功/总   平均回答字数   平均最长重复')
for (const [name, rows] of byModel) {
  const ok = rows.filter((r) => r.ok).length
  const avgChars = Math.round(rows.reduce((a, r) => a + (r.chars || 0), 0) / rows.length)
  const avgRep = Math.round(rows.reduce((a, r) => a + (r.longest || 0), 0) / rows.length)
  console.log(name.padEnd(24) + `${ok}/${rows.length}`.padStart(8) + String(avgChars).padStart(14) + String(avgRep).padStart(14))
}

console.log(`\n原始输出留在 ${TMP}`)
