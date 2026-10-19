// 往 llama.cpp 自带的 Web UI 里注入一个「档位」面板。
//
// 为什么需要注入而不是改 llama.cpp 的界面:那个界面是**预压缩的 Svelte 包**
// (8.8 MB),改它需要反编译和重建,而且一升级 llama.cpp 就白改。代理正好夹在
// 浏览器和 llama-server 之间,可以在**返回 HTML 时**追加一小段自己的脚本 ——
// 只有一个文件、不碰上游代码、上游换版本也不受影响。
//
// 面板做三件事:
//   1. 切档位(通用 / 推理 / 写作 / 代码)—— 手机端原本完全没法切
//   2. 显示当前档位与思考开关状态(原来只有电脑端的 Model Stove 能看到)
//   3. 开关自动压缩
//
// 请求走代理自己的 /_bridge 接口,所以不带 API Key 也能用。
//
// 关于位置:**默认就在右上角,而且这是纯 HTML+CSS 决定的,不依赖脚本**。
//
// 这一点是被现实逼出来的:面板初始在右下角时挡住了「发送」按钮,而改成
// "可以拖动"之后,手机上长按会触发系统文字选取、pointermove 根本没机会跑,
// 拖动等于没有。更麻烦的是故障表现是"看起来改了但没生效" —— 脚本有没有跑
// 从界面上一眼看不出来。
//
// 所以现在的设计是:
//   - 位置由 CSS 定死在右上角(纯静态,脚本挂了也不会跑到右下角挡发送键)
//   - **拖动改成拖标题栏**(面板里那行「任务档位」),而不是拖按钮本身
//   - 面板用 <details> 实现开合 —— 纯 HTML 行为,不吃长按、不需要脚本
//   - 标题旁边有个版本标记,用来一眼确认手机上跑的是哪一版
export const PANEL_VERSION = 4

export const PANEL_HTML = `<div id="stove-panel">
  <button id="stove-toggle" type="button" title="任务档位">档位</button>
  <div id="stove-body">
    <div class="stove-h" id="stove-drag">
      <span class="stove-grip">⠿</span>任务档位 <span id="stove-dot"></span>
      <span class="stove-ver">v${PANEL_VERSION}</span>
    </div>
    <div id="stove-list"></div>
    <div id="stove-note"></div>
    <button type="button" id="stove-copy">复制最后一个代码块</button>
    <label class="stove-opt"><input type="checkbox" id="stove-compress" /> 自动压缩上下文</label>
    <div class="stove-tip">拖这行标题可移动面板 · <a id="stove-reset" href="#">复位</a></div>
  </div>
</div>`

export const PANEL_CSS = `
#stove-panel{position:fixed;top:14px;right:14px;z-index:2147483000;
  font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#e6edf3;
  -webkit-user-select:none;user-select:none;-webkit-touch-callout:none}
#stove-panel *{box-sizing:border-box;
  -webkit-user-select:none;user-select:none;-webkit-touch-callout:none}
/* 按钮固定在面板容器里;容器的位置由上面的 top/right 决定 */
#stove-toggle{display:block;margin-left:auto;background:#1f6feb;color:#fff;border:0;
  border-radius:999px;padding:9px 15px;font:600 13px/1 system-ui,sans-serif;
  cursor:pointer;box-shadow:0 3px 12px rgba(0,0,0,.4);
  -webkit-tap-highlight-color:transparent}
#stove-body{display:none;width:236px;margin-top:8px;background:#161b22;
  border:1px solid #30363d;border-radius:11px;padding:11px;
  box-shadow:0 6px 24px rgba(0,0,0,.5);max-height:64vh;overflow:auto}
#stove-panel.stove-open #stove-body{display:block}
.stove-h{font-weight:600;font-size:12px;color:#8b949e;margin-bottom:8px;
  display:flex;align-items:center;gap:6px;
  cursor:grab;touch-action:none;      /* 标题栏是拖动把手 */
  border-bottom:1px solid #21262d;padding-bottom:7px}
.stove-h:active{cursor:grabbing}
.stove-grip{opacity:.5;letter-spacing:-1px}
.stove-ver{margin-left:auto;font-weight:400;font-size:10px;color:#6e7681;
  border:1px solid #30363d;border-radius:4px;padding:0 4px}
#stove-dot{width:7px;height:7px;border-radius:50%;background:#8b949e;display:inline-block}
#stove-dot.on{background:#3fb950;box-shadow:0 0 6px #3fb950}
#stove-dot.err{background:#f85149}
#stove-list button{display:block;width:100%;text-align:left;margin-bottom:5px;
  background:#21262d;color:#e6edf3;border:1px solid #30363d;border-radius:7px;
  padding:7px 9px;cursor:pointer;font:inherit}
#stove-list button:hover{border-color:#58a6ff}
#stove-list button.sel{background:#1f6feb;border-color:#1f6feb;color:#fff}
#stove-list .d{display:block;font-size:11px;opacity:.75;margin-top:2px}
#stove-note{font-size:11px;color:#8b949e;margin:6px 0}
/* 复制产物按钮:样式与档位按钮一致,成功时变绿 */
#stove-copy{display:block;width:100%;text-align:center;margin:0 0 2px;
  background:#21262d;color:#e6edf3;border:1px solid #30363d;border-radius:7px;
  padding:7px 9px;cursor:pointer;font:inherit}
#stove-copy:hover{border-color:#58a6ff}
#stove-copy.ok{background:#238636;border-color:#238636;color:#fff}
.stove-opt{display:flex;align-items:center;gap:6px;font-size:12px;
  color:#c9d1d9;cursor:pointer;padding-top:7px;border-top:1px solid #30363d}
.stove-tip{font-size:10.5px;color:#6e7681;margin-top:7px;text-align:center}
.stove-tip a{color:#58a6ff;text-decoration:none}
`

