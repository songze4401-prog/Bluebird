#!/usr/bin/env node
/* Self-tests for scripts/sync-doc-counts.js (outside the backend test inventory). */
const assert = require('assert');
const {
  computeCounts,
  buildRunnerList,
  applyTargets,
  TARGETS,
} = require('./sync-doc-counts');

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✔ ${name}`);
  } catch (error) {
    failed++;
    console.log(`  ✖ ${name} — ${error.message}`);
  }
}

const baseline = {
  backendTotal: 5,
  nodeTestSuiteTotal: 3,
  runnerTotal: 2,
  frontend: { suites: 1, tests: 1 },
  nodeTestSuiteFiles: ['node-case'],
  runnerFiles: ['custom-case'],
  files: {
    'custom-case': { format: 'custom', count: 2, runner: true },
    'node-case': { format: 'node', count: 3, runner: false },
  },
};

console.log('1) 计数推导');
check('总量按基线累加，不接受手填', () => {
  const ctx = computeCounts(baseline);
  assert.equal(ctx.files, 2);
  assert.equal(ctx.backendTotal, 5);
  assert.equal(ctx.nodeTestSuiteTotal, 3);
  assert.equal(ctx.runnerTotal, 2);
  assert.equal(ctx.runnerFiles, 1);
  assert.equal(ctx.customRunnerCount, 1);
  assert.equal(ctx.nodeRunnerCount, 0);
});
check('计数取值来自 files 条目', () => {
  const ctx = computeCounts(baseline);
  assert.equal(ctx.count('custom-case'), 2);
  assert.throws(() => ctx.count('ghost'), /没有测试文件/);
});

console.log('\n2) 清单生成');
check('清单包含 node:test 汇总行与每个 runner 文件', () => {
  const ctx = computeCounts(baseline);
  const list = buildRunnerList({ ...ctx, eol: '\n' });
  assert.ok(list.startsWith('```bash\n'));
  assert.ok(list.endsWith('\n```'));
  assert.ok(list.includes('node --test --test-concurrency=1 tests/node-case.test.js   # node:test suites (3)'));
  assert.ok(list.includes('node tests/custom-case.test.js'));
  assert.ok(list.includes('# 2'));
});
check('清单沿用文件原有换行符（CRLF 不被写成 LF）', () => {
  const ctx = computeCounts(baseline);
  const list = buildRunnerList({ ...ctx, eol: '\r\n' });
  assert.ok(list.includes('\r\n'));
  assert.ok(!/[^\r]\n/.test(list));
});

console.log('\n3) 锚点替换');
const target = {
  id: 'demo',
  find: /共 \d+ 项/,
  build: ctx => `共 ${ctx.backendTotal} 项`,
};

check('命中时按生成函数替换', () => {
  const ctx = computeCounts(baseline);
  const { text, results } = applyTargets('共 0 项', [target], ctx);
  assert.equal(text, '共 5 项');
  assert.equal(results[0].status, 'changed');
});
check('已经一致时报告 ok 且不改文本', () => {
  const ctx = computeCounts(baseline);
  const { text, results } = applyTargets('共 5 项', [target], ctx);
  assert.equal(text, '共 5 项');
  assert.equal(results[0].status, 'ok');
});
check('锚点未命中时报 missing，不静默跳过', () => {
  const ctx = computeCounts(baseline);
  const { results } = applyTargets('这里没有计数', [target], ctx);
  assert.equal(results[0].status, 'missing');
});
check('锚点命中多次时报 ambiguous', () => {
  const ctx = computeCounts(baseline);
  const { results } = applyTargets('共 1 项 / 共 2 项', [target], ctx);
  assert.equal(results[0].status, 'ambiguous');
  assert.equal(results[0].count, 2);
});

console.log('\n4) 规则表自检');
check('每条规则都有唯一 id', () => {
  const ids = TARGETS.map(item => item.id);
  assert.equal(new Set(ids).size, ids.length);
});
check('每条规则的 find 都是全局可匹配的正则', () => {
  for (const item of TARGETS) {
    assert.ok(item.find instanceof RegExp, item.id);
    assert.ok(item.find.global === false, item.id);
    assert.equal(typeof item.build, 'function', item.id);
    assert.ok(item.file, item.id);
  }
});

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
process.exit(failed ? 1 : 0);
