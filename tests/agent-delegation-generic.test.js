/* global __dirname */
/**
 * 通用委派架构回归测试：
 * 1. 主控独占记忆工具，不再有 Memory Bot 记忆专岗
 * 2. delegate_to_bot 可派给任意已注册小 agent
 * 3. 不再有"记忆查询旁路/强制派发"逻辑
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-agent-generic-'));
process.env.BLUEBIRD_DATA_DIR = TMP;
process.env.DEEPSEEK_API_KEY = '';
process.env.MEMORY_ENABLED = 'true';
process.env.BLUEBIRD_AGENT_TOOLS = '';
process.env.BLUEBIRD_MONITORING = '0';

test.after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {
    // ignore
  }
});

test('manifest：不存在记忆专岗角色，三个小 agent 不持有记忆工具', () => {
  const manifest = require('../server/agents/manifest');
  const ids = manifest.listManifests().map(item => item.botId).sort();
  assert.deepEqual(ids, ['executor', 'memory', 'researcher', 'reviewer']);

  for (const item of manifest.listManifests()) {
    // memory_search 完全移除；memory_remember 仅作为 Gateway 副作用判定载体保留，
    // 运行时由 handler 的 agentId 硬闸拒绝，见下方测试。
    assert.equal(
      item.toolAllowlist.includes('memory_search'),
      false,
      `${item.botId} 不应持有 memory_search`
    );
  }
  // memory 这个 id 保留为通用执行 agent，但不再是记忆专岗
  const generic = manifest.getManifest('memory');
  assert.equal(generic.displayName, 'Action Bot');
  assert.equal(generic.systemPrompt.includes('Memory Bot'), false);
  assert.equal(generic.systemPrompt.includes('不处理长期记忆'), true);
});

test('delegate_to_bot：botId 必填且可派给任意已注册 agent', () => {
  const tool = require('../server/tool-dispatch-bot').definition;
  assert.equal(tool.validate({ taskType: 'research.analyze', goal: 'x' }).ok, false);
  assert.equal(tool.validate({ botId: 'nonexistent', taskType: 'research.analyze', goal: 'x' }).ok, false);
  const ok = tool.validate({ botId: 'researcher', taskType: 'research.analyze', goal: 'x' });
  assert.equal(ok.ok, true, JSON.stringify(ok));
});

test('主控仍持有记忆工具（记忆由模型负责）', () => {
  const runtime = require('../server/agent-runtime');
  const names = runtime
    .listToolSpecs()
    .map(item => item.function && item.function.name);
  assert.ok(names.includes('memory_search'));
  assert.ok(names.includes('memory_remember'));
});

test('agent-runtime 不再有记忆查询旁路/强制派发的提示词', () => {
  const source = fs.readFileSync(require.resolve('../server/agent-runtime'), 'utf8');
  assert.equal(source.includes('DIRECT_MEMORY_QUERY_INSTRUCTION'), false);
  assert.equal(source.includes('FORCED_DELEGATION_INSTRUCTION'), false);
  assert.equal(source.includes('enforceExplicitDelegation'), false);
  assert.equal(source.includes('memory_query_direct'), false);
});

test('memory_remember 硬闸：Bot 上下文调用一律拒绝，主控上下文放行', async () => {
  const tool = require('../server/tool-memory-remember');
  const botCall = await tool.definition.handler(
    { content: '测试记忆', type: 'fact' },
    { agentId: 'memory', sessionId: 's1', userText: '记住测试记忆' }
  );
  assert.equal(botCall.ok, false);
  assert.equal(botCall.code, 'memory_main_agent_only');
});
