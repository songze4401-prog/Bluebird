/**
 * 技能系统回归（任务书 2026-11-21）。
 *
 * 覆盖三层：
 *  ① skills-loader 解析：front matter 正常/缺失/未闭合、slug 取目录名、
 *     正文读取、坏技能跳过不崩、目录不存在按空处理；
 *  ② persona.enabledSkills 集成：listSkills 的 enabled 标记、validateConfig
 *     严格校验（非数组/超上限拒绝）、normalize 宽松归一（去重截断）；
 *  ③ 运行层与 HTTP：BLUEBIRD_SKILLS=1 注册 load_skill（flag 关不注册，子进程验证）、
 *     工具 handler 对已启用/未启用/不存在的三种结局、真实 HTTP GET/PUT /skills
 *     （PUT 持久化进 persona.json，重启语义=重新读取仍然生效）、系统提示词
 *     清单块 buildPromptList（有启用→含 name+slug+description，无启用→null）。
 *
 * 测试只用临时目录（BLUEBIRD_DATA_DIR / BLUEBIRD_SKILLS_DIR 都指向 mkdtemp）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const test = require('node:test');
const assert = require('node:assert');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-skills-'));
const DATA_DIR = path.join(TMP_ROOT, 'data');
const SKILLS_DIR = path.join(TMP_ROOT, 'skills');

// ---- 环境隔离（必须在 require 任何服务端模块之前） ----
process.env.BLUEBIRD_DATA_DIR = DATA_DIR;
process.env.BLUEBIRD_SKILLS_DIR = SKILLS_DIR;
process.env.BLUEBIRD_API_TOKEN = 'test-skills-token';
process.env.DEEPSEEK_API_KEY = ''; // 空串防 dotenv 回灌
process.env.PORT = '0';
process.env.BLUEBIRD_AGENT_TOOLS = '1';
process.env.BLUEBIRD_SKILLS = '1';
process.env.BLUEBIRD_MONITORING = '0';

// 技能夹具：两个合法 + 两个坏技能（缺 front matter / 缺 description）
fs.mkdirSync(path.join(SKILLS_DIR, 'daily-brief'), { recursive: true });
fs.writeFileSync(
  path.join(SKILLS_DIR, 'daily-brief', 'SKILL.md'),
  '---\nname: 每日简报\ndescription: 按固定结构把内容整理成简报\n---\n\n# 每日简报\n\n正文内容甲。\n'
);
fs.mkdirSync(path.join(SKILLS_DIR, 'commit-style'), { recursive: true });
fs.writeFileSync(
  path.join(SKILLS_DIR, 'commit-style', 'SKILL.md'),
  "---\nname: 提交信息规范\ndescription: 按约定式提交撰写 commit message\n---\n\n正文内容乙。\n"
);
fs.mkdirSync(path.join(SKILLS_DIR, 'broken'), { recursive: true });
fs.writeFileSync(path.join(SKILLS_DIR, 'broken', 'SKILL.md'), '没有 front matter 的普通文档。\n');
fs.mkdirSync(path.join(SKILLS_DIR, 'noname'), { recursive: true });
fs.writeFileSync(path.join(SKILLS_DIR, 'noname', 'SKILL.md'), '---\nname: 缺描述\n---\n\n正文。\n');

const skillsLoader = require('../server/skills-loader');
const toolSkill = require('../server/tool-skill');
const persona = require('../server/persona');
const agentRuntime = require('../server/agent-runtime');
const { server: testServer } = require('../server/index.js');

let PORT = 0;

async function req(route, options = {}) {
  const { method = 'GET', body, token = 'test-skills-token' } = options;
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`http://127.0.0.1:${PORT}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {
    /* 非 JSON */
  }
  return { status: res.status, json, text };
}

test.before(async () => {
  if (!testServer.listening) {
    await new Promise(resolve => testServer.once('listening', resolve));
  }
  PORT = testServer.address().port;
});

test.after(() => {
  try {
    if (typeof testServer.closeAllConnections === 'function') testServer.closeAllConnections();
  } catch (_) {}
  try {
    testServer.close();
  } catch (_) {}
  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch (_) {}
});

function runTool(definition, args) {
  const checked = definition.validate(args);
  if (!checked.ok) return { ok: false, code: 'validation_failed', error: checked.error };
  return definition.handler(checked.args);
}

const loadSkillDef = toolSkill.loadSkillDefinition;

// ================= ① skills-loader 解析 =================

test('a. 解析：合法技能进清单，坏技能跳过且不崩', () => {
  const skills = skillsLoader.listSkills();
  const slugs = skills.map(s => s.slug);
  assert.deepEqual(slugs, ['commit-style', 'daily-brief'], '坏技能必须被跳过且列表按 slug 排序');
  const brief = skills.find(s => s.slug === 'daily-brief');
  assert.equal(brief.name, '每日简报');
  assert.equal(brief.description, '按固定结构把内容整理成简报');
  assert.equal(brief.enabled, false, '默认 enabledSkills 为空');
});

