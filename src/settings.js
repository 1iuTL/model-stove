// model-stove —— 外壳自己的设置(跟模型清单分开)。
//
// 存哪些东西:用户不想每次都重输、又不适合写进源码的偏好。
// 目前只有 API Key —— 手机访问时用它挡住同网段的其他人。
//
// 放哪儿:Electron 的 userData 目录,而不是程序目录。
// 原因有两个:一是程序目录在更新/重装时会被覆盖,二是用户目录天然是
// 每个账户私有,不会跟着仓库被提交上去。
//
// 文件权限说明:Windows 下没有 chmod 那一套,这个文件对同机其它账户
// 可读。它保护的是「局域网里的别人」,不是「本机上的别人」—— 后者
// 本来就等同有你这个账户的权限。这个边界要说清楚,不能给人假的安全感。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let settingsPath = null;

/** 由 main.js 在 app ready 之后调用,传进真正的 userData 路径。 */
function initSettings(userDataDir) {
  settingsPath = path.join(userDataDir, 'settings.json');
}

function readSettings() {
  if (!settingsPath) return {};
  try {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    // 文件不存在,或者被手工改坏了。都当作「没设置过」,
    // 这样用户删掉文件就能回到默认状态。
    return {};
  }
}

function writeSettings(patch) {
  if (!settingsPath) throw new Error('设置尚未初始化');
  const next = { ...readSettings(), ...patch };
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

/**
 * 造一个够用的随机 Key。
 *
 * 用 32 位十六进制(128 bit)。它是给人手抄/粘贴的,不追求口令那样的
 * 记忆强度 —— 攻击面是同一个 WiFi 下的人,128 bit 足够。
 * 刻意只用 0-9a-f:避免大小写混淆、也避免 URL 里需要转义的字符。
 */
function generateApiKey() {
  return crypto.randomBytes(16).toString('hex');
}

module.exports = { initSettings, readSettings, writeSettings, generateApiKey };
