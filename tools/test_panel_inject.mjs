// 验证代理往 llama.cpp Web UI 里注入的「档位面板」。
//
// 为什么需要注入:llama.cpp 的界面是预压缩的 Svelte 包(8.8 MB),改它要反编译
// 重建,而且上游一升级就白改。代理夹在浏览器和 llama-server 之间,在返回 HTML
// 时追加一小段自己的脚本最省事。手机端因此第一次有了切档位的入口 ——
// 在此之前,手机上完全没法改档位,只能跑到电脑上点。
//
// 要守住两件事:
//   1. HTML 里确实有面板(否则手机上还是没入口)
//   2. **其它响应一个字节都不能变**(注入只该动 HTML)——
//      这条尤其重要,因为代理刚因为资源相关的问题被怀疑过一次,
//      test_assets.mjs 已经证明它不改资源,这里再钉一遍。
//
// 用法:node tools/test_panel_inject.mjs
//   需要 8091 上有一个在跑的 llama-server(用 UPSTREAM 可指到别的端口)。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { panelScript } from '../ui-inject.mjs'

const REPO = path.resolve(import.meta.dirname, '..')
const TMP = path.join(REPO, '.panel-test')
const PORT = Number(process.env.STOVE_TEST_PORT || 8099)
const UPSTREAM = process.env.UPSTREAM || 'http://127.0.0.1:8091'

let failed = 0
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`)
  if (!ok) failed++
}

fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(TMP, { recursive: true })

console.log('=== 档位面板注入 ===')
console.log(`  上游: ${UPSTREAM}   测试代理端口: ${PORT}`)

// 上游必须活着,否则什么也验不了
try {
  const h = await fetch(`${UPSTREAM}/health`, { signal: AbortSignal.timeout(4000) })
  if (!h.ok) throw new Error('status ' + h.status)
} catch (e) {
  console.log(`  ✗ 上游不可用(${e.message})—— 先启动一个 llama-server,或用 UPSTREAM 指到别处`)
  process.exit(1)
}
check('上游可用', true)

const log = path.join(TMP, 'proxy.log')
const fd = fs.openSync(log, 'w')
const proxy = spawn(process.execPath, [path.join(REPO, 'context-proxy.mjs')], {
  cwd: REPO,
  windowsHide: true,
  env: { ...process.env, PROXY_PORT: String(PORT), UPSTREAM, PROXY_STATE_DIR: TMP },
  stdio: ['ignore', fd, fd],
})
fs.closeSync(fd)

let up = false
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 400))
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/_bridge/status`, { signal: AbortSignal.timeout(2000) })
    if (r.ok) { up = true; break }
  } catch { /* 还没起来 */ }
}
if (!up) {
  console.log('  ✗ 测试代理没起来')
  try { console.log(fs.readFileSync(log, 'utf8').slice(-800)) } catch {}
  proxy.kill()
  process.exit(1)
}
check('测试代理就绪', true)