test('b. loadSkill：返回 front matter + 正文全文', () => {
  const full = skillsLoader.loadSkill('daily-brief');
  assert.ok(full);
  assert.equal(full.name, '每日简报');
  assert.ok(full.body.includes('# 每日简报'));
  assert.ok(full.body.includes('正文内容甲'));
  assert.equal(skillsLoader.loadSkill('broken'), null, '被跳过的技能读不到');
});

test('c. 目录不存在：按空列表处理（正常形态，不是错误）', () => {
  const dir = path.join(TMP_ROOT, 'empty-skills');
  fs.mkdirSync(dir, { recursive: true });
  const previous = process.env.BLUEBIRD_SKILLS_DIR;
  try {
    process.env.BLUEBIRD_SKILLS_DIR = dir;
    skillsLoader.resetSkillsCacheForTests();
    assert.deepEqual(skillsLoader.listSkills(), []);
  } finally {
    process.env.BLUEBIRD_SKILLS_DIR = previous;
    skillsLoader.resetSkillsCacheForTests();
  }
});

// ================= ② persona.enabledSkills 集成 =================

test('d. 启用状态来自 persona 配置：save 后 listSkills 反映', () => {
  const saved = persona.saveConfig({
    ...persona.getConfig(),
    enabledSkills: ['daily-brief'],
  });
  assert.equal(saved.ok, true);
  const skills = skillsLoader.listSkills();
  assert.equal(skills.find(s => s.slug === 'daily-brief').enabled, true);
  assert.equal(skills.find(s => s.slug === 'commit-style').enabled, false);
});

test('e. validateConfig 严格校验：非数组 / 超 50 项拒绝', () => {
  const bad = persona.validateConfig({ enabledSkills: 'daily-brief' });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some(e => e.includes('enabledSkills 必须是字符串数组')));
  const tooMany = persona.validateConfig({
    enabledSkills: Array.from({ length: 51 }, (_, i) => `s${i}`),
  });
  assert.equal(tooMany.ok, false);
  assert.ok(tooMany.errors.some(e => e.includes('超过 50 项')));
});

test('f. normalize 宽松归一：非法元素过滤 + 去重 + 截断', () => {
  const config = persona.normalizeConfig({
    enabledSkills: ['daily-brief', 'daily-brief', '', 42, 'commit-style'],
  });
  assert.deepEqual(config.enabledSkills, ['daily-brief', 'commit-style']);
});

test('g. 持久化：写盘文件含 enabledSkills，重读仍然生效', () => {
  const personaFile = path.join(DATA_DIR, 'persona.json');
  const onDisk = JSON.parse(fs.readFileSync(personaFile, 'utf8'));
  assert.deepEqual(onDisk.config.enabledSkills, ['daily-brief']);
});

// ================= ③ 系统提示词清单块 =================

test('h. buildPromptList：有启用技能 → 含 name+slug+description；清空 → null', () => {
  const text = skillsLoader.buildPromptList();
  assert.ok(text.includes('【可用技能】'));
  assert.ok(text.includes('每日简报'));
  assert.ok(text.includes('slug: daily-brief'));
  assert.ok(text.includes('按固定结构把内容整理成简报'));
  assert.ok(!text.includes('提交信息规范'), '未启用的技能不得出现在清单里');

  persona.saveConfig({ ...persona.getConfig(), enabledSkills: [] });
  assert.equal(skillsLoader.buildPromptList(), null, '无启用技能时不加块');
});

// ================= ④ 运行层：load_skill 注册与三种结局 =================

test('i. 注册面：BLUEBIRD_SKILLS=1 时 load_skill 只读注册', () => {
  const meta = agentRuntime.listToolMetadata().find(t => t.name === 'load_skill');
  assert.ok(meta, 'flag 开时 load_skill 必须注册');
  assert.equal(meta.readOnly, true);
  assert.equal(meta.risk, 'read');
});

test('j. 工具三种结局：已启用返回全文 / 未启用 skill_disabled / 不存在 skill_not_found', async () => {
  persona.saveConfig({ ...persona.getConfig(), enabledSkills: ['daily-brief'] });

  const enabled = await runTool(loadSkillDef, { name: 'daily-brief' });
  assert.equal(enabled.ok, true);
  assert.equal(enabled.slug, 'daily-brief');
  assert.ok(enabled.content.includes('正文内容甲'));

  const byDisplayName = await runTool(loadSkillDef, { name: '提交信息规范' });
  assert.equal(byDisplayName.ok, false);
  assert.equal(byDisplayName.code, 'skill_disabled', '未启用的技能拒绝读取');

  const missing = await runTool(loadSkillDef, { name: 'no-such-skill' });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'skill_not_found');
});

