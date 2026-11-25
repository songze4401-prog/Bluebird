'use strict';

const READ_BACK_RE =
  /(?:读回|回读|重新读取|读取并|核对|检查|确认).{0,24}(?:文件|内容|结果|实际|是否|一致|对不对|写入|落盘|目录|列表)|(?:文件|内容|结果|实际).{0,24}(?:读回|回读|核对|检查|确认)/i;

const READ_BACK_TOOLS = new Set([
  'workspace_read',
  'workspace_list',
  'memory_search',
  'knowledge_search',
]);

function requiresReadBack(userText) {
  return READ_BACK_RE.test(String(userText || ''));
}

function preferredReadBackTool(userText) {
  const text = String(userText || '');
  if (/(?:目录|列表|列出)/i.test(text)) return 'workspace_list';
  if (/(?:文件|读回|回读|重新读取|workspace)/i.test(text)) {
    return 'workspace_read';
  }
  if (/(?:记忆|画像|偏好)/i.test(text)) return 'memory_search';
  if (/(?:知识|资料|文档|检索)/i.test(text)) return 'knowledge_search';
  return null;
}

function hasReadBackReceipt(toolSteps, userText = '') {
  const preferred = preferredReadBackTool(userText);
  const allowed = preferred ? new Set([preferred]) : READ_BACK_TOOLS;
  return (
    Array.isArray(toolSteps) &&
    toolSteps.some(
      step =>
        step &&
        step.ok === true &&
        !step.pendingConfirmation &&
        allowed.has(step.name)
    )
  );
}

// 委派意图必须同时出现「派/交/让」动作与具体受理方（agent 名或角色），
// 且不是被否定的一刻。「派生」「让我想想」这类词面不算委派。
const DELEGATION_INTENT_RE =
  /(?:派给|派去|派到|派个|派一名|派一位|派发|派遣|委派|指派|委托|交给|转给|让)[^。！？\n]{0,16}(?:子\s*agent|小\s*agent|\bagent\b|researcher|reviewer|executor|研究员|调研|审阅|评审|执行器|机器人|助理)/i;

const DELEGATION_NEGATION_RE =
  /(?:不用|不需要|不必|无需|不要|别再|先别|别|自己(?:来|处理|查|做|答|说))[^。！？\n]{0,10}(?:派|委派|委托|交给|转给|让)/i;

function requiresDelegation(userText) {
  const text = String(userText || '');
  if (!text) return false;
  if (DELEGATION_NEGATION_RE.test(text)) return false;
  return DELEGATION_INTENT_RE.test(text);
}

module.exports = {
  requiresReadBack,
  preferredReadBackTool,
  hasReadBackReceipt,
  requiresDelegation,
};
