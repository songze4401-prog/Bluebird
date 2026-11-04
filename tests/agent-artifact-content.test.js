/**
 * 产物正文复读与版本链回归（Phase 1 收口 A）。
 *
 * 断言口径：
 *  a) 正文随产物落盘，重启（丢掉模块实例）后仍能按 {id,version} 读回并校验 contentHash；
 *  b) 正文缺失/被篡改 → fail-closed 抛错，绝不返回空内容，也不允许提交为完成；
 *  c) 同一 lineage 出新版本：version+1、旧版 superseded 且保留、老引用冻结不漂移；
 *  d) 被已终态任务引用的版本不参与清理；
 *  e) 超过 256 KB 显式拒绝，不留半截记录、不写正文文件。
 *
 * 隔离纪律：BLUEBIRD_DATA_DIR 在 require server/ 之前指向临时目录。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-artifact-content-'));
process.env.BLUEBIRD_DATA_DIR = TMP;

const tasks = require('../server/agents/tasks');
const artifactStore = require('../server/agents/artifact-store');
const artifactCommit = require('../server/agents/artifact-commit');
const { normalizeWorkerResult } = require('../server/agents/worker-result');

let seq = 0;

function makeTask(goal = '产物正文测试') {
  seq += 1;
  return tasks.createTask({
    botId: 'memory',
    taskType: 'memory.search',
    goal: `${goal} ${seq}`,
    allowedTools: ['memory_search'],
  });
}

function contentFileOf(id) {
  return path.join(artifactStore.CONTENTS_DIR, `${id}.json`);
}

// "重启"：丢掉当前模块实例，用磁盘上的数据重新读。
function loadFreshStore() {
  delete require.cache[require.resolve('../server/agents/artifact-store')];
  return require('../server/agents/artifact-store');
}

test('正文复读：重启后按 {id,version} 读回内容并通过 contentHash 校验', () => {
  const task = makeTask('复读');
  const refs = artifactCommit.persistTaskArtifacts({
    taskId: task.taskId,
    runId: 'run_replay',
    artifacts: [{ kind: 'message', content: { text: '可复读的正文' } }],
  });
  assert.strictEqual(refs.length, 1);
  assert.strictEqual(refs[0].version, 1);

  const fresh = loadFreshStore();
  const first = fresh.readContent(refs[0].id, { version: refs[0].version });
  assert.strictEqual(first.content.text, '可复读的正文');
  assert.strictEqual(first.contentHash, fresh.get(refs[0].id).contentHash);
  assert.ok(first.bytes > 0);
  // 同一份内容重复读回必须稳定
  const second = fresh.readContent(refs[0].id);
  assert.deepStrictEqual(second.content, first.content);
  assert.strictEqual(second.contentHash, first.contentHash);
});

test('正文损坏：fail-closed 抛错，不返回空内容，也不允许提交为完成', () => {
  const task = makeTask('损坏');
  const refs = artifactCommit.persistTaskArtifacts({
    taskId: task.taskId,
    runId: 'run_corrupt',
    artifacts: [{ kind: 'message', content: { text: '原始正文' } }],
  });
  const id = refs[0].id;

  // 篡改正文但保留索引里的 contentHash → hash 校验失败
  const record = JSON.parse(fs.readFileSync(contentFileOf(id), 'utf8'));
  record.content = { text: '被篡改的正文' };
  fs.writeFileSync(contentFileOf(id), JSON.stringify(record));

  assert.throws(
    () => artifactStore.readContent(id, { version: 1 }),
    error => error.code === 'artifact_content_corrupted'
  );

  // 提交门禁同样 fail-closed：不能把审计不可复现的产物提交为完成
  assert.throws(
    () => artifactStore.assertRefsCommitReady(refs),
    error => error.code === 'artifact_content_corrupted'
  );

  // 正文文件整体缺失也是失败，而不是空内容
  fs.unlinkSync(contentFileOf(id));
  assert.throws(
    () => artifactStore.readContent(id),
    error => error.code === 'artifact_content_missing'
  );
});

test('版本链：新版本 version+1、旧版 superseded 且保留、老引用不漂移', () => {
  const task = makeTask('版本链');
  const firstRefs = artifactCommit.persistTaskArtifacts({
    taskId: task.taskId,
    artifacts: [{ kind: 'message', content: { text: '第一版' } }],
  });
  const firstRef = { ...firstRefs[0] };

  const secondRefs = artifactCommit.persistTaskArtifacts({
    taskId: task.taskId,
    artifacts: [{ kind: 'message', content: { text: '第二版' } }],
  });

  assert.strictEqual(secondRefs[0].version, 2);
  assert.notStrictEqual(secondRefs[0].id, firstRef.id);

  const versions = artifactStore.versionsOf({ taskId: task.taskId, kind: 'message' });
  assert.strictEqual(versions.length, 2);
  assert.deepStrictEqual(
    versions.map(item => item.version),
    [1, 2]
  );
  assert.strictEqual(versions[0].status, 'superseded');
  assert.strictEqual(versions[0].supersededBy, secondRefs[0].id);
  assert.strictEqual(versions[1].status, 'active');

  // 旧版正文仍在，且按老引用读回的是第一版内容（引用冻结）
  const oldContent = artifactStore.readContent(firstRef.id, { version: firstRef.version });
  assert.strictEqual(oldContent.content.text, '第一版');
  assert.deepStrictEqual(firstRefs[0], firstRef);

  // superseded 版本永不自动清理
  const cleanup = artifactCommit.cleanupOrphans({
    now: Date.now() + 30 * 24 * 60 * 60 * 1000,
  });
  assert.ok(
    cleanup.kept.some(item => item.id === firstRef.id && item.reason === 'status:superseded')
  );
  assert.ok(artifactStore.get(firstRef.id));
});

test('被已终态任务引用的产物版本不可清理', () => {
  const task = makeTask('终态引用');
  const refs = artifactCommit.persistTaskArtifacts({
    taskId: task.taskId,
    runId: 'run_terminal',
    artifacts: [{ kind: 'message', content: { text: '终态任务引用的正文' } }],
  });
  // 只提交任务状态、不确认产物引用：产物停在 pending-commit（模拟 confirm 失败），
  // 这样清理扫描才会真正走到"是否有任务引用"这一步。
  tasks.transitionTask(task.taskId, { to: 'accepted' });
  tasks.transitionTask(task.taskId, { to: 'running' });
  tasks.transitionTask(task.taskId, {
    to: 'completed',
    completedAt: new Date().toISOString(),
    result: normalizeWorkerResult({
      status: 'completed',
      summary: '完成',
      artifacts: refs,
      runId: 'run_terminal',
      finishedAt: new Date().toISOString(),
    }),
  });

  const artifact = artifactStore.get(refs[0].id);
  assert.strictEqual(artifact.commit, 'pending-commit');

  const farFuture = Date.now() + 30 * 24 * 60 * 60 * 1000;
  const cleanup = artifactCommit.cleanupOrphans({ now: farFuture });
  assert.deepStrictEqual(cleanup.cleaned, []);
  assert.ok(
    cleanup.kept.some(item => item.id === refs[0].id && item.reason === 'referenced_by_task')
  );
  assert.ok(artifactStore.get(refs[0].id));
  assert.strictEqual(artifactStore.readContent(refs[0].id).content.text, '终态任务引用的正文');
});

test('正文超过 256 KB 显式拒绝：不留记录、不写正文文件', () => {
  const before = artifactStore.all().length;
  const contentFilesBefore = fs.existsSync(artifactStore.CONTENTS_DIR)
    ? fs.readdirSync(artifactStore.CONTENTS_DIR).length
    : 0;
  const big = 'x'.repeat(artifactStore.CONTENT_MAX_BYTES + 1);
  assert.throws(
    () => artifactStore.persist({ kind: 'message', content: big, taskId: 'task_big' }),
    error => error.code === 'artifact_content_too_large'
  );
  assert.strictEqual(artifactStore.all().length, before);
  const contentFilesAfter = fs.existsSync(artifactStore.CONTENTS_DIR)
    ? fs.readdirSync(artifactStore.CONTENTS_DIR).length
    : 0;
  assert.strictEqual(contentFilesAfter, contentFilesBefore);
  // 边界内仍可落盘（正好等于上限）
  const atLimit = 'y'.repeat(artifactStore.CONTENT_MAX_BYTES);
  const artifact = artifactStore.persist({ kind: 'message', content: atLimit, taskId: 'task_big' });
  assert.ok(artifact.id);
  assert.strictEqual(artifactStore.readContent(artifact.id).bytes, artifactStore.CONTENT_MAX_BYTES);
});
