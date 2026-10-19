// 启动参数门控与失败分类。
//
// 这一层刻意放在 src/config.js 的 buildArgs() **外面**：
//   - buildArgs() 继续按 P0 的语义生成“理想 argv”，90 例快照逐字节不变；
//   - gateArgs() 再根据构建能力删掉这个构建不认识的参数；
//   - 探测失败（caps 未知）时 gateArgs() 原样返回，保持旧行为。
//
// 另外两类信息也在这里，因为都只与“启动失败”有关：
//   - classifyStartupError(日志尾巴)：把 llama-server 的原始报错归成几类；
//   - planRetry(legacyArgs, caps, kind)：给出**一次**降级的 argv 与建议文本。
const cfg = require('../config');
const capsModule = require('./capabilities');

// “开关 + 一个值”的参数。表里没有的单横线/双横线 token 都按布尔开关处理。
// 这张表必须覆盖 buildArgs() 可能产出的所有带值参数，否则值会被当成开关。
const VALUE_FLAGS = new Set([
  '-m', '-c', '-ngl', '-fa', '-np', '-ctk', '-ctv', '-t',
  '--temp', '--top-p', '--top-k', '--host', '--port',
  '--reasoning-effort', '--reasoning-budget', '--reasoning-budget-message',
  '--api-key', '--mmproj', '--image-max-tokens', '--n-cpu-moe',
]);

const REQUIRED_SET = new Set(capsModule.REQUIRED_FLAGS);
const FLAG_TOKEN_RE = /^--?[A-Za-z][A-Za-z0-9-]*$/;

/** 某个 token 看起来是不是参数（负数等值不会被误判成开关）。 */
function looksLikeFlag(token) {
  return typeof token === 'string' && FLAG_TOKEN_RE.test(token);
}

/** caps 是否给出了可用且结构完整的参数集合。 */
function capsKnown(caps) {
  return !!caps && caps.ok === true
    && (caps.flags instanceof Set || Array.isArray(caps.flags));
}

function sameArgs(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** 从 argv 里删掉一个（可能带值的）参数；返回新数组与被删值。 */
function removeFlag(args, flag, dropped) {
  const out = [];
  let removed = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== flag) {
      out.push(args[i]);
      continue;
    }
    const takesValue = VALUE_FLAGS.has(flag);
    const value = takesValue && i + 1 < args.length ? args[i + 1] : null;
    dropped.push({ flag, value });
    if (takesValue && i + 1 < args.length) i++;
    removed = true;
  }
  return { args: out, removed };
}

/** 给日志/错误文案用的 dropped 摘要。 */
function formatDropped(dropped) {
  if (!Array.isArray(dropped) || !dropped.length) return '';
  const parts = dropped.slice(0, 10).map((d) => (
    d.value == null ? d.flag : `${d.flag} ${d.value}`
  ));
  return parts.join(', ') + (dropped.length > 10 ? ' 等' : '');
}

/**
 * 按构建能力过滤 config.buildArgs() 的输出。
 *
 * 返回 { args, dropped, unsupportedRequired }：
 *   - dropped：[{ flag, value }]，布尔开关的 value 为 null；
 *   - unsupportedRequired：缺了会让外壳无法工作的核心参数，调用方应报错而不是继续。
 *
 * 兼容模式：caps 未知/探测失败 → 原样返回（见 capabilities.supports 的注释）。
 *
 * 两条联动规则：
 *   1. -fa 被删 → -ctk/-ctv 一起删。KV 量化依赖 flash attention，单删一个
 *      只会换一种报错。
 *   2. --mmproj 被删 → --no-mmproj-offload / --image-max-tokens 一起删。
 *      没有投影器时这两个参数没有意义，有些构建还会因此拒绝启动。
 *
 * --jinja 是例外：不支持也**保留**。聊天模板是自带 Web UI 工作的前提，
 * 这里静默删掉只会让界面变成纯补全，用户不知道发生了什么。交给上层在
 * classifyStartupError/planRetry 里明确处理（missing-chat-template → 去掉）。
 */
