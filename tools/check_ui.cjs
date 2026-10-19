// 检查 src/index.html 结构:内联脚本语法 + 关键元素与引用是否齐全。
// 之所以用文件而不是 node -e:PowerShell 会把双引号转义搞坏(踩过多次)。
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const srcDir = path.join(__dirname, '..', 'src');
const file = path.join(srcDir, 'index.html');
const html = fs.readFileSync(file, 'utf8');
let bad = 0;

// 1. 内联脚本语法
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
blocks.forEach((b, i) => {
  try {
    new vm.Script(b[1], { filename: `inline${i}` });
    console.log(`  ok    内联脚本 ${i} 语法正确 (${b[1].length} 字符)`);
  } catch (e) {
    bad++;
    console.log(`  FAIL  内联脚本 ${i}: ${e.message}`);
  }
});

// 2. 引用的外部脚本存在
for (const m of html.matchAll(/<script src="([^"]+)"/g)) {
  const p = path.join(srcDir, m[1]);
  const ok = fs.existsSync(p);
  if (!ok) bad++;
  console.log(`  ${ok ? 'ok    ' : 'FAIL  '} 引用脚本 ${m[1]}`);
}

// 3. 必需的 DOM id 都在
const ids = [
  'optReasoning', 'inpKey', 'optLan', 'lanList', 'qrbox', 'qrwhy',
  'btnRefreshNet', 'btnGenKey', 'btnSaveKey', 'btnClearKey',
  'btnStart', 'btnStop', 'btnSettings', 'reasoningGroup', 'models', 'presets',
];
for (const id of ids) {
  const ok = html.includes(`id="${id}"`);
  if (!ok) bad++;
  console.log(`  ${ok ? 'ok    ' : 'FAIL  '} 元素 #${id}`);
}

// 4. 脚本里 $('xxx') 引用的 id 必须都存在于 HTML 中
const script = blocks.map((b) => b[1]).join('\n');
const referenced = new Set([...script.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
const missing = [...referenced].filter((id) => !html.includes(`id="${id}"`));
if (missing.length) {
  bad += missing.length;
  console.log(`  FAIL  脚本引用了不存在的元素: ${missing.join(', ')}`);
} else {
  console.log(`  ok    脚本引用的 ${referenced.size} 个元素全部存在`);
}

// 5. id 不能重复(重复会让 getElementById 取到意外那个)
const allIds = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
const dupes = allIds.filter((v, i) => allIds.indexOf(v) !== i);
if (dupes.length) {
  bad += dupes.length;
  console.log(`  FAIL  重复的 id: ${[...new Set(dupes)].join(', ')}`);
} else {
  console.log(`  ok    ${allIds.length} 个 id 无重复`);
}

console.log(bad ? `\n${bad} 项失败` : '\n全部通过');
process.exit(bad ? 1 : 0);
