#!/usr/bin/env node
/* eslint-env node */
/**
 * 统一测试入口（B-4）：逐个文件跑 tests/*.test.js，与 CI 使用同一套文件。
 *
 * - 每个文件独立子进程，互不污染；
 * - 统一指向临时数据目录，并禁用真实 LLM（DEEPSEEK_API_KEY=''，避免 dotenv 回填）；
 * - 任一文件失败则整体非零退出。
 *
 * 用法：npm test
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const testsDir = path.join(root, 'tests');

const files = fs
  .readdirSync(testsDir)
  .filter(name => name.endsWith('.test.js'))
  .sort();

if (!files.length) {
  console.error('未找到任何 tests/*.test.js');
  process.exit(1);
}

// 兜底隔离：即使某个测试忘了自己设置，也不会落到真实 server/data。
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-npm-test-'));
const env = {
  ...process.env,
  BLUEBIRD_DATA_DIR: dataDir,
  // 空串而非 delete：dotenv 只会回填"不存在"的变量，空串才能真正禁用真实调用。
  DEEPSEEK_API_KEY: '',
  // 开发者本地 .env 可能打开 Agent 开关；测试必须从确定的默认态开始。
  BLUEBIRD_AGENT_TOOLS: '',
};

const failed = [];

for (const file of files) {
  process.stdout.write(`\n▶ ${file}\n`);

  const result = spawnSync(process.execPath, [path.join(testsDir, file)], {
    stdio: 'inherit',
    env,
  });

  if (result.status !== 0) failed.push(file);
}

try {
  fs.rmSync(dataDir, { recursive: true, force: true });
} catch (_) {
  /* 清理失败不影响测试结论 */
}

process.stdout.write('\n========================================\n');
if (failed.length) {
  process.stdout.write(
    `${files.length} 个测试文件，${failed.length} 个失败：\n  ${failed.join('\n  ')}\n`
  );
  process.exit(1);
}

process.stdout.write(`${files.length} 个测试文件，全部通过\n`);