function gateArgs(legacyArgs, caps) {
  const input = Array.isArray(legacyArgs) ? legacyArgs.slice() : [];
  const dropped = [];
  const unsupportedRequired = [];

  if (!capsKnown(caps)) {
    // 兼容模式：宁可发出去让 llama 报 unknown argument，也不静默少参数。
    return { args: input, dropped, unsupportedRequired };
  }

  const kept = [];
  for (let i = 0; i < input.length; i++) {
    const token = input[i];
    if (!looksLikeFlag(token)) {
      kept.push(token);
      continue;
    }

    const takesValue = VALUE_FLAGS.has(token);
    const hasValue = takesValue && i + 1 < input.length;
    const value = hasValue ? input[i + 1] : null;

    // 核心参数缺了不能删：明确记下来让上层报“构建太旧/不是 llama-server”。
    if (REQUIRED_SET.has(token)) {
      if (!capsModule.supportsRequired(caps, token)) unsupportedRequired.push(token);
      kept.push(token);
      if (hasValue) { kept.push(value); i++; }
      continue;
    }

    if (!capsModule.supports(caps, token)) {
      if (token === '--jinja') {
        // 见函数头注释：模板能力是聊天界面必需，不做静默降级。
        kept.push(token);
        continue;
      }
      dropped.push({ flag: token, value });
      if (hasValue) i++;
      continue;
    }

    kept.push(token);
    if (hasValue) { kept.push(value); i++; }
  }

  let args = kept;

  // 联动 1：flash attention 没了，KV 量化也必须去掉。
  if (dropped.some((d) => d.flag === '-fa')) {
    for (const flag of ['-ctk', '-ctv']) {
      const r = removeFlag(args, flag, dropped);
      args = r.args;
    }
  }

  // 联动 2：视觉投影器没了，它的两个附属参数也去掉。
  if (dropped.some((d) => d.flag === '--mmproj')) {
    for (const flag of ['--no-mmproj-offload', '--image-max-tokens']) {
      const r = removeFlag(args, flag, dropped);
      args = r.args;
    }
  }

  return { args, dropped, unsupportedRequired };
}

const CLASSIFIERS = Object.freeze([
  {
    kind: 'unknown-argument',
    re: /unknown argument|unrecognized option|option .*not recognized|unknown option|invalid argument/i,
  },
  {
    kind: 'unsupported-quantization',
    re: /unknown (?:model|quantization)|unsupported (?:ggml type|quantization)|invalid ggml type|unknown ggml type|quantization.*not supported/i,
  },
  {
    kind: 'missing-chat-template',
    re: /chat[\s_-]*template|apply template|failed to apply.*template|jinja exception|template.*(?:not found|missing)/i,
  },
  {
    kind: 'oom',
    re: /out of memory|failed to allocate|cuda error|(?:^|\W)oom(?:\W|$)|insufficient memory|not enough memory/i,
  },
]);

/**
 * 把启动失败的日志尾巴归类。
 *
 * logTail 可以是数组（Supervisor 的默认形式）或整段字符串。
 * 返回 { kind, evidence }；evidence 是命中的第一行（unknown 时取最后一行）。
 * 分类顺序是有意的：unknown-argument 放最前，避免“unknown model”之类被抢走。
 */
function classifyStartupError(logTail) {
  const lines = Array.isArray(logTail)
    ? logTail.map((l) => String(l == null ? '' : l))
    : String(logTail == null ? '' : logTail).split(/\r?\n/);

  for (const rule of CLASSIFIERS) {
    const hit = lines.find((line) => rule.re.test(line));
    if (hit) {
      return {
        kind: rule.kind,
        evidence: hit.replace(/\s+/g, ' ').trim().slice(0, 500),
      };
    }
  }

  const last = [...lines].reverse().find((line) => line.trim());
  return {
    kind: 'unknown',
    evidence: last ? last.replace(/\s+/g, ' ').trim().slice(0, 500) : '',
  };
}

