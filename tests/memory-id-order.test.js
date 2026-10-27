/**
 * 记忆 ID 稳定性验证（只验证，不改生产代码）
 *
 * 覆盖：
 * 1) 同内容 + 同 createdAt + 同 sourceQuote 的重复条目，按文件顺序得到 base id 与 #2；
 * 2) 同一文件重复读取（迁移重试）得到相同 id；
 * 3) 未落盘前重排文件：#2 归属会随顺序互换，id 集合不变；
 * 4) 触发一次真实写入后 id 落盘；重排文件并重启，id 与 marker 的映射不变；
 * 5) 完全相同的重复条目（无 marker）重排：id 集合稳定，归属不可观测。
 *
 * 运行：node tests/memory-id-order.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MEMORY_MODULE = path.join(ROOT, 'server', 'memory.js');
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-id-order-'));
const RUNNER = path.join(TMP_ROOT, 'runner.js');

process.on('exit', () => {
  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch (_) {
    /* 清理失败不影响结论 */
  }
});

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✔ ${name}`);
  } else {
    failed += 1;
    failures.push(name + (extra ? ` — ${extra}` : ''));
    console.log(`  ✖ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

fs.writeFileSync(
  RUNNER,
  `
const fs = require('fs');
const path = require('path');
const memory = require(process.env.MEMORY_MODULE);
const memoryFile = path.join(process.env.BLUEBIRD_DATA_DIR, 'memory.json');

(async () => {
  if (process.argv[2] === 'persist') {
    const disk = JSON.parse(fs.readFileSync(memoryFile, 'utf8'));
    const sentinel = disk.find(item => item.marker === 'S');
    const result = await memory.deleteMemory({
      createdAt: sentinel.createdAt,
      content: sentinel.content,
    });

    if (!result || result.removed !== 1) {
      throw new Error('哨兵删除失败：' + JSON.stringify(result));
    }
  }

  const items = memory.getMemories({ includeSuperseded: true }).map(item => ({
    id: item.id,
    marker: item.marker === undefined ? null : item.marker,
    content: item.content,
    createdAt: item.createdAt,
  }));

  process.stdout.write('RESULT:' + JSON.stringify(items));
})().catch(error => {
  console.error(error);
  process.exit(1);
});
`.trim(),
  'utf8'
);

function envFor(dataDir) {
  return {
    ...process.env,
    BLUEBIRD_DATA_DIR: dataDir,
    MEMORY_MODULE,
    DEEPSEEK_API_KEY: '',
  };
}

function run(dataDir, action) {
  const result = spawnSync(process.execPath, [RUNNER, action], {
    env: envFor(dataDir),
    encoding: 'utf8',
    timeout: 15000,
  });

  if (result.status !== 0) {
    throw new Error(
      `子进程失败 status=${result.status} stderr=${(result.stderr || '').slice(-500)}`
    );
  }

  const line = String(result.stdout || '')
    .split(/\r?\n/)
    .find(item => item.startsWith('RESULT:'));

  if (!line) {
    throw new Error(`未找到 RESULT：${(result.stdout || '').slice(-500)}`);
  }

  return JSON.parse(line.slice('RESULT:'.length));
}

function readDisk(dataDir) {
  return JSON.parse(
    fs.readFileSync(path.join(dataDir, 'memory.json'), 'utf8')
  );
}

function writeDisk(dataDir, items) {
  fs.writeFileSync(
    path.join(dataDir, 'memory.json'),
    JSON.stringify(items, null, 2),
    'utf8'
  );
}

function idsOf(items) {
  return items.map(item => item.id).sort();
}

function mapping(items) {
  const result = {};
  items.forEach(item => {
    result[item.marker] = item.id;
  });
  return result;
}

function withoutSentinel(items) {
  return items.filter(item => item.marker !== 'S');
}

function baseEntry(marker) {
  return {
    content: '用户有一条完全相同的重复记忆',
    type: 'fact',
    keywords: ['重复', '记忆'],
    confidence: 0.95,
    sourceQuote: '我有一条完全相同的重复记忆',
    sessionId: 's-id-order',
    createdAt: '2026-10-20T08:00:00.000Z',
    ...(marker === undefined ? {} : { marker }),
  };
}

const sentinel = {
  content: '用于触发写盘的哨兵',
  type: 'fact',
  keywords: ['哨兵'],
  confidence: 0.95,
  sourceQuote: '用于触发写盘的哨兵',
  sessionId: 's-id-order',
  createdAt: '2026-10-20T08:01:00.000Z',
  marker: 'S',
};

