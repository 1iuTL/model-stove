// 外部进程脚本的路径解析。
//
// 打包后（asar: true）主进程的 REPO_ROOT（__dirname/..）是
// `resources\app.asar`，但下面这些文件是交给**外部进程**执行的：
//
//   - context-proxy.mjs / ui-inject.mjs  由外部 node.exe 执行
//   - tools/allow-lan.ps1 / .cmd         由 powershell.exe / cmd.exe 执行
//
// 外部进程没有 Electron 的 asar 补丁，读不到 asar 里的文件；electron-builder
// 通过 asarUnpack 把它们原样放到 `resources\app.asar.unpacked`。本模块只负责
// 把"逻辑上的安装根"映射到那个真实目录，普通 require() 仍走 asar 内路径。
//
//   resolveScriptRoot({ repoRoot, isPackaged })
//     未打包 → repoRoot；打包（isPackaged === true，或 repoRoot 以
//     `app.asar` 结尾）→ `${repoRoot}.unpacked`。
//
//   resolveScriptPath({ repoRoot, isPackaged, relative })
//     = path.join(resolveScriptRoot(...), relative)。
//
// 纯函数、不碰文件系统，测试见 tests/script-paths.test.mjs。
const path = require('path');

// `app.asar` 后缀判断不区分大小写：Windows 路径本身不区分大小写，
// 打包器输出的大小写也不该成为运行期陷阱。允许末尾带分隔符。
const ASAR_SUFFIX = /app\.asar[\\/]*$/i;

/** 去掉末尾的路径分隔符（`C:\` 这种盘根除外，不会出现在 asar 后缀场景）。 */
function stripTrailingSep(p) {
  return p.replace(/[\\/]+$/, '');
}

/**
 * 外部进程脚本所在的根目录。
 *
 * @param {{ repoRoot?: string, isPackaged?: boolean }} [opts]
 * @returns {string} 未打包时是 repoRoot；打包后是 repoRoot + '.unpacked'。
 */
function resolveScriptRoot({ repoRoot, isPackaged } = {}) {
  const root = String(repoRoot || '');
  // isPackaged 优先（main.js 直接用 app.isPackaged）；测试桩/旧 Electron
  // 拿不到这个字段时，用 app.asar 后缀兜底。
  if (isPackaged === true || ASAR_SUFFIX.test(root)) {
    return `${stripTrailingSep(root)}.unpacked`;
  }
  return root;
}

/**
 * 解析一个需要交给外部进程执行的脚本路径。
 *
 * @param {{ repoRoot?: string, isPackaged?: boolean, relative?: string }} [opts]
 * @returns {string} 绝对/相对路径的拼接结果。
 */
function resolveScriptPath({ repoRoot, isPackaged, relative } = {}) {
  return path.join(resolveScriptRoot({ repoRoot, isPackaged }), relative);
}

module.exports = { resolveScriptRoot, resolveScriptPath };
