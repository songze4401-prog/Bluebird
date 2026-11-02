/**
 * 显式子 agent 委派意图识别（确定性纯函数）。
 *
 * 主控不能把"是否真的调用 Memory Bot"交给模型自觉：用户明确要求
 * 让记忆机器人 / Memory Bot / 子 agent 处理时，agent-runtime 会据此
 * 直接调用 delegate_to_bot，再让模型基于真实工具结果回复。
 *
 * 识别保持保守：
 * - 必须出现目标称谓，且委派动作与目标在同一句内；
 * - 明确否定（别 / 不要 / 不用…）不触发；
 * - "是什么 / 怎么用"这类元问题不触发；
 * - "上次让记忆机器人查的结果呢"这类回看旧任务不触发（除非同时出现
 *   这次 / 现在 / 重新 / 再等新的动作信号）。
 */
const { truncateText } = require('./text-utils');

const TARGET_SOURCE = String.raw`(?:记忆\s*机器人|记忆\s*bot|memory\s*bot|memorybot|子\s*agent|子代理|sub\s*-?\s*agent|subagent)`;

const TARGET_RE = new RegExp(TARGET_SOURCE, 'i');
const NEGATION_RE = new RegExp(
  String.raw`(?:不要|不用|不需要|无需|不必|别|禁止|不准|不能)[^。！？\n]{0,20}${TARGET_SOURCE}|${TARGET_SOURCE}[^。！？\n]{0,8}(?:不要|不用|别|算了)`,
  'i'
);
const STRONG_ACTION_RE = new RegExp(
  String.raw`(?:让|叫|派(?:给|遣)?|交给|转给|委托|安排|命令|要求)[^。！？\n]{0,16}${TARGET_SOURCE}`,
  'i'
);
const LOOSE_ACTION_RE = new RegExp(
  String.raw`(?:通过|用|调用|唤起|找|问|delegate|hand|send|assign|ask)[^。！？\n]{0,12}${TARGET_SOURCE}`,
  'i'
);
const ACTION_AFTER_RE = new RegExp(
  String.raw`${TARGET_SOURCE}[^。！？\n]{0,16}(?:帮我|帮忙|去|查|找|看看|检索|搜索|整理|处理|解释|说明|分析|回顾|总结|delegate|search|explain|check|handle)`,
  'i'
);
const META_QUESTION_RE = /(?:是什么|是啥|能做什么|能干什么|怎么用|如何用|怎么工作|干什么的|有什么区别)/;
const PAST_REFERENCE_RE = /(?:上次|之前|刚才|刚刚|昨天|前天|早先)/;
const FRESH_ACTION_RE = /(?:这次|现在|重新|再|帮我|帮忙|去)/;
const EXPLAIN_RE = /(?:解释|说明|为什么|为何|怎么回事|依据|来源|怎么记得|回顾|分析|梳理|总结|explain)/i;

const GOAL_MAX_CHARS = 2000;

function detectExplicitDelegation(text) {
  const raw = typeof text === 'string' ? text.trim() : '';

  if (!raw) return null;
  if (!TARGET_RE.test(raw)) return null;
  if (NEGATION_RE.test(raw)) return null;

  const strong = STRONG_ACTION_RE.test(raw);
  const actionable = strong || LOOSE_ACTION_RE.test(raw) || ACTION_AFTER_RE.test(raw);

  if (!actionable) return null;
  if (META_QUESTION_RE.test(raw) && !strong) return null;
  if (PAST_REFERENCE_RE.test(raw) && !FRESH_ACTION_RE.test(raw)) return null;

  return {
    taskType: EXPLAIN_RE.test(raw) ? 'memory.explain' : 'memory.search',
    goal: truncateText(raw, GOAL_MAX_CHARS),
    context: '',
  };
}

module.exports = { detectExplicitDelegation, GOAL_MAX_CHARS };
