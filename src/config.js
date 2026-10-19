// 模型与预设清单。
// 平时只改这个文件就能增删模型、调整启动参数 —— 其它源码不用动。
const path = require('path');

const MODELS_DIR = 'D:\\';

// 归档盘。
//
// 2026-09-29 把三个不常用的模型移到 F 盘留档(D 盘让给日常用的 Heretic):
//   Bonsai-27B-Q1_0 / Ternary-Bonsai-2-27B-PTQ1_0 / Ternary-Bonsai-2-27B-Abliterated-PTQ1_0
// 搬运走的是"复制 -> SHA256 校验 -> 校验通过才删源文件",不是裸 Move-Item。
//
// ⚠ 两个注意点:
//   1) F 盘是独立物理盘。不接上时,下面挂 ARCHIVE_DIR 的三个条目会启动失败 ——
//      这是预期行为,它们只是留档,日常用的只有 MODELS_DIR 下那两个文件。
//   2) `Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf` 故意**留在 D 盘**:它是下面全局的
//      MMPROJ,搬走会让**在用的 Heretic 版**视觉预设一起失效。别顺手把它也归档。
const ARCHIVE_DIR = 'F:\\models-archive\\';

// 三个 llama.cpp 构建:
//   fast  —— **社区** sudoingX/llama.cpp 的 pr-ptq1-mmv 分支编出来的,含 PTQ1_0
//            专用 mat-vec 内核,实测预填充快一倍(332 -> 769 t/s)。
//            **但这个构建不能用来跑 Bonsai 2(三值)**:同一模型文件、同一套参数,
//            它会稳定塌缩成几百字符的连续 '/'。详见下面 prism 的说明。
//   prism —— PrismML **官方** fork 的预编译包。Bonsai 2 必须用它。
//            官方 README 说得很明确:Bonsai 2 需要 Hadamard 激活变换,尚未进入上游,
//            且"每个版本只兼容特定 fork"(Q2_0 配官方 fork,Q2_0_g64 配上游)。
//            实测对照(问题:解释反射定律,各 2 次):
//              官方 prism × PTQ1_0   -> 2/2 正常,content 750-944 字
//              官方 prism × Heretic  -> 2/2 正常
//              社区 fast  × PTQ1_0   -> 0/2,最长连续重复 708 个字符
//              社区 fast  × Heretic  -> 0/2,最长连续重复 657 个字符
//            所以三值模型一律走 prism;曾经误用 fast,导致白查了两天"模型是不是坏的"。
//   stock —— ggml-org 上游构建。Bonsai 1 的 Q1_0 在上游是开箱即用的
//            (CPU/Metal/CUDA/Vulkan 全支持),所以它配 stock 最稳。
// 路径写成绝对路径是有意的:这个外壳放在那棵目录树**旁边**,不在里面。
const WORKSPACE = 'C:\\deepseek harness\\models';
const FAST_BUILD = 'C:\\deepseek harness\\llama-cpp-mmq\\build\\bin';

const BIN = {
  fast: path.join(FAST_BUILD, 'llama-server.exe'),
  prism: path.join(WORKSPACE, 'llama-prism', 'llama-server.exe'),
  stock: path.join(WORKSPACE, 'llama-cpp', 'llama-server.exe'),
};

// 思考强度的 token 上限。
//
// llama-server 的 --reasoning-budget 默认是 **-1(无限)**。这是一道**保险**,
// 不是常态约束。
//
// 但要看清它的作用边界:实测这类极低比特量化模型的退化是**随机**的
// (同一配置 3 次里 1 次正常、2 次塌缩成连续斜杠),而且**降温、加重复惩罚
// 都不能改善**(temp 0.6 反而 3/3 全崩)。所以预算只能限制"崩多久",
// 不能减少"崩不崩"。真正的解法是换模型或关掉思考,见 README。
//
// 注意别把它和"思考档位"混为一谈:档位由 --reasoning-effort 控制,预算只
// 限制总长度。两者独立。
const REASONING_BUDGETS = [
  { key: 'unlimited', label: '不限', hint: '不干预,完全由模型自己决定何时停', value: -1 },
  { key: '8192', label: '8K', hint: '较紧,适合快问快答', value: 8192 },
  { key: '32768', label: '32K', hint: '推荐:难题够用,又能兜住失控', value: 32768 },
  { key: '65536', label: '64K', hint: '几乎等同不限', value: 65536 },
];

const DEFAULT_REASONING_BUDGET = '32768';

// 预算耗尽时**不做**任何注入。
//
// 这里原本有一条中文提示语("思考预算已用完,请立即基于已有分析给出最终答案"),
// 实测它是**退化触发器**:同一模型、同一提示词、同一采样参数下,
//   - 加上它:reasoning 1026 字符里 1016 个是 '/' (99%),content 为空,答不出
//   - 去掉它:reasoning 仅 29 字符,内容正常,正常作答
// 复现 100% 稳定。原因大概是这类量化模型对输入扰动极敏感,一段固定的长中文串
// 会把它推入重复塌缩。
//
// 所以预算只做"截断",不做"提醒":宁可停在思考中途,也不要因为一句提示
// 把整轮输出废掉。
const REASONING_BUDGET_MESSAGE = null;

