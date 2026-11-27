'use strict';
/**
 * W4 长任务 step ledger。
 *
 * 只对“明确编号的步骤”（第1步 / 步骤1 / 1.）建账；没有编号的任务不猜。
 * 账本独立于 sessions.json，避免改动历史消息契约；只存步骤文本前缀、状态、
 * 工具回执引用与短错误码，不存文件正文。
 */
const fs = require('fs');
const path = require('path');
const { writeFileAtomicSync } = require('./atomic-write');

const DATA_DIR = process.env.BLUEBIRD_DATA_DIR
  ? path.resolve(process.env.BLUEBIRD_DATA_DIR)
  : path.join(__dirname, 'data');
const LEDGER_FILE = path.join(DATA_DIR, 'agent-ledgers.json');
const MAX_SESSIONS = 200;
const MAX_STEPS = 100;
const MAX_STEP_TEXT = 180;
const MAX_BLOCK_CHARS = 3200;

function enabled() {
  const raw = process.env.BLUEBIRD_TASK_LEDGER;
  return raw === undefined || raw === '' ? true : String(raw).trim() !== '0';
}

let cache = null;

function load() {
  if (cache) return cache;
  if (!fs.existsSync(LEDGER_FILE)) {
    cache = { version: 1, sessions: {} };
    return cache;
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'));
  } catch (_) {
    cache = { version: 1, sessions: {} };
    return cache;
  }
  if (!parsed || parsed.version !== 1 || !parsed.sessions || typeof parsed.sessions !== 'object') {
    cache = { version: 1, sessions: {} };
  } else {
    cache = parsed;
  }
  return cache;
}

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  writeFileAtomicSync(LEDGER_FILE, JSON.stringify(cache, null, 2));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function cleanSessionId(sessionId) {
  return typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim().slice(0, 120) : null;
}

/**
 * 解析编号步骤。同一编号取正文最长的一条，兼容“步骤1：…现在只执行步骤1”这种重复提及。
 */
