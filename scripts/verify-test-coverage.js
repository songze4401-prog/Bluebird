#!/usr/bin/env node
/*
 * Runtime test-coverage verifier.
 *
 * The baseline is runtime-oriented: every tests/*.test.js file must actually
 * execute and report its expected number of cases. Source-level test( / check(
 * scans are intentionally not used (loops and helper calls make call-site
 * counts differ from runtime counts).
 *
 * Update rule: when adding/removing a test file or changing its case count,
 * update scripts/test-coverage-baseline.json in the same change.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TESTS_DIR = path.join(ROOT, 'tests');
const BASELINE_FILE = path.join(__dirname, 'test-coverage-baseline.json');
const CI_FILE = path.join(ROOT, '.github', 'workflows', 'ci.yml');

function readBaseline(file = BASELINE_FILE) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function parseNodeTestOutput(output) {
  const text = String(output || '');
  const tests = text.match(/^(?:ℹ tests|# tests) (\d+)$/m);
  if (!tests) return null;

  const pass = text.match(/^(?:ℹ pass|# pass) (\d+)$/m);
  const fail = text.match(/^(?:ℹ fail|# fail) (\d+)$/m);

  return {
    format: 'node',
    count: Number(tests[1]),
    failed: fail ? Number(fail[1]) : 0,
    passed: pass ? Number(pass[1]) : 0,
  };
}

function parseCustomOutput(output) {
  const text = String(output || '');
  const patterns = [
    /通过\s*(\d+)\s*项[，,]\s*失败\s*(\d+)\s*项/,
    /结果[：:]\s*(\d+)\s*通过[，,]\s*(\d+)\s*失败/,
    /(?:^|\n)[^\n:]+:\s*(\d+)\s*passed,\s*(\d+)\s*failed/m,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;

    return {
      format: 'custom',
      count: Number(match[1]),
      failed: Number(match[2]),
      passed: Number(match[1]) - Number(match[2]),
    };
  }

  return null;
}

function parseBackendOutput(output) {
  return parseNodeTestOutput(output) || parseCustomOutput(output);
}

function evaluateInventory(baseline, actualResults) {
  const errors = [];
  const expectedNames = Object.keys(baseline.files).sort();
  const actualNames = Object.keys(actualResults).sort();

  if (JSON.stringify(expectedNames) !== JSON.stringify(actualNames)) {
    const missing = expectedNames.filter(name => !actualResults[name]);
    const extra = actualNames.filter(name => !baseline.files[name]);
    if (missing.length) errors.push(`缺少测试文件：${missing.join(', ')}`);
    if (extra.length) errors.push(`未登记的新测试文件：${extra.join(', ')}`);
  }

  let total = 0;
  let nodeSuiteTotal = 0;
  let runnerTotal = 0;
  const nodeSuiteFiles = new Set(baseline.nodeTestSuiteFiles || []);
  const runnerFiles = new Set(baseline.runnerFiles || []);

  if (nodeSuiteFiles.size + runnerFiles.size !== expectedNames.length) {
    errors.push('基线 nodeTestSuiteFiles + runnerFiles 与 files 数量不一致');
  }

  for (const name of expectedNames) {
    const expected = baseline.files[name];
    const actual = actualResults[name];

    if (!actual) continue;
    if (!actual.ok) {
      errors.push(`${name}: 执行失败（退出码非 0）`);
      continue;
    }

    const parsed = actual.parsed;
    if (!parsed) {
      errors.push(`${name}: 未找到可识别的用例计数`);
      continue;
    }

    if (parsed.failed !== 0) {
      errors.push(`${name}: 有 ${parsed.failed} 个失败用例`);
    }
    if (parsed.format !== expected.format) {
      errors.push(
        `${name}: 运行格式 ${parsed.format} 与基线 ${expected.format} 不一致`
      );
    }
    if (parsed.count !== expected.count) {
      errors.push(
        `${name}: 运行计数 ${parsed.count} 与基线 ${expected.count} 不一致`
      );
    }

    total += parsed.count;
    if (nodeSuiteFiles.has(name)) nodeSuiteTotal += parsed.count;
    if (runnerFiles.has(name)) runnerTotal += parsed.count;

    if (expected.runner !== runnerFiles.has(name)) {
      errors.push(`${name}: runner 标记与 runnerFiles 不一致`);
    }
  }

  if (nodeSuiteTotal !== baseline.nodeTestSuiteTotal) {
    errors.push(
      `node:test 七套总计 ${nodeSuiteTotal} 与基线 ${baseline.nodeTestSuiteTotal} 不一致`
    );
  }
  if (runnerTotal !== baseline.runnerTotal) {
    errors.push(
      `runner 总计 ${runnerTotal} 与基线 ${baseline.runnerTotal} 不一致`
    );
  }
  if (total !== baseline.backendTotal) {
    errors.push(`后端总计 ${total} 与基线 ${baseline.backendTotal} 不一致`);
  }

  return {
    ok: errors.length === 0,
    errors,
    totals: { total, nodeSuiteTotal, runnerTotal },
  };
}

function discoverBackendFiles() {
  return fs
    .readdirSync(TESTS_DIR)
    .filter(name => name.endsWith('.test.js'))
    .map(name => name.slice(0, -'.test.js'.length))
    .sort();
}

// CI 清单提取：既认显式 tests/<name>.test.js，也认
// `for f in a b c; do node "tests/$f.test.js"` 这种循环写法。
// 先剥掉 YAML/Shell 注释，避免“只在注释里出现”被误判为已覆盖。
function extractCiTestNames(ciText) {
  const text = String(ciText || '').replace(/#.*$/gm, '');
  const names = new Set();
  const explicit = /tests\/([a-z0-9_-]+)\.test\.js/g;
  let match = explicit.exec(text);

  while (match) {
    names.add(match[1]);
    match = explicit.exec(text);
  }

  const loops = /for\s+f\s+in\s+([^;]+);\s*do/g;
  match = loops.exec(text);

  while (match) {
    for (const name of match[1].trim().split(/\s+/)) {
      if (/^[a-z0-9_-]+$/.test(name)) names.add(name);
    }
    match = loops.exec(text);
  }

  return names;
}

function evaluateCiCoverage(baseline, ciText) {
  const errors = [];
  const ciNames = extractCiTestNames(ciText);
  const expectedNames = Object.keys(baseline.files).sort();

  const missing = expectedNames.filter(name => !ciNames.has(name));
  const extra = [...ciNames].filter(name => !baseline.files[name]).sort();

  if (missing.length) {
    errors.push(`CI 未覆盖测试文件：${missing.join(', ')}`);
  }
  if (extra.length) {
    errors.push(`CI 引用了未登记的测试文件：${extra.join(', ')}`);
  }

  return {
    ok: errors.length === 0,
    errors,
    ciFiles: [...ciNames].sort(),
  };
}

function backendEnv(dataDir) {
  return {
    ...process.env,
    BLUEBIRD_DATA_DIR: dataDir,
    DEEPSEEK_API_KEY: '',
    BLUEBIRD_API_TOKEN: 'test-token-coverage',
    PORT: '0',
    // 开发者本地 .env 可能打开 Agent 开关；覆盖验证必须从确定默认态开始。
    BLUEBIRD_AGENT_TOOLS: '',
    BLUEBIRD_MONITORING: '0',
  };
}

function runBackendFile(name, dataDir, format = 'custom') {
  const file = path.join(TESTS_DIR, `${name}.test.js`);
  const args =
    format === 'node'
      ? ['--test', '--test-reporter=tap', '--test-concurrency=1', file]
      : [file];

  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    env: backendEnv(dataDir),
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 16 * 1024 * 1024,
  });

  const output = `${result.stdout || ''}${result.stderr || ''}`;
  const parsed = parseBackendOutput(output);

  return {
    ok: result.status === 0,
    status: result.status,
    parsed,
    output: output.slice(-2000),
  };
}

function runJest(reportFile) {
  const jestBin = path.join(ROOT, 'node_modules', 'jest', 'bin', 'jest.js');

  if (!fs.existsSync(jestBin)) {
    return {
      ok: false,
      status: null,
      error: `未找到 Jest：${jestBin}`,
      output: '',
    };
  }

  const result = spawnSync(
    process.execPath,
    [jestBin, '--ci', '--json', `--outputFile=${reportFile}`],
    {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 180000,
      maxBuffer: 16 * 1024 * 1024,
    }
  );

  if (result.status !== 0) {
    return {
      ok: false,
      status: result.status,
      error: `Jest 退出码 ${result.status}`,
      output: `${result.stdout || ''}${result.stderr || ''}`.slice(-2000),
    };
  }

  let report;
  try {
    report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  } catch (error) {
    return {
      ok: false,
      status: result.status,
      error: `无法读取 Jest JSON：${error.message}`,
      output: '',
    };
  }

  const suites = Number(report.numTotalTestSuites);
  const tests = Number(report.numTotalTests);
  const failed = Number(report.numFailedTests);
  const passed = Number(report.numPassedTests);

  return {
    ok: failed === 0,
    status: result.status,
    suites,
    tests,
    passed,
    failed,
    error:
      failed === 0
        ? null
        : `Jest 失败 ${failed} 项`,
    output: '',
  };
}

function main() {
  let baseline;

  try {
    baseline = readBaseline();
  } catch (error) {
    console.error(`✖ 无法读取基线：${error.message}`);
    process.exit(1);
  }

  const files = discoverBackendFiles();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-coverage-'));
  const actualResults = {};
  let runError = null;

  try {
    for (const name of files) {
      const result = runBackendFile(
        name,
        dataDir,
        baseline.files[name] ? baseline.files[name].format : 'custom'
      );
      actualResults[name] = result;
      const status = result.ok ? 'PASS' : `FAIL(${result.status})`;
      console.log(`${status} ${name}${result.parsed ? ` ${result.parsed.count}` : ' ?'}`);

      if (!result.ok) runError = result;
    }
  } finally {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch (_) {
      /* ignore */
    }
  }

  const inventory = evaluateInventory(baseline, actualResults);
  const errors = [...inventory.errors];

  try {
    const ciCoverage = evaluateCiCoverage(
      baseline,
      fs.readFileSync(CI_FILE, 'utf8')
    );
    errors.push(...ciCoverage.errors);
    console.log(
      `CI runner 覆盖：${ciCoverage.ciFiles.length}/${Object.keys(baseline.files).length} 个测试文件`
    );
  } catch (error) {
    errors.push(`无法读取 CI 清单：${error.message}`);
  }

  if (runError) {
    errors.push(`首个执行失败：\n${runError.output}`);
  }

  const jestReport = path.join(os.tmpdir(), `bluebird-jest-${process.pid}.json`);
  const jest = runJest(jestReport);

  try {
    fs.rmSync(jestReport, { force: true });
  } catch (_) {
    /* ignore */
  }

  if (
    !jest.ok ||
    jest.suites !== baseline.frontend.suites ||
    jest.tests !== baseline.frontend.tests ||
    jest.failed !== 0
  ) {
    errors.push(
      `Jest: suites=${jest.suites}, tests=${jest.tests}, failed=${jest.failed}；` +
        `期望 ${baseline.frontend.suites}/${baseline.frontend.tests}/0` +
        (jest.error ? `；${jest.error}` : '')
    );
  }

  console.log(
    `backend=${inventory.totals.total}/${baseline.backendTotal} ` +
      `nodeSuite=${inventory.totals.nodeSuiteTotal}/${baseline.nodeTestSuiteTotal} ` +
      `runner=${inventory.totals.runnerTotal}/${baseline.runnerTotal}`
  );
  console.log(
    `frontend=${jest.tests}/${baseline.frontend.tests} suites=${jest.suites}/${baseline.frontend.suites} failed=${jest.failed}`
  );

  if (errors.length) {
    console.error(`✖ 测试覆盖验证失败（${errors.length} 项）：`);
    errors.forEach(error => console.error(`  - ${error}`));
    process.exit(1);
  }

  console.log('✔ 测试覆盖验证通过');
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = {
  readBaseline,
  parseNodeTestOutput,
  parseCustomOutput,
  parseBackendOutput,
  evaluateInventory,
  extractCiTestNames,
  evaluateCiCoverage,
  discoverBackendFiles,
  backendEnv,
  runBackendFile,
  runJest,
};
