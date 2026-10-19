// 滑块渲染的行为测试:用假 DOM 真的跑一遍 index.html 里的 renderCtx()。
//
// 为什么值得这么测:index.html 没有构建步骤,内联脚本里的错误只在运行时暴露,
// 而这是个 GUI —— 出错的表现是"窗口一片空白 + 控制台一行红字",用户根本
// 不知道该看哪里。语法检查只能保证"能解析",保证不了"画得对"。
//
// 跑法:node tools/test_ctx_render.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
const code = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
  .map((m) => m[1]).join('\n;\n');

// ---- 假 DOM:任何属性访问都返回一个可用的假节点 -------------------------
const mkEl = (id) => {
  const el = {
    id,
    _text: '',
    _html: '',
    value: '0',
    min: '0', max: '0', step: '1',
    disabled: false,
    style: { _v: {}, setProperty(k, v) { this._v[k] = v; }, getPropertyValue(k) { return this._v[k]; } },
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
      toggle(c, on) { if (on === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } else if (on) { this._s.add(c); } else { this._s.delete(c); } },
    },
    addEventListener() {}, removeEventListener() {}, appendChild() {}, contains() { return false; },
    get textContent() { return this._text; }, set textContent(v) { this._text = String(v); },
    get innerHTML() { return this._html; }, set innerHTML(v) { this._html = String(v); },
    querySelector() { return mkEl('anon'); }, querySelectorAll() { return []; },
    scrollTop: 0, scrollHeight: 0,
  };
  return el;
};
const els = new Map();
const getEl = (id) => { if (!els.has(id)) els.set(id, mkEl(id)); return els.get(id); };

const store = new Map();
const CATALOGUE = {
  models: [
    { id: 'onbit', name: 'Bonsai 27B 1-bit', note: 'x', defaultPreset: 'text-64k', present: true,
      safeCtx: { q4_0: 196608, q8_0: 98304 }, maxCtx: 262144, probeTps: 41 },
    { id: 'ternary', name: 'Bonsai 2 三元版', note: 'x', defaultPreset: 'text-64k', present: true,
      safeCtx: { q4_0: 98304, q8_0: 49152 }, maxCtx: 262144, probeTps: 31 },
  ],
  presets: [
    { key: 'text-64k', label: '长文本 64K', hint: 'x', ctx: 65536, vision: false },
    { key: 'quick-8k', label: '轻量 8K', hint: 'x', ctx: 8192, vision: false },
  ],
  ctxSteps: [8192, 16384, 32768, 49152, 65536, 98304, 131072, 163840, 196608, 262144],
  kvTypes: [
    { key: 'q4_0', label: 'q4_0', hint: 'KV 压到约 1/4,上下文最大(推荐)' },
    { key: 'q8_0', label: 'q8_0', hint: 'KV 精度更高,但上下文减半' },
  ],
  defaultKv: 'q4_0',
  vramCeilingMiB: 7869,
  reasoning: [{ key: 'medium', label: '中', hint: 'x', flag: 'medium' }],
  budgets: [{ key: '32768', label: '32K', hint: 'x', value: 32768 }],
  defaultBudget: '32768',
  port: 8091,
};

const ctx = {
  console,
  document: { getElementById: getEl, createElement: () => mkEl('new'), querySelector: () => mkEl('q'), body: mkEl('body'), addEventListener() {} },
  localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
  URL, JSON, Math, Number, String, Array, Object, Boolean, Date, RegExp, Promise, Error,
  alert() {}, fetch: async () => ({ ok: false, json: async () => ({}) }),
};
ctx.window = ctx;
ctx.globalThis = ctx;
// init() 会 await catalogue() 然后继续调一堆其它 IPC;全部给个无害的返回值,
// 否则第一个没 stub 的方法就会把整个 init 打断,后面的渲染根本不执行。
const noop = async () => ({});
ctx.window.shell = {
  catalogue: async () => CATALOGUE,
  status: async () => ({ running: false }),
  getSettings: async () => ({ apiKey: '', lanMode: false, addresses: [] }),
  setSettings: noop, genKey: noop, addresses: async () => [],
  proxyStatus: async () => ({ state: 'offline' }),
  startProxy: noop, stopProxy: noop,
  firewallStatus: async () => ({ allowed: false }),
  allowFirewall: noop, setProfile: noop, setCompression: noop,
  start: noop, stop: noop, logs: async () => '',
  onStateChanged() {},
};

const sandbox = vm.createContext(ctx);
// 顶层 `let` 在 vm 里**不会**挂到 global 上(只有 var / function 会),
// 所以从外面直接 `sandbox.selCtx = x` 改的是另一个属性,驱动不了真正的状态。
// 这里在脚本末尾追加一个钩子,把词法作用域里的状态暴露出来。
const HOOK = `
;globalThis.__t = {
  setModel(v) { selModel = v; },
  setPreset(v) { selPreset = v; },
  setCtx(v) { selCtx = v; },
  getCtx() { return selCtx; },
  getKv() { return selKv; },
  setKv(v) { selKv = v; renderKv(); renderCtx(); },
  render() { renderCtx(); },
  renderSpeed(sp) { renderSpeed(sp); },
};
`;
vm.runInContext(code + HOOK, sandbox, { filename: 'index.html:inline' });