// 上下文压缩 / 任务档位代理的地址。
//
// 为什么是独立进程而不塞进外壳:档位要在**请求层**改写采样参数
// (请求级优先于服务端启动参数,已实测),而外壳不该去碰 llama.cpp 的界面逻辑。
// 手机连它的端口,所以它也承担"手机访问"那一侧。
//
// PROXY_PORT 允许用环境变量覆盖,和 context-proxy.mjs 读的是同一个变量 ——
// 这一点必须一致:外壳照这个值起代理、也照它探端口,两边不同步就会出现
// "探到端口被占、但那个端口上其实没有代理"这种自相矛盾的状态。
// (这是测试在非默认端口上跑时暴露出来的。)
const PROXY_PORT = Number(process.env.PROXY_PORT || 8092);
const PROXY_BASE = 'http://127.0.0.1:' + PROXY_PORT;

const MMPROJ = 'D:\\Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf';

// ---------------------------------------------------------------- 上下文滑块
//
// 预设里的 ctx 只是**起点**,不是上限。实测(2026-09-26,本机 RTX 5060 Laptop
// 8GB,q4_0 KV + `-fa on` + `-np 1`):
//
//   Bonsai 27B Q1_0   192K -> 7809 MiB / 41.3 tok/s ; 224K -> 静默溢出,6.4 tok/s
//   Bonsai 2 三元版    96K -> 7865 MiB / 32.6 tok/s ; 128K -> 静默溢出,4.8 tok/s
//
// 为什么能开到这么大:两个模型都是 qwen35 **混合注意力**架构 —— block_count=64,
// 但 full_attention_interval=4,**只有 16 层带 KV cache**,其余 48 层是线性注意力
// (状态恒定,不随上下文增长)。实测 KV 斜率约 23 MiB / 1K token,
// 也就是说吃显存的从来是权重,不是上下文。
//
// 为什么**必须**给上限:溢出是**静默**的。`-ngl 99` 是用户显式指定的,
// llama.cpp 于是跳过自动显存适配,只在日志留一行 warning:
//
//   W common_fit_params: failed to fit params to free device memory:
//                        n_gpu_layers already set by user to 99, abort
//
// ⚠ 2026-09-29 更正:上面这行 warning **不能**当溢出判据,别再用它排查。
//   实测它在启动后 0.5 秒就打印(模型还没开始载入),而那次是**健康**的:
//   32K 上下文 / 显存 6590 MiB / 生成 30.0 t/s(正好等于该模型的实测基线)。
//   原因:只要用户显式写了 `-ngl 99`,自动适配就被跳过并留下这句 —— 恒定出现,
//   有溢出时出现、没溢出时也出现,零区分力。
//   真正的溢出判据只有 tok/s(见下一段),warning 只能说明"自动适配没参与"。
//
// 然后把 KV cache 挪到主机内存、注意力改由 CPU 算 —— 不报错、不退出,
// 只是慢 8 倍。实测 192K -> 224K 时显存读数几乎没变(7809 -> 7791),
// 速度却从 41.3 掉到 6.4 tok/s。极容易被误判成"模型不行"或"上下文太长就这样"。
const CTX_STEPS = [8192, 16384, 32768, 49152, 65536, 98304, 131072, 163840, 196608, 262144];

// 本机观测到的显存分配天花板。卡总容量 8151 MiB,系统桌面约占 300 MiB。
// (这里接管了原先散落在 PRESETS 里、从未被读取的 budgetMiB 字段。)
//
// ⚠ 它**不能**用来判断有没有溢出 —— 这是实测踩到的坑,记下来免得再犯:
//
//     三元版 @ 64K + q8_0 : 7869 MiB,但只有  4.9 tok/s   (已溢出到内存)
//     三元版 @ 96K + q4_0 : 7869 MiB,却有 31.8 tok/s     (满速)
//
//   两者显存读数**一模一样**。原因是 KV 漏到主机内存时,llama.cpp 仍会把显存
//   分配到接近上限,读数反映的是"分配了多少",不是"KV 在不在设备上"。
//
// 结论:**唯一可靠的溢出判据是 tok/s,不是显存。** 想加运行时护栏就得测速;
// 用显存做阈值只会给出假警报。上面每个模型的 safeCtx 也都是按**实测速度**
// 定的,不是按显存定的 —— 这正是它能分对的原因。
const VRAM_CEILING_MIB = 7869;

