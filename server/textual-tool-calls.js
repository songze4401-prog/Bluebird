/* global module */
/**
 * 正文里的工具调用封装解析（纯函数，无依赖）。
 *
 * DeepSeek 系模型偶尔不把调用放进 message.tool_calls，而是写成正文：
 *   <｜｜DSML｜｜ calls>
 *   <｜｜DSML｜｜ invoke name="memory_remember">
 *   <｜｜DSML｜｜ parameter name="content" string="true">…</｜｜DSML｜｜ parameter>
 *   </｜｜DSML｜｜ invoke>
 *   </｜｜DSML｜｜ calls>
 *
 * 这里只认严格结构：外层 calls 与每个 invoke/parameter 都必须成对闭合，
 * 否则返回 null（绝不猜测、绝不半解析）。解析结果仍由调用方走
 * executeToolCall 的注册/授权/策略/预算闸门，本模块不执行任何工具。
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

/**
 * @param {unknown} content 模型返回的 assistant 正文
 * @returns {{ text: string, calls: Array<{type:'function', function:{name:string, arguments:string}}> } | null}
 *   完整封装 → 去掉封装后的正文 + 调用列表；否则 null。
 */
function parseTextualToolCalls(content) {
  if (typeof content !== 'string' || !content.includes('DSML')) return null;

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

  // 外层封装存在却没有任何合法 invoke：不当作工具调用，也不改写正文。
  if (!calls.length) return null;

  const text = (
    content.slice(0, open.index) +
    content.slice(bodyStart + close.index + close[0].length)
  ).trim();

  return { text, calls };
}

module.exports = { parseTextualToolCalls };
