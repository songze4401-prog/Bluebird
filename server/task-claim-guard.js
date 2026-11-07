/* global module */
/**
 * 回复里的任务声明核对（纯函数，无副作用）。
 *
 * 模型会声称"已派发 / 进了队列 / 返回了任务 ID"，但本轮实际上没有调用
 * delegate_to_bot，任务库里也没有对应记录。本模块在交付前做确定性核对：
 * - 回复中出现的 task_<uuid> 必须在任务库存在，否则替换为 task_（不存在）；
 * - 声称派发/排队、但本轮没有派发、该会话又没有活跃或近期任务时，视为无据声明。
 * 命中任一情况，在回复末尾追加系统校验说明；正文以外的内容不做改写。
 */

const TASK_ID_RE =
  /\btask_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
// 只匹配"本轮任务的状态声明"，不匹配"怎么看任务 ID"这类说明性文字。
// 派发动词必须带任务对象（任务 / 子 agent / bot），避免"把垃圾扔了"这类误报。
const DISPATCH_CLAIM_RE =
  /(?:扔了|派了|派出去了?|已派发|派发成功|已交给|已转给)[^。！？\n]{0,12}(?:任务|子\s*agent|memory\s*bot|记忆\s*bot|agent)|(?:进了?队列|进入队列|在队列|队列里|还在排|排着|queued)/i;
const DEFAULT_TERMINAL = new Set([
  'completed',
  'failed',
  'cancelled',
  'canceled',
  'timed_out',
  'recovery',
  'rejected',
]);
const NOTICE =
  '（系统校验：本轮没有产生新的子任务；上述任务 ID 或排队状态在本机任务库中没有对应记录，请以任务页为准。）';
const DEFAULT_RECENT_WINDOW_MS = 10 * 60 * 1000;

function auditTaskClaims(
  reply,
  {
    lookupTask = null,
    listSessionTasks = null,
    dispatchedThisTurn = false,
    isTerminal = status => DEFAULT_TERMINAL.has(String(status || '')),
    now = Date.now(),
    recentWindowMs = DEFAULT_RECENT_WINDOW_MS,
  } = {}
) {
  if (typeof reply !== 'string' || !reply.trim()) {
    return { reply, violations: [] };
  }

  const ids = [...new Set(reply.match(TASK_ID_RE) || [])];
  const violations = [];
  let text = reply;

  // 无法核对（未注入 lookupTask）时不误报，保持原样。
  const unknown = ids.filter(id =>
    typeof lookupTask === 'function' ? !lookupTask(id) : false
  );

  for (const id of unknown) {
    text = text.split(id).join('task_（不存在）');
    violations.push({ kind: 'unknown_task_id', id });
  }

  // 没有给出任务 ID 的"排队/派发"声明：会话里既没有活跃任务、也没有近期
  // 任务时，说明它凭空冒出来的。给了已知 ID 的回复不参与这条判断。
  if (
    DISPATCH_CLAIM_RE.test(reply) &&
    !dispatchedThisTurn &&
    ids.length === 0
  ) {
    const sessionTasks =
      typeof listSessionTasks === 'function' ? listSessionTasks() || [] : [];
    const hasActive = sessionTasks.some(task => task && !isTerminal(task.status));
    const hasRecent = sessionTasks.some(task => {
      const at = Date.parse(task && task.createdAt);
      return Number.isFinite(at) && now - at <= recentWindowMs;
    });

    if (!hasActive && !hasRecent) {
      violations.push({ kind: 'dispatch_without_task' });
    }
  }

  if (!violations.length) return { reply, violations: [] };

  return { reply: `${text}\n\n${NOTICE}`, violations };
}

module.exports = { auditTaskClaims };