// ------------------------------------------------------------ KV cache 精度
//
// KV 量化不是"优化选项",是能不能跑的前提:`-fa on` + `-ctk/-ctv` 是这台
// 8GB 卡能开到 64K 以上的唯一原因。实测把 KV 从 q4_0 提到 f16,64K 就要
// ~9727 MiB,直接超出 8151 MiB 可用。
//
// 两种精度的取舍(本机实测):
//
//              1-bit (3.54GB 权重)      三元版 (5.54GB 权重)
//   q4_0       192K @ 41 tok/s          96K @ 31 tok/s
//   q8_0        96K @ 41 tok/s          48K @ 31 tok/s
//
// 也就是 **提高精度 = 上下文减半**。而实测两边的输出质量看不出差异
// (20 次生成,最长同字符连续都在 4-16,无乱码无塌缩),所以默认 q4_0。
//
// ⚠ KV 量化**依赖 flash attention**。`-fa off` 时 llama.cpp 会直接报错而不是
// 静默降级,所以下面 `-fa on` 与 `-ctk/-ctv` 必须成对出现,别单独删一个。
const KV_TYPES = [
  { key: 'q4_0', label: 'q4_0', hint: 'KV 压到约 1/4,上下文最大(推荐)' },
  { key: 'q8_0', label: 'q8_0', hint: 'KV 精度更高,但上下文减半' },
];
const DEFAULT_KV = 'q4_0';

/** 取某个模型在指定 KV 精度下"实测不会溢出"的上下文。 */
function safeCtxFor(model, kv) {
  if (!model || !model.safeCtx) return null;
  if (typeof model.safeCtx === 'number') return model.safeCtx;   // 兼容旧写法
  const key = KV_TYPES.some((k) => k.key === kv) ? kv : DEFAULT_KV;
  return model.safeCtx[key] || null;
}

/** 把 KV 精度键名收敛成合法值。 */
function resolveKv(kv) {
  return KV_TYPES.some((k) => k.key === kv) ? kv : DEFAULT_KV;
}

/** 把任意上下文值吸附到最近的合法档位,并夹在 [minCtx, maxCtx] 内。 */
function snapCtx(value, model) {
  const max = (model && model.maxCtx) || CTX_STEPS[CTX_STEPS.length - 1];
  const min = CTX_STEPS[0];
  const v = Number(value);
  if (!Number.isFinite(v)) return null;
  const clamped = Math.min(max, Math.max(min, v));
  let best = CTX_STEPS[0];
  for (const s of CTX_STEPS) {
    if (s > max) break;
    if (Math.abs(s - clamped) < Math.abs(best - clamped)) best = s;
  }
  return best;
}

// 视觉能力会多占约 0.9 GiB(投影器放内存)外加图片 token,
// 所以在 8 GB 卡上给它配了更小的上下文。
const PRESETS = {
  'text-64k': {
    label: '长文本 64K',
    hint: '64K 上下文,适合读长文档/代码',
    ctx: 65536,
    vision: false,
  },
  'text-32k': {
    label: '常规 32K',
    hint: '32K 上下文,显存更宽裕',
    ctx: 32768,
    vision: false,
  },
  'vision-64k': {
    label: '图片 64K',
    hint: '带视觉投影,可传图片',
    // 原为 32K。实测(2026-09-26)视觉**几乎不占显存** —— `--no-mmproj-offload`
    // 把 0.59 GiB 的投影器留在系统内存,开与不开差 ≈0 MiB:
    //   64K 开视觉 7274 MiB / 纯文本 29.4 · 带图 22.4 tok/s
    //   96K 开视觉 7888 MiB / 纯文本 27.2 · 带图 21.8 tok/s
    // 所以 32K 白白浪费了大半上下文。取 64K 而不是 96K:96K 只剩 263 MiB 余量,
    // 桌面或别的程序多吃一点就溢出;64K 有 877 MiB 余量。
    ctx: 65536,
    vision: true,
  },
  'quick-8k': {
    label: '轻量 8K',
    hint: '8K 上下文,启动最快',
    ctx: 8192,
    vision: false,
  },
};

// 侧栏可选的思考强度,映射到 llama-server 的参数。
//
// 这里刻意做成**用户可选**而不是写死。早先的版本无条件钉上
// `--reasoning-effort medium`,结果静默覆盖了聊天界面发出的思考档位 ——
// 选了「高」也照样只有浅思考。选 'server-default' 则完全不带参数,
// 由模型自己的聊天模板决定。
const REASONING = {
  'server-default': { label: '跟随模型默认', hint: '不加参数,由模板决定', flag: null },
  off: { label: '关闭思考', hint: '最快,不产出思考内容', flag: 'none' },
  low: { label: '低', hint: '浅思考', flag: 'low' },
  medium: { label: '中', hint: '推荐起点', flag: 'medium' },
  high: { label: '高', hint: '深思考,更慢', flag: 'high' },
};

