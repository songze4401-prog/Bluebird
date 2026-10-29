/**
 * 云岫 Bluebird — Trace 上下文（monitoring/context.js）
 *
 * 用 AsyncLocalStorage 把一次请求的 trace/span 关联到异步调用链上：
 * - 业务代码不需要层层传 traceId；
 * - 模型调用、工具执行、记忆检索等边界自动挂到当前 trace；
 * - 没有活动 trace 时所有监控调用都是 no-op（测试/脚本不产生副作用）。
 *
 * 只传递标识，不携带任何正文；span 栈只在内存中存在，结束时写 Trace 存储。
 */
const { AsyncLocalStorage } = require('async_hooks');
const crypto = require('crypto');

const storage = new AsyncLocalStorage();

function newTraceId() {
  return `tr_${crypto.randomUUID()}`;
}

function newSpanId() {
  return `sp_${crypto.randomUUID()}`;
}

function newEventId() {
  return `ev_${crypto.randomUUID()}`;
}

// 会话引用：内部可关联、外部不暴露原始会话 ID（页面隐私要求）。
function sessionRefFor(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  return `s_${crypto
    .createHash('sha256')
    .update(`bluebird:${sessionId}`)
    .digest('hex')
    .slice(0, 16)}`;
}

// 操作者引用：没有独立身份体系时，用 token 的哈希前缀做审计关联，
// 绝不记录 token 原文。
function actorRefFor(authorization) {
  const raw = typeof authorization === 'string' ? authorization : '';
  const token = raw.startsWith('Bearer ') ? raw.slice(7) : raw;
  if (!token) return null;
  return `a_${crypto.createHash('sha256').update(token).digest('hex').slice(0, 12)}`;
}

function runWithTrace(store, fn) {
  return storage.run(store, fn);
}

function currentStore() {
  return storage.getStore() || null;
}

function currentTraceId() {
  const store = currentStore();
  return store ? store.traceId : null;
}

function currentSpanId() {
  const store = currentStore();
  if (!store || !Array.isArray(store.spanStack) || !store.spanStack.length) {
    return null;
  }
  return store.spanStack[store.spanStack.length - 1];
}

function pushSpan(spanId) {
  const store = currentStore();
  if (!store) return false;
  store.spanStack.push(spanId);
  return true;
}

function popSpan(spanId) {
  const store = currentStore();
  if (!store) return;
  const stack = store.spanStack;
  if (!stack.length) return;
  if (stack[stack.length - 1] === spanId) {
    stack.pop();
    return;
  }
  // 异步分支里 span 可能乱序结束：只移除对应项，绝不误弹栈顶。
  const index = stack.lastIndexOf(spanId);
  if (index >= 0) stack.splice(index, 1);
}

module.exports = {
  storage,
  newTraceId,
  newSpanId,
  newEventId,
  sessionRefFor,
  actorRefFor,
  runWithTrace,
  currentStore,
  currentTraceId,
  currentSpanId,
  pushSpan,
  popSpan,
};
