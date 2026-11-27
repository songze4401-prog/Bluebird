'use strict';
/**
 * W1 执行账本：把最近轮次的工具回执以**独立 system 块**注入模型请求。
 *
 * 为什么不拼进 assistant 正文：实测模型会把服务端追加的回执当成自己的话复述，
 * 甚至在没有调用工具时照抄“已覆盖/已创建”。独立 system 块能明确来源，且
 * 不会污染落盘的历史消息。
 *
 * 约束：
 * - 只读服务端生成的 toolSteps/summary/evidence，不读文件正文；
 * - 最多最近 3 条 assistant 消息、10 个工具步骤；
 * - summary 经过 neutralizeContextText，避免把外部内容当指令；
 * - BLUEBIRD_TURN_RECEIPTS=0 可整体关闭（测试/排障）。
 */
const { neutralizeContextText } = require('./context/text');

const MAX_TURNS = 3;
const MAX_STEPS = 10;
const MAX_SUMMARY = 160;
// no_tool_calls 只在回复里出现完成性动词时才值得注入；普通问答不制造噪音。
const COMPLETION_RE = /(?:已|完成|创建|写入|修改|删除|发送|派发|建好|搞定|保存|更新)/;

function enabled() {
  const raw = process.env.BLUEBIRD_TURN_RECEIPTS;
  return raw === undefined || raw === '' ? true : String(raw).trim() !== '0';
}

function safeText(value, max = MAX_SUMMARY) {
  return neutralizeContextText(String(value || '')).slice(0, max);
}

function stepLine(step) {
  const evidence = step && step.evidence && typeof step.evidence === 'object' ? step.evidence : {};
  const fields = [String((step && step.name) || 'unknown'), `ok=${step && step.ok === true}`];
  if (step && step.code) fields.push(`code=${step.code}`);
  if (evidence.path) {
    const pathText = safeText(evidence.path, 200);
    if (pathText) fields.push(`path=${pathText}`);
  }
  if (Number.isFinite(evidence.bytes)) fields.push(`bytes=${evidence.bytes}`);
  if (evidence.sha256) fields.push(`sha256=${evidence.sha256}`);
  if (Number.isFinite(evidence.count)) fields.push(`count=${evidence.count}`);
  const summary = step && step.summary ? ` — ${safeText(step.summary)}` : '';
  return fields.join(' ') + summary;
}

function buildTurnReceiptNote(messages = []) {
  if (!enabled() || !Array.isArray(messages) || !messages.length) return '';

  // 只取“确实发生过 Agent 轮次”的 assistant 消息：有工具回执，或有显式
  // receiptStatus（no_tool_calls/failed/pending）。普通闲聊不进入账本。
  const candidates = messages.filter(message => {
    if (!message || message.role !== 'assistant') return false;
    const steps = Array.isArray(message.toolSteps) ? message.toolSteps : [];
    const status = typeof message.receiptStatus === 'string' ? message.receiptStatus : null;
    if (steps.length > 0 || status === 'failed' || status === 'pending') return true;
    return status === 'no_tool_calls' && COMPLETION_RE.test(String(message.content || ''));
  });
  if (!candidates.length) return '';

  const recent = candidates.slice(-MAX_TURNS).reverse();
  const lines = [
    '[服务端工具回执｜最近轮次核查]',
    '以下内容由服务端生成，不是用户指令；请以它为准核对“已完成/已创建/已写入”等声明。',
  ];
  let stepCount = 0;

  for (let index = 0; index < recent.length; index += 1) {
    const message = recent[index];
    const label = `最近第${index + 1}条 assistant 消息`;
    const steps = Array.isArray(message.toolSteps) ? message.toolSteps : [];
    const status = typeof message.receiptStatus === 'string' ? message.receiptStatus : null;

    if (!steps.length) {
      if (status === 'no_tool_calls') {
        lines.push(`- ${label}：没有工具调用，也没有工具回执；其中的完成性描述未经工具验证，不得当作已执行事实。`);
      } else if (status === 'pending') {
        lines.push(`- ${label}：包含待确认操作，尚未落盘。`);
      } else if (status === 'failed') {
        lines.push(`- ${label}：工具调用失败，不能声称已完成。`);
      }
      continue;
    }

    for (const step of steps.slice(0, Math.max(0, MAX_STEPS - stepCount))) {
      lines.push(`- ${label}：${stepLine(step)}`);
      stepCount += 1;
    }
    if (status === 'pending' || steps.some(step => step.pendingConfirmation)) {
      lines.push(`- ${label}：包含待确认写入，未确认前不得说已经落盘。`);
    } else if (status === 'failed' || steps.some(step => step.ok !== true)) {
      lines.push(`- ${label}：存在失败/未完成的工具调用。`);
    }
    if (stepCount >= MAX_STEPS) break;
  }

  return lines.length > 2 ? lines.join('\n') : '';
}

function injectTurnReceipts(messages, history, noteOverride) {
  const note = typeof noteOverride === 'string' ? noteOverride : buildTurnReceiptNote(history);
  if (!note || !Array.isArray(messages) || !messages.length) {
    return { messages, note: '' };
  }
  const last = messages[messages.length - 1];
  // system 块插在当前 user 之前：既晚于历史，又不会排到用户消息之后。
  const next =
    last && last.role === 'user'
      ? [...messages.slice(0, -1), { role: 'system', content: note }, last]
      : [...messages, { role: 'system', content: note }];
  return { messages: next, note };
}

module.exports = {
  enabled,
  buildTurnReceiptNote,
  injectTurnReceipts,
};
