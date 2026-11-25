'use strict';

// 模型服务商：列表 / CRUD / 默认模型 / 启停 / 连通性测试
// （健康度审计 R3b：自 index.js 迁出的路由族，工厂注入共享依赖，
//  调用点零行为变化——路径全为精确匹配，挂载顺序不敏感。）
const express = require('express');
const {
  BUILTIN_PROVIDER_ID,
  listModelProviders,
  getModelProvider,
  getDefaults,
  isConfigCorrupted,
  addModelProvider,
  updateModelProvider,
  applyProviderModelMetadata,
  deleteModelProvider,
  setDefaultModel,
  setProviderEnabled,
} = require('../api-configs');
const {
  assertPublicUrl,
  classifyError,
  testProviderConnection,
  invalidateProviderCache,
} = require('../model-adapter');

function createModelProvidersRouter(deps) {
  const {
    requireAuth,
    auditAction,
  } = deps;

  const router = express.Router();

router.get('/model-providers', requireAuth, (req, res) => {
  res.json({
    providers: listModelProviders(),
    defaults: getDefaults(),
    builtinProviderId: BUILTIN_PROVIDER_ID,
    configCorrupted: isConfigCorrupted(),
  });
});

// 单个服务商详情（脱敏）
router.get('/model-providers/:id', requireAuth, (req, res) => {
  const provider = getModelProvider(req.params.id);
  if (!provider) {
    return res.status(404).json({ error: '服务商不存在' });
  }
  res.json({ provider });
});

// 新增服务商：{ name, baseUrl, apiKey, models: [{ id, name?, capabilities?: { vision?: true } }] }
// baseUrl 先过 SSRF 校验再落盘——被拦截的 URL 绝不进入配置。
router.post('/model-providers', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    if (typeof body.baseUrl === 'string' && body.baseUrl.trim()) {
      await assertPublicUrl(body.baseUrl);
    }

    const result = addModelProvider(body);
    if (result.error) {
      return res
        .status(result.error === 'config_corrupted' ? 409 : 400)
        .json({ error: result.error });
    }

    auditAction(req, 'model_provider.create', {
      target: 'model_provider',
      reason: 'configuration_changed',
    });
    res.status(201).json({ provider: result.provider });
  } catch (error) {
    auditAction(req, 'model_provider.create', {
      target: 'model_provider',
      result: 'failed',
      reason: error && error.code ? error.code : 'create_failed',
    });
    const info = classifyError(error);
    res.status(info.status).json({ error: info.error, code: info.code });
  }
});

// 编辑服务商：局部更新。apiKey 缺省或空串 = 保留原有密钥（不意外覆盖）；
// 改 baseUrl 需重新过 SSRF 校验。
router.patch('/model-providers/:id', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    if (typeof body.baseUrl === 'string' && body.baseUrl.trim()) {
      await assertPublicUrl(body.baseUrl);
    }

    const result = updateModelProvider(req.params.id, body);
    if (result.error) {
      const status =
        result.error === 'not_found'
          ? 404
          : result.error === 'config_corrupted'
            ? 409
            : 400;
      return res.status(status).json({ error: result.error });
    }

    invalidateProviderCache(req.params.id);
    auditAction(req, 'model_provider.update', {
      target: 'model_provider',
      reason: 'configuration_changed',
    });
    res.json({ provider: result.provider });
  } catch (error) {
    auditAction(req, 'model_provider.update', {
      target: 'model_provider',
      result: 'failed',
      reason: error && error.code ? error.code : 'update_failed',
    });
    const info = classifyError(error);
    res.status(info.status).json({ error: info.error, code: info.code });
  }
});

// 删除服务商：内置不可删；当前默认服务商不可删（先切换默认）。
router.delete('/model-providers/:id', requireAuth, (req, res) => {
  const result = deleteModelProvider(req.params.id);
  if (result.error) {
    const status =
      result.error === 'not_found'
        ? 404
        : result.error === 'config_corrupted'
          ? 409
          : 400;
    return res.status(status).json({ error: result.error });
  }

  invalidateProviderCache(req.params.id);
  auditAction(req, 'model_provider.delete', {
    target: 'model_provider',
    reason: 'configuration_changed',
  });
  res.json({ ok: true });
});

// 设置默认服务商 + 默认模型：{ providerId, modelId }
router.put('/model-providers/default', requireAuth, (req, res) => {
  const result = setDefaultModel(req.body || {});
  if (result.error) {
    return res.status(400).json({ error: result.error });
  }
  auditAction(req, 'model_provider.set_default', {
    target: 'model_provider',
    reason: 'configuration_changed',
  });
  res.json({ defaults: result.defaults });
});

// 启用 / 禁用服务商：{ enabled: true|false }。默认服务商不可禁用。
router.post('/model-providers/:id/enabled', requireAuth, (req, res) => {
  const body = req.body || {};
  if (typeof body.enabled !== 'boolean') {
    return res.status(400).json({ error: '缺少布尔字段 enabled' });
  }

  const result = setProviderEnabled(req.params.id, body.enabled);
  if (result.error) {
    const status =
      result.error === 'not_found'
        ? 404
        : result.error === 'config_corrupted'
          ? 409
          : 400;
    return res.status(status).json({ error: result.error });
  }

  if (body.enabled === false) invalidateProviderCache(req.params.id);
  auditAction(req, body.enabled ? 'model_provider.enable' : 'model_provider.disable', {
    target: 'model_provider',
    reason: 'configuration_changed',
  });
  res.json({ provider: result.provider });
});

// 连接测试：GET {baseUrl}/models（5s 超时 / 64KB 响应上限）。
// 自定义 Base URL 先过 SSRF 校验；错误摘要不含密钥。
// 连通成功后顺手把 /models 声明的上下文窗口同步进模型记录（只同步服务商
// 真实声明的数值），响应里以 windowSync 明示同步/拒绝项，不静默改配置。
router.post('/model-providers/:id/test', requireAuth, async (req, res) => {
  const result = await testProviderConnection(req.params.id);
  if (result && result.ok && Array.isArray(result.models)) {
    const sync = applyProviderModelMetadata(req.params.id, result.models);
    res.json({
      ...result,
      windowSync: {
        error: sync.error || null,
        updated: sync.updated || [],
        rejected: sync.rejected || [],
      },
    });
    return;
  }
  res.json(result);
});


  return router;
}

module.exports = { createModelProvidersRouter };
