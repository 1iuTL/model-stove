// model-stove —— 极简二维码生成器(byte 模式,纠错等级 L,版本 1-10)。
//
// 为什么要自己写:外壳要求**完全离线**。引一个 npm 包就得处理打包和
// 内网 registry 的问题,而这里只需要能编出一条 http://192.168.x.x:8091/
// 这样的短链接(几十字节),用不到 QR 规范里的大部分功能。
// 所以只实现最小可用子集:byte 模式、纠错 L、版本 1-10、单块/多块交织。
//
// 数据容量对照(纠错 L,byte 模式):
//   版本 3  = 53 字节    版本 6  = 134 字节   版本 10 = 271 字节
// 一条带 32 位 Key 的局域网地址大约 90 字节,落在版本 6-7。
//
// 这个文件不依赖任何东西,可以直接在浏览器里 require 或当普通脚本读。

(function (root) {
  'use strict';

  // (每块纠错码字数, 块数) —— 只列纠错等级 L。
  // 索引 = 版本 - 1。版本 1-5 是单块。
  var EC_L = [
    [7, 1], [10, 1], [15, 1], [20, 1], [26, 1],
    [18, 2], [20, 2], [24, 2], [30, 2], [18, 4],
  ];

  // 各版本总码字数(数据 + 纠错)。
  var TOTAL_CODEWORDS = [
    26, 44, 70, 100, 134, 172, 196, 242, 292, 346,
  ];

  // 5x5 定位图案的中心坐标。版本 1 没有。
  var ALIGN = [
    [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
    [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
  ];

  // ------------------------------------------------------------ GF(256)

  var EXP = new Array(512);
  var LOG = new Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;   // 本原多项式 x^8+x^4+x^3+x^2+1
    }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();

  function mul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }

  /**
   * 生成多项式 g(x) = (x-a^0)(x-a^1)...(x-a^(n-1)),按次数降序返回系数。
   * 常数项恒为 1,不过这里照样算出来,不特判。
   */
  function generatorPoly(n) {
    var g = [1];
    for (var i = 0; i < n; i++) {
      var next = new Array(g.length + 1).fill(0);
      for (var j = 0; j < g.length; j++) {
        next[j] ^= g[j];                    // 乘 x
        next[j + 1] ^= mul(g[j], EXP[i]);   // 乘 a^i
      }
      g = next;
    }
    return g;
  }

  /** 对 data 做多项式除法,返回 n 个纠错码字。 */
  function ecCodewords(data, n) {
    var gen = generatorPoly(n);
    var rem = new Array(n).fill(0);
    for (var i = 0; i < data.length; i++) {
      var factor = data[i] ^ rem[0];
      rem.shift();
      rem.push(0);
      if (factor !== 0) {
        for (var j = 0; j < n; j++) rem[j] ^= mul(gen[j + 1], factor);
      }
    }
    return rem;
  }

  // ------------------------------------------------------------ 位缓冲

  function BitBuffer() { this.bits = []; }
  BitBuffer.prototype.put = function (value, length) {
    for (var i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  };
  BitBuffer.prototype.length = function () { return this.bits.length; };
  BitBuffer.prototype.toBytes = function () {
    while (this.bits.length % 8 !== 0) this.bits.push(0);
    var out = [];
    for (var i = 0; i < this.bits.length; i += 8) {
      var b = 0;
      for (var j = 0; j < 8; j++) b = (b << 1) | this.bits[i + j];
      out.push(b);
    }
    return out;
  };

  // ------------------------------------------------------------ 编码

  /**
   * 把任意文本编成最终的码字序列(已交织)。
   * 返回 { codewords, version }。
   */
  function encode(text) {
    // 先按 UTF-8 转字节。二维码本身不管字符集,长度按字节算。
    var bytes = [];
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      if (c < 0x80) bytes.push(c);
      else if (c < 0x800) {
        bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      } else {
        bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      }
    }

    var version = 0;
    var dataCodewords = 0;
    var ecPerBlock = 0;
    var blocks = 0;

    for (var v = 1; v <= 10; v++) {
      var ec = EC_L[v - 1];
      var total = TOTAL_CODEWORDS[v - 1];
      var dc = total - ec[0] * ec[1];
      // 模式指示符 4 位 + 字节数指示符(版本 1-9 是 8 位,10 是 16 位)
      var lenBits = v < 10 ? 8 : 16;
      if (4 + lenBits + bytes.length * 8 <= dc * 8) {
        version = v; dataCodewords = dc; ecPerBlock = ec[0]; blocks = ec[1];
        break;
      }
    }
    if (!version) throw new Error('内容太长,超出二维码版本 10 的容量');

    var lenBits = version < 10 ? 8 : 16;
    var buf = new BitBuffer();
    buf.put(4, 4);                       // 0100 = byte 模式
    buf.put(bytes.length, lenBits);
    for (var k = 0; k < bytes.length; k++) buf.put(bytes[k], 8);

    // 结束符:最多 4 个 0,但也不能撑破容量。
    var capacityBits = dataCodewords * 8;
    var term = Math.min(4, capacityBits - buf.length());
    if (term > 0) buf.put(0, term);
    // 补到字节边界
    while (buf.length() % 8 !== 0) buf.bits.push(0);

    var data = buf.toBytes();
    // 交替填充 0xEC / 0x11,这是规范指定的补位字节。
    var pad = [0xec, 0x11];
    var pi = 0;
    while (data.length < dataCodewords) data.push(pad[pi++ % 2]);

    // 分块并各自算纠错。
    var perBlock = Math.floor(dataCodewords / blocks);
    var extra = dataCodewords % blocks;
    var dataBlocks = [];
    var ecBlocks = [];
    var offset = 0;
    for (var bi = 0; bi < blocks; bi++) {
      var size = perBlock + (bi >= blocks - extra ? 1 : 0);
      var chunk = data.slice(offset, offset + size);
      offset += size;
      dataBlocks.push(chunk);
      ecBlocks.push(ecCodewords(chunk, ecPerBlock));
    }

    // 交织:先按列取遍所有数据块,再按列取遍所有纠错块。
    var out = [];
    var maxData = Math.max.apply(null, dataBlocks.map(function (b) { return b.length; }));
    for (var col = 0; col < maxData; col++) {
      for (var b2 = 0; b2 < blocks; b2++) {
        if (col < dataBlocks[b2].length) out.push(dataBlocks[b2][col]);
      }
    }
    for (var col2 = 0; col2 < ecPerBlock; col2++) {
      for (var b3 = 0; b3 < blocks; b3++) out.push(ecBlocks[b3][col2]);
    }

    return { codewords: out, version: version };
  }

  // ------------------------------------------------------------ 矩阵

  /** 生成未填数据的矩阵骨架:定位/校正/时序图案,以及占位标记。 */
  function buildMatrix(version) {
    var size = version * 4 + 17;
    var m = [];
    var reserved = [];   // true 表示这格已经被图案或格式信息占用
    for (var i = 0; i < size; i++) {
      m.push(new Array(size).fill(0));
      reserved.push(new Array(size).fill(false));
    }

    function set(x, y, v) {
      if (x < 0 || y < 0 || x >= size || y >= size) return;
      m[y][x] = v;
      reserved[y][x] = true;
    }

    // 三个 7x7 定位图案 + 一圈白边(分隔符)
    var corners = [[0, 0], [size - 7, 0], [0, size - 7]];
    for (var c = 0; c < corners.length; c++) {
      var ox = corners[c][0];
      var oy = corners[c][1];
      for (var y = -1; y <= 7; y++) {
        for (var x = -1; x <= 7; x++) {
          var inX = x >= 0 && x <= 6;
          var inY = y >= 0 && y <= 6;
          var dark = inX && inY && (x === 0 || x === 6 || y === 0 || y === 6 ||
            (x >= 2 && x <= 4 && y >= 2 && y <= 4));
          set(ox + x, oy + y, dark ? 1 : 0);
        }
      }
    }

    // 定位图案(版本 2 起才有),注意别盖到三个角上的定位图案
    var centers = ALIGN[version - 1];
    for (var a = 0; a < centers.length; a++) {
      for (var b = 0; b < centers.length; b++) {
        var cx = centers[a];
        var cy = centers[b];
        var nearCorner = (cx <= 8 && cy <= 8) ||
          (cx >= size - 9 && cy <= 8) ||
          (cx <= 8 && cy >= size - 9);
        if (nearCorner) continue;
        for (var dy = -2; dy <= 2; dy++) {
          for (var dx = -2; dx <= 2; dx++) {
            var ring = Math.max(Math.abs(dx), Math.abs(dy));
            set(cx + dx, cy + dy, ring === 1 ? 0 : 1);
          }
        }
      }
    }

    // 时序图案:第 6 行与第 6 列,黑白相间
    for (var t = 8; t < size - 8; t++) {
      set(t, 6, t % 2 === 0 ? 1 : 0);
      set(6, t, t % 2 === 0 ? 1 : 0);
    }

    // 固定为深的那个模块
    set(8, size - 8, 1);

    // 预留格式信息区(第 8 行/列,以及左下、右上两小段)
    for (var f = 0; f <= 8; f++) {
      if (!reserved[8][f]) set(f, 8, 0);
      if (!reserved[f][8]) set(8, f, 0);
    }
    // 右上 8 格,左下只有 7 格 —— 左下第 8 格是那个恒为深的模块,
    // 多留一格就会把它冲成浅色。
    for (var g = 0; g < 8; g++) {
      set(size - 1 - g, 8, 0);
      if (g < 7) set(8, size - 1 - g, 0);
    }

    // 版本信息(版本 7 起):两个 3x6 区块
    if (version >= 7) {
      var rem = version;
      for (var vb = 0; vb < 12; vb++) {
        rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      }
      var bits = (version << 12) | rem;
      for (var vi = 0; vi < 18; vi++) {
        var bit = (bits >>> vi) & 1;
        var r = Math.floor(vi / 3);
        var col = vi % 3;
        set(size - 11 + col, r, bit);
        set(r, size - 11 + col, bit);
      }
    }

    return { matrix: m, reserved: reserved, size: size };
  }

  /** 按之字形把码字填进矩阵,返回填入的模块坐标(供掩码阶段使用)。 */
  function placeData(m, reserved, size, codewords) {
    var bitIndex = 0;
    var totalBits = codewords.length * 8;
    var cells = [];
    var upward = true;

    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;   // 第 6 列是时序图案,跳过
      for (var vert = 0; vert < size; vert++) {
        var y = upward ? size - 1 - vert : vert;
        for (var c = 0; c < 2; c++) {
          var x = right - c;
          if (reserved[y][x]) continue;
          var bit = 0;
          if (bitIndex < totalBits) {
            bit = (codewords[bitIndex >> 3] >>> (7 - (bitIndex & 7))) & 1;
          }
          m[y][x] = bit;
          cells.push([x, y]);
          bitIndex++;
        }
      }
      upward = !upward;
    }
    return cells;
  }

  /**
   * 掩码条件。
   *
   * 参数按 (x=列, y=行) 传入。注意规范里这些公式是用 (行 i, 列 j) 写的,
   * 而掩码 1 看成行、掩码 2 看成列 —— 两者不对称,很容易把 x/y 弄反。
   * 这里统一换算好:x 对应规范的 j,y 对应规范的 i。
   */
  function maskFn(id, x, y) {
    switch (id) {
      case 0: return (y + x) % 2 === 0;
      case 1: return y % 2 === 0;                                  // 看行
      case 2: return x % 3 === 0;                                  // 看列
      case 3: return (y + x) % 3 === 0;
      case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
      case 5: return ((y * x) % 2) + ((y * x) % 3) === 0;
      case 6: return (((y * x) % 2) + ((y * x) % 3)) % 2 === 0;
      default: return (((y * x) % 3) + ((y + x) % 2)) % 2 === 0;   // 掩码 7
    }
  }

  // 格式信息查表:纠错等级 L 的 8 组(索引 = 掩码编号)。
  var FORMAT_L = [
    0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976,
  ];

  /**
   * 写入格式信息。
   *
   * 规范里格式信息 15 位,要写**两份**。这里最容易搞错的是两份的形状:
   * 它们不是"一条竖、一条横",而是各 15 个模块、且都贴着第 8 行/第 8 列:
   *
   *   垂直份:(x=8, y=0..5) 位 0-5,(x=8, y=7) 位 6,(x=8, y=8) 位 7,
   *          (x=8, y=size-7..size-1) 位 8-14      <- 只有 7 格,到此为止
   *   水平份:(y=8, x=size-1..size-8) 位 0-7,(y=8, x=7..0) 位 8-14
   *
   * 左下角第 size-8 行那格是恒深模块,不属于格式信息 ——
   * 早期版本在这里多写一格,掩码 4-7 时正好把它冲成浅色。
   */
  function applyFormat(m, size, mask) {
    var bits = FORMAT_L[mask];
    for (var i = 0; i < 15; i++) {
      var bit = (bits >>> i) & 1;

      // 垂直份
      if (i < 6) m[i][8] = bit;
      else if (i < 8) m[i + 1][8] = bit;
      else m[size - 15 + i][8] = bit;

      // 水平份
      if (i < 8) m[8][size - 1 - i] = bit;
      else if (i < 9) m[8][15 - i - 1 + 1] = bit;
      else m[8][15 - i - 1] = bit;
    }
  }

  /**
   * 按规范给掩码打分(分数越低越好)。四条规则:
   *
   *   1. 每个模块看它 3x3 邻域里有多少个同色(不含自己)。超过 5 个就
   *      加 3 + (超出部分)。注意这是**邻域计数**,不是"连续同色长度"。
   *   2. 每个 2x2 块如果四格同色,加 3。
   *   3. 出现 1:1:3:1:1 的类定位图案序列(1011101),加 40。
   *   4. 深色占比偏离 50% 越多加得越多:每偏 5% 加 10,且**不取整**。
   *
   * 这四条必须照规范写。写得"差不多"会让掩码选择与主流实现不同 ——
   * 码仍然合法(格式信息如实记录了掩码号),但脱离参考实现就说明
   * 罚分逻辑有偏差,值得纠正。
   */
  function penalty(m, size) {
    var score = 0;
    var x, y, r, c;

    // 规则 1:3x3 邻域同色计数
    for (y = 0; y < size; y++) {
      for (x = 0; x < size; x++) {
        var same = 0;
        var dark = m[y][x];
        for (r = -1; r <= 1; r++) {
          if (y + r < 0 || y + r >= size) continue;
          for (c = -1; c <= 1; c++) {
            if (x + c < 0 || x + c >= size) continue;
            if (r === 0 && c === 0) continue;
            if (dark === m[y + r][x + c]) same++;
          }
        }
        if (same > 5) score += 3 + same - 5;
      }
    }

    // 规则 2:2x2 同色块
    for (y = 0; y < size - 1; y++) {
      for (x = 0; x < size - 1; x++) {
        var v = m[y][x];
        if (v === m[y][x + 1] && v === m[y + 1][x] && v === m[y + 1][x + 1]) score += 3;
      }
    }

    // 规则 3:1011101 序列,横向与纵向各扫一遍
    function scan(horizontal) {
      var s = 0;
      for (var a = 0; a < size; a++) {
        for (var b = 0; b + 6 < size; b++) {
          var p = [];
          for (var k = 0; k < 7; k++) {
            p.push(horizontal ? m[a][b + k] : m[b + k][a]);
          }
          if (p[0] && !p[1] && p[2] && p[3] && p[4] && !p[5] && p[6]) s += 40;
        }
      }
      return s;
    }
    score += scan(true) + scan(false);

    // 规则 4:深色占比。刻意不取整 —— 取整会让分数细粒度丢失。
    var darkCount = 0;
    for (y = 0; y < size; y++) {
      for (x = 0; x < size; x++) if (m[y][x]) darkCount++;
    }
    var ratio = Math.abs((100 * darkCount) / size / size - 50) / 5;
    score += ratio * 10;

    return score;
  }

  /**
   * 生成二维码矩阵。返回 { size, modules } —— modules[y][x] 为 0/1。
   * text 超出容量会抛错。
   */
  function make(text) {
    var enc = encode(text);
    var version = enc.version;
    var built = buildMatrix(version);
    var size = built.size;
    var cells = placeData(built.matrix, built.reserved, size, enc.codewords);

    // 逐个试 8 种掩码,选罚分最低的那个。
    var best = null;
    var bestScore = Infinity;
    for (var mask = 0; mask < 8; mask++) {
      var trial = built.matrix.map(function (row) { return row.slice(); });
      for (var i = 0; i < cells.length; i++) {
        var x = cells[i][0];
        var y = cells[i][1];
        if (maskFn(mask, x, y)) trial[y][x] ^= 1;
      }
      applyFormat(trial, size, mask);
      var s = penalty(trial, size);
      if (s < bestScore) { bestScore = s; best = trial; }
    }

    return { size: size, modules: best, version: version };
  }

  /**
   * 渲染成 SVG 字符串。用 SVG 而不是 canvas:矢量放大不糊,
   * 而且不用等图片解码,手机扫起来更稳。
   */
  function toSvg(text, opts) {
    opts = opts || {};
    var quiet = opts.quiet == null ? 2 : opts.quiet;   // 静默区,规范要求 4,留 2 也够扫
    var qr = make(text);
    var dim = qr.size + quiet * 2;

    var path = [];
    for (var y = 0; y < qr.size; y++) {
      for (var x = 0; x < qr.size; x++) {
        if (qr.modules[y][x]) path.push('M' + (x + quiet) + ' ' + (y + quiet) + 'h1v1h-1z');
      }
    }

    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + dim + ' ' + dim +
      '" shape-rendering="crispEdges" width="100%" height="100%">' +
      '<rect width="' + dim + '" height="' + dim + '" fill="#fff"/>' +
      '<path d="' + path.join('') + '" fill="#000"/></svg>';
  }

  var api = { make: make, toSvg: toSvg, encode: encode };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ModelStoveQR = api;
})(typeof window !== 'undefined' ? window : globalThis);
