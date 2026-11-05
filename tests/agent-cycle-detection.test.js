/* global require, process, Buffer */
/**
 * §17 委派环 + Artifact lineage 环检测回归。
 *
 * 断言口径（对齐原文）：
 *  a) 委派链成环 → 拒绝（not_authorized）并给出可读环路；合法链放行；
 *  b) lineage 成环 → 拒绝（validation_failed）并给出可读环路；合法链放行；
 *  c) 接入真实入口：agent-limits 的委派深度检查与 artifact-store 的
 *     新增引用检查都走同一检测器；检测到环时不落任何新产物。
 *
 * 隔离纪律：BLUEBIRD_DATA_DIR 在 require server/ 之前指向临时目录。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-cycle-detection-'));
process.env.BLUEBIRD_DATA_DIR = TMP;

const cycleDetection = require('../server/agents/cycle-detection');
const agentLimits = require('../server/agents/agent-limits');
const artifactStore = require('../server/agents/artifact-store');

const AGENTS_DIR = path.join(TMP, 'agents');
const ARTIFACTS_FILE = path.join(AGENTS_DIR, 'agent-artifacts.json');

function seedArtifacts(entries) {
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
  fs.mkdirSync(artifactStore.CONTENTS_DIR, { recursive: true });
  const store = { version: 1, artifacts: {} };
  for (const entry of entries) {
    const content = { evidence: entry.evidence || [] };
    const serialized = JSON.stringify(content);
    const contentHash = crypto.createHash('sha256').update(serialized).digest('hex');
    store.artifacts[entry.id] = {
      id: entry.id,
      kind: 'message',
      version: 1,
      createdAt: '2026-11-01T00:00:00.000Z',
      contentHash,
      refCount: 0,
      status: 'active',
      commit: 'committed',
      taskId: null,
      runId: null,
      refs: [],
      trustLevel: 'untrusted',
      trust: null,
      lastCheckedAt: null,
      supersededBy: null,
      supersededAt: null,
      invalidatedAt: null,
      invalidatedReason: null,
    };
    fs.writeFileSync(
      path.join(artifactStore.CONTENTS_DIR, `${entry.id}.json`),
      JSON.stringify({
        version: 1,
        id: entry.id,
        artifactVersion: 1,
        kind: 'message',
        contentHash,
        bytes: Buffer.byteLength(serialized, 'utf8'),
        content,
      })
    );
  }
  fs.writeFileSync(ARTIFACTS_FILE, JSON.stringify(store, null, 2));
}

test('§17 委派环：检测到即拒绝并给出可读路径', () => {
  const cyclic = {
    t1: { parentTaskId: 't2' },
    t2: { parentTaskId: 't3' },
    t3: { parentTaskId: 't1' },
  };
  assert.throws(
    () => cycleDetection.assertDelegationAcyclic('t1', cyclic),
    error => {
      assert.strictEqual(error.code, 'not_authorized');
      assert.strictEqual(error.status, 403);
      assert.match(error.message, /t1 -> t2 -> t3 -> t1/);
      assert.strictEqual(error.details.causeRef, 'delegation_cycle');
      return true;
    }
  );
  // 真实入口（agent-limits）复用同一检测器
  assert.throws(
    () => agentLimits.assertDelegationAllowed('t1', cyclic),
    error => {
      assert.strictEqual(error.code, 'not_authorized');
      assert.match(error.message, /t1 -> t2 -> t3 -> t1/);
      return true;
    }
  );
});

test('§17 合法委派链放行', () => {
  const legal = {
    root: { parentTaskId: null },
    t1: { parentTaskId: 'root' },
  };
  assert.strictEqual(cycleDetection.assertDelegationAcyclic('t1', legal), null);
  // root -> t1 再委派一层 = 深度 2，未超硬限
  assert.strictEqual(agentLimits.assertDelegationAllowed('t1', legal), 2);
});

test('§17 lineage 环：检测到即拒绝并给出可读路径', () => {
  const graph = {
    art_A: { content: { evidence: [{ id: 'art_B' }] } },
    art_B: { content: { evidence: [{ id: 'art_C' }] } },
    art_C: { content: { evidence: [{ id: 'art_A' }] } },
  };
  const read = id => graph[id];
  const cycle = cycleDetection.findLineageCycle('art_A', read);
  assert.deepStrictEqual(cycle, ['art_A', 'art_B', 'art_C', 'art_A']);
  assert.throws(
    () => cycleDetection.assertLineageAcyclic('art_A', read),
    error => {
      assert.strictEqual(error.code, 'validation_failed');
      assert.strictEqual(error.status, 400);
      assert.match(error.message, /art_A -> art_B -> art_C -> art_A/);
      assert.strictEqual(error.details.causeRef, 'lineage_cycle');
      return true;
    }
  );
});

test('§17 合法 lineage 链放行', () => {
  const graph = {
    art_A: { content: { evidence: [{ id: 'art_B' }] } },
    art_B: { content: { evidence: [{ id: 'art_C' }] } },
    art_C: { content: { evidence: [] } },
  };
  const read = id => graph[id];
  assert.strictEqual(cycleDetection.findLineageCycle('art_A', read), null);
  assert.strictEqual(cycleDetection.assertLineageAcyclic('art_A', read), null);
});

test('§17 接入产物入口：新增引用遇到 lineage 环时拒绝且不落新产物', () => {
  seedArtifacts([
    { id: 'art_A', evidence: [{ id: 'art_B' }] },
    { id: 'art_B', evidence: [{ id: 'art_C' }] },
    { id: 'art_C', evidence: [{ id: 'art_A' }] },
  ]);
  const before = JSON.parse(fs.readFileSync(ARTIFACTS_FILE, 'utf8'));
  assert.throws(
    () =>
      artifactStore.persist({
        kind: 'message',
        content: { text: '引用成环链', evidence: [{ kind: 'conclusion', id: 'art_A' }] },
        taskId: 'task_cycle',
      }),
    error => {
      assert.strictEqual(error.code, 'validation_failed');
      assert.strictEqual(error.details.causeRef, 'lineage_cycle');
      return true;
    }
  );
  const after = JSON.parse(fs.readFileSync(ARTIFACTS_FILE, 'utf8'));
  assert.strictEqual(Object.keys(after.artifacts).length, Object.keys(before.artifacts).length);
});

test('§17 接入产物入口：合法 lineage 链可正常落盘', () => {
  seedArtifacts([
    { id: 'art_X', evidence: [{ id: 'art_Y' }] },
    { id: 'art_Y', evidence: [] },
  ]);
  const artifact = artifactStore.persist({
    kind: 'message',
    content: { text: '引用合法链', evidence: [{ kind: 'conclusion', id: 'art_X' }] },
    taskId: 'task_legal',
  });
  assert.ok(artifact.id);
  assert.strictEqual(artifactStore.readContent(artifact.id).content.text, '引用合法链');
});