try {
  // ---- 1. HTML 里要有面板,并且用外链引用脚本 ----
  const r = await fetch(`http://127.0.0.1:${PORT}/`)
  const html = await r.text()
  check('/ 返回 HTML', r.headers.get('content-type', '').includes('text/html'),
    r.headers.get('content-type') || '(无 content-type)')
  check('面板容器存在', html.includes('id="stove-panel"'))
  check('面板样式存在', html.includes('id="stove-style"'))
  check('有档位文案', html.includes('任务档位'))
  check('注入在 </body> 之前', html.indexOf('stove-panel') < html.lastIndexOf('</body>'))
  check('没有叠加两份', (html.match(/id="stove-panel"/g) || []).length === 1)

  // ---- 脚本必须是外链,不能内联 ----
  //
  // 内联脚本可能被 CSP 或"脚本拦截"策略挡掉,而元素照样渲染 ——
  // 表现就是"面板在,但点不动、拖不动"。外链走独立资源请求,
  // 不受内联策略影响,而且能单独设缓存头、单独请求来看内容。
  console.log('\n  --- 脚本外链 ---')
  check('HTML 用外链引用面板脚本', /src="\/_stove\/panel\.js(\?v=\d+)?"/.test(html))
  check('脚本 URL 带版本号(缓存失效)', /src="\/_stove\/panel\.js\?v=\d+"/.test(html))
  check('HTML 里没有内联的面板脚本', !html.includes('__stovePanelLoaded'))

  // 带版本号的那条也要能取到(代理路由用了 startsWith,不然会 404)
  const withV = html.match(/src="(\/_stove\/panel\.js\?v=\d+)"/)
  if (withV) {
    const rv = await fetch(`http://127.0.0.1:${PORT}${withV[1]}`)
    check('带 ?v= 的脚本路径可取', rv.status === 200, 'HTTP ' + rv.status)
  } else {
    check('带 ?v= 的脚本路径可取', false, 'HTML 里没找到带版本号的 URL')
  }

  const sp = await fetch(`http://127.0.0.1:${PORT}/_stove/panel.js`)
  const script = await sp.text()
  check('/_stove/panel.js 可取', sp.status === 200, 'HTTP ' + sp.status)
  check('脚本 content-type 正确',
    (sp.headers.get('content-type') || '').includes('javascript'),
    sp.headers.get('content-type') || '(无)')
  check('脚本禁止缓存(免得手机上一直是旧面板)',
    (sp.headers.get('cache-control') || '').includes('no-store'),
    sp.headers.get('cache-control') || '(无)')
  check('脚本内容完整', script.includes('__stovePanelLoaded') && script.includes('bindDrag'))

  // HTML 也必须禁止缓存:正文被我们改过,上游的 ETag 不再对应实际内容
  check('HTML 禁止缓存', (r.headers.get('cache-control') || '').includes('no-store'),
    r.headers.get('cache-control') || '(无)')

  // 后面的断言有的看 HTML(标签、样式),有的看脚本(交互实现),
  // 所以合并成一个整体来查 —— 否则会因为"代码搬到外链文件"而误报。
  const all = html + '\n' + script
  console.log('\n  --- 行为接线 ---')
  check('面板会查询档位', all.includes('/_bridge/status'))
  check('面板会切换档位', all.includes('/_bridge/config'))

  // ---- 拖动 ----
  //
  // 现在拖的是**面板里的标题栏**(id=stove-drag),不是按钮本身 ——
  // 因为手机上拖按钮会触发系统长按选字,pointermove 根本没机会跑。
  //
  // 但更要紧的是:**按钮位置由 CSS 定死在右上角,不依赖脚本**。
  // 即使拖动在某台设备上仍不灵,面板也不会跑到右下角挡发送键。
  console.log('\n  --- 拖动(拖标题栏) ---')
  check('拖动把手是标题栏', all.includes('id="stove-drag"'))
  check('拖的是把手而不是按钮', /pointerdown/.test(script) && script.includes("handle.addEventListener('pointerdown'"))
  check('用 Pointer Events(鼠标与触摸一套)', all.includes('pointerdown') && all.includes('pointermove') && all.includes('pointerup'))
  check('把手设了 touch-action:none(否则手机上是滚动)', /\.stove-h\{[^}]*touch-action:none/.test(all))
  check('pointercancel 也收尾(来电/手势打断)', all.includes('pointercancel'))
  check('有拖动阈值,手抖不会误判为拖动', all.includes('dragMoved') && all.includes('< 6'))
  check('位置记进 localStorage', all.includes('localStorage') && all.includes('stove-panel-pos-v3'))
  check('越界会被拉回可视区', all.includes('clamp'))
  check('拖过之后的那次点击不会误开合', all.includes('if (dragMoved)'))
  check('提示文案在', all.includes('可拖动') || all.includes('可移动'))

  // ---- 长按防御 ----
  //
  // 实测:光靠 CSS 的 user-select:none 不够 —— 长按会弹出系统的文字选取/
  // 复制菜单,pointermove 根本没机会跑,拖动完全失效。所以要几层一起上。
  console.log('\n  --- 长按防御 ---')
  check('user-select:none', all.includes('user-select:none'))
  check('-webkit-touch-callout:none(iOS 长按菜单)', all.includes('-webkit-touch-callout:none'))
  check('pointerdown 里 preventDefault', /pointerdown[\s\S]{0,600}preventDefault/.test(script))
  check('吞掉 contextmenu', script.includes("'contextmenu'") || script.includes('"contextmenu"'))
  check('lostpointercapture 也收尾', script.includes('lostpointercapture'))
  check('有复位入口(拖丢了能拉回来)', all.includes('stove-reset'))

  // ---- 默认位置必须在右上角,而且不依赖脚本 ----
  //
  // 右下角是 llama.cpp 的「发送 / 停止」按钮 —— 挡在那里手机上就没法发消息了。
  // 关键:位置写在 CSS 里(静态),不是在脚本里设 —— 脚本没跑也照样在右上角。
  console.log('\n  --- 默认位置 ---')
  check('默认在右上角(不是右下角)', /#stove-panel\{[^}]*top:14px/.test(html) && /#stove-panel\{[^}]*right:14px/.test(html))
  check('默认不在右下角', !/#stove-panel\{[^}]*bottom:14px/.test(html))
  check('位置不依赖脚本设置(HTML 里就有 top/right)', /id="stove-panel"/.test(html) && /#stove-panel\{[^}]*top:14px/.test(html))
  check('位置键带版本号(避免沿用旧的右下角坐标)', script.includes('stove-panel-pos-v3'))
  check('面板带版本标记(一眼确认手机上跑的是哪版)', /class="stove-ver"/.test(html) || html.includes('stove-ver'))

  // ---- 脚本本身要能作为"经典脚本"编译 ----
  //
  // 浏览器里 <script> 不带 type 就是经典脚本。用 node:vm 按经典脚本编译,
  // 能抓出 import / 顶层 await / 重复声明这类"页面里直接整段失效"的问题 ——
  // 而失效的表现正是这次踩的坑:面板在,但完全点不动。
  console.log('\n  --- 脚本可编译 ---')
  const localScript = panelScript()
  let compileErr = null
  try { new vm.Script(localScript, { filename: 'panel.js' }) } catch (e) { compileErr = e.message }
  check('可作为经典脚本编译', compileErr === null, compileErr || '')
  check('下发的脚本与源码一致', script === localScript,
    script === localScript ? '' : `下发 ${script.length} 字节 / 源码 ${localScript.length} 字节`)

  const dupKeys = (localScript.match(/var POS_KEY/g) || []).length;
  check('POS_KEY 只声明一次', dupKeys === 1, '声明 ' + dupKeys + ' 次');

  // 注入之后 content-length 必须被丢掉(长度变了,不能沿用上游的值)
  check('没有沿用上游的 content-length', !r.headers.get('content-length'),
    r.headers.get('content-length') || '(已丢弃,由 Node 重新计算)')

  // ---- 2. 其它响应一个字节都不能变 ----

  const assets = ['/manifest.webmanifest', '/_app/immutable/assets/bundle.CsYLz1sd.css']
  for (const a of assets) {
    let ua = null, ub = null
    try {
      ua = Buffer.from(await (await fetch(`http://127.0.0.1:${PORT}${a}`)).arrayBuffer())
    } catch { /* 下面报 */ }
    try {
      ub = Buffer.from(await (await fetch(`${UPSTREAM}${a}`)).arrayBuffer())
    } catch { /* 下面报 */ }
    if (!ub || !ub.length) {
      // 上游没有这个资源(版本不同),跳过而不是误报
      console.log(`  - ${a} 上游没有,跳过`)
      continue
    }
    check(`${a} 逐字节一致`, !!ua && ua.equals(ub), ua ? `${ua.length} vs ${ub.length}` : '取不到')
  }
} finally {
  proxy.kill()
  await new Promise((r) => setTimeout(r, 600))
  fs.rmSync(TMP, { recursive: true, force: true })
}

console.log(failed === 0 ? '\n全部通过' : `\n有 ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
