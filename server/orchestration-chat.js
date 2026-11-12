/* global module */
/**
 * 轮 4（Orchestrator 立项书）：主聊天接线（orchestration-chat-v1）。
 *
 * 职责（纯函数优先，执行委托给 plan-compiler / orchestration-engine）：
 *  - extractPlanBlock(reply)：从模型回复中提取 ```bluebird-plan 围栏块并剥出正文；
 *  - buildPromptAppendix(capabilities)：开关开启时追加给模型的协议说明（能力清单
 *    由服务端 Manifest 动态生成，不硬编码）；
 *  - wireOrchestration({policy, reply, userText, userId, sessionId})：开关关闭 →
 *    原文返回（零行为差异，不触达任何解析）；开启且回复带合法计划块 → 剥块 →
 *    planCompiler.compilePlan（模型 agent 名丢弃并审计）→
 *    orchestrationEngine.orchestrateDAG（父会话 = 当前聊天会话）→ 回执文本；
 *    编译/编排失败 → 降级为剥块后的普通回复（fail-safe：用户请求绝不失败）。
 *
 * 安全边界：服务端只认「编译通过」的计划块；块内容不进持久消息（剥离后落盘）；
 * 执行者由路由解析；直答路径（无块）逐字节不变。
 */
const PLAN_BLOCK_RE = /```bluebird-plan\s*([\s\S]*?)```/i;
const RECEIPT_MAX = 400;

function extractPlanBlock(reply) {
  if (typeof reply !== 'string') return null;
  const match = reply.match(PLAN_BLOCK_RE);
  if (!match) return null;
  const rest = (reply.slice(0, match.index) + reply.slice(match.index + match[0].length)).trim();
  let parsed = null;
  try {
    parsed = JSON.parse(match[1].trim());
  } catch (_) {
    parsed = null;
  }
  return { raw: match[0], body: match[1], parsed, rest };
}

function buildPromptAppendix(capabilities) {
  const list = Array.isArray(capabilities)
    ? capabilities.filter(item => typeof item === 'string' && item.trim()).slice(0, 24)
    : [];
  return [
    '【复杂任务编排协议（可选）】',
    '当用户请求确实需要多个步骤、多种能力或可并行的子任务时，你可以在回复末尾输出一个 ```bluebird-plan 代码块申请编排：',
    '```bluebird-plan',
    '{"mode":"dag","goal":"<整体目标>","nodes":[{"key":"n1","taskType":"<能力>","goal":"<这一步做什么>","dependsOn":[]}]}',
    '```',
    `约束：taskType 只能取这些能力：${list.join(' / ') || '（当前无可用能力）'}；节点不超过 8 个；dependsOn 引用其它节点的 key；mode 取 dag（多节点）或 single（单节点）。`,
    '简单问答、闲聊、无需工具或并行的任务：不要输出此块，直接回答。',
    '服务端会校验计划并决定执行者；校验不通过时你的其余回复会按普通回答处理。',
  ].join('\n');
}

/**
 * 主接线。返回 {reply, orchestration, reason}：
 *  - orchestration 非空 = 已派发（reply 已剥块并附回执）；
 *  - orchestration 为空 = 直答（reason: disabled / no_block / bad_json / <错误码>）。
 */
function wireOrchestration({ policy, reply, userText = '', userId = null, sessionId = null } = {}) {
  const enabled = Boolean(
    policy &&
      policy.orchestration &&
      policy.orchestration.enabled === true
  );
  if (!enabled) {
    return { reply, orchestration: null, reason: 'disabled' };
  }
  const extracted = extractPlanBlock(reply);
  if (!extracted) {
    return { reply, orchestration: null, reason: 'no_block' };
  }
  const rest = extracted.rest;
  if (!extracted.parsed || typeof extracted.parsed !== 'object' || Array.isArray(extracted.parsed)) {
    return { reply: rest, orchestration: null, reason: 'bad_json' };
  }
  const planCompiler = require('./agents/plan-compiler');
  const orchestrationEngine = require('./agents/orchestration-engine');
  const mode = extracted.parsed.mode === 'single' ? 'single' : 'dag';
  const nodes = Array.isArray(extracted.parsed.nodes) ? extracted.parsed.nodes : [];
  const declaredAgents = Array.isArray(extracted.parsed.agents) ? extracted.parsed.agents : null;
  let compiled = null;
  try {
    compiled = planCompiler.compilePlan({
      goal: typeof extracted.parsed.goal === 'string' && extracted.parsed.goal.trim()
        ? extracted.parsed.goal.trim()
        : String(userText || '').slice(0, 2000),
      mode,
      nodes,
      declaredAgents,
    });
  } catch (error) {
    return {
      reply: rest,
      orchestration: null,
      reason: (error && error.code) || 'plan_compile_failed',
    };
  }
  let orchestration = null;
  try {
    const dispatched = orchestrationEngine.orchestrateDAG({
      planId: compiled.planId,
      definitions: compiled.definitions,
      parentSessionId: sessionId || null,
      parentUserText: String(userText || '').slice(0, 2000),
      parentUserId: userId || null,
    });
    orchestration = dispatched.orchestration;
  } catch (error) {
    return {
      reply: rest,
      orchestration: null,
      reason: (error && error.code) || 'orchestration_failed',
      planId: compiled.planId,
    };
  }
  const nodeCount = Object.keys((orchestration && orchestration.nodes) || {}).length;
  const shortPlanId = String(orchestration.planId || '').slice(0, 20);
  const receipt = `

[已编排] 服务端已按计划派发 ${nodeCount} 个任务（${shortPlanId}…），完成后结果会自动回传本会话。`.slice(
    0,
    RECEIPT_MAX
  );
  return {
    reply: `${rest}${receipt}`,
    orchestration: {
      planId: orchestration.planId,
      planVersion: orchestration.planVersion,
      nodeCount,
      status: orchestration.status,
    },
    reason: 'dispatched',
  };
}

module.exports = {
  extractPlanBlock,
  buildPromptAppendix,
  wireOrchestration,
  PLAN_COMPILER_CONSUMER: 'orchestration-chat-v1',
};