function parseSteps(text) {
  const input = typeof text === 'string' ? text : '';
  const pattern = /(?:第\s*(\d+)\s*步|步骤\s*(\d+)|(?:^|[。！？!?；;\n])\s*(\d+)\s*[.、：:)])/g;
  const headers = [];
  let match;
  while ((match = pattern.exec(input)) !== null) {
    const index = Number(match[1] || match[2] || match[3]);
    if (!Number.isInteger(index) || index < 1 || index > MAX_STEPS) continue;
    headers.push({ index, start: match.index, bodyStart: match.index + match[0].length });
  }
  const byIndex = new Map();
  for (let i = 0; i < headers.length; i += 1) {
    const header = headers[i];
    const end = i + 1 < headers.length ? headers[i + 1].start : input.length;
    const body = input
      .slice(header.bodyStart, end)
      .replace(/^[：:\s，,]+/, '')
      .replace(/[。！？!?；;\n]+$/, '')
      .trim()
      // 只保留步骤动作本身，丢掉“现在执行这三步/完成后报告”这类调度尾句。
      .split(/[。！？!?；;]/)[0]
      .trim()
      .slice(0, MAX_STEP_TEXT);
    if (body.length < 2) continue;
    const previous = byIndex.get(header.index);
    if (!previous || body.length > previous.text.length) {
      byIndex.set(header.index, { index: header.index, text: body });
    }
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

function isSynthesisStep(text) {
  return /汇总|总结|报告|清单|最终/.test(String(text || ''));
}

function ensureLedger(sessionId, userText) {
  if (!enabled()) return null;
  const key = cleanSessionId(sessionId);
  if (!key) return null;
  const parsed = parseSteps(userText);
  const current = load();
  const existing = current.sessions[key];
  if (!parsed.length) return existing ? clone(existing) : null;

  const now = new Date().toISOString();
  const steps = existing && Array.isArray(existing.steps) ? clone(existing.steps) : [];
  const byIndex = new Map(steps.map(step => [step.index, step]));
  for (const item of parsed) {
    const prev = byIndex.get(item.index);
    if (prev && prev.text === item.text && prev.status !== 'pending') continue;
    if (prev && prev.text === item.text) continue;
    byIndex.set(item.index, {
      index: item.index,
      text: item.text,
      status: 'pending',
      receipts: [],
      errorCode: null,
      attempts: 0,
      updatedAt: now,
    });
  }
  const merged = [...byIndex.values()].sort((a, b) => a.index - b.index).slice(0, MAX_STEPS);
  const next = {
    steps: merged,
    turnsSinceProgress: existing && Number.isInteger(existing.turnsSinceProgress)
      ? existing.turnsSinceProgress
      : 0,
    stalled: existing && existing.stalled === true,
    updatedAt: now,
  };
  current.sessions[key] = next;
  const keys = Object.keys(current.sessions);
  if (keys.length > MAX_SESSIONS) {
    const remove = keys
      .filter(item => item !== key)
      .sort((a, b) => String(current.sessions[a].updatedAt).localeCompare(String(current.sessions[b].updatedAt)))
      .slice(0, keys.length - MAX_SESSIONS);
    for (const item of remove) delete current.sessions[item];
  }
  save();
  return clone(next);
}

function getLedger(sessionId) {
  if (!enabled()) return null;
  const key = cleanSessionId(sessionId);
  const current = load();
  return key && current.sessions[key] ? clone(current.sessions[key]) : null;
}

function stepOperation(text) {
  if (/读取|读回|核对|检查/.test(text)) return 'read';
  if (/列|目录|扫描/.test(text)) return 'list';
  if (/创建|新建|写入|保存|覆盖|追加|修改|更新|生成/.test(text)) return 'write';
  return null;
}

function stepMatchesReceipt(step, receipt) {
  const text = String(step.text || '');
  const evidence = receipt.evidence || {};
  const name = String(receipt.name || '');
  const receiptOp =
    name === 'workspace_read' ? 'read' : name === 'workspace_list' ? 'list' : name === 'workspace_write' ? 'write' : null;
  const stepOp = stepOperation(text);
  // 有明确动作词时以动作为准：同路径的“读取 f01.txt”不能被写入回执抢走。
  if (stepOp && receiptOp) return stepOp === receiptOp;
  if (stepOp) return false;
  if (evidence.path && text.includes(String(evidence.path))) return true;
  if (evidence.path && text.includes(path.basename(String(evidence.path)))) return true;
  return false;
}

function receiptRef(receipt) {
  const evidence = receipt.evidence && typeof receipt.evidence === 'object' ? receipt.evidence : {};
  const ref = {
    name: String(receipt.name || 'unknown'),
    ok: receipt.ok === true,
    summary: String(receipt.summary || '').slice(0, 120),
    at: new Date().toISOString(),
  };
  if (evidence.path) ref.path = String(evidence.path).slice(0, 200);
  if (Number.isFinite(evidence.bytes)) ref.bytes = evidence.bytes;
  if (evidence.sha256) ref.sha256 = String(evidence.sha256).slice(0, 64);
  if (Number.isFinite(evidence.count)) ref.count = evidence.count;
  if (receipt.code) ref.code = String(receipt.code).slice(0, 60);
  return ref;
}

function bindReceipts(sessionId, toolSteps, userText) {
  if (!enabled()) return null;
  const key = cleanSessionId(sessionId);
  const current = load();
  const ledger = key ? current.sessions[key] : null;
  if (!ledger) return null;

  const parsedIndices = new Set(parseSteps(userText).map(item => item.index));
  const candidates = ledger.steps.filter(
    step => step.status === 'pending' && (!parsedIndices.size || parsedIndices.has(step.index))
  );
  const receipts = Array.isArray(toolSteps) ? toolSteps : [];
  let bound = 0;

  for (const receipt of receipts) {
    const step =
      candidates.find(item => stepMatchesReceipt(item, receipt) && !item._boundThisTurn) ||
      candidates.find(item => !item._boundThisTurn);
    if (!step) continue;
    step._boundThisTurn = true;
    step.receipts = Array.isArray(step.receipts) ? step.receipts : [];
    step.receipts.push(receiptRef(receipt));
    step.status = receipt.ok === true ? 'completed' : 'failed';
    step.errorCode = receipt.ok === true ? null : String(receipt.code || 'tool_failed').slice(0, 60);
    step.attempts = Number.isInteger(step.attempts) ? step.attempts + 1 : 1;
    step.updatedAt = new Date().toISOString();
    bound += 1;
  }
  for (const step of candidates) delete step._boundThisTurn;

  if (bound) {
    ledger.turnsSinceProgress = 0;
    ledger.stalled = false;
  } else {
    ledger.turnsSinceProgress = Number.isInteger(ledger.turnsSinceProgress)
      ? ledger.turnsSinceProgress + 1
      : 1;
    if (ledger.turnsSinceProgress >= 2 && ledger.steps.some(step => step.status === 'pending')) {
      ledger.stalled = true;
    }
  }
  ledger.updatedAt = new Date().toISOString();
  save();
  return clone(ledger);
}

function markSynthesizedSteps(sessionId) {
  if (!enabled()) return null;
  const key = cleanSessionId(sessionId);
  const current = load();
  const ledger = key ? current.sessions[key] : null;
  if (!ledger) return null;
  const synthesis = ledger.steps.filter(
    step => step.status === 'pending' && isSynthesisStep(step.text)
  );
  const othersPending = ledger.steps.some(
    step => step.status === 'pending' && !isSynthesisStep(step.text)
  );
  if (synthesis.length && !othersPending) {
    const now = new Date().toISOString();
    for (const step of synthesis) {
      step.status = 'completed';
      step.updatedAt = now;
    }
    ledger.updatedAt = now;
    save();
  }
  return clone(ledger);
}

function counts(ledger) {
  const steps = Array.isArray(ledger && ledger.steps) ? ledger.steps : [];
  return {
    total: steps.length,
    completed: steps.filter(step => step.status === 'completed').length,
    pending: steps.filter(step => step.status === 'pending').length,
    failed: steps.filter(step => step.status === 'failed').length,
  };
}

function buildLedgerContextBlock(sessionId) {
  const ledger = getLedger(sessionId);
  if (!ledger || !ledger.steps.length) return '';
  const summary = counts(ledger);
  const lines = [
    '[服务端长任务账本]',
    `计划步骤 ${summary.total}；已完成 ${summary.completed}；未完成 ${summary.pending}；失败 ${summary.failed}。`,
  ];
  const pending = ledger.steps.filter(step => step.status === 'pending');
  const failed = ledger.steps.filter(step => step.status === 'failed');
  for (const step of pending.slice(0, 12)) {
    lines.push(`- 未完成：步骤${step.index} ${step.text}`);
  }
  for (const step of failed.slice(0, 6)) {
    lines.push(`- 失败：步骤${step.index} ${step.text}（${step.errorCode || 'tool_failed'}）`);
  }
  if (ledger.stalled) {
    lines.push('- 停滞：连续两轮没有新的步骤回执；不得再说“全部完成”，请报告未完成清单或请求指示。');
  }
  lines.push('- 规则：存在未完成步骤时禁止声称全部完成；只处理未完成步骤；最终答复必须按步骤列出状态。');
  return lines.join('\n').slice(0, MAX_BLOCK_CHARS);
}

// 最终汇总轮仍有未完成执行步骤时，服务端强制对应工具先补齐，而不是让模型
// 用自然语言“诚实报告未完成”后结束——那会让长任务永远差最后一步。
function forcedToolsForPending(sessionId, userText) {
  if (!enabled() || !/汇总|总结|最终|整个|全部/.test(String(userText || ''))) return [];
  const ledger = getLedger(sessionId);
  if (!ledger) return [];
  const pending = ledger.steps.filter(
    step => step.status === 'pending' && !isSynthesisStep(step.text)
  );
  const step = pending[0];
  if (!step) return [];
  const op = stepOperation(step.text);
  const tool =
    op === 'write' ? 'workspace_write' : op === 'read' ? 'workspace_read' : op === 'list' ? 'workspace_list' : null;
  return tool ? [tool] : [];
}

function buildDeliverySummary(sessionId) {
  const ledger = markSynthesizedSteps(sessionId);
  if (!ledger || !ledger.steps.length) return null;
  const summary = counts(ledger);
  const lines = [
    '【长任务交付清单】',
    `共 ${summary.total} 步：完成 ${summary.completed}、未完成 ${summary.pending}、失败 ${summary.failed}。`,
  ];
  const groups = [
    ['完成', ledger.steps.filter(step => step.status === 'completed')],
    ['未完成', ledger.steps.filter(step => step.status === 'pending')],
    ['失败', ledger.steps.filter(step => step.status === 'failed')],
  ];
  for (const [label, steps] of groups) {
    if (!steps.length) continue;
    const items = steps.map(step => {
      const receipt = Array.isArray(step.receipts) ? step.receipts[step.receipts.length - 1] : null;
      const evidence = receipt
        ? `（${receipt.name}${receipt.ok === true ? ' ok' : ' failed'}${receipt.path ? ` ${receipt.path}` : ''}${Number.isFinite(receipt.bytes) ? ` ${receipt.bytes}B` : ''}）`
        : '';
      return `${step.index}. ${step.text}${evidence}`;
    });
    lines.push(`${label}（${steps.length}）：${items.join('；')}`);
  }
  if (summary.pending) {
    lines.push('下一步：继续处理上述未完成步骤后再报告完成。');
  } else if (summary.failed) {
    lines.push('说明：失败步骤已保留错误码，按实际回执判断是否需要恢复。');
  } else {
    lines.push('下一步：全部步骤均有服务端回执，任务结束。');
  }
  return lines.join('\n').slice(0, MAX_BLOCK_CHARS);
}

function reloadForTests() {
  cache = null;
}

module.exports = {
  LEDGER_FILE,
  enabled,
  parseSteps,
  ensureLedger,
  getLedger,
  bindReceipts,
  forcedToolsForPending,
  buildLedgerContextBlock,
  buildDeliverySummary,
  counts,
  reloadForTests,
};
