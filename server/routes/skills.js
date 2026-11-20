/**
 * 技能 HTTP API（任务书 2026-11-21）。
 *
 * GET /skills → 全部技能 + enabled 状态（来源 persona.enabledSkills）；
 * PUT /skills → {slug, enabled}，写 persona.enabledSkills（走 saveConfig 全量校验，
 * 与 PUT /persona 的契约一致：非法输入 400、文件损坏/写失败 409/500）。
 * 复用 Bearer 鉴权与全局限流；技能目录扫描失败按空列表返回，不让路由崩。
 */
const express = require('express');
const persona = require('../persona');
const skillsLoader = require('../skills-loader');

function createSkillsRouter({ requireAuth } = {}) {
  if (typeof requireAuth !== 'function') {
    throw new TypeError('[skills] createSkillsRouter 需要 requireAuth');
  }

  const router = express.Router();

  router.get('/', requireAuth, (req, res) => {
    res.json({ ok: true, skills: skillsLoader.listSkills() });
  });

  router.put('/', requireAuth, (req, res) => {
    const slug = req.body && typeof req.body.slug === 'string' ? req.body.slug.trim() : '';
    const enabled = req.body ? req.body.enabled : undefined;

    if (!slug) {
      return res.status(400).json({ error: '缺少 slug', code: 'bad_request' });
    }
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled 必须是布尔值', code: 'bad_request' });
    }
    if (!skillsLoader.loadSkill(slug)) {
      return res.status(404).json({ error: `技能不存在：${slug}`, code: 'skill_not_found' });
    }

    const current = persona.getConfig();
    const set = new Set(current.enabledSkills || []);
    if (enabled) set.add(slug);
    else set.delete(slug);

    const saved = persona.saveConfig({ ...current, enabledSkills: [...set] });
    if (!saved.ok) {
      // HTTP 码与 PUT /persona 三态对齐（oracle P3）：invalid_config 400 /
      // 文件损坏 409 / 写失败 500。
      const status =
        saved.code === 'invalid_config'
          ? 400
          : saved.code === 'persona_write_failed'
            ? 500
            : 409;
      return res.status(status).json({ ok: false, error: saved.error, code: saved.code });
    }
    return res.json({ ok: true, slug, enabled, skills: skillsLoader.listSkills() });
  });

  return router;
}

module.exports = { createSkillsRouter };
