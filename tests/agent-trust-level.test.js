/* global require, process */
/**
 * §27 trustLevel 四档回归。
 *
 * 断言口径（对齐原文）：
 *  a) 新 Artifact 默认 untrusted；唯一写入者是 Verification Engine，其它写入者被拒；
 *  b) 升级/降级只能经验证器，且每次变更留审计；
 *  c) 非法取值拒绝，且不改变已存值；
 *  d) 读边界兼容旧数据：记录缺 trustLevel 字段时按默认值 untrusted 返回。
 *
 * 隔离纪律：BLUEBIRD_DATA_DIR 在 require server/ 之前指向临时目录。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-trust-level-'));
process.env.BLUEBIRD_DATA_DIR = TMP;

const artifactStore = require('../server/agents/artifact-store');

let seq = 0;

function makeArtifact() {
  seq += 1;
  return artifactStore.persist({
    kind: 'message',
    content: { text: `trustLevel 测试 ${seq}` },
    taskId: `task_trust_${seq}`,
    runId: 'run_trust',
  });
}

test('§27 非验证器写入被拒（只允许 Verification Engine）', () => {
  const artifact = makeArtifact();
  for (const writer of ['memory-agent', 'orchestrator', 'gateway', null]) {
    assert.throws(
      () => artifactStore.setTrustLevel(artifact.id, { level: 'declared', writer }),
      error => {
        assert.strictEqual(error.code, 'not_authorized');
        assert.strictEqual(error.status, 403);
        return true;
      },
      `writer=${writer} 不应被允许写入 trustLevel`
    );
  }
  // 拒绝后不产生副作用
  assert.strictEqual(artifactStore.readTrustLevel(artifact.id), 'untrusted');
  assert.strictEqual(artifactStore.get(artifact.id).trust, null);
});

test('§27 升级/降级只能经验证器，并留审计', () => {
  const artifact = makeArtifact();
  assert.strictEqual(artifactStore.readTrustLevel(artifact.id), 'untrusted');

  artifactStore.setTrustLevel(artifact.id, {
    level: 'declared',
    writer: artifactStore.TRUST_WRITER,
    policyVersion: 'trust-rules-v1',
    evidenceRefs: ['producer:declaration'],
    scope: 'message',
  });
  assert.strictEqual(artifactStore.readTrustLevel(artifact.id), 'declared');

  const upgraded = artifactStore.setTrustLevel(artifact.id, {
    level: 'independently_verified',
    writer: artifactStore.TRUST_WRITER,
    policyVersion: 'trust-rules-v1',
    evidenceRefs: ['independent:replay_hash'],
    scope: 'message',
  });
  assert.strictEqual(upgraded.trustLevel, 'independently_verified');
  assert.strictEqual(upgraded.trust.verifier, artifactStore.TRUST_WRITER);
  assert.ok(upgraded.trust.verifiedAt);
  assert.deepStrictEqual(upgraded.trust.evidenceRefs, ['independent:replay_hash']);

  artifactStore.setTrustLevel(artifact.id, {
    level: 'untrusted',
    writer: artifactStore.TRUST_WRITER,
    policyVersion: 'trust-rules-v1',
    evidenceRefs: [],
    scope: 'message',
  });
  assert.strictEqual(artifactStore.readTrustLevel(artifact.id), 'untrusted');

  const changes = artifactStore
    .auditEntries()
    .filter(entry => entry.action === 'artifact.trust_level_changed' && entry.artifactId === artifact.id);
  assert.strictEqual(changes.length, 3);
  assert.deepStrictEqual(
    changes.map(entry => entry.reason),
    ['untrusted->declared', 'declared->independently_verified', 'independently_verified->untrusted']
  );
});

test('§27 非法取值拒绝，且不改变已存值', () => {
  const artifact = makeArtifact();
  artifactStore.setTrustLevel(artifact.id, { level: 'declared', writer: artifactStore.TRUST_WRITER });
  for (const level of ['verified', 'trusted', 'UNTRUSTED', '', null]) {
    assert.throws(
      () => artifactStore.setTrustLevel(artifact.id, { level, writer: artifactStore.TRUST_WRITER }),
      error => {
        assert.strictEqual(error.code, 'artifact_trust_level_invalid');
        assert.strictEqual(error.status, 400);
        return true;
      },
      `level=${level} 应被拒绝`
    );
  }
  assert.strictEqual(artifactStore.readTrustLevel(artifact.id), 'declared');
});

test('§27 读边界兼容旧数据：缺 trustLevel 字段按 untrusted', () => {
  const artifact = makeArtifact();
  const raw = JSON.parse(fs.readFileSync(artifactStore.ARTIFACTS_FILE, 'utf8'));
  delete raw.artifacts[artifact.id].trustLevel;
  delete raw.artifacts[artifact.id].trust;
  fs.writeFileSync(artifactStore.ARTIFACTS_FILE, JSON.stringify(raw, null, 2));

  assert.strictEqual(artifactStore.readTrustLevel(artifact.id), 'untrusted');
  // 重新加载模块（等价于进程重启后首次读取）仍按 untrusted。
  const modulePath = require.resolve('../server/agents/artifact-store');
  delete require.cache[modulePath];
  const reloaded = require('../server/agents/artifact-store');
  assert.strictEqual(reloaded.readTrustLevel(artifact.id), 'untrusted');
  console.log(
    `[EVIDENCE] legacy-missing-field ${JSON.stringify({
      artifactId: artifact.id,
      afterReload: reloaded.readTrustLevel(artifact.id),
    })}`
  );
  // 缺字段的旧记录仍可被验证器正常升级
  const upgraded = artifactStore.setTrustLevel(artifact.id, {
    level: 'evidence_checked',
    writer: artifactStore.TRUST_WRITER,
  });
  assert.strictEqual(upgraded.trustLevel, 'evidence_checked');
});

test('§27 有序语义：untrusted < declared < evidence_checked < independently_verified', () => {
  const order = ['untrusted', 'declared', 'evidence_checked', 'independently_verified'];
  assert.deepStrictEqual(artifactStore.TRUST_LEVELS.slice(), order);
  const ranks = order.map(level => artifactStore.trustRank(level));
  assert.deepStrictEqual(ranks, [0, 1, 2, 3]);
  assert.strictEqual(artifactStore.trustRank('verified'), 0, '未知值按 untrusted');
  assert.strictEqual(artifactStore.trustAtLeast('independently_verified', 'evidence_checked'), true);
  assert.strictEqual(artifactStore.trustAtLeast('declared', 'evidence_checked'), false);
  console.log(
    `[EVIDENCE] trust-order ${JSON.stringify({ order, ranks, unknownRank: artifactStore.trustRank('verified') })}`
  );
});

test('§27 正交性：高 trustLevel 不带来读取权限', () => {
  const artifact = makeArtifact();
  artifactStore.setTrustLevel(artifact.id, {
    level: 'independently_verified',
    writer: artifactStore.TRUST_WRITER,
  });
  assert.strictEqual(artifactStore.readTrustLevel(artifact.id), 'independently_verified');

  const otherTaskId = 'task_trust_outsider';
  const access = artifactStore.sharedAccess(artifact.id, { requesterTaskId: otherTaskId });
  assert.strictEqual(access.ok, false, '未共享产物的跨任务读取必须被拒绝');
  assert.strictEqual(access.state, 'not_shared');
  assert.throws(
    () => artifactStore.readSharedArtifact(artifact.id, { requesterTaskId: otherTaskId }),
    error => {
      assert.strictEqual(error.code, 'artifact_not_shared');
      assert.strictEqual(error.status, 409);
      return true;
    },
    '高 trustLevel 不等于访问授权'
  );
  console.log(
    `[EVIDENCE] trust-orthogonality ${JSON.stringify({
      artifactId: artifact.id,
      trustLevel: artifactStore.readTrustLevel(artifact.id),
      requesterTaskId: otherTaskId,
      sharedAccess: access,
      deniedCode: 'artifact_not_shared',
    })}`
  );
});

test('§27 重启后复读：trustLevel 随产物记录持久化，不因进程重启回到默认值', () => {
  const artifact = makeArtifact();
  artifactStore.setTrustLevel(artifact.id, {
    level: 'evidence_checked',
    writer: artifactStore.TRUST_WRITER,
    policyVersion: 'trust-rules-v1',
    reason: 'deterministic_passed',
  });
  assert.strictEqual(artifactStore.readTrustLevel(artifact.id), 'evidence_checked');

  const modulePath = require.resolve('../server/agents/artifact-store');
  delete require.cache[modulePath];
  const reloaded = require('../server/agents/artifact-store');
  const stored = reloaded.get(artifact.id);
  assert.strictEqual(reloaded.readTrustLevel(artifact.id), 'evidence_checked');
  assert.strictEqual(stored.trust.verifier, reloaded.TRUST_WRITER);
  assert.strictEqual(stored.trust.reason, 'deterministic_passed');
  console.log(
    `[EVIDENCE] trust-restart ${JSON.stringify({
      artifactId: artifact.id,
      afterReload: reloaded.readTrustLevel(artifact.id),
      verifier: stored.trust && stored.trust.verifier,
      reason: stored.trust && stored.trust.reason,
    })}`
  );
});
