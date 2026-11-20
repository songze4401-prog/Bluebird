/**
 * 台账证据模块守卫（2026-11-21 收尾条 1）。
 *
 * 五个模块在生产主链路里零引用，只被固定评测集与离线评测入口使用：
 *   server/agents/planner.js            规划拆解（Phase 1 第 1 项）
 *   server/agents/phase0-degradation.js Phase 0 降级分支/退出判据（A-14）
 *   server/agents/eval-tiers.js         §14 四分层与轮换退役
 *   server/agents/eval-baseline.js      §14 基线快照与对比
 *   server/agents/eval-indicators.js    §7 八项质量指标 + 漏检率
 *
 * 它们不是死代码：台账 A-06 / A-07 的证据格逐条指向这些文件，删掉就等于
 * 拆掉那两行的可复跑证据。本测试把「保留」这件事钉住——文件在、能加载、
 * 导出没被掏空、台账仍然引用它们；谁要清理，必须先改台账口径再来改这里。
 *
 * 运行：node tests/ledger-evidence-modules.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-ledger-evidence-'));
process.env.BLUEBIRD_DATA_DIR = TMP;
process.env.DEEPSEEK_API_KEY = '';

const ROOT = path.join(__dirname, '..');
const LEDGER = path.join(ROOT, 'docs', 'notion-delivery-ledger-2026-11-04.md');

const MODULES = [
  { rel: 'server/agents/planner.js', minExports: 1, ledgerHint: 'A-06' },
  { rel: 'server/agents/phase0-degradation.js', minExports: 1, ledgerHint: 'A-14' },
  { rel: 'server/agents/eval-tiers.js', minExports: 1, ledgerHint: 'A-07' },
  { rel: 'server/agents/eval-baseline.js', minExports: 1, ledgerHint: 'A-07' },
  { rel: 'server/agents/eval-indicators.js', minExports: 1, ledgerHint: 'A-06' },
];

test('五个台账证据模块存活且可加载（删任何一个都算拆台账证据）', () => {
  for (const item of MODULES) {
    const file = path.join(ROOT, item.rel);

    assert.ok(fs.existsSync(file), `${item.rel} 不见了：这是台账证据模块，不能按死代码删`);
    const mod = require(file);

    assert.ok(mod && typeof mod === 'object', `${item.rel} 导出不是对象`);
    assert.ok(
      Object.keys(mod).length >= item.minExports,
      `${item.rel} 的导出被掏空了（${Object.keys(mod).join(',') || '空'}）`
    );
  }
});

test('五个模块头部都带「勿按死代码删除」的台账标注', () => {
  for (const item of MODULES) {
    const head = fs
      .readFileSync(path.join(ROOT, item.rel), 'utf8')
      .split('\n')
      .slice(0, 14)
      .join('\n');

    assert.match(
      head,
      /台账证据模块[\s\S]*勿按死代码删除/,
      `${item.rel} 丢了台账标注：下一个人会把它当死代码清掉`
    );
  }
});

test('台账 A-06 / A-07 仍指向这些模块（标注与台账不能各说各话）', () => {
  const ledger = fs.readFileSync(LEDGER, 'utf8');

  for (const id of ['A-06', 'A-07']) {
    assert.ok(ledger.includes(`| ${id} |`), `台账缺 ${id} 行`);
  }

  for (const name of ['eval-tiers.js', 'eval-baseline.js', 'eval-indicators.js']) {
    assert.ok(
      ledger.includes(name),
      `台账不再引用 ${name}：证据链断了，要么补引用要么改判行状态`
    );
  }
});

test('生产主链路仍然零引用（标注说的是实情，不是自我安慰）', () => {
  const production = ['server/index.js', 'server/agent-runtime.js']
    .map(rel => path.join(ROOT, rel))
    .filter(file => fs.existsSync(file))
    .map(file => fs.readFileSync(file, 'utf8'))
    .join('\n');

  for (const item of MODULES) {
    const base = path.basename(item.rel, '.js');

    assert.ok(
      !new RegExp(`(require\\([^)]*agents/${base}['"]|from ['"][^'"]*agents/${base}['"])`).test(
        production
      ),
      `${item.rel} 已被生产链路引用：请把标注与本文档口径一起更新（它不再是零引用模块）`
    );
  }
});
