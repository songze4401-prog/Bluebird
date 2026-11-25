/* global module */
/**
 * 正文里的工具调用封装解析（纯函数，无依赖）。
 *
 * 观测到两种形态：
 * 1) DeepSeek DSML 封装：
 *   <｜｜DSML｜｜ calls>
 *   <｜｜DSML｜｜ invoke name="memory_remember">
 *   <｜｜DSML｜｜ parameter name="content" string="true">…</｜｜DSML｜｜ parameter>
 *   </｜｜DSML｜｜ invoke>
 *   </｜｜DSML｜｜ calls>
 * 2) 通用 <tool_call> 标签（2026-11-22 真机观测，DeepSeek 变体）：
 *   <tool_call>memory_remember
 *   {"content": "…"}
 *   </tool_call>
 *   也兼容 <tool_calls> 外层、name="x" 属性与 OpenAI 风格 {"name","arguments"}。
 *
 * 只认结构完整的块；解析结果仍由调用方走 executeToolCall 的
 * 注册/授权/策略/预算闸门，本模块不执行任何工具。
 * stripToolProtocolText 用于交付前的兜底：无论能否解析，都不把协议标记
 * 原样发给用户。
 */

// 分隔符兼容全角 ｜（U+FF5C，实际观测到的形态）与半角 |。
const BAR = '[|｜]{1,3}';
const CALLS_OPEN_RE = new RegExp(`<${BAR}DSML${BAR}\\s*calls\\s*>`, 'i');
const CALLS_CLOSE_RE = new RegExp(`</${BAR}DSML${BAR}\\s*calls\\s*>`, 'i');
const INVOKE_RE = new RegExp(
  `<${BAR}DSML${BAR}\\s*invoke\\s+name="([^"]+)"\\s*>` +
    `([\\s\\S]*?)` +
    `</${BAR}DSML${BAR}\\s*invoke\\s*>`,
  'gi'
);
const PARAM_RE = new RegExp(
  `<${BAR}DSML${BAR}\\s*parameter\\s+name="([^"]+)"` +
    `(?:\\s+string="(true|false)")?\\s*>` +
    `([\\s\\S]*?)` +
    `</${BAR}DSML${BAR}\\s*parameter\\s*>`,
  'gi'
);

// <tool_call> 标签形态（\b 保证不会把 <tool_calls> 当成 <tool_call>）
const TOOL_CALL_BLOCK_RE = /<tool_call\b([^>]*)>([\s\S]*?)<\/tool_call>/gi;
const TOOL_CALLS_BLOCK_RE = /<tool_calls\b[^>]*>([\s\S]*?)<\/tool_calls>/gi;
const TOOL_CALL_OPEN_RE = /<tool_calls?\b/i;
const DSML_ENVELOPE_RE = new RegExp(
  `<${BAR}DSML${BAR}\\s*calls\\s*>[\\s\\S]*?</${BAR}DSML${BAR}\\s*calls\\s*>`,
  'gi'
);

function parseParamValue(raw, kind) {
  const text = String(raw == null ? '' : raw);
  // 只有显式声明 string="false" 才按 JSON 解析；其余一律当字符串，
  // 避免把 "001"、"true" 这类正文悄悄改型。
  if (kind === 'false') {
    try {
      return JSON.parse(text);
    } catch (_) {
      return text.trim();
    }
  }
  return text.trim();
}

function parseDsmlContent(content) {
  const open = CALLS_OPEN_RE.exec(content);
  if (!open) return null;
  const bodyStart = open.index + open[0].length;
  const close = CALLS_CLOSE_RE.exec(content.slice(bodyStart));
  if (!close) return null;

  const body = content.slice(bodyStart, bodyStart + close.index);
  const calls = [];

  INVOKE_RE.lastIndex = 0;
  let invoke;
  while ((invoke = INVOKE_RE.exec(body)) !== null) {
    const name = String(invoke[1] || '').trim();
    if (!name) return null;

    const args = {};
    PARAM_RE.lastIndex = 0;
    let param;
    while ((param = PARAM_RE.exec(invoke[2])) !== null) {
      const key = String(param[1] || '').trim();
      if (!key) return null;
      args[key] = parseParamValue(param[3], param[2]);
    }

    calls.push({
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    });
  }

  if (!calls.length) return null;

  const text = (
    content.slice(0, open.index) +
    content.slice(bodyStart + close.index + close[0].length)
  ).trim();

  return { text, calls };
}

