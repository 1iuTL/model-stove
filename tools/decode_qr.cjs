// 独立解码器:只读我生成的矩阵,把它解回原始字符串。
// 这是端到端验证 —— 不做"看起来对"的判断,只认能不能还原数据。
const path = require('path');
const qr = require(path.join(__dirname, '..', 'src', 'qr.js'));

const EXP = [], LOG = [];
(function () {
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const gfMul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];

// 版本 -> (每块纠错数, 块数),纠错等级 L
const EC_L = [[7,1],[10,1],[15,1],[20,1],[26,1],[18,2],[20,2],[24,2],[30,2],[18,4]];
const TOTAL = [26,44,70,100,134,172,196,242,292,346];
const ALIGN = [[],[6,18],[6,22],[6,26],[6,30],[6,34],[6,22,38],[6,24,42],[6,26,46],[6,28,50]];

// 各掩码的取值函数(x=列, y=行)。必须与规范一致 ——
// 这里曾经和编码端一起写错,导致"自洽但不合规",即互相能解、
// 真实扫码器却解不出来。所以两个文件都要按规范写。
function maskFn(id, x, y) {
  switch (id) {
    case 0: return (y + x) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (y + x) % 3 === 0;
    case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5: return ((y * x) % 2) + ((y * x) % 3) === 0;
    case 6: return (((y * x) % 2) + ((y * x) % 3)) % 2 === 0;
    default: return (((y * x) % 3) + ((y + x) % 2)) % 2 === 0;
  }
}

/** 重建"哪些格属于功能图案"的掩码 —— 与编码端 buildMatrix 独立实现。 */
function reservedMap(version) {
  const size = version * 4 + 17;
  const res = [];
  for (let i = 0; i < size; i++) res.push(new Array(size).fill(false));
  const mark = (x, y) => { if (x >= 0 && y >= 0 && x < size && y < size) res[y][x] = true; };

  // 定位图案 + 分隔符
  for (const [ox, oy] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
    for (let y = -1; y <= 7; y++) for (let x = -1; x <= 7; x++) mark(ox + x, oy + y);
  }
  // 校正图案
  const centers = ALIGN[version - 1];
  for (const cx of centers) for (const cy of centers) {
    const nearCorner = (cx <= 8 && cy <= 8) || (cx >= size - 9 && cy <= 8) || (cx <= 8 && cy >= size - 9);
    if (nearCorner) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) mark(cx + dx, cy + dy);
  }
  // 时序图案
  for (let t = 0; t < size; t++) { mark(t, 6); mark(6, t); }
  // 格式信息
  for (let i = 0; i < 9; i++) { mark(i, 8); mark(8, i); }
  for (let i = 0; i < 8; i++) { mark(size - 1 - i, 8); }
  for (let i = 0; i < 7; i++) { mark(8, size - 1 - i); }
  // 恒深模块
  mark(8, size - 8);
  // 版本信息
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      mark(size - 11 + (i % 3), Math.floor(i / 3));
      mark(Math.floor(i / 3), size - 11 + (i % 3));
    }
  }
  return res;
}

function decode(qrResult) {
  const size = qrResult.size;
  const version = (size - 17) / 4;
  const m = qrResult.modules;

  // 1. 读出格式信息,确定掩码号
  const bits = [];
  for (let i = 0; i < 6; i++) bits.push(m[i][8]);
  bits.push(m[7][8]);
  bits.push(m[8][8]);
  for (let i = 8; i < 15; i++) bits.push(m[size - 15 + i][8]);
  let fmt = 0;
  for (let i = 0; i < 15; i++) fmt |= (bits[i] & 1) << i;

  // 反查掩码号(纠错 L 的 8 个格式串)
  const FORMAT_L = [0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976];
  let mask = FORMAT_L.indexOf(fmt);
  if (mask < 0) {
    // 容错:允许 3 位以内的偏差(Hamming 距离)
    let best = -1, bestD = 99;
    for (let k = 0; k < 8; k++) {
      let d = 0;
      for (let b = 0; b < 15; b++) d += ((FORMAT_L[k] >> b) & 1) ^ ((fmt >> b) & 1);
      if (d < bestD) { bestD = d; best = k; }
    }
    if (bestD > 3) throw new Error('格式信息无法识别,fmt=0x' + fmt.toString(16));
    mask = best;
  }

  // 2. 去掩码并取数据位
  const res = reservedMap(version);
  const bitsOut = [];
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      const y = upward ? size - 1 - vert : vert;
      for (let c = 0; c < 2; c++) {
        const x = right - c;
        if (res[y][x]) continue;
        let v = m[y][x];
        if (maskFn(mask, x, y)) v ^= 1;
        bitsOut.push(v & 1);
      }
    }
    upward = !upward;
  }

  // 3. 收成码字
  const codewords = [];
  for (let i = 0; i + 8 <= bitsOut.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bitsOut[i + j];
    codewords.push(b);
  }

  // 4. 反交织
  const [ecPer, blocks] = EC_L[version - 1];
  const total = TOTAL[version - 1];
  const dataCodewords = total - ecPer * blocks;
  const perBlock = Math.floor(dataCodewords / blocks);
  const extra = dataCodewords % blocks;
  const sizes = [];
  for (let b = 0; b < blocks; b++) sizes.push(perBlock + (b >= blocks - extra ? 1 : 0));

  const dataBlocks = sizes.map(() => []);
  let p = 0;
  const maxData = Math.max(...sizes);
  for (let col = 0; col < maxData; col++) {
    for (let b = 0; b < blocks; b++) {
      if (col < sizes[b]) dataBlocks[b].push(codewords[p++]);
    }
  }
  const data = [].concat(...dataBlocks);

  // 5. 解析 byte 模式
  let bitPos = 0;
  const readBits = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = data[bitPos >> 3];
      v = (v << 1) | ((byte >> (7 - (bitPos & 7))) & 1);
      bitPos++;
    }
    return v;
  };

  const mode = readBits(4);
  if (mode !== 4) throw new Error('模式不是 byte 模式,得到 ' + mode);
  const lenBits = version < 10 ? 8 : 16;
  const len = readBits(lenBits);
  const bytes = [];
  for (let i = 0; i < len; i++) bytes.push(readBits(8));

  return { text: Buffer.from(bytes).toString('utf8'), version, mask, dataCodewords };
}

// ------------------------------------------------------------------ 测试

const cases = [
  'hello',
  'http://127.0.0.1:8091/',
  'http://192.168.137.1:8091/',
  'http://10.91.12.66:8091/?k=0123456789abcdef0123456789abcdef',
  'A'.repeat(17),
  'B'.repeat(130),
  '中文测试:模型灶台 · 手机访问 · http://192.168.1.5:8091/',
  'z'.repeat(271),
];

let pass = 0, fail = 0;
for (const c of cases) {
  try {
    const r = qr.make(c);
    const out = decode(r);
    const ok = out.text === c;
    if (ok) { pass++; console.log(`  ok   版本 ${String(r.version).padStart(2)} 掩码 ${out.mask}  ${c.length} 字节  ${JSON.stringify(c.slice(0, 42))}${c.length > 42 ? '...' : ''}`); }
    else {
      fail++;
      console.log(`  FAIL 版本 ${r.version}\n       原: ${JSON.stringify(c.slice(0, 60))}\n       解: ${JSON.stringify(out.text.slice(0, 60))}`);
    }
  } catch (e) {
    fail++;
    console.log(`  FAIL ${JSON.stringify(c.slice(0, 40))} -> ${e.message}`);
  }
}

console.log(`\n往返解码: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
