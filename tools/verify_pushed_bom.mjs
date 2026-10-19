// 从 GitHub 直接取原始字节,确认 tools/allow-lan.ps1 的 UTF-8 BOM 活着。
//
// 为什么要单独查这一项:push 脚本的内容校验是按**文本**比对的,而 BOM 是
// 字节层面的东西 —— 正好落在"文本比对看不见"的盲区里。如果它在服务端被
// 规范化掉,本地测试全会通过,而用户 clone 下来拿到的脚本是语法错误的。
//
// 用法:node tools/verify_pushed_bom.mjs
const BLOB = 'tools/allow-lan.ps1';

const m = await (async () => {
  // 先问 HEAD 的 sha
  const r = await fetch('https://api.github.com/repos/1iuTL/model-stove/commits/main', {
    headers: { 'User-Agent': 'model-stove-bom-check' },
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`commits/main -> HTTP ${r.status}`);
  return r.json();
})();

const sha = m.sha;
const short = sha.slice(0, 7);
const treeSha = m.commit.tree.sha;

// tools/ 这层的 tree
const t1 = await (await fetch(`https://api.github.com/repos/1iuTL/model-stove/git/trees/${treeSha}`, {
  headers: { 'User-Agent': 'model-stove-bom-check' }, signal: AbortSignal.timeout(30000),
})).json();
const toolsEntry = t1.tree.find((e) => e.path === 'tools');
if (!toolsEntry) throw new Error('树里没有 tools');
const t2 = await (await fetch(`https://api.github.com/repos/1iuTL/model-stove/git/trees/${toolsEntry.sha}`, {
  headers: { 'User-Agent': 'model-stove-bom-check' }, signal: AbortSignal.timeout(30000),
})).json();
const fileEntry = t2.tree.find((e) => e.path === 'allow-lan.ps1');
if (!fileEntry) throw new Error('tools 里没有 allow-lan.ps1');

// 按 blob sha 取**原始字节**(raw 端点,不做任何解码)
const raw = await fetch(`https://api.github.com/repos/1iuTL/model-stove/git/blobs/${fileEntry.sha}`, {
  headers: { 'User-Agent': 'model-stove-bom-check', Accept: 'application/vnd.github.raw' },
  signal: AbortSignal.timeout(30000),
});
if (!raw.ok) throw new Error(`blob -> HTTP ${raw.status}`);
const buf = Buffer.from(await raw.arrayBuffer());

console.log(`远程提交: ${short}`);
console.log(`blob sha: ${fileEntry.sha}  (git 里记录的大小 ${fileEntry.size})`);
console.log(`取回字节: ${buf.length}`);
console.log(`前三字节: ${[...buf.subarray(0, 3)].map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);

const hasBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
const sizeOk = buf.length === fileEntry.size;
const text = (hasBom ? buf.subarray(3) : buf).toString('utf8');
const cjkOk = /[\u4e00-\u9fff]/.test(text);
const noReplacement = !text.includes('\uFFFD');

console.log('');
console.log(`  ${hasBom ? '✓' : '✗'} UTF-8 BOM 存在`);
console.log(`  ${sizeOk ? '✓' : '✗'} 字节数与 git 记录一致`);
console.log(`  ${cjkOk ? '✓' : '✗'} 中文内容完好`);
console.log(`  ${noReplacement ? '✓' : '✗'} 无替换字符(说明没有解码损失)`);

if (!(hasBom && sizeOk && cjkOk && noReplacement)) {
  console.log('\nBOM 在服务端被改动了 —— 需要换一种方式保存这个文件。');
  process.exit(1);
}
console.log('\n远程文件与本地字节一致,BOM 活着。');
