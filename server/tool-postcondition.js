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

module.exports = {
  requiresReadBack,
  preferredReadBackTool,
  hasReadBackReceipt,
};
