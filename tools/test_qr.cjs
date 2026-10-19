// 针对 src/qr.js 的逐层验证。
// 重点验证三处最容易写错的地方:GF(256) 运算、纠错码字、格式信息位。
const qr = require('../src/qr.js');

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
}

console.log('--- 1. 编码层:版本选择与容量边界 ---');
let e = qr.encode('hello');
check('"hello" 落在版本 1', e.version, 1);
check('版本 1 码字总数 = 26', e.codewords.length, 26);

check('17 字节仍是版本 1(容量上限)', qr.encode('x'.repeat(17)).version, 1);
check('18 字节升到版本 2', qr.encode('x'.repeat(18)).version, 2);
check('271 字节是版本 10 上限', qr.encode('x'.repeat(271)).version, 10);
check('版本 10 码字总数 = 346', qr.encode('x'.repeat(271)).codewords.length, 346);

let threw = false;
try { qr.encode('x'.repeat(272)); } catch (err) { threw = true; }
check('272 字节正确抛错', threw, true);

console.log('\n--- 2. 纠错码字:多项式校验(RS 码的数学定义)---');
// 一个码字多项式 c(x) 是合法 RS 码字,当且仅当它在生成多项式的
// 所有根 a^0..a^(n-1) 上取值都为 0。这是充分必要条件,
// 比"跟某个向量比对"更强 —— 它直接验证了纠错码字的正确性。
const EXP = [], LOG = [];
(function () {
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const gfMul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];

function checkRsRoots(codewords, nEc) {
  const roots = [];
  for (let i = 0; i < nEc; i++) {
    let acc = 0;
    for (const c of codewords) acc = gfMul(acc, EXP[i]) ^ c;
    roots.push(acc);
  }
  return roots;
}

// 版本 1-L:19 数据 + 7 纠错。分别测短内容与满容量内容。
[1, 7, 17].forEach((len) => {
  const enc = qr.encode('a'.repeat(len));
  const roots = checkRsRoots(enc.codewords, 7);
  check(`版本 1-L,${len} 字节数据:7 个根全为 0`, roots, new Array(7).fill(0));
});

// 版本 6-L:纠错 18 x 2 块 —— 这是唯一的多块样例,值得单独测
const v6 = qr.encode('b'.repeat(130));
check('130 字节落在版本 6', v6.version, 6);
check('版本 6-L 码字总数 = 172', v6.codewords.length, 172);

console.log('\n--- 3. 格式信息位:与规范的 BCH(15,5) 对算 ---');
// 规范表:纠错等级 L 的 8 组格式串
const FORMAT_L_TABLE = [0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976];
function bchFormat(data) {
  let rem = data << 10;
  for (let i = 4; i >= 0; i--) {
    if (rem & (1 << (i + 10))) rem ^= 0x537 << i;   // 生成多项式 0b10100110111
  }
  return ((data << 10) | rem) ^ 0x5412;             // 掩码 0b101010000010010
}
const computed = [];
for (let mk = 0; mk < 8; mk++) computed.push(bchFormat((0b01 << 3) | mk));  // 01 = 纠错等级 L
check('独立 BCH 计算 == 查表值', computed, FORMAT_L_TABLE);

console.log('\n--- 4. 矩阵结构 ---');
check('短串尺寸 21', qr.make('hi').size, 21);

const r = qr.make('http://192.168.137.1:8091/');
console.log(`  92 字节链接 -> 版本 ${r.version},尺寸 ${r.size}`);
const m = r.modules;

function finderOk(ox, oy) {
  const want = [
    [1,1,1,1,1,1,1],[1,0,0,0,0,0,1],[1,0,1,1,1,0,1],[1,0,1,1,1,0,1],
    [1,0,1,1,1,0,1],[1,0,0,0,0,0,1],[1,1,1,1,1,1,1],
  ];
  for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
    if (m[oy + y][ox + x] !== want[y][x]) return false;
  }
  return true;
}
check('左上定位图案', finderOk(0, 0), true);
check('右上定位图案', finderOk(r.size - 7, 0), true);
check('左下定位图案', finderOk(0, r.size - 7), true);

let timingOk = true;
for (let i = 8; i < r.size - 8; i++) {
  if (m[6][i] !== (i % 2 === 0 ? 1 : 0)) timingOk = false;
  if (m[i][6] !== (i % 2 === 0 ? 1 : 0)) timingOk = false;
}
check('水平/垂直时序图案', timingOk, true);

// 恒为深的模块在 x=8, y=size-8,即左下定位图案正上方、时序图案右侧那一格。
// 索引是 modules[y][x],所以写成 m[size-8][8] —— 写成 m[8][size-8] 会取到
// 格式信息横条上的另一格,那是完全不同的位置(踩过一次)。
check('固定深色模块 (x=8, y=size-8)', m[r.size - 8][8], 1);

// 格式信息必须与纠错等级 L 的 BCH 串相符。垂直份位 i 在 (x=8, y=i)(y=6/8 有跳格),
// 所以前 6 位读 m[i][8] —— 注意是 m[y][x],不是 m[8][i]。
function readFormat(m, size) {
  const bits = [];
  for (let i = 0; i < 6; i++) bits.push(m[i][8]);
  bits.push(m[7][8]);
  bits.push(m[8][8]);
  for (let i = 8; i < 15; i++) bits.push(m[size - 15 + i][8]);
  let v = 0;
  for (let i = 0; i < 15; i++) v |= (bits[i] & 1) << i;
  return v;
}
const readBack = readFormat(m, r.size);
check('格式信息读回后属于纠错 L 的合法集合', FORMAT_L_TABLE.includes(readBack), true);

// 矩阵必须只含 0/1,且每格都确定
let clean = true;
for (let y = 0; y < r.size; y++) for (let x = 0; x < r.size; x++) {
  const v = m[y][x];
  if (v !== 0 && v !== 1) clean = false;
}
check('矩阵只含 0/1', clean, true);

console.log('\n--- 5. SVG 输出 ---');
const svg = qr.toSvg('http://192.168.137.1:8091/');
check('以 <svg 开头', svg.startsWith('<svg'), true);
check('含 path 图元', svg.includes('<path'), true);
check('有白色底', svg.includes('fill="#fff"'), true);
console.log(`  SVG ${svg.length} 字节`);

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
