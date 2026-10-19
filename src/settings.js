// model-stove —— 外壳自己的设置(跟模型清单分开)。
//
// 这一层现在只是 src/core/settings.js 的**薄适配**：
//   - 文件位置由 paths.settingsFile 决定（main.js 在 app ready 后注入）；
//   - 读/写交给 core：版本化、非法值回落、旧文件迁移、坏文件备份、原子写；
//   - 对外保留原来的四个导出，main.js 的调用点不需要跟着换一套 API。
//
// 为什么还要留这层而不是让 main.js 直接 require core：
//   main.js 里全是 `settings.readSettings()` 这样的调用点，保留同名导出能把
//   改动限制在一个文件里，也避免把"设置文件在哪"这种路径决策抄两遍。
//
// 兼容性：旧版把设置写在 `<userData>/settings.json`。默认情况下 paths.dataDir
// 就是 userData，所以 initSettings(userData) 与 initSettingsFile(paths.settingsFile)
// 指向同一个文件 —— 旧 Key 会被 core 当作 v1 自动迁移成 v2，不需要用户重输。
const path = require('path');
const core = require('./core/settings');

// 绝对路径。null 表示还没初始化 —— 这时读写都按"没有设置"处理。
let settingsFile = null;
// 迁移/校验警告只提示一次，避免每次状态轮询都往控制台刷同一句。
let warned = false;

/** 由 main.js 在 app ready 之后调用，传进真正的 userData 目录（旧版接口）。 */
function initSettings(userDataDir) {
  settingsFile = path.join(userDataDir, 'settings.json');
  warned = false;
  return settingsFile;
}

/** 直接指定设置文件的绝对路径（main.js 用 paths.settingsFile 调这个）。 */
function initSettingsFile(file) {
  settingsFile = String(file);
  warned = false;
  return settingsFile;
}

function currentFile() {
  return settingsFile;
}

function readSettings() {
  if (!settingsFile) return {};
  const result = core.loadSettings(settingsFile);
  if (!warned && result.warnings.length) {
    warned = true;
    // 坏文件会被 core 备份成 *.bad-<时间戳>，这里只把原因说出来。
    console.warn('[settings] 设置文件有警告:', result.warnings.map((w) => w.reason).join(', '));
    if (result.backupFile) console.warn('[settings] 坏文件已备份到:', result.backupFile);
  }
  return result.settings;
}

function writeSettings(patch) {
  if (!settingsFile) throw new Error('设置尚未初始化');
  // updateSettings 内部是"读 → 校验 → 原子写"，失败会抛错，保持旧接口语义。
  return core.updateSettings(settingsFile, patch || {}).settings;
}

function generateApiKey() {
  return core.generateApiKey();
}

module.exports = {
  initSettings,
  initSettingsFile,
  currentFile,
  readSettings,
  writeSettings,
  generateApiKey,
};