// 这里的每个模型都已经在本机下载并校验过。
//
// 关于 PTQ1_0 那三个:它们**必须配 PrismML 官方构建**(BIN.prism)。
//
// 这里曾经走过一段弯路,记录下来免得重犯:先前用 BIN.fast(社区 sudoingX fork)
// 跑三值模型,结果稳定塌缩成几百字符的连续 '/',一度误判成"模型坏了"、
// "三值量化不可靠"。实际上同一模型文件换成官方 prism 构建就完全正常:
//
//   官方 prism × PTQ1_0  -> 2/2 正常(content 750-944 字,最长重复 1)
//   社区 fast  × PTQ1_0  -> 0/2,最长连续重复 708 个字符
//
// 官方 README 明确写过:Bonsai 2 需要 Hadamard 变换(尚未上游),
// 且"每个版本只兼容特定 fork"。所以这不是模型问题,是配错了二进制。
//
// BIN.fast 那个内核确实快一倍,但只对**能正确工作**的模型有意义 —— 现在没有
// 模型用它,保留仅供实验参考。
const MODELS = [
  {
    id: 'onbit',
    name: 'Bonsai 27B 1-bit',
    note: 'Q1_0 · 3.54 GB · 已归档 F 盘(上游原生支持最稳)',
    file: ARCHIVE_DIR + 'Bonsai-27B-Q1_0.gguf',
    bin: BIN.stock,
    defaultPreset: 'text-64k',
    // 本机实测:192K 仍满速(7809 MiB / 41.3 tok/s),224K 静默溢出。
    // 权重只有 3.54 GB,所以它能开最大 —— 三元版给不了。
    // q8_0 时 96K 满速(7583 MiB / 41.4 tok/s),128K 溢出(4.9 tok/s)。
    safeCtx: { q4_0: 196608, q8_0: 98304 },
    maxCtx: 262144,
    // 启动探针的对照基线(tok/s)。低于它的 60% 判定为"KV 溢出到内存"。
    probeTps: 41,
  },
  {
    id: 'ternary',
    name: 'Bonsai 2 27B 三元版',
    note: 'PTQ1_0 · 5.54 GB · 已归档 F 盘(须配官方构建)',
    file: ARCHIVE_DIR + 'Ternary-Bonsai-2-27B-PTQ1_0.gguf',
    bin: BIN.prism,
    defaultPreset: 'text-64k',
    // 本机实测:q4_0 时 96K 满速(7869 MiB / 30-32 tok/s),128K 溢出(4.8 tok/s);
    //       q8_0 时 48K 满速(7670 MiB / 30-32 tok/s), 64K 溢出(4.9 tok/s)。
    // 权重 5.54 GB 比 1-bit 多 2 GB,那 2 GB 全是从上下文里扣出来的。
    safeCtx: { q4_0: 98304, q8_0: 49152 },
    maxCtx: 262144,
    // 启动探针的对照基线(tok/s)。
    probeTps: 31,
  },
  {
    id: 'ternary-heretic',
    name: '三元版 · 去审查(Heretic)',
    note: 'PTQ1_0 · 5.54 GB · 拒答率大幅降低',
    file: MODELS_DIR + 'Ternary-Bonsai-2-27B-Heretic-PTQ1_0.gguf',
    bin: BIN.prism,
    defaultPreset: 'text-64k',
    // 本机实测:q4_0 时 96K 满速(7869 MiB / 30-32 tok/s),128K 溢出(4.8 tok/s);
    //       q8_0 时 48K 满速(7670 MiB / 30-32 tok/s), 64K 溢出(4.9 tok/s)。
    // 权重 5.54 GB 比 1-bit 多 2 GB,那 2 GB 全是从上下文里扣出来的。
    safeCtx: { q4_0: 98304, q8_0: 49152 },
    maxCtx: 262144,
    // 启动探针的对照基线(tok/s)。
    probeTps: 31,
  },
  {
    id: 'ternary-abliterated',
    name: '三元版 · 去审查(Abliterated)',
    note: 'PTQ1_0 · 5.54 GB · 已归档 F 盘(实测零拒答)',
    file: ARCHIVE_DIR + 'Ternary-Bonsai-2-27B-Abliterated-PTQ1_0.gguf',
    bin: BIN.prism,
    defaultPreset: 'text-64k',
    // 本机实测:q4_0 时 96K 满速(7869 MiB / 30-32 tok/s),128K 溢出(4.8 tok/s);
    //       q8_0 时 48K 满速(7670 MiB / 30-32 tok/s), 64K 溢出(4.9 tok/s)。
    // 权重 5.54 GB 比 1-bit 多 2 GB,那 2 GB 全是从上下文里扣出来的。
    safeCtx: { q4_0: 98304, q8_0: 49152 },
    maxCtx: 262144,
    // 启动探针的对照基线(tok/s)。
    probeTps: 31,
  },


  // ------------------------------------------------------ 35B-A3B 无审查版(2026-09-29 新增)
  //
  // 两个都是 IsValorum 的 APEX-I-MiniPlus V2.1 Abliterated(heretic 定向消融),
  // 3.40 bpw 混合精度、14.66 GB。选它的理由**不是**那个"Q6_K 档"标签 ——
  // 经查证那是噪声加一处笔误(表格里 5.3952 与 ΔPPL +0.0552 自相矛盾,
  // 且两版差异 0.027 只有误差棒 ±0.12 的 1/5)。成立的是三条硬事实:
  //   1) 结构:路由 gate 保持 F32、输出头 Q6_K、共享专家 Q5_K、注意力门 Q8_0
  //   2) 3.40 bpw 相对本机在用的 1.58 bpw 三值版是质变
  //   3) 作者是按"从系统内存流式推理"专门配的量化配方
  //
  // ⚠ 这两个**必须**给 --n-cpu-moe:权重 14.66 GB 而显存只有 8 GB。
  //   把 MoE 专家权重留在内存、注意力与共享专家放显存,才既跑得动又不慢。
  //   档位靠实测扫描确定 —— 按本项目的规矩,没量过就不写死。
  //
  // ⚠ 采样用官方推荐的 0.6,别沿用小模型那套 0.7;官方明确禁止 greedy(长生成会复读)。
  //
  // ⚠ 底座差异(这就是两个都要留的原因):
  //   qwen36-abl        底座是 Qwen3.6-35B-A3B **本体**,无长生成退化记录;
  //   qwen38distill-abl 底座是 empero-ai 从 Qwen3.8 蒸馏的 Distill。官方模型卡自述
  //     "长输出/长上下文相对 base 可能退化"(学生只在 8192 token 样本上训过),
  //     且上游承认长生成会复读;修复版 V2 截至 2026-09-29 仍无任何公开踪影。
  {
    id: 'qwen36-abl',
    name: 'Qwen3.6-35B-A3B · 去审查',
    note: '3.40bpw · 14.66GB · 需 --n-cpu-moe 分流(档位待实测)',
    file: 'D:\\Qwen3.6-35B-A3B-Abl\\Qwen3.6-35B-A3B.APEX-I-MiniPlus-V2.1-Abliterated.gguf',
    bin: BIN.stock,
    mmproj: 'D:\\Qwen3.6-35B-A3B-Abl\\mmproj-Q8_0.gguf',
    kvLayers: { total: 40, withKv: 10 },
    temp: 0.6,
    // ---- 以下全是本机实测值(2026-09-29, RTX 5060 Laptop 8GB + 单通道 DDR5-5600) ----
    //
    // --n-cpu-moe 扫描(与 3.8-Distill **完全一致**):
    //   40→2022 MiB/27.4   36→3342/30.3   32→4662/35.2   28→5910/35.4
    //   24→7086/**40.3**   20→7788/**8.9** ← 静默溢出,止损规则命中
    //   注意 24→20 时显存只涨 702 MiB(前几档每档约 1300),增速骤降正是溢出的指纹。
    // 2026-09-30 交错对照(各 3 次,ABABAB 抵消系统漂移)把 23 与 24 分开了:
    //   24 → 31.6 / 35.0 / 36.6(平均 34.4)   23 → 41.5 / 41.9 / 38.8(平均 40.7)
    //   两档区间**完全不重叠**(23 的最低 38.8 > 24 的最高 36.6)=> +18%,不是噪声。
    //   代价只有 +294 MiB 显存(6994→7288),离实测天花板 ~7869 还有 580 MiB 余量。
    //   22 档(7580 MiB)反而掉到 34.9 —— 再往下就开始贴天花板,23 是局部最优。
    //
    // 线程数用同一套交错对照(在 23 档下,各 2 次):
    //   20 → 41.0 / 34.3(平均 37.6,**极不稳定**)   12 → 42.3 / 44.0(平均 43.1,最稳)
    //    8 → 39.6 / 38.0(平均 38.8)
    // 12 最快且最可预测,还把 CPU 占用从"20 核满载"降下来 —— 直接缓解
    // "CPU 满载 90°C"那个问题。显存不受线程数影响(三档都 7288 MiB)。
    //
    // 2026-09-30 散热实测:厂商控制中心三种模式(同一负载、同一 -t 12):
    //   狂暴+OC: 4508 MHz / CPU 86°C / 风扇 4037 RPM  →  生成 44.9 t/s
    //   均衡   : 3992 MHz / CPU 74°C / 风扇 3028 RPM  →  生成 47.4 t/s   ← 推荐
    //   办公   : 2733 MHz / CPU 64°C / 风扇 2162 RPM  →  生成 41.6 t/s
    //   「均衡」是白拿的:频率降 11%、温度降 12°C、风扇降 25%,速度**没有损失**。
    //   但再往下压就有代价 ——「办公」又低 10°C,却掉了 12% 速度。
    //   所以准确的说法是:**约 3.9 GHz 以上降频不掉速,再低就不行** ——
    //   这个负载是"带宽受限、但有频率下限"型(CPU 算得太慢时它自己就成瓶颈)。
    //   另外别忘了:这些数字与"核型/线程数影响很小""预填充对 -t/-tb/n_ubatch 全免疫"
    //   互相印证,共同指向"瓶颈在内存子系统,不在算力"。
    extraArgs: ['--n-cpu-moe', '23', '-t', '12'],
    defaultPreset: 'text-64k',
    //
    // 上下文上限:
    //   q4_0 → 192K 满速(**四次独立测量** 34.5/38.2/38.4/40.1),224K 稳定溢出(9.0-9.2)。
    //          边界双向确认,所以给 196608 而不是更激进的值。
    //   q8_0 → 64K 健康(三次 36.3/38.2),96K 出现一次请求失败(边界不稳),128K 溢出。
    //          保守给 65536:这是唯一在多次测量里都稳的档。
    //   maxCtx 保留 262144(模型原生上限):超过 safeCtx 时界面会给 ⚠ 并说明后果,
    //   刻意超限仍是用户的选择 —— 与 Bonsai 系的处理方式一致。
    // ⚠️ 2026-09-30 重要修正:**safeCtx 与 --n-cpu-moe 强耦合,改 ncm 必须重测!**
    //   上面那个 196608(192K)是在 ncm **24** 下测的(7758 MiB,健康)。改成 ncm 23
    //   后每 token 多占约 294 MiB 显存,192K 直接越过天花板(约 7869 MiB):
    //   实测显存 7850/8151 MiB(只剩 301 MiB)、聊天掉到 7-16 t/s —— 而且是
    //   **服务级**的静默溢出,连"1+1 等于几"都跟着慢。
    //   当天用户实测:**160K + 视觉投影器**下 47.6 t/s 健康 → 采用 163840。
    //   重测(2026-09-30,ncm 23,机器空闲,单次测量):
    //     q4_0 → 128K 44.7 t/s / **160K 35.9 健康** / 192K **9.4 溢出**  => 163840
    //     q8_0 → 32K 34.8 / 48K 42.5 / **64K 35.7 全部健康**              => 65536
    //   q8_0 那个 32768 是我在没实测时的保守推算,**重测证明没必要** —— 64K 依然安全。
    //   但注意 64K 时离天花板只剩约 85 MiB 余量(7784 MiB),属于"能用但不宽裕";
    //   想更稳可以用 48K(7634 MiB,多 150 MiB 余量)。
    safeCtx: { q4_0: 163840, q8_0: 65536 },
    maxCtx: 262144,
    // 启动探针基线。2026-09-30 直接用**探针本身**在 160K 下实测 51.3 t/s(ncm 23 / -t 12),
    //   所以基线定到 50:判定线 = 50 × 0.6 = 30。
    //   定高一点的意义:溢出会掉到 9 左右(必抓),而"部分溢出"掉到 30-40 这种
    //   以前基线 40 时会漏判的档,现在也能抓到。
    probeTps: 50,
  },
  {
    id: 'qwen38distill-abl',
    name: 'Qwen3.8-Distill-35B-A3B · 去审查',
    note: '3.40bpw · 14.66GB · 蒸馏版,长输出有已知退化',
    file: 'D:\\Qwen3.8-35B-A3B-Distill-Abl\\Qwen3.8-35B-A3B-Distill.APEX-I-MiniPlus-V2.1-Abliterated.gguf',
    bin: BIN.stock,
    mmproj: 'D:\\Qwen3.8-35B-A3B-Distill-Abl\\mmproj-Q8_0.gguf',
    kvLayers: { total: 40, withKv: 10 },
    temp: 0.6,
    // ---- 实测值同 3.6 版(两个模型几何完全相同,扫描结果逐档一致) ----
    //   唯一差异:A/B 实测 3.8 的正文更短(14,669 字/333 行 vs 16,143/534),
    //   但速度、显存、上下文边界都相同。
    //   --n-cpu-moe 23 与 -t 12 均由交错对照定出(数据见 3.6 条目);两模型几何相同故共用。
    //   另:散热模式建议「均衡」——"狂暴+OC"只买到 +12°C,速度不变(实测见 3.6 条目)。
    extraArgs: ['--n-cpu-moe', '23', '-t', '12'],
    defaultPreset: 'text-64k',
    //   同上:**safeCtx 随 --n-cpu-moe 变**。192K 是 ncm 24 时的值,ncm 23 下实测溢出
    //   (本次复现:196608 → 7800 MiB / **9.4 t/s**)。160K 健康(用户实测 47.6 t/s)。
    //   q8_0 重测后确认仍是 64K,完整数据见 3.6 条目。
    safeCtx: { q4_0: 163840, q8_0: 65536 },
    maxCtx: 262144,
    // 探针基线 50:与 3.6 同(探针在 160K 下实测 51.3 t/s,详见 3.6 条目注释)
    probeTps: 50,
  },


  // 【警告】不要给 Bonsai 2(PTQ1_0)添加任何「更快的构建」条目。
  // 社区 fork(sudoingX/llama.cpp 的 pr-ptq1-mmv,即 BIN.fast / llama-cpp-mmq)虽然
  // 加载只要 2.5 秒(官方构建要 19 秒)、预填充还快一倍,但对 Bonsai 2 会【稳定塌缩】:
  // 实测最长连续重复 657~708 个字符,输出整片是斜杠。
  // README「fork 与 gguf 必须配对」一节有完整实测表。
  // 那 19 秒加载是官方构建为 Hadamard 激活变换付出的代价,没有捷径。
  // BIN.fast 保留仅供参考,不要挂到任何三元模型上。
];

