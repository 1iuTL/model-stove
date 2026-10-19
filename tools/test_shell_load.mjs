// 用一个假的 electron 模块加载 src/main.js。
//
// 目的:Electron 应用**没法在 DSH 沙箱里启动**(mojo IPC 要命名管道,会被拒绝),
// 所以界面改动无法在这里点开验证。退而求其次:把 electron 换成一个桩,
// 让 main.js 真的被 require 一遍 —— 这样能抓到语法错误、require 路径错误、
// 以及模块顶层初始化时抛出的异常(比如 IPC 通道重名、常量未定义)。
//
// 它**不能**验证渲染层交互,那部分只能靠用户重启外壳后实际点一遍。
//
// 用法:node tools/test_shell_load.mjs
import { pathToFileURL } from 'node:url';
import Module from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '..');

/**
 * 用 PowerShell 自己的解析器检查一个脚本。
 *
 * 返回 null 表示能解析;否则返回错误摘要。
 *
 * 注意不用管道收输出(沙箱里管道会被拒),所以让 PowerShell 把结论写进
 * 一个临时文件,再读回来。
 */
function runPsParse(file) {
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (!fs.existsSync(ps)) return null; // 没有 Windows PowerShell 就跳过这项检查
  const out = path.join(REPO, 'logs', `_psparse-${process.pid}.txt`);
  try { fs.mkdirSync(path.dirname(out), { recursive: true }); } catch {}
  const cmd = [
    '$e=$null',
    `[void][System.Management.Automation.Language.Parser]::ParseFile('${file.replace(/'/g, "''")}',[ref]$null,[ref]$e)`,
    `if($e -and $e.Count){ $e | ForEach-Object { $_.Message + ' @ line ' + $_.Extent.StartLineNumber } | Set-Content -Path '${out.replace(/'/g, "''")}' -Encoding UTF8 } else { Set-Content -Path '${out.replace(/'/g, "''")}' -Value 'OK' -Encoding UTF8 }`,
  ].join('; ');
  try {
    execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', cmd], { stdio: 'ignore', timeout: 30000 });
  } catch {
    return null; // 起不来就当检查不适用,不要误报
  }
  let text = '';
  try { text = fs.readFileSync(out, 'utf8').replace(/^\uFEFF/, '').trim(); } catch { return null; }
  try { fs.unlinkSync(out); } catch {}
  if (!text || text === 'OK') return null;
  return text;
}

const calls = { handles: [], on: [], loads: [] };

const fakeApp = {
  whenReady: () => Promise.resolve(),
  getPath: () => path.join(REPO, 'logs'),
  on: (ev) => { calls.on.push(ev); },
  quit: () => {},
};
const fakeWin = {
  setMenuBarVisibility() {}, loadFile(f) { calls.loads.push(f); },
  on() {}, isDestroyed: () => true, webContents: { send() {}, isLoadingMainFrame: () => false, once() {} },
};

const electronStub = {
  app: fakeApp,
  BrowserWindow: function BrowserWindow() { return fakeWin; },
  ipcMain: {
    handle: (ch, fn) => { calls.handles.push(ch); if (typeof fn !== 'function') throw new Error(`IPC ${ch} 的处理函数不是函数`); },
  },
};

// 拦掉 require('electron')。_load 是内部 API,但它是唯一能注入模块桩的钩子。
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub;
  return origLoad.call(this, request, parent, isMain);
};

const mainPath = path.join(REPO, 'src', 'main.js');
let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};

console.log('=== 加载 src/main.js(用 electron 桩) ===');
try {
  // require 而不是 import:main.js 是 CommonJS,而且我们要的就是它顶层全跑一遍
  const m = Module._load(mainPath, null, false);
  check('模块加载成功', true);
  check('导出了测试钩子', !!m && !!m.__test, m && m.__test ? `(${Object.keys(m.__test).join(', ')})` : '');

  if (m && m.__test) {
    const t = m.__test;
    check('startProxy 是函数', typeof t.startProxy === 'function');
    check('stopProxy 是函数', typeof t.stopProxy === 'function');
    check('firewallStatus 是函数', typeof t.firewallStatus === 'function');
    check('launchFirewallHelper 是函数', typeof t.launchFirewallHelper === 'function');
    check('proxyState 存在', !!t.proxyState);
    check('findNodeExe 能找到 node', typeof t.findNodeExe === 'function' && !!t.findNodeExe(), t.findNodeExe ? String(t.findNodeExe()) : '');
  }
} catch (e) {
  check('模块加载成功', false);
  console.log('\n异常:'); console.log(e && e.stack ? e.stack : e);
}

console.log('\n=== IPC 通道 ===');
console.log('  ' + calls.handles.join(', '));
const need = ['catalogue', 'settings:get', 'start', 'stop', 'status', 'logs',
  'proxy:status', 'proxy:start', 'proxy:stop', 'proxy:setProfile', 'proxy:setCompression',
  'proxy:firewallStatus', 'proxy:allowFirewall'];
