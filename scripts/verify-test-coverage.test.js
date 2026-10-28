#!/usr/bin/env node
/* Self-tests for scripts/verify-test-coverage.js (outside the backend test inventory). */
const assert = require('assert');
const {
  parseNodeTestOutput,
  parseCustomOutput,
  parseBackendOutput,
  evaluateInventory,
} = require('./verify-test-coverage');

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

function baseline() {
  return {
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
}

function result(parsed, ok = true) {
  return { ok, parsed };
}

console.log('1) 输出解析');
check('node:test 的 tests/pass/fail 被识别', () => {
  const parsed = parseNodeTestOutput('ℹ tests 3\nℹ pass 3\nℹ fail 0\n');
  assert.deepEqual(parsed, { format: 'node', count: 3, failed: 0, passed: 3 });
});
check('node:test 的 TAP 摘要也被识别', () => {
  const parsed = parseNodeTestOutput('# tests 4\n# pass 4\n# fail 0\n');
  assert.deepEqual(parsed, { format: 'node', count: 4, failed: 0, passed: 4 });
});
check('自定义 “通过 N 项” 被识别', () => {
  assert.deepEqual(parseCustomOutput('通过 2 项，失败 0 项'), {
    format: 'custom',
    count: 2,
    failed: 0,
    passed: 2,
  });
});
check('自定义 “结果：N 通过” 被识别', () => {
  assert.equal(parseCustomOutput('结果：4 通过，0 失败').count, 4);
});
check('注释/字符串里的 check( 不会被当成计数', () => {
  assert.equal(parseBackendOutput("// check(1)\nconst s = 'check(2)';\n"), null);
});
check('真实摘要中的 check( 字符串不影响计数', () => {
  assert.equal(
    parseBackendOutput("console.log('check(999)');\n通过 2 项，失败 0 项").count,
    2
  );
});

console.log('\n2) 库存对账');
check('正常库存通过', () => {
  const outcome = evaluateInventory(baseline(), {
    'custom-case': result({ format: 'custom', count: 2, failed: 0 }),
    'node-case': result({ format: 'node', count: 3, failed: 0 }),
  });
  assert.equal(outcome.ok, true, outcome.errors.join('\n'));
  assert.deepEqual(outcome.totals, { total: 5, nodeSuiteTotal: 3, runnerTotal: 2 });
});
check('缺少测试文件失败', () => {
  const outcome = evaluateInventory(baseline(), {
    'custom-case': result({ format: 'custom', count: 2, failed: 0 }),
  });
  assert.equal(outcome.ok, false);
  assert.ok(outcome.errors.some(error => error.includes('缺少测试文件')));
});
check('计数不一致失败', () => {
  const outcome = evaluateInventory(baseline(), {
    'custom-case': result({ format: 'custom', count: 3, failed: 0 }),
    'node-case': result({ format: 'node', count: 3, failed: 0 }),
  });
  assert.equal(outcome.ok, false);
  assert.ok(outcome.errors.some(error => error.includes('运行计数')));
});
check('执行失败失败', () => {
  const outcome = evaluateInventory(baseline(), {
    'custom-case': result(null, false),
    'node-case': result({ format: 'node', count: 3, failed: 0 }),
  });
  assert.equal(outcome.ok, false);
  assert.ok(outcome.errors.some(error => error.includes('执行失败')));
});
check('新增未登记文件失败', () => {
  const outcome = evaluateInventory(baseline(), {
    'custom-case': result({ format: 'custom', count: 2, failed: 0 }),
    'node-case': result({ format: 'node', count: 3, failed: 0 }),
    'new-case': result({ format: 'custom', count: 1, failed: 0 }),
  });
  assert.equal(outcome.ok, false);
  assert.ok(outcome.errors.some(error => error.includes('未登记')));
});

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
process.exit(failed ? 1 : 0);