// ---------------------------------------------------------------- 混合注意力的层数
//
// 给每个模型补上"多少层里有多少层带 KV cache"。界面用它生成
// "为什么上下文便宜"的解释文案。
//
// 为什么必须有这个字段:那段文案原来把层数**写死**成"64 层里只有 16 层带 KV cache",
// 加了 Qwen3.6/3.8-35B-A3B 之后就成了**事实错误**。
// 数字来源:
//   Bonsai 系(qwen35 混合注意力):block_count = 64,full_attention_interval = 4 → 16 层;
//   Qwen3.6-35B-A3B 系 MoE:40 层里 10 层完整注意力,其余是 DeltaNet 线性注意力
//     (见 IsValorum 模型卡的 tensor map 与实测量化说明)。
//
// 默认给 Bonsai 的值,因为那 4 个是历史条目;MoE 那两个在自己的条目里显式写了 kvLayers。
const KV_LAYERS_DEFAULT = { total: 64, withKv: 16 };
for (const m of MODELS) {
  if (!m.kvLayers) m.kvLayers = KV_LAYERS_DEFAULT;
}

/**
 * 为「模型 + 预设」拼出 llama-server 的命令行。
 *
 * 下面这些参数是 8 GB 显存档位的社区配置
 * (sudoingX/bonsai2-small-gpu)。每一条都有理由:
 *   -fa on              flash attention,省掉计算缓冲
 *   -np 1               单槽位;多一个槽位白吃约 450 MiB
 *   -ctk q4_0 -ctv q4_0 KV cache 压到 1/4 —— 64K 能塞进 8GB 全靠这个
 *   --jinja             启用工具调用
 *   --temp/--top-p/--top-k  模型卡推荐的思考模式采样值
 *
 * reasoningKey 的三种取值:
 *   未传 / null / 'server-default' —— 都不加 --reasoning-effort,由模型模板
 *     或聊天界面里那个按对话的控件决定。这是默认行为。
 *   其它已知档位 —— 加对应的 flag。
 *
 * 只有在明确要「服务级固定档位」时才传 reasoningKey。注意服务端 flag 会盖住
 * 界面里按对话设置的档位,因为界面通常以请求参数下发,优先级低于服务端配置。
 *
 * lanMode 为 true 时监听 0.0.0.0,手机才能连上;同网段的人也能连。
 * 默认只监听 127.0.0.1。手机访问的可行做法是让电脑(或手机)开热点,
 * 这样安全边界就是热点本身,不依赖校园网是否允许设备互访。
 *
 * apiKey 非空时加 --api-key,所有接口都要带 Authorization: Bearer <key>。
 *
 * 另外按 reasoningBudgetKey 加 --reasoning-budget。这是一道保险,防止模型
 * 陷入重复生成后停不下来;默认 32K,想完全不干预可以选「不限」。
 * 详见 REASONING_BUDGETS 的注释。
 *
 * 关于 API Key 与网页界面:llama.cpp 自带的 Web UI **认识**这个 Key ——
 * 检测到 401 会弹一个输入框,校验通过就存进浏览器 localStorage,之后免输。
 * 所以手机只需输一次。注意 / 这个页面本身是放行的(不然连输入框都拿不到),
 * 被挡住的是 /v1/* 与 /props 这些真正的接口。
 *
 * ctxOverride 是界面上那个上下文滑块的取值,单位 token。
 * 传 null / undefined / 空串 => 用预设自带的 ctx(旧行为,完全不变)。
 * 传具体数字 => 先 snapCtx() 吸附档位并夹到 model.maxCtx,再覆盖预设的 ctx。
 * 校验放在这里而不是界面里,是因为这是**唯一**能决定 `-c` 的地方 ——
 * 界面漏校验一次,代价就是用户看到模型莫名变慢 8 倍。
 *
 * overrides 是可选覆盖项(第 8 个位置参数,本身就是个对象,方便以后扩展):
 *   overrides.ctx  上下文 token 数,见上
 *   overrides.kv   KV cache 精度键名('q4_0' / 'q8_0'),非法值回落到默认
 *
 * 另有三个**可选 per-model 字段**,不写就完全保持原行为(为 35B-A3B 那两个加的):
 *   model.mmproj    该模型自己的视觉投影器;留空用全局 MMPROJ
 *                   (两个 Qwen 仓库都发了一个叫 mmproj-Q8_0.gguf 的文件,
 *                    同名不同内容,所以必须 per-model,不能共用全局那个)
 *   model.temp / model.topP / model.topK
 *                   该模型自己的采样参数;留空用 0.7 / 0.95 / 20。
 *                   Qwen 系列官方推荐 0.6 / 0.95 / 20,且明确禁止 greedy。
 *   model.extraArgs 追加到命令行的参数数组,例如 ['--n-cpu-moe', '32']
 */