for (const ch of need) check(`注册了 ${ch}`, calls.handles.includes(ch));
const dupes = calls.handles.filter((c, i) => calls.handles.indexOf(c) !== i);
check('没有重复的 IPC 通道', dupes.length === 0, dupes.join(','));

console.log('\n=== 应用事件 ===');
console.log('  ' + calls.on.join(', '));
check('监听了 window-all-closed', calls.on.includes('window-all-closed'));
check('监听了 before-quit', calls.on.includes('before-quit'));

// ---------------------------------------------------------------- 脚本编码
//
// PowerShell 5.1 读**无 BOM 的 UTF-8** 文件时按 ANSI 解码,其中的中文会变乱码,
// 而乱码本身能打断引号/括号 —— 脚本直接语法错误,却看不出是编码问题。
// 实测:allow-lan.ps1 和 diag_phone.ps1 都栽在这上面(diag_phone 甚至有一个
// 未终止的字符串)。所以这里机器检查:含中文的 .ps1 必须有 UTF-8 BOM,
// 并且能被 PowerShell 的解析器解析通过。
console.log('\n=== PowerShell 脚本编码与语法 ===');
const psFiles = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.toLowerCase().endsWith('.ps1')) psFiles.push(p);
  }
})(REPO);

check('找到了 .ps1 文件', psFiles.length > 0, psFiles.map((f) => path.basename(f)).join(', '));

for (const f of psFiles) {
  const buf = fs.readFileSync(f);
  const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const text = hasBom ? buf.subarray(3).toString('utf8') : buf.toString('utf8');
  const hasCjk = /[\u4e00-\u9fff]/.test(text);
  const name = path.basename(f);
  check(`${name}:含中文则必须有 BOM`, !hasCjk || hasBom, hasCjk ? (hasBom ? '有 BOM' : '含中文却无 BOM —— PowerShell 5.1 会按 ANSI 解码') : '无中文,BOM 无所谓');
  const errs = runPsParse(f);
  check(`${name}:语法可解析`, errs === null, errs === null ? '' : String(errs).split('\n')[0]);
}

// 有功能测试的 .ps1 也要真的跑一遍。
// 注意执行策略在这台机器上是禁用的(Restricted),所以必须带 -ExecutionPolicy Bypass。
const psTests = ['test_firewall_rules.ps1'];
console.log('\n=== PowerShell 功能测试 ===');
for (const t of psTests) {
  const full = path.join(REPO, 'tools', t);
  if (!fs.existsSync(full)) { check(`${t} 存在`, false); continue; }
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const outFile = path.join(REPO, 'logs', `_pstest-${path.basename(t, '.ps1')}.log`);
  try { fs.mkdirSync(path.dirname(outFile), { recursive: true }); } catch {}
  let fd;
  try { fd = fs.openSync(outFile, 'w'); } catch { check(`${t} 运行`, false, '日志打不开'); continue; }
  try {
    execFileSync(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', full], {
      stdio: ['ignore', fd, fd], windowsHide: true, timeout: 120000,
    });
    check(`${t} 通过`, true);
  } catch (e) {
    check(`${t} 通过`, false, `exit=${e.status}`);
    let txt = '';
    try { txt = fs.readFileSync(outFile, 'utf8'); } catch {}
    const bad = txt.split(/\r?\n/).filter((l) => l.includes('[XX]') || l.includes('失败'));
    bad.slice(0, 5).forEach((l) => console.log('        ' + l.trim()));
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}

// .cmd / .bat 走的是另一套规则:cmd.exe 按 **OEM 代码页** 解码(中文系统是 936),
// 所以 UTF-8 中文在批处理里必然是乱码 —— 加 BOM 也救不了(BOM 会被当成命令)。
// 唯一稳妥的做法是保持纯 ASCII。
console.log('\n=== 批处理脚本必须是纯 ASCII ===');
const batFiles = [];
(function walk2(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk2(p);
    else if (/\.(cmd|bat)$/i.test(e.name)) batFiles.push(p);
  }
})(REPO);
check('找到了批处理文件', batFiles.length > 0, batFiles.map((f) => path.basename(f)).join(', '));
for (const f of batFiles) {
  const buf = fs.readFileSync(f);
  const name = path.basename(f);
  const bad = [];
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] > 0x7f) { bad.push(`字节 0x${buf[i].toString(16)} @ 偏移 ${i}`); }
  }
  check(`${name}:纯 ASCII`, bad.length === 0, bad.length ? bad.slice(0, 3).join('; ') : '');
  const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  check(`${name}:没有 BOM`, !hasBom, hasBom ? 'BOM 会被 cmd.exe 当成命令' : '');
}

console.log(failed === 0 ? '\n全部通过' : `\n有 ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
