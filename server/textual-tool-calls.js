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

/**
 * 交付前兜底：无论块能否解析，都不把工具协议标记原样发给用户。
 * 只作用于协议块，不动普通正文。
 */
function stripToolProtocolText(content) {
  if (typeof content !== 'string') return content;
  return content
    .replace(DSML_ENVELOPE_RE, ' ')
    .replace(TOOL_CALLS_BLOCK_RE, ' ')
    .replace(TOOL_CALL_BLOCK_RE, ' ')
    .replace(/<\/?tool_calls?\b[^>]*>/gi, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

module.exports = { parseTextualToolCalls, stripToolProtocolText };
