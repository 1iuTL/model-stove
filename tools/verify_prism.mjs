// 收尾验证:三个三值模型在**官方 prism 构建**下是否都正常。
// 其中 Abliterated 是唯一还没测过的。
import { spawn } from 'node:child_process'
import { openSync, closeSync, mkdirSync, rmSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const SRC = 'C:\\deepseek harness\\model-stove'
const TMP = `${SRC}\\.verify-final`
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

const PORT = 8099
const PROMPT = '解释反射定律'
const BIN = 'C:\\deepseek harness\\models\\llama-prism\\llama-server.exe'

const MODELS = [
  { name: '三元版', file: 'F:\\models-archive\\Ternary-Bonsai-2-27B-PTQ1_0.gguf' },
  { name: 'Heretic', file: 'D:\\Ternary-Bonsai-2-27B-Heretic-PTQ1_0.gguf' },
  { name: 'Abliterated', file: 'F:\\models-archive\\Ternary-Bonsai-2-27B-Abliterated-PTQ1_0.gguf' },
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

console.log('二进制: PrismML 官方 (llama-prism)')
console.log(`问题: ${PROMPT}\n`)

for (const m of MODELS) {
  const args = [
    '-m', m.file, '-c', '32768', '-ngl', '99', '-fa', 'on', '-np', '1',
    '-ctk', 'q4_0', '-ctv', 'q4_0', '--jinja',
    '--temp', '0.7', '--top-p', '0.95', '--top-k', '20',
    '--host', '127.0.0.1', '--port', String(PORT), '--no-slots',
    '--reasoning-budget', '32768',
  ]
  const out = openSync(`${TMP}\\${m.name}.log`, 'w')
  const child = spawn(BIN, args, { stdio: ['ignore', out, out], detached: false, windowsHide: true })
  closeSync(out)
  let up = false
  for (let i = 0; i < 200; i++) {
    await sleep(1000)
    try { const r = await fetch(`http://127.0.0.1:${PORT}/health`); if (r.status === 200) { up = true; break } } catch {}
  }
  if (!up) {
    console.log(`  ${m.name.padEnd(12)} ✗ 未能就绪`)
    try { child.kill() } catch {}
    await sleep(4000)
    continue
  }
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'local', messages: [{ role: 'user', content: PROMPT }],
        max_tokens: 900, stream: false,
      }),
    })
    const j = await res.json()
    const msg = j.choices?.[0]?.message || {}
    const r = analyse(msg.reasoning_content)
    const c = analyse(msg.content)
    const longest = Math.max(r.longest, c.longest)
    const ok = (msg.content || '').trim().length > 0 && longest < 50
    console.log(`  ${m.name.padEnd(12)} completion=${String(j.usage?.completion_tokens ?? '?').padStart(4)}  ` +
      `reasoning ${String(r.len).padStart(4)}字  content ${String(c.len).padStart(4)}字  ` +
      `最长连续 ${String(longest).padStart(3)}  ${ok ? '✓正常' : '✗塌缩'}`)
    console.log(`      ${JSON.stringify((msg.content || '(空)').slice(0, 90))}`)
  } catch (e) {
    console.log(`  ${m.name.padEnd(12)} 请求失败: ${e.message}`)
  }
  try { child.kill() } catch {}
  await sleep(4500)
}
console.log('\n完成。')