function buildArgs(model, presetKey, port, reasoningKey, lanMode, apiKey, budgetKey, overrides) {
  const preset = PRESETS[presetKey];
  if (!preset) throw new Error('未知的预设: ' + presetKey);

  // 没指定、或指定了「跟随模型默认」,都表示不加参数。
  const reasoning = reasoningKey ? REASONING[reasoningKey] : null;

  // 可选覆盖项收进一个对象,而不是继续往参数表尾部堆位置参数 ——
  // 这个函数本来就已经有 7 个位置参数了,再多两个没人记得住顺序。
  // 以后加新选项也只动这里,不必改所有调用点。
  const ctxOverride = overrides ? overrides.ctx : undefined;
  const kv = resolveKv(overrides ? overrides.kv : undefined);

  // 滑块传来的上下文。吸附到合法档位并夹在模型上限内 —— 这一层是必须的,
  // 不能让界面直接决定 `-c`,否则一次误拖就是静默溢出(见上面 VRAM_CEILING_MIB)。
  // 留空则用预设自带的 ctx,保持原有行为不变。
  //
  // ⚠ 2026-09-29 新增:预设来源的 ctx 还要**夹到该 KV 精度下的实测安全上限**。
  //   原因:预设里的 ctx 是固定数字,而 safeCtx 随 KV 精度变 ——
  //   "长文本 64K" 预设 + q8_0(三值模型实测安全上限只有 49152)会直接落在溢出区,
  //   表现是静默慢 6-8 倍(见 config.js 顶部的实测记录)。
  //   注意**只夹预设来源**的值:滑块传进来的具体数字是用户显式选择,
  //   界面已经给了 ⚠ 和解释,不该被这里悄悄改掉。
  const safeNow = safeCtxFor(model, kv);
  const safePresetCtx = (safeNow && preset.ctx > safeNow) ? safeNow : preset.ctx;
  const ctx = ctxOverride === null || ctxOverride === undefined || ctxOverride === ''
    ? safePresetCtx
    : (snapCtx(ctxOverride, model) || safePresetCtx);

  const args = [
    '-m', model.file,
    '-c', String(ctx),
    '-ngl', '99',
    // -fa on 与下面两行必须成对:KV 量化依赖 flash attention。
    '-fa', 'on',
    '-np', '1',
    '-ctk', kv,
    '-ctv', kv,
    '--jinja',
    // 官方 model card 明确给出思考模式下的推荐采样,且实测报告的分数都基于这组值:
    //   Temperature 0.7 / Top-p 0.95 / Top-k 20
    // 这里原来是 temp 1.0 —— 偏高,会放大低比特模型的采样噪声。
    // 可用 model.temp/topP/topK 逐模型覆盖(如 Qwen 官方要 0.6)。
    '--temp', String(model.temp ?? 0.7),
    '--top-p', String(model.topP ?? 0.95),
    '--top-k', String(model.topK ?? 20),
    '--host', lanMode ? '0.0.0.0' : '127.0.0.1',
    '--port', String(port),
  ];

  if (reasoning && reasoning.flag) {
    args.push('--reasoning-effort', reasoning.flag);
  }

  // /slots 默认开启,会回报每个槽位正在处理的内容 —— 也就是别人能看到你的提问。
  // 绑到网络上时关掉。
  if (lanMode) args.push('--no-slots');

  // 思考预算。'off' 档位下模型本就不思考,不必加。
  // 预算为 -1(不限)时也不加参数,保持 llama-server 默认行为。
  if (reasoningKey !== 'off') {
    const budget = resolveBudget(budgetKey);
    if (budget.value >= 0) {
      args.push('--reasoning-budget', String(budget.value));
      // 提示语默认是 null(实测它会诱发退化),只有显式配置了才加。
      if (REASONING_BUDGET_MESSAGE) {
        args.push('--reasoning-budget-message', REASONING_BUDGET_MESSAGE);
      }
    }
  }

  // 只在真的设了 Key 时才加。留空表示不鉴权 —— 局域网模式下等于
  // 同网段任何人都能用,界面上必须把这件事说清楚。
  if (apiKey) args.push('--api-key', apiKey);

  if (preset.vision) {
    // per-model 投影器优先;没写才回落到全局那个(现有 Bonsai 系列走这条)
    args.push('--mmproj', model.mmproj || MMPROJ, '--no-mmproj-offload', '--image-max-tokens', '1024');
  }

  // 逐模型追加参数(如 --n-cpu-moe)。放最后,便于覆盖前面的默认值。
  if (Array.isArray(model.extraArgs) && model.extraArgs.length) {
    args.push(...model.extraArgs);
  }
  return args;
}

/** 把预算键名解析成具体档位;键名缺失或无效时回落到默认档。 */
function resolveBudget(key) {
  if (key) {
    const hit = REASONING_BUDGETS.find((b) => b.key === key);
    if (hit) return hit;
  }
  return REASONING_BUDGETS.find((b) => b.key === DEFAULT_REASONING_BUDGET) || REASONING_BUDGETS[0];
}

module.exports = {
  MODELS, PRESETS, REASONING, REASONING_BUDGETS, DEFAULT_REASONING_BUDGET,
  BIN, MMPROJ, MODELS_DIR, buildArgs, resolveBudget,
  PROXY_PORT, PROXY_BASE,
  CTX_STEPS, VRAM_CEILING_MIB, snapCtx,
  KV_TYPES, DEFAULT_KV, safeCtxFor, resolveKv,
};
