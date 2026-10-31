/* global module */
/**
 * 首期权限配置：单用户本地部署。
 *
 * 不引入多用户 ACL；这里保留一个明确的服务端检查入口，未来替换成
 * 真实用户/角色解析时无需改 Runtime 或审批执行器。
 */
const { getManifest } = require('./manifest');
const { AgentError } = require('./errors');
const { OPERATIONS } = require('../memory-service');

const SINGLE_USER_ACTOR = 'local-owner';

function getPermissionProfile(botId) {
  const manifest = getManifest(botId);
  if (!manifest) throw new AgentError('agent_not_found', 'Agent 不存在', 404);
  return {
    profileId: manifest.permissionProfileId,
    mode: 'single_user',
    actorId: SINGLE_USER_ACTOR,
    allowedOperations: [...OPERATIONS],
    approvalRequired: [...OPERATIONS],
    extensionPoint: {
      multiUser: false,
      aclResolver: 'permissions.checkOperation',
    },
  };
}

function checkOperation({ botId, operation, approved = false } = {}) {
  const manifest = getManifest(botId);
  if (!manifest) throw new AgentError('agent_not_found', 'Agent 不存在', 404);
  if (!OPERATIONS.includes(operation)) {
    return { ok: false, code: 'operation_not_allowed' };
  }
  if (approved !== true) {
    return { ok: false, code: 'approval_required' };
  }
  return { ok: true, actorId: SINGLE_USER_ACTOR };
}

module.exports = {
  SINGLE_USER_ACTOR,
  getPermissionProfile,
  checkOperation,
};