function parseJsonObject(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch (_) {
    return null;
  }
}

/**
 * 把一个 <tool_call> 块归一化成 OpenAI tool_call。
 * 支持：name 属性 + JSON 正文、首行函数名 + JSON 正文、
 * name({...}) 括号形态、{"name","arguments"} 自描述 JSON。
 */
function callFromTaggedBlock(attrs, body) {
  const attrName = (/name\s*=\s*["']([^"']+)["']/i.exec(attrs || '') || [])[1];
  let name = attrName ? attrName.trim() : '';
  let args = parseJsonObject(body);

  if (args && typeof args.name === 'string' && args.name.trim()) {
    if (!name) name = args.name.trim();
    const rawArgs = args.arguments !== undefined ? args.arguments : args.parameters;
    args =
      typeof rawArgs === 'string'
        ? parseJsonObject(rawArgs)
        : rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
          ? rawArgs
          : null;
  }

  if (!args) {
    const trimmed = body.trim();
    const paren = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*\(([\s\S]*)\)\s*$/.exec(trimmed);
    const head = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*(?:[\r\n]+|\s+)(\{[\s\S]*)$/.exec(trimmed);
    if (paren) {
      name = name || paren[1];
      args = parseJsonObject(paren[2]);
    } else if (head) {
      name = name || head[1];
      args = parseJsonObject(head[2]);
    }
  }

  if (!name || !args) return null;
  return { type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

function parseTaggedToolCalls(content) {
  if (!TOOL_CALL_OPEN_RE.test(content)) return null;

  const calls = [];
  let text = content;

  // 外层 <tool_calls>：优先按子 <tool_call> 解析，否则把内部当单个调用。
  text = text.replace(TOOL_CALLS_BLOCK_RE, (_whole, inner) => {
    const childRe = new RegExp(TOOL_CALL_BLOCK_RE.source, 'gi');
    let child;
    let found = false;
    while ((child = childRe.exec(inner)) !== null) {
      const call = callFromTaggedBlock(child[1], child[2]);
      if (call) {
        calls.push(call);
        found = true;
      }
    }
    if (!found) {
      const call = callFromTaggedBlock('', inner);
      if (call) calls.push(call);
    }
    return ' ';
  });

  // 外层之外的单个 <tool_call> 块。
  text = text.replace(TOOL_CALL_BLOCK_RE, (_whole, attrs, body) => {
    const call = callFromTaggedBlock(attrs, body);
    if (call) calls.push(call);
    return ' ';
  });

  if (!calls.length) return null;
  return { text, calls };
}

/**
 * @param {unknown} content 模型返回的 assistant 正文
 * @returns {{ text: string, calls: Array<{type:'function', function:{name:string, arguments:string}}> } | null}
 *   完整封装 → 去掉封装后的正文 + 调用列表；否则 null。
 */
function parseTextualToolCalls(content) {
  if (typeof content !== 'string') return null;

  let text = content;
  const calls = [];

  if (text.includes('DSML')) {
    const dsml = parseDsmlContent(text);
    if (dsml) {
      text = dsml.text;
      calls.push(...dsml.calls);
    }
  }

  const tagged = parseTaggedToolCalls(text);
  if (tagged) {
    text = tagged.text;
    calls.push(...tagged.calls);
  }

  if (!calls.length) return null;
  return { text: text.trim(), calls };
}

// 模型偶尔把内部提示词里的标记原样 echoed 成「[memory_remember 候选]」这类
// 方括号短语。只按已知工具名 + 已知状态词匹配，普通方括号（markdown 链接、
// [重要] 之类）一律不动。
const TOOL_LABEL = 'tool_' + 'call';
const KNOWN_TOOL_NAMES = [
  'memory_remember',
  'memory_search',
  'knowledge_search',
  'workspace_read',
  'workspace_write',
  'workspace_list',
  'delegate_to_bot',
  'load_skill',
  'web_search',
  'web_fetch',
].join('|');
const INTERNAL_MARKER_RE = new RegExp(
  `\\[\\s*(?:${KNOWN_TOOL_NAMES})\\s*(?:候选|待确认|已提交|已派发|已调用|调用|派发|结果)\\s*\\]`,
  'gi'
);
// 完整块与独立标签都清掉之后，仍然残留的开括标记只可能是残缺/未闭合形态。
// 真机观测到的截断形态连 '>' 都没有（如 "<tool_callmemory_remember"），因此
// 这里不以 '>' 作为终止条件。
const RESIDUAL_TOOL_CALL_RE = new RegExp(`<${TOOL_LABEL}`, 'i');
// 独立的协议标签（带 '>' 的开/闭括），在截断处理之后兜底清除。
const STANDALONE_TOOL_TAG_RE = new RegExp(`</?${TOOL_LABEL}s?\\b[^<>]*>`, 'gi');
const RESIDUAL_DSML_RE = new RegExp(`<${BAR}${BAR}DSML${BAR}`, 'i');

// 代码示例不是协议：围栏块与行内代码原样保留，只在其余文本上做清洗。
const PROTECTED_SEGMENT_RE = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g;

function isFenceDelimiter(line) {
  return /^\s*(?:```|~~~)/.test(line);
}

/**
 * 把文本切成「代码 / 非代码」两类片段。
 * 围栏块按整块保留（包含未闭合到文本末尾的情况），行内代码按 span 保留。
 */
function splitProtected(text) {
  const lines = String(text).split('\n');
  const segments = [];
  let buffer = [];
  let fence = null;

  const flushProse = () => {
    if (!buffer.length) return;
    const prose = buffer.join('\n');
    buffer = [];
    for (const part of prose.split(PROTECTED_SEGMENT_RE)) {
      if (!part) continue;
      if (part.startsWith('`')) segments.push({ code: true, text: part });
      else segments.push({ code: false, text: part });
    }
  };

  for (const line of lines) {
    if (fence) {
      segments.push({ code: true, text: line });
      if (isFenceDelimiter(line) && line.trim() !== fence) {
        fence = null;
      }
      continue;
    }
    if (isFenceDelimiter(line)) {
      flushProse();
      fence = line.trim().slice(0, 3);
      segments.push({ code: true, text: line });
      continue;
    }
    buffer.push(line);
  }
  flushProse();
  return segments;
}

function cleanProseSegment(text) {
  let out = text
    .replace(DSML_ENVELOPE_RE, ' ')
    .replace(TOOL_CALLS_BLOCK_RE, ' ')
    .replace(TOOL_CALL_BLOCK_RE, ' ');

  // 完整块已被摘走，剩下的开括标记只可能是残缺/未闭合形态：从最早出现处截到段尾。
  // 说明性散文里的协议写法应写在代码块内（已保护），因此散文中的残留开括一定是
  // 模型截断的调用，而不是用户该看到的内容。
  const residual = [RESIDUAL_TOOL_CALL_RE.exec(out), RESIDUAL_DSML_RE.exec(out)]
    .filter(Boolean)
    .sort((a, b) => a.index - b.index)[0];
  if (residual) out = out.slice(0, residual.index);

  return out.replace(STANDALONE_TOOL_TAG_RE, ' ').replace(INTERNAL_MARKER_RE, ' ');
}

function tidyWhitespace(text) {
  return text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 交付前兜底：无论块能否解析，都不把工具协议标记原样发给用户。
 * 只作用于协议块与残缺协议文本，不动普通正文，也不动代码示例。
 */
function stripToolProtocolText(content) {
  if (typeof content !== 'string') return content;
  return tidyWhitespace(
    splitProtected(content)
      .map(segment => (segment.code ? segment.text : cleanProseSegment(segment.text)))
      .join('\n')
  );
}

/**
 * 这条文本是否含工具协议形态（完整块、独立标签、残缺开括、内部候选标记）。
 * 实时回复与历史读取用同一个探测函数决定是否走清洗，避免两条路径口径漂移。
 */
function looksLikeToolProtocol(content) {
  if (typeof content !== 'string' || !content) return false;
  // 探测用无 g 标志的正则：带 g 的正则会在 .test() 之间保留 lastIndex，
  // 让同一段文本第二次探测得到不同结果。
  const internal = new RegExp(INTERNAL_MARKER_RE.source, 'i');
  const envelope = new RegExp(`${BAR}${BAR}DSML${BAR}`, 'i');
  return splitProtected(content).some(
    segment =>
      !segment.code &&
      (TOOL_CALL_OPEN_RE.test(segment.text) ||
        RESIDUAL_TOOL_CALL_RE.test(segment.text) ||
        envelope.test(segment.text) ||
        internal.test(segment.text))
  );
}

module.exports = {
  parseTextualToolCalls,
  stripToolProtocolText,
  looksLikeToolProtocol,
};
