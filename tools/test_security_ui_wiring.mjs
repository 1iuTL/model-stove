// P1 设备访问 UI 接线测试：不启动 Electron，用桩加载 main.js + 静态检查前端。
//
// 为什么需要它：security:* 这些 IPC、preload 方法、index.html 里的元素是三层
// 各自独立的字符串契约，任何一层改名/漏加都不会有编译错误，只会在用户点按钮
// 时才炸。这里用最轻的方式把它们钉在一起：
//   1. 用 electron 桩 require src/main.js，抓 ipcMain.handle 注册的通道；
//   2. 读 preload 文本，确认 6 个 security 方法真的 invoke 了对应通道；
//   3. 读 index.html，确认新 id 存在且内联脚本用 $('id') 引用了它们；
//   4. 读 core/settings 的默认值，确认 deviceAuth=false（不改变现有行为）；
//   5. 静态确认代理新增了 /_security/issue 与 /_security/audit，且集成测试覆盖。
//
// 用法：node tools/test_security_ui_wiring.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'model-stove-security-ui-'));

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};

const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

// ---------------------------------------------------------------- electron 桩
const registered = [];
const electronStub = {
  app: {
    // 永不 resolve：main.js 的 ready 回调不会跑，也就不会 initRuntime / 起代理。
    // 所有 ipcMain.handle 都在模块顶层同步注册，足以验证接线。
    whenReady: () => new Promise(() => {}),
    getPath: () => TMP,
    on: () => {},
    quit: () => {},
  },
  BrowserWindow: function BrowserWindow() {
    return {
      setMenuBarVisibility() {}, loadFile() {}, on() {}, isDestroyed: () => true,
      webContents: { send() {}, isLoadingMainFrame: () => false, once() {} },
    };
  },
  ipcMain: {
    handle: (channel, fn) => {
      registered.push(channel);
      if (typeof fn !== 'function') throw new Error(`IPC ${channel} 的处理函数不是函数`);
    },
  },
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub;
  return origLoad.call(this, request, parent, isMain);
};

process.env.MODEL_STOVE_QUIET = '1';