export const PANEL_JS = `
(function () {
  if (window.__stovePanelLoaded) return;
  window.__stovePanelLoaded = true;
  var $ = function (id) { return document.getElementById(id); };

  function render(s) {
    var dot = $('stove-dot');
    var list = $('stove-list');
    var note = $('stove-note');
    if (!s || !s.profile) {
      dot.className = 'err';
      note.textContent = '连不上档位代理';
      return;
    }
    dot.className = 'on';
    list.innerHTML = '';
    var avail = s.profile.available || [];
    for (var i = 0; i < avail.length; i++) {
      (function (p) {
        var b = document.createElement('button');
        b.type = 'button';
        if (p.key === s.profile.current) b.className = 'sel';
        var t = document.createElement('span');
        t.textContent = p.label;
        var d = document.createElement('span');
        d.className = 'd';
        d.textContent = p.hint || '';
        b.appendChild(t); b.appendChild(d);
        b.onclick = function () { setProfile(p.key); };
        list.appendChild(b);
      })(avail[i]);
    }
    // ⚠ 2026-09-30:档位在**请求层**覆盖采样参数与思考开关,会盖住 Web UI 侧栏里的
    //   设置(档位说了算 —— 见 context-proxy.mjs "应用任务档位"那段的设计说明)。
    //   以前界面完全不说明,用户在侧栏改温度会"改了没效果"。现在把接管项摆出来。
    var pr = s.profile.params || {};
    var ov = [];
    if (pr.temperature !== undefined) ov.push('温度' + pr.temperature);
    if (pr.top_p !== undefined) ov.push('top_p ' + pr.top_p);
    if (pr.top_k !== undefined) ov.push('top_k ' + pr.top_k);
    if (pr.repeat_penalty !== undefined) ov.push('重复' + pr.repeat_penalty);
    if (pr.presence_penalty !== undefined) ov.push('存在' + pr.presence_penalty);
    ov.push('思考' + (s.profile.thinking ? '开' : '关'));
    if (s.profile.systemAdd) ov.push('输出约束');
    note.textContent = s.profile.label + ' · 本档接管:' + ov.join('/') + '(会盖住侧栏设置)' +
      (s.context && s.context.nCtx
        // (兜底值) = 代理没读到上游 /props,这个数是猜的,压缩阈值会算错
        ? ' · 上下文 ' + s.context.nCtx + (s.context.fallback ? '(兜底值)' : '')
        : '');
    var cb = $('stove-compress');
    cb.disabled = false;
    cb.checked = !!(s.compression && s.compression.enabled);
  }

  function load() {
    fetch('/_bridge/status', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(render)
      .catch(function () { render(null); });
  }

  function setProfile(key) {
    $('stove-note').textContent = '切换中…';
    fetch('/_bridge/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: key })
    }).then(function (r) { return r.json(); })
      .then(function () {
        // 档位在**请求层**生效,当前这轮不重发;下一句话就是新档位。
        load();
      })
      .catch(function () { $('stove-note').textContent = '切换失败'; });
  }

  // ---------- 复制产物(只复制最后一个代码块)----------
  //
  // 为什么需要:三个模型都会在产物**之后**追加说明文字(qwen36 还多带一个 markdown
  // 表格),在聊天里全选复制会把这些一起带走。提示词约束能治这个,但实测会把产物
  // 一起砍瘦(详见 src/profiles.js 的实测记录),所以改在"取用"这一步解决 ——
  // 只取最后一个代码块的内容,尾巴自然就被排除在外了。
  //
  // ⚠ 手机上这个页面是 http(非安全上下文),**navigator.clipboard 不可用** ——
  //   必须回落到 textarea + execCommand('copy'),否则手机上点了没任何反应。
  function lastCodeText() {
    var codes = document.querySelectorAll('pre code');
    if (codes.length) return codes[codes.length - 1].textContent;
    var pres = document.querySelectorAll('pre');
    if (pres.length) return pres[pres.length - 1].textContent;
    return null;
  }

  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    document.body.appendChild(ta);
    ta.select();
    try { ta.setSelectionRange(0, text.length); } catch (e) {}
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  function flash(btn, msg, ok) {
    if (!btn) return;
    if (!btn.getAttribute('data-orig')) btn.setAttribute('data-orig', btn.textContent);
    btn.textContent = msg;
    btn.className = ok ? 'ok' : '';
    setTimeout(function () {
      btn.textContent = btn.getAttribute('data-orig');
      btn.className = '';
    }, 1800);
  }

  function copyArtifact() {
    var btn = $('stove-copy');
    var text = lastCodeText();
    if (!text) { flash(btn, '没找到代码块', false); return; }
    var done = function (ok) {
      flash(btn, ok ? ('已复制 ' + text.length + ' 字符') : '复制失败,请长按选择', ok);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { done(true); },
        function () { done(legacyCopy(text)); }
      );
    } else {
      done(legacyCopy(text));
    }
  }

  // ---------- 拖动(拖标题栏,不是拖按钮)----------
  //
  // 为什么改拖标题栏:原来拖按钮本身,**手机上长按会触发系统的文字选取/复制
  // 菜单**,pointermove 根本没机会跑,拖动等于没有。标题栏在面板内部,用户是
  // 先点开面板再拖,这个动作不会被系统当成"长按选字"。
  //
  // 但更重要的是:**按钮的位置现在由 CSS 定死在右上角,不依赖任何脚本**。
  // 所以即使拖动在某台设备上仍然不灵,面板也不会跑到右下角去挡发送按钮 ——
  // 这是这次改动的核心,毕竟"拖动不好用"最多是不方便,而"挡住发送键"是没法用。
  //
  // 位置键带版本号:换了默认位置后,旧的右下角坐标不该再被沿用,
  // 否则用户会以为"改了没生效"。
  var POS_KEY = 'stove-panel-pos-v3';
  var DEFAULT_POS = { top: 14, right: 14 };

  var dragMoved = false;

  /** 用 left/top 定位。right/bottom 归零,否则会和 left/top 打架。 */
  function applyPos(box, x, y) {
    box.style.left = x + 'px';
    box.style.top = y + 'px';
    box.style.right = 'auto';
    box.style.bottom = 'auto';
  }

  function savePos(x, y) {
    try { localStorage.setItem(POS_KEY, JSON.stringify({ x: x, y: y })); } catch (e) {}
  }

  function clearPos(box) {
    try { localStorage.removeItem(POS_KEY); } catch (e) {}
    box.style.left = 'auto';
    box.style.top = DEFAULT_POS.top + 'px';
    box.style.right = DEFAULT_POS.right + 'px';
    box.style.bottom = 'auto';
  }

  function restorePos(box) {
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(POS_KEY) || 'null'); } catch (e) {}
    if (saved && typeof saved.x === 'number' && typeof saved.y === 'number') {
      applyPos(box, saved.x, saved.y);
    }
  }

  /** 把面板拉回可视区;返回修正后的坐标(没定位过就返回 null)。 */
  function clamp(box) {
    var r = box.getBoundingClientRect();
    var x = parseFloat(box.style.left);
    var y = parseFloat(box.style.top);
    if (isNaN(x) || isNaN(y)) return null;
    var maxX = window.innerWidth - r.width - 8;
    var maxY = window.innerHeight - r.height - 8;
    x = Math.min(Math.max(8, x), Math.max(8, maxX));
    y = Math.min(Math.max(8, y), Math.max(8, maxY));
    applyPos(box, x, y);
    return { x: x, y: y };
  }

  function bindDrag() {
    var box = $('stove-panel');
    var handle = $('stove-drag');
    if (!box || !handle) return;

    restorePos(box);

    var startX = 0, startY = 0, originLeft = 0, originTop = 0, active = false;

    handle.addEventListener('pointerdown', function (e) {
      active = true;
      dragMoved = false;
      var r = box.getBoundingClientRect();
      originLeft = r.left;
      originTop = r.top;
      startX = e.clientX;
      startY = e.clientY;
      try { handle.setPointerCapture(e.pointerId); } catch (err) {}
      // 阻止浏览器把这次按下当成"长按选取文字"的起点
      if (e.cancelable) e.preventDefault();
    });

    handle.addEventListener('pointermove', function (e) {
      if (!active) return;
      var dx = e.clientX - startX;
      var dy = e.clientY - startY;
      if (!dragMoved && Math.abs(dx) + Math.abs(dy) < 6) return;  // 阈值内当作点击
      dragMoved = true;
      applyPos(box, originLeft + dx, originTop + dy);
      if (e.cancelable) e.preventDefault();
    });

    function end(e) {
      if (!active) return;
      active = false;
      try { handle.releasePointerCapture(e.pointerId); } catch (err) {}
      if (dragMoved) {
        var c = clamp(box);
        if (c) savePos(c.x, c.y);
      }
    }
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    // 拖出把手范围再松手也要收尾,否则会卡在拖动状态
    handle.addEventListener('lostpointercapture', end);
    // 长按时浏览器会弹系统菜单(复制/搜索),直接吞掉
    handle.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    // 复位
    var reset = $('stove-reset');
    if (reset) {
      reset.addEventListener('click', function (e) {
        e.preventDefault();
        clearPos(box);
      });
    }

    // 横竖屏切换或窗口变化后把面板拉回可视区
    window.addEventListener('resize', function () { clamp(box); });
  }

  function bindControls() {
    if (!$('stove-panel')) return false;

    // 开合面板
    var btn = $('stove-toggle');
    if (btn) {
      btn.onclick = function () {
        var box = $('stove-panel');
        box.classList.toggle('stove-open');
        if (box.classList.contains('stove-open')) load();
      };
    }

    var cb = $('stove-compress');
    if (cb) {
      cb.onchange = function (e) {
        fetch('/_bridge/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: !!e.target.checked })
        }).catch(function () {});
      };
    }

    // 防御:HTML 与脚本是两个独立请求,可能其中一个被缓存成旧版(旧 HTML 没有这个
    // 按钮)。取不到就别绑定,绝不能因此让后面的 bindDrag/load 一起挂掉。
    var copyBtn = $('stove-copy');
    if (copyBtn) copyBtn.onclick = copyArtifact;
    bindDrag();
    load();
    return true;
  }

  if (!bindControls()) {
    // 脚本放在 body 末尾,通常 DOM 已就绪;真没就绪就等一等。
    window.addEventListener('DOMContentLoaded', bindControls);
  }
})();
`

