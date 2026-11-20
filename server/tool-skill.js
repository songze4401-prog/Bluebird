/**
 * 技能读取工具（任务书 2026-11-21）：load_skill
 *
 * 只读：只能读取已启用技能的 SKILL.md 全文；未启用/不存在返回清楚的错误。
 * 注册受 BLUEBIRD_SKILLS=1 控制（agent-runtime.js），同时受 BLUEBIRD_AGENT_TOOLS
 * 总开关约束；系统提示词只注入已启用技能的 name+description 清单（非全文），
 * 模型需要全文时自己调本工具。
 */
const skillsLoader = require('./skills-loader');

const LIMITS = Object.freeze({ nameMax: 120 });

const loadSkillDefinition = Object.freeze({
  name: 'load_skill',
  description:
    '读取一个已启用技能的 SKILL.md 完整说明。系统提示词里列出的技能只有一句话简介；' +
    '需要按某个技能的具体流程行事时，先用本工具读全文再执行。参数传技能的 slug 或显示名。',
  parameters: Object.freeze({
    type: 'object',
    properties: Object.freeze({
      name: Object.freeze({
        type: 'string',
        description: '技能的 slug（目录名）或显示名',
        maxLength: LIMITS.nameMax,
      }),
    }),
    required: Object.freeze(['name']),
  }),
  timeoutMs: 5000,
  readOnly: true,

  validate(args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return { ok: false, error: '参数必须是 JSON 对象' };
    }
    const name = typeof args.name === 'string' ? args.name.trim() : '';
    if (!name) return { ok: false, error: '缺少必填参数 name' };
    if (name.length > LIMITS.nameMax) {
      return { ok: false, error: `name 超过 ${LIMITS.nameMax} 字符上限` };
    }
    return { ok: true, args: { name } };
  },

  async handler(args) {
    const skills = skillsLoader.listSkills();
    const found = skills.find(s => s.slug === args.name || s.name === args.name);
    if (!found) {
      return {
        ok: false,
        code: 'skill_not_found',
        error: `没有这个技能：${args.name}。可用技能：${
          skills.map(s => s.slug).join(', ') || '(无)'
        }`,
        summary: '技能不存在',
      };
    }
    if (!found.enabled) {
      return {
        ok: false,
        code: 'skill_disabled',
        error: `技能「${found.name}」未启用，请用户在设置的技能面板里开启后再试`,
        summary: '技能未启用',
      };
    }
    const full = skillsLoader.loadSkill(found.slug);
    if (!full) {
      return {
        ok: false,
        code: 'skill_not_found',
        error: `技能内容读取失败：${found.slug}`,
        summary: '技能内容缺失',
      };
    }
    return {
      ok: true,
      slug: full.slug,
      name: full.name,
      content: full.body,
      bytes: Buffer.byteLength(full.body, 'utf8'),
      summary: `已读取技能：${full.name}`,
    };
  },
});

function isEnabled() {
  return process.env.BLUEBIRD_SKILLS === '1';
}

module.exports = { loadSkillDefinition, LIMITS, isEnabled };
