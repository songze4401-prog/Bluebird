/**
 * 云岫 Bluebird — 统一文本度量（text-utils.js）
 *
 * 全后端唯一的长度计算规则：按 Unicode 码点计数（CJK、emoji 均计 1），
 * 不用 String.length——后者按 UTF-16 单元计数，会把 emoji 算成 2，
 * 导致"字数上限"在不同文本间不可比。
 *
 * 所有对外暴露的文本上限（工具参数、工具结果、toolSteps 摘要）
 * 必须经过这里的 textLength / truncateText 在后端强制执行，
 * 不得在各模块各自用 .length 另立标准。
 */

function textLength(value) {
  if (typeof value !== 'string' || !value) return 0;
  return Array.from(value).length;
}

// 截断到 max 个码点，超长时末尾补省略号（省略号本身计入额度）。
function truncateText(value, max) {
  const text = typeof value === 'string' ? value : '';
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : 0;

  if (textLength(text) <= limit) return text;
  if (limit <= 1) return Array.from(text).slice(0, limit).join('');

  return Array.from(text).slice(0, limit - 1).join('') + '…';
}

// 近似 token 估算，不是模型分词器的精确计数：
// CJK/全角字符按 1 token，ASCII 与空白按 0.25，其余 Unicode 按 0.5。
// 检索预算用它做保守上限，返回元数据会明确标注 estimator 版本。
const TOKEN_ESTIMATOR_VERSION = 'heuristic-cjk-ascii-v1';

function estimateTokens(value) {
  if (typeof value !== 'string' || !value) return 0;

  let units = 0;

  for (const char of value) {
    const code = char.codePointAt(0);

    if (
      (code >= 0x2e80 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      units += 1;
    } else if (code <= 0x7f) {
      units += 0.25;
    } else {
      units += 0.5;
    }
  }

  return Math.max(1, Math.ceil(units));
}

// 在 token 预算内截断，保留 truncateText 的省略号语义。
function truncateToTokenBudget(value, maxTokens) {
  const text = typeof value === 'string' ? value : '';
  const limit =
    Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : 0;

  if (!text || limit <= 0) return '';
  if (estimateTokens(text) <= limit) return text;

  let low = 0;
  let high = textLength(text);

  while (low < high) {
    const mid = Math.ceil((low + high) / 2);

    if (estimateTokens(truncateText(text, mid)) <= limit) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return truncateText(text, low);
}

module.exports = {
  textLength,
  truncateText,
  estimateTokens,
  truncateToTokenBudget,
  TOKEN_ESTIMATOR_VERSION,
};
