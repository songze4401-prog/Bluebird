/* global module, __dirname */
/**
 * Phase 4 第 1 项：离线评测集的加载与校验。
 *
 * 评测集是固定文件（server/agents/eval-suite-v1.json），每条用例声明目标、
 * 期望 Agent/能力、期望终态、允许的失败码、是否应触发审校、预算上限，以及
 * 可离线重放的确定性 stub 脚本。这里不做任何执行，只保证：
 *  - 用例字段完整、枚举合法、id 唯一；
 *  - 同一文件内容得到同一个版本摘要（digest），供基线快照钉住"跑的是哪份集"。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_SUITE_FILE = path.join(__dirname, 'eval-suite-v1.json');
const TERMINALS = ['completed', 'failed', 'cancelled', 'timed_out', 'recovery'];
const OUTCOMES = ['completed', 'failed'];

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function suiteDigest(raw) {
  return crypto.createHash('sha256').update(canonicalize(raw)).digest('hex');
}

function assertUsage(usage, caseId) {
  if (usage === null) return;
  if (typeof usage !== 'object' || Array.isArray(usage)) {
    throw new Error(`用例 ${caseId} 的 usage 必须是对象或 null`);
  }
  const total = Number(usage.total_tokens);
  if (!Number.isFinite(total) || total < 0) {
    throw new Error(`用例 ${caseId} 的 usage.total_tokens 必须是非负有限数`);
  }
}

function validateCase(item, seen) {
  if (!item || typeof item !== 'object') throw new Error('用例必须是对象');
  const id = String(item.id || '').trim();
  if (!id) throw new Error('用例缺少 id');
  if (seen.has(id)) throw new Error(`用例 id 重复：${id}`);
  seen.add(id);
  const goal = typeof item.goal === 'string' ? item.goal.trim() : '';
  if (!goal) throw new Error(`用例 ${id} 缺少 goal`);
  const agentId = String(item.agentId || '').trim();
  if (!agentId) throw new Error(`用例 ${id} 缺少 agentId`);
  const taskType = String(item.taskType || '').trim();
  if (!taskType) throw new Error(`用例 ${id} 缺少 taskType`);
  if (!TERMINALS.includes(item.expectedTerminal)) {
    throw new Error(`用例 ${id} 的 expectedTerminal 不合法`);
  }
  if (!Array.isArray(item.allowedErrorCodes)) {
    throw new Error(`用例 ${id} 的 allowedErrorCodes 必须是数组`);
  }
  if (typeof item.expectReview !== 'boolean') {
    throw new Error(`用例 ${id} 的 expectReview 必须是布尔值`);
  }
  const cap = Number(item.budgetTokenCap);
  if (!Number.isInteger(cap) || cap < 1 || cap > 500000) {
    throw new Error(`用例 ${id} 的 budgetTokenCap 必须在 1 到 500000 之间`);
  }
  if (!Array.isArray(item.script) || item.script.length === 0) {
    throw new Error(`用例 ${id} 的 script 至少要有一次 attempt`);
  }
  for (const step of item.script) {
    if (!OUTCOMES.includes(step.outcome)) {
      throw new Error(`用例 ${id} 的 script outcome 不合法`);
    }
    if (step.outcome === 'failed' && !String(step.errorCode || '').trim()) {
      throw new Error(`用例 ${id} 的失败 attempt 必须声明 errorCode`);
    }
    const simulatedMs = Number(step.simulatedMs);
    if (!Number.isFinite(simulatedMs) || simulatedMs < 0) {
      throw new Error(`用例 ${id} 的 simulatedMs 必须是非负有限数`);
    }
    assertUsage(step.usage === undefined ? null : step.usage, id);
  }
  return {
    id,
    goal,
    agentId,
    taskType,
    // split 只做透传与形态检查，分层语义由 eval-tiers 判定：
    // 这里不默认补 'dev'，缺分层必须显式暴露成分层校验失败。
    split: item.split === undefined || item.split === null ? null : String(item.split),
    expectedTerminal: item.expectedTerminal,
    allowedErrorCodes: item.allowedErrorCodes.map(code => String(code)),
    expectReview: item.expectReview,
    budgetTokenCap: cap,
    script: item.script.map(step => ({
      outcome: step.outcome,
      errorCode: step.errorCode === undefined ? null : step.errorCode,
      simulatedMs: Number(step.simulatedMs),
      usage: step.usage === undefined ? null : step.usage,
    })),
  };
}

function loadSuite(filePath = DEFAULT_SUITE_FILE) {
  const target = String(filePath || DEFAULT_SUITE_FILE);
  const text = fs.readFileSync(target, 'utf8');
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`评测集不是合法 JSON：${error.message}`);
  }
  const version = String((raw && raw.version) || '').trim();
  if (!version) throw new Error('评测集缺少 version');
  if (!Array.isArray(raw.cases) || raw.cases.length === 0) {
    throw new Error('评测集 cases 不能为空');
  }
  const seen = new Set();
  const cases = raw.cases.map(item => validateCase(item, seen));
  return {
    file: target,
    version,
    // datasetVersion 让基线快照能说清"跑的是哪一版数据"：同一 version 下补充或
    // 替换用例时必须换 datasetVersion，否则两次结果会被混称同一基线（§14）。
    datasetVersion: raw.datasetVersion ? String(raw.datasetVersion) : version,
    digest: suiteDigest(raw),
    caseCount: cases.length,
    cases,
  };
}

module.exports = { DEFAULT_SUITE_FILE, TERMINALS, OUTCOMES, canonicalize, suiteDigest, loadSuite };