// init() 是 async IIFE,给它一拍把 CATALOGUE 装上
await new Promise((r) => setTimeout(r, 30));

let fail = 0;
const ok = (cond, msg) => { if (cond) console.log('  PASS  ' + msg); else { console.error('  FAIL  ' + msg); fail++; } };

const range = getEl('ctxRange'), val = getEl('ctxVal'), note = getEl('ctxNote');
const T = sandbox.__t;

console.log('--- 场景 1:默认选中 1-bit + 长文本 64K + q4_0 ---');
ok(T.getKv() === 'q4_0', `默认 KV 精度 = ${T.getKv()}`);
ok(range.max === '9', `滑块档位数 = ${Number(range.max) + 1} (期望 10)`);
ok(range.value === '4', `初始索引 = ${range.value} (65536 在第 5 档)`);
ok(val.textContent.includes('64K'), `读数 = "${val.textContent}"`);
ok(!val.classList.contains('over'), '未越界,不显示警告色');
// (196608-8192)/(262144-8192) = 74.19%
ok(range.style.getPropertyValue('--safe') === '74.2%',
   `安全区色标 = ${range.style.getPropertyValue('--safe')} (期望 74.2%)`);
ok(note.innerHTML.includes('混合注意力'), '提示文案说明混合注意力');
console.log('');

console.log('--- 场景 2:拖到超过安全上限(1-bit + q4_0,上限 192K)---');
T.setCtx(262144);
T.render();
ok(val.textContent.includes('\u26a0'), `越界后读数带警告标记 = "${val.textContent}"`);
ok(val.classList.contains('over'), '读数变警告色');
ok(note.classList.contains('warn'), '提示文案变警告色');
ok(note.innerHTML.includes('6-8 倍'), '警告文案点明"速度掉约 6-8 倍"');
ok(note.innerHTML.includes('192K'), `警告文案报出安全上限 = ${/实测的安全上限 <b>([^<]+)<\/b>/.exec(note.innerHTML)?.[1]}`);
console.log('');

console.log('--- 场景 3:KV 换 q8_0,安全区必须立刻减半 ---');
T.setCtx(65536);
T.setKv('q8_0');
ok(T.getKv() === 'q8_0', `KV = ${T.getKv()}`);
// (98304-8192)/(262144-8192) = 35.48%
ok(range.style.getPropertyValue('--safe') === '35.5%',
   `安全区色标 = ${range.style.getPropertyValue('--safe')} (期望 35.5%,q4_0 时是 74.2%)`);
ok(!val.classList.contains('over'), '64K 对 q8_0 的 96K 上限仍是安全的');
T.setCtx(131072);
T.render();
ok(val.classList.contains('over'), '128K 对 q8_0 越界(对 q4_0 却是安全的)—— 精度联动正确');
ok(note.innerHTML.includes('q8_0'), `警告文案点出当前精度 = ${/已超过 <b>([^<]+)<\/b>/.exec(note.innerHTML)?.[1]}`);
console.log('');

console.log('--- 场景 4:切到三元版(KV 保持 q8_0,上限只剩 48K)---');
T.setModel('ternary');
T.setCtx(null);
T.setPreset('text-64k');
T.render();
ok(val.textContent.includes('64K'), `切模型后回到预设值 = "${val.textContent}"`);
ok(val.classList.contains('over'), '64K 对三元版 + q8_0(上限 48K)越界 —— 分模型判定正确');
// (49152-8192)/(262144-8192) = 16.13%
ok(range.style.getPropertyValue('--safe') === '16.1%',
   `安全区色标 = ${range.style.getPropertyValue('--safe')} (期望 16.1%)`);
console.log('');

console.log('--- 场景 5:预设点选把滑块带回该预设的值 ---');
T.setModel('onbit');
T.setPreset('quick-8k');
T.setCtx(8192);
T.render();
ok(val.textContent.includes('8K'), `读数 = "${val.textContent}"`);
ok(range.value === '0', `索引 = ${range.value} (最小档)`);
console.log('');

console.log('--- 场景 6:探针速度那一行 ---');
const sp = getEl('stSpeed');
T.renderSpeed(null);
ok(sp.textContent === '—', `无数据 -> "${sp.textContent}"`);
T.renderSpeed({ pending: true });
ok(sp.textContent.includes('探测中'), `探测中 -> "${sp.textContent}"`);
T.renderSpeed({ tps: 29.4, expected: 31, ratio: 0.95, spilled: false });
ok(sp.textContent === '29.4 tok/s', `正常 -> "${sp.textContent}"`);
ok(sp.classList.contains('ok') && !sp.classList.contains('bad'), '正常时是绿色');
T.renderSpeed({ tps: 5.2, expected: 31, ratio: 0.17, spilled: true });
ok(sp.textContent.includes('5.2 tok/s'), `溢出 -> "${sp.textContent}"`);
ok(sp.textContent.includes('疑似溢出'), '溢出时文案点明');
ok(sp.classList.contains('bad'), '溢出时是红色');
ok(typeof sp.title === 'string' && sp.title.includes('q4_0'), '溢出时提示文案给出补救方向');
console.log('');

if (fail) { console.error(`✗ ${fail} 项失败`); process.exit(1); }
console.log('✓ 全部通过');
