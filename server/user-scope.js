/* global module, process */
/**
 * 云岫 Bluebird — 可信用户身份（user-scope.js）
 *
 * 长期记忆的读作用域是「用户级」，所以必须有一个服务端可信的用户身份。
 *
 * 当前部署形态：单实例 + 单一共享 Bearer token。所有通过认证的请求都属于
 * 同一个实例用户，因此实例用户 id 只从服务端配置读取，**绝不接受客户端传入
 * 的 userId**（架构决策明确要求：不能仅凭客户端传入的 userId/sessionId 放行）。
 *
 * 将来接入真实多用户认证时，只需把 resolveUserId 改成「从认证凭证解析用户」，
 * 记忆读路径与检索作用域不用再改。
 */

// 与 server/agents/permissions.js 的 SINGLE_USER_ACTOR 保持同一口径：
// 单用户部署下只有一个服务端身份。这里不直接 require 它，避免
// memory.js → user-scope → permissions → memory-service → memory.js 的循环依赖。
const DEFAULT_USER_ID = 'local-owner';
const USER_ID_MAX = 120;

function cleanUserId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, USER_ID_MAX);
}

// 实例用户 id：启动时读一次，运行期不变（避免同一进程内作用域漂移）。
const INSTANCE_USER_ID =
  cleanUserId(process.env.BLUEBIRD_USER_ID) || DEFAULT_USER_ID;

function getInstanceUserId() {
  return INSTANCE_USER_ID;
}

/**
 * 从请求解析可信用户身份。
 *
 * 当前实现刻意忽略 req：单实例单用户，身份来自服务端配置。
 * 保留 req 形参是为了将来接入认证时不用改调用点；任何实现都不得读取
 * req.body.userId / req.query.userId 之类的客户端字段。
 */
function resolveUserId(_req) {
  return INSTANCE_USER_ID;
}

module.exports = {
  DEFAULT_USER_ID,
  getInstanceUserId,
  resolveUserId,
  cleanUserId,
};