let main = null;
try {
  console.log('=== P1 设备访问 UI 接线测试 ===');

  // ------------------------------------------------------------ 1. 主进程 IPC
  main = Module._load(path.join(REPO, 'src', 'main.js'), null, false);
  check('main.js 用 electron 桩加载成功', !!main);
  check('导出了 __test', !!main && !!main.__test);

  const requiredChannels = [
    'security:issue',
    'security:pairing',
    'security:devices',
    'security:audit',
    'security:revoke',
    'security:rotate',
    'settings:get',
    'settings:set',
  ];
  for (const channel of requiredChannels) {
    check(`注册了 ${channel}`, registered.includes(channel));
  }
  const dupes = registered.filter((c, i) => registered.indexOf(c) !== i);
  check('IPC 通道没有重复', dupes.length === 0, dupes.join(','));

  const t = main.__test || {};
  for (const name of ['securityIssue', 'securityPairing', 'securityDevices', 'securityAudit', 'securityRevoke', 'securityRotate']) {
    check(`__test.${name} 是函数`, typeof t[name] === 'function');
  }

  // settings:get / settings:set 的返回结构里必须带 deviceAuth。
  const mainText = read('src/main.js');
  check('settings:get 返回 deviceAuth',
    /deviceAuth:\s*s\.deviceAuth === true/.test(mainText) || /deviceAuth:\s*s\.deviceAuth/.test(mainText));
  check('settings:set 允许 boolean deviceAuth',
    /typeof patch\?\.deviceAuth === 'boolean'/.test(mainText));
  check('设备鉴权变化会重启代理',
    /deviceAuthChanged[\s\S]{0,600}startProxy\(\{ refresh: true \}\)/.test(mainText));
  check('代理启动 env 写 PROXY_DEVICE_AUTH', /PROXY_DEVICE_AUTH/.test(mainText));
  check('status 返回 deviceAuth', /deviceAuth:\s*currentSettings\.deviceAuth === true/.test(mainText));

  // --------------------------------------------------------------- 2. preload
  const preload = read('src/preload.js');
  const preloadMethods = [
    ['securityIssue', 'security:issue'],
    ['securityPairing', 'security:pairing'],
    ['securityDevices', 'security:devices'],
    ['securityAudit', 'security:audit'],
    ['securityRevoke', 'security:revoke'],
    ['securityRotate', 'security:rotate'],
  ];
  for (const [method, channel] of preloadMethods) {
    const declared = new RegExp(`\\b${method}\\s*:`).test(preload);
    check(`preload 暴露 ${method}`, declared);
    check(`preload ${method} 调用 ${channel}`,
      new RegExp(`${method}[\\s\\S]{0,160}ipcRenderer\\.invoke\\('${channel.replace(':', '\\:')}'`).test(preload));
  }

  // ------------------------------------------------------------ 3. index.html
  const html = read('src/index.html');
  const newIds = [
    'optDeviceAuth', 'btnIssueDevice', 'deviceOnceBox',
    'btnPairing', 'pairingBox', 'deviceList', 'btnAudit', 'auditBox', 'deviceHint',
  ];
  for (const id of newIds) {
    check(`index.html 存在 #${id}`, html.includes(`id="${id}"`));
  }
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  const inline = blocks.map((b) => b[1]).join('\n');
  for (const id of newIds) {
    check(`内联脚本引用了 #${id}`, inline.includes(`$('${id}')`));
  }
  const allIds = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
  const idDupes = [...new Set(allIds.filter((v, i) => allIds.indexOf(v) !== i))];
  check('新 id 没有与既有 id 重复', idDupes.length === 0, idDupes.join(','));
  for (const call of ['securityIssue', 'securityPairing', 'securityDevices', 'securityAudit', 'securityRevoke']) {
    check(`设置页调用了 window.shell.${call}`, inline.includes(`window.shell.${call}(`));
  }
  check('审计结果用 textContent 渲染（不拼 innerHTML）',
    /window\.shell\.securityAudit\([\s\S]{0,1200}\.textContent\s*=/.test(inline));
  check('签发结果区提示只显示一次', /只显示一次/.test(html));
  check('关闭设备鉴权仍是现有行为（文案）', /关闭 = 现有行为/.test(html));

  // ------------------------------------------------- 4. settings 默认与校验键
  const settings = require('../src/core/settings.js');
  check('DEFAULT_SETTINGS.deviceAuth === false', settings.DEFAULT_SETTINGS.deviceAuth === false);
  check('BOOLEAN_KEYS 包含 deviceAuth', settings.BOOLEAN_KEYS.includes('deviceAuth'));
  check('SCHEMA_VERSION 保持 2', settings.SCHEMA_VERSION === 2);

  // ------------------------------------------- 5. 代理端点 + 集成测试静态覆盖
  const proxy = read('context-proxy.mjs');
  check('代理包含 /_security/issue', proxy.includes("'/_security/issue'"));
  check('代理包含 /_security/audit', proxy.includes("'/_security/audit'"));
  check('审计端点仍先过 bridgeAuthorized', /handleSecurityRequest[\s\S]{0,200}bridgeAuthorized\(req\)/.test(proxy));
  check('审计端点通过 auditLog.read({ limit }) 读取', /auditLog\.read\(\{\s*limit\s*\}\)/.test(proxy));
  check('审计端点返回 file 路径', /file:\s*AUDIT_FILE/.test(proxy));
  check('签发端点仍先过 bridgeAuthorized', /handleSecurityRequest[\s\S]{0,200}bridgeAuthorized\(req\)/.test(proxy));
  check('签发调用 registry.issueDevice', /issueDevice\(\{\s*name\s*\}\)/.test(proxy));
  const wiringTest = read('tools/test_security_wiring.mjs');
  check('集成测试覆盖 /_security/issue', wiringTest.includes("'/_security/issue'"));
  check('集成测试覆盖 /_security/audit', wiringTest.includes("'/_security/audit"));
  check('集成测试断言 issue 审计', wiringTest.includes("'issue'"));
} catch (e) {
  check('测试执行无异常', false, e && e.message ? e.message : String(e));
  console.log(e && e.stack ? e.stack : e);
} finally {
  Module._load = origLoad;
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
}

console.log(failed === 0 ? '\n全部通过' : `\n有 ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