/**
 * 给出“只降级一次”的 argv 与建议。
 *
 * 调用方负责保证只调用/执行一次（main.js 用 retried 标记）。本函数本身无状态：
 * 对它的输出再调一次，changed 会变成 false（--jinja 已经没了、gateArgs 也不会
 * 再产生新删除），所以即使误调用也不会无限降级。
 *
 * 返回 { args, action, changed }。changed 表示 argv 真的变了；oom / 量化不兼容 /
 * 未知错误只给建议，不动 argv（返回 changed:false）。
 */
function planRetry(legacyArgs, caps, kind) {
  const input = Array.isArray(legacyArgs) ? legacyArgs.slice() : [];

  if (kind === 'unknown-argument') {
    const gated = gateArgs(input, caps);
    const changed = !sameArgs(gated.args, input);
    let action;
    if (changed) {
      action = `按构建能力移除不支持的参数：${formatDropped(gated.dropped)}`;
    } else if (gated.unsupportedRequired.length) {
      action = `缺少核心参数 ${gated.unsupportedRequired.join(', ')}，该构建可能不是 llama-server 或太旧`;
    } else {
      action = '没有可移除的参数（能力探测未给出可降级项）';
    }
    return { args: gated.args, action, changed };
  }

  if (kind === 'unsupported-quantization') {
    return {
      args: input,
      changed: false,
      action: '这个构建不认识该模型的量化格式：请换用产出该格式的构建（如 PrismML 官方 fork），或换一个该构建支持的量化文件。',
    };
  }

  if (kind === 'missing-chat-template') {
    const args = input.filter((token) => token !== '--jinja');
    const changed = args.length !== input.length;
    return {
      args,
      changed,
      action: changed
        ? '移除 --jinja：该构建没有可用的聊天模板，只能使用纯补全接口（Web 聊天界面会不可用）。'
        : '没有找到 --jinja，无法通过降级解决聊天模板问题。',
    };
  }

  if (kind === 'oom') {
    return {
      args: input,
      changed: false,
      action: '显存不足：先降低上下文（-c），再把 KV 精度换回 q4_0，或换更小的模型/量化；不要指望自动降级解决。',
    };
  }

  return {
    args: input,
    changed: false,
    action: '未能识别的启动错误，无法自动降级；请查看日志末尾的原始报错。',
  };
}

/**
 * 统一入口：config.buildArgs() → gateArgs()。
 *
 * 硬约束：caps 支持全部参数时，返回的 args 必须与 buildArgs() 逐字节相同
 * （tests/args.test.mjs 对 90 例快照做 deepEqual）。
 *
 * 核心参数缺失时直接抛错，不静默降级 —— 这是“构建太旧/不是 llama-server”
 * 唯一能给出明确提示的时机。
 */
function buildStartArgs(params = {}) {
  const {
    model, presetKey, port, reasoningKey, lanMode, apiKey, budgetKey, overrides, caps,
  } = params;

  const legacy = cfg.buildArgs(
    model, presetKey, port, reasoningKey, lanMode, apiKey, budgetKey, overrides,
  );
  const gated = gateArgs(legacy, caps);

  if (gated.unsupportedRequired.length) {
    const exe = model && model.bin ? model.bin : '(未知)';
    throw new Error(
      `这个 llama-server 缺少外壳必需的核心参数: ${gated.unsupportedRequired.join(', ')}\n`
      + `它很可能不是 llama-server，或者构建太旧。请换用官方/更新的构建。\n`
      + `构建: ${exe}`,
    );
  }
  return gated;
}

module.exports = {
  VALUE_FLAGS,
  gateArgs,
  classifyStartupError,
  planRetry,
  buildStartArgs,
  formatDropped,
};