test('k. 子进程验证：BLUEBIRD_SKILLS=0 时 load_skill 不注册', () => {
  const runtimePath = JSON.stringify(path.join(__dirname, '..', 'server', 'agent-runtime.js'));
  const outPath = path.join(TMP_ROOT, 'child-registered.json');
  const script = `
    process.env.BLUEBIRD_DATA_DIR = process.env.CHILD_TMP;
    process.env.BLUEBIRD_MONITORING = '0';
    const fs = require('fs');
    const rt = require(${runtimePath});
    fs.writeFileSync(process.env.CHILD_OUT, JSON.stringify(rt.listToolMetadata().map(t => t.name)));
  `;
  execFileSync(process.execPath, ['-e', script], {
    env: { ...process.env, BLUEBIRD_SKILLS: '0', CHILD_TMP: path.join(TMP_ROOT, 'child'), CHILD_OUT: outPath },
  });
  const off = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.equal(off.includes('load_skill'), false, 'flag 关时不得注册 load_skill');

  execFileSync(process.execPath, ['-e', script], {
    env: { ...process.env, BLUEBIRD_SKILLS: '1', CHILD_TMP: path.join(TMP_ROOT, 'child'), CHILD_OUT: outPath },
  });
  const on = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.equal(on.includes('load_skill'), true);
});

// ================= ⑤ 真实 HTTP：GET/PUT /skills =================

test('l. GET /skills：清单 + enabled 状态（Bearer 鉴权）', async () => {
  const ok = await req('/skills');
  assert.equal(ok.status, 200);
  assert.ok(Array.isArray(ok.json.skills));
  const brief = ok.json.skills.find(s => s.slug === 'daily-brief');
  assert.equal(brief.enabled, true, '接续用例 j 的启用状态');

  const unauthorized = await req('/skills', { token: '' });
  assert.equal(unauthorized.status, 401);
});

test('m. PUT /skills：切换并持久化（重启语义=重读文件仍生效）', async () => {
  const put = await req('/skills', {
    method: 'PUT',
    body: { slug: 'commit-style', enabled: true },
  });
  assert.equal(put.status, 200);
  assert.equal(put.json.slug, 'commit-style');
  assert.equal(put.json.enabled, true);

  // 持久化：persona.json 落盘 + GET 复读一致（重启语义）
  const onDisk = JSON.parse(
    fs.readFileSync(path.join(DATA_DIR, 'persona.json'), 'utf8')
  );
  assert.ok(onDisk.config.enabledSkills.includes('commit-style'));
  assert.ok(onDisk.config.enabledSkills.includes('daily-brief'));
  const reread = await req('/skills');
  assert.equal(reread.json.skills.find(s => s.slug === 'commit-style').enabled, true);
});

test('n. PUT /skills 错误路径：未知 slug 404 / 缺 body 400 / 非布尔 enabled 400', async () => {
  const unknown = await req('/skills', { method: 'PUT', body: { slug: 'ghost', enabled: true } });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.code, 'skill_not_found');

  const noBody = await req('/skills', { method: 'PUT', body: {} });
  assert.equal(noBody.status, 400);
  assert.equal(noBody.json.code, 'bad_request');

  const badEnabled = await req('/skills', {
    method: 'PUT',
    body: { slug: 'daily-brief', enabled: 'yes' },
  });
  assert.equal(badEnabled.status, 400);
});

test('o. 未鉴权 PUT 拒绝（401）', async () => {
  const res = await req('/skills', { method: 'PUT', body: { slug: 'daily-brief', enabled: false }, token: '' });
  assert.equal(res.status, 401);
});

test('p. 解析边界：BOM 剥离 / 引号值 / body_too_large / 未闭合 front matter（oracle P2-2）', () => {
  fs.mkdirSync(path.join(SKILLS_DIR, 'bom-skill'), { recursive: true });
  fs.writeFileSync(
    path.join(SKILLS_DIR, 'bom-skill', 'SKILL.md'),
    '\uFEFF---\nname: BOM 技能\ndescription: 带 BOM 也能解析\n---\n\n正文丙。\n'
  );
  fs.mkdirSync(path.join(SKILLS_DIR, 'quoted'), { recursive: true });
  fs.writeFileSync(
    path.join(SKILLS_DIR, 'quoted', 'SKILL.md'),
    '---\nname: "引号技能"\ndescription: \'带引号的描述\'\n---\n\n正文。\n'
  );
  fs.mkdirSync(path.join(SKILLS_DIR, 'big-skill'), { recursive: true });
  fs.writeFileSync(
    path.join(SKILLS_DIR, 'big-skill', 'SKILL.md'),
    '---\nname: 超大\ndescription: 超限\n---\n\n' + 'x'.repeat(64 * 1024 + 1) + '\n'
  );
  fs.mkdirSync(path.join(SKILLS_DIR, 'unclosed'), { recursive: true });
  fs.writeFileSync(path.join(SKILLS_DIR, 'unclosed', 'SKILL.md'), '---\nname: 未闭合\ndescription: 没有\n');

  skillsLoader.resetSkillsCacheForTests();
  const bySlug = Object.fromEntries(skillsLoader.listSkills().map(s => [s.slug, s]));
  assert.equal(bySlug['bom-skill'] && bySlug['bom-skill'].name, 'BOM 技能', 'BOM 必须剥离');
  assert.equal(bySlug['quoted'] && bySlug['quoted'].name, '引号技能');
  assert.equal(bySlug['quoted'] && bySlug['quoted'].description, '带引号的描述', '成对引号剥离');
  assert.equal(bySlug['big-skill'], undefined, '超限技能跳过');
  assert.equal(bySlug['unclosed'], undefined, '未闭合 front matter 跳过');
});
