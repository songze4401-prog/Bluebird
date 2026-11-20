/**
 * 技能（skill）加载器（任务书 2026-11-21）。
 *
 * 扫描 skills/<slug>/SKILL.md，解析 front matter（name/description）+ 正文，
 * 结果进程内缓存；单个技能解析失败跳过并告警，绝不让整个加载崩掉。
 *
 * 导出：
 * - listSkills() → [{slug,name,description,enabled}]（enabled 由注入的启用状态读取器提供）
 * - loadSkill(slug) → {slug,name,description,body} | null（不限启用态，启用校验由调用方做）
 * - isEnabled(slug) → 是否已启用
 * - buildPromptList() → 已启用技能的 name+description 清单文本；一个都没启用时返回 null
 * - setEnablementProvider(fn) / resetSkillsCacheForTests()
 *
 * 启用状态持久化在 persona.enabledSkills；但本模块不直接依赖 persona——由组装根
 * （index.js）注入读取器。静态依赖会把「agent-runtime → tool-skill → skills-loader
 * → persona → data-events → … → agent-runtime」闭成新循环圈（SCC 冻结门禁 R1 违规，
 * 门禁同时计入函数内惰性 require）。
 * 测试缝隙：BLUEBIRD_SKILLS_DIR 可把扫描目录指向临时目录（仅测试用，类似
 * BLUEBIRD_ALLOW_PRIVATE_BASE_URL 的 test-only 旁路），默认扫仓库根 skills/。
 */
const fs = require('fs');
const path = require('path');

const LIMITS = Object.freeze({
  bodyMaxBytes: 64 * 1024, // 单技能正文上限（SKILL.md 正文）
  enabledMax: 50, // enabledSkills 数组上限
});

const DEFAULT_SKILLS_DIR = path.resolve(__dirname, '..', 'skills');

// 每次扫描时读取（而非模块加载期固化）：测试可翻转 BLUEBIRD_SKILLS_DIR 指向
// 临时目录；生产环境 env 静态，行为不变。注意解析结果有进程内缓存——
// 技能文件的增删改需重启才生效（.env.example 已声明）。
function getSkillsDir() {
  // 测试缝隙：可指向任意目录，SKILL.md 内容会进系统提示词与 load_skill 可读面；
  // 仅测试使用，生产不要设置。
  return process.env.BLUEBIRD_SKILLS_DIR
    ? path.resolve(process.env.BLUEBIRD_SKILLS_DIR)
    : DEFAULT_SKILLS_DIR;
}

let cache = null;

// 启用状态读取器（由组装根注入）；未注入时视为无启用技能。
let enablementProvider = null;

function setEnablementProvider(fn) {
  enablementProvider = typeof fn === 'function' ? fn : null;
}

// front matter 解析：只认 name/description 两个键（未知键忽略），
// 值支持成对引号剥离；缺 name 或 description 直接判失败（调用方跳过+告警）。
function parseSkillFile(text, slug) {
  // 剥 UTF-8 BOM（Windows 编辑器常见；oracle P2-2）
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (!text.startsWith('---')) return { error: 'missing_front_matter' };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { error: 'front_matter_not_closed' };
  const fields = {};
  for (const line of text.slice(3, end).split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (key) fields[key] = value;
  }
  const name = typeof fields.name === 'string' ? fields.name.trim() : '';
  const description =
    typeof fields.description === 'string' ? fields.description.trim() : '';
  if (!name) return { error: 'missing_name' };
  if (!description) return { error: 'missing_description' };
  const body = text
    .slice(end + 4)
    .replace(/^\s*\n/, '')
    .replace(/\s+$/, '');
  if (Buffer.byteLength(body, 'utf8') > LIMITS.bodyMaxBytes) {
    return { error: 'body_too_large' };
  }
  if (!body.trim()) return { error: 'empty_body' };
  return { slug, name, description, body };
}

function scanSkills() {
  if (cache) return cache;
  const out = [];
  const skillsDir = getSkillsDir();
  let entries;
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch (error) {
    // 目录不存在（没装任何技能）按空列表处理——这是正常形态，不是错误。
    if (error && error.code !== 'ENOENT') {
      console.warn(`[skills] 技能目录不可读（${error.code || 'io_error'}），按无技能处理`);
    }
    cache = [];
    return cache;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const slug = entry.name;
    const file = path.join(skillsDir, slug, 'SKILL.md');
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        console.warn(`[skills] 跳过目录 ${slug}：缺少 SKILL.md`);
      } else {
        console.warn(`[skills] 跳过技能 ${slug}：SKILL.md 不可读（${error.code || 'io_error'}）`);
      }
      continue;
    }
    const parsed = parseSkillFile(text, slug);
    if (parsed.error) {
      console.warn(`[skills] 跳过技能 ${slug}：${parsed.error}`);
      continue;
    }
    out.push(parsed);
  }
  out.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  cache = out;
  return cache;
}

function enabledSlugSet() {
  // 启用状态经依赖注入读取（拆接口，SCC 冻结门禁 R1）；未注入时视为无启用技能。
  const list = enablementProvider ? enablementProvider() : [];
  return new Set(Array.isArray(list) ? list : []);
}

function listSkills() {
  const enabled = enabledSlugSet();
  return scanSkills().map(s => ({
    slug: s.slug,
    name: s.name,
    description: s.description,
    enabled: enabled.has(s.slug),
  }));
}

function loadSkill(slug) {
  if (typeof slug !== 'string' || !slug.trim()) return null;
  return scanSkills().find(s => s.slug === slug) || null;
}

function isEnabled(slug) {
  return enabledSlugSet().has(slug);
}

// 系统提示词清单块：只含已启用技能的 name+description（非全文，省 token）。
// 一个都没启用返回 null（调用方据此不加块）。
function buildPromptList() {
  const enabled = enabledSlugSet();
  const rows = scanSkills()
    .filter(s => enabled.has(s.slug))
    .map(s => `- ${s.name}（slug: ${s.slug}）：${s.description}`);
  if (!rows.length) return null;
  return `【可用技能】以下技能已启用。需要按某个技能行事时，先用 load_skill 工具读取它的完整说明（参数传 slug）：\n${rows.join('\n')}`;
}

function resetSkillsCacheForTests() {
  cache = null;
}

module.exports = {
  LIMITS,
  getSkillsDir,
  setEnablementProvider,
  listSkills,
  loadSkill,
  isEnabled,
  buildPromptList,
  resetSkillsCacheForTests,
};
