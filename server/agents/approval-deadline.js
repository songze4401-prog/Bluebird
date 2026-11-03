/**
 * S6b：审批等待期的 Task deadline 计时器注册表。
 *
 * 只负责“一个任务最多一个等待审批计时器”的挂载与清除，不做状态写入；
 * 到期回调由 runtime 注册（run history / 投递 / 事件），任务离开
 * waiting_approval 时由 tasks.applyTransition 统一清除。
 * 本模块不依赖 tasks/runtime，避免循环依赖。
 */
const timers = new Map();
let expireHandler = null;

function setExpireHandler(handler) {
  expireHandler = typeof handler === 'function' ? handler : null;
}

function disarm(taskId) {
  const key = String(taskId || '');
  const timer = timers.get(key);
  if (timer) clearTimeout(timer);
  timers.delete(key);
}

function arm(taskId, delayMs) {
  const key = String(taskId || '');
  if (!key) return;
  disarm(key);
  const timer = setTimeout(() => {
    timers.delete(key);
    if (expireHandler) expireHandler(key);
  }, Math.max(0, delayMs));
  if (typeof timer.unref === 'function') timer.unref();
  timers.set(key, timer);
}

function isArmed(taskId) {
  return timers.has(String(taskId || ''));
}

module.exports = { arm, disarm, isArmed, setExpireHandler };