console.log('\n1) 未落盘：重复条目、顺序与迁移重试');
{
  const dataDir = path.join(TMP_ROOT, 'unpersisted');

  fs.mkdirSync(dataDir, { recursive: true });
  writeDisk(dataDir, [baseEntry('A'), baseEntry('B'), sentinel]);

  const first = withoutSentinel(run(dataDir, 'inspect'));
  const again = withoutSentinel(run(dataDir, 'inspect'));
  const firstIds = idsOf(first);
  const firstMap = mapping(first);

  check(
    '两条重复条目得到 base id 与 #2，id 全局唯一',
    first.length === 2 &&
      new Set(firstIds).size === 2 &&
      firstIds.filter(id => id.includes('#2')).length === 1,
    JSON.stringify(firstIds)
  );
  check(
    '同一文件重复读取（迁移重试）id 完全一致',
    JSON.stringify(firstIds) === JSON.stringify(idsOf(again)) &&
      JSON.stringify(firstMap) === JSON.stringify(mapping(again)),
    `${JSON.stringify(firstMap)} vs ${JSON.stringify(mapping(again))}`
  );

  writeDisk(dataDir, [baseEntry('B'), baseEntry('A'), sentinel]);

  const reordered = withoutSentinel(run(dataDir, 'inspect'));
  const reorderedMap = mapping(reordered);

  check(
    '未落盘重排：id 集合不变',
    JSON.stringify(idsOf(reordered)) === JSON.stringify(firstIds),
    `${JSON.stringify(idsOf(reordered))} vs ${JSON.stringify(firstIds)}`
  );
  check(
    '未落盘重排：#2 归属随文件顺序互换',
    reorderedMap.A === firstMap.B && reorderedMap.B === firstMap.A,
    `before=${JSON.stringify(firstMap)} after=${JSON.stringify(reorderedMap)}`
  );
}

console.log('\n2) 落盘后：重排文件并重启');
{
  const dataDir = path.join(TMP_ROOT, 'persisted');

  fs.mkdirSync(dataDir, { recursive: true });
  writeDisk(dataDir, [baseEntry('A'), baseEntry('B'), sentinel]);

  const beforePersist = withoutSentinel(run(dataDir, 'persist'));
  const beforeMap = mapping(beforePersist);
  const disk = readDisk(dataDir);

  check(
    '触发真实写入后，磁盘上每条都有 id',
    disk.length === 2 && disk.every(item => typeof item.id === 'string' && item.id),
    JSON.stringify(disk.map(item => [item.marker, item.id]))
  );

  writeDisk(dataDir, [disk[1], disk[0]]);

  const afterReorder = withoutSentinel(run(dataDir, 'inspect'));
  const afterMap = mapping(afterReorder);

  check(
    '已落盘重排：id 集合不变',
    JSON.stringify(idsOf(afterReorder)) === JSON.stringify(idsOf(beforePersist)),
    `${JSON.stringify(idsOf(afterReorder))} vs ${JSON.stringify(idsOf(beforePersist))}`
  );
  check(
    '已落盘重排：marker 与 id 的映射不变',
    afterMap.A === beforeMap.A && afterMap.B === beforeMap.B,
    `before=${JSON.stringify(beforeMap)} after=${JSON.stringify(afterMap)}`
  );
  check(
    '已落盘重排：没有新增第三个后缀',
    afterReorder.every(item => !item.id.includes('#3')),
    JSON.stringify(afterReorder.map(item => item.id))
  );
}

console.log('\n3) 完全相同的重复条目（无 marker）');
{
  const dataDir = path.join(TMP_ROOT, 'identical');

  fs.mkdirSync(dataDir, { recursive: true });
  writeDisk(dataDir, [baseEntry(), baseEntry()]);

  const first = run(dataDir, 'inspect');
  const firstIds = idsOf(first);

  writeDisk(dataDir, [baseEntry(), baseEntry()]);

  const second = run(dataDir, 'inspect');

  check(
    '完全相同的重复条目：仍得到两个唯一 id',
    first.length === 2 && new Set(firstIds).size === 2,
    JSON.stringify(firstIds)
  );
  check(
    '完全相同的重复条目：重排后 id 集合不变（归属不可观测）',
    JSON.stringify(idsOf(second)) === JSON.stringify(firstIds),
    `${JSON.stringify(idsOf(second))} vs ${JSON.stringify(firstIds)}`
  );
}

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);

if (failures.length) {
  console.log('失败明细：');
  failures.forEach(item => console.log(`  - ${item}`));
  process.exit(1);
}

process.exit(0);