/**
 * 面板脚本的对外路径。
 *
 * 为什么把脚本做成**外链**而不是内联:
 *   1. 内联脚本可能被 CSP 或某些"脚本拦截"策略挡掉,而元素照样渲染 ——
 *      表现就是"面板在,但点不动、拖不动"。外链走独立的资源请求,不受
 *      内联策略影响。
 *   2. 外链可以单独设缓存头,避免手机拿到旧版本的面板脚本(内联的话它跟着
 *      HTML 一起被缓存,更难控制)。
 *   3. 语法/加载失败更容易定位:直接请求这个路径就能看到内容。
 */
export const PANEL_SCRIPT_PATH = '/_stove/panel.js'

/**
 * 把面板注入到 HTML 里。
 *
 * 只用字符串拼接,不用正则改写原有内容 —— 侵入性最小,也最不容易改坏上游。
 * 注入的三种成分:
 *   - CSS 放在 </head> 之前(样式内联没问题,它不涉及执行)
 *   - 面板 HTML + 一段**外链** script 放在 </body> 之前
 *   - </body> 不存在时退化为直接追加(上游结构变化时不至于什么都不注入)
 */
export function injectPanel(html) {
  const head = `<style id="stove-style">${PANEL_CSS}</style>`
  // 脚本 URL 带版本号:换版本时浏览器一定会重新取,不会拿旧的面板脚本。
  // (路径本身也设了 no-store,但查询串是第二道保险 —— 有些内置浏览器
  //  对 no-store 处理得并不认真。)
  const tail = `${PANEL_HTML}<script src="${PANEL_SCRIPT_PATH}?v=${PANEL_VERSION}" defer></script>`

  let out = html
  if (out.includes('</head>')) out = out.replace('</head>', `${head}</head>`)
  else out = head + out

  if (out.includes('</body>')) out = out.replace('</body>', `${tail}</body>`)
  else out = out + tail

  return out
}

/** 面板 HTML 片段(CSS + 容器 + 外链脚本标签),给测试用。 */
export function panelFragment() {
  return injectPanel('</head><body></body>')
}

/** 面板脚本源码,给测试做语法校验用。 */
export function panelScript() {
  return PANEL_JS
}
