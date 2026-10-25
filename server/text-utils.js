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

module.exports = { textLength, truncateText };
