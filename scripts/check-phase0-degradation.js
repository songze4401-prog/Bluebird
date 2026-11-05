#!/usr/bin/env node
/**
 * A-14 / §21：Phase 0 降级判定的可执行检查。
 *
 * 用法：
 *   node scripts/check-phase0-degradation.js            # 真实探针当前仓库
 *   node scripts/check-phase0-degradation.js --json     # 机器可读
 *   node scripts/check-phase0-degradation.js --gates <file.json>  # 注入门禁状态
 *
 * 退出码：0 = 可退出降级；1 = 仍在降级；2 = 输入/探针异常。
 */
const fs = require('fs');
const path = require('path');

function readArg(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : null;
}

function main() {
  const gatesFile = readArg('--gates');
  const asJson = process.argv.includes('--json');
  // 模块加载会打印既有启动日志；--json 时把日志改道 stderr，保证 stdout 只有 JSON。
  const originalLog = console.log;
  if (asJson) console.log = (...args) => console.error(...args);
  let mod;
  try {
    mod = require('../server/agents/phase0-degradation');
  } finally {
    console.log = originalLog;
  }

  let gates;
  if (gatesFile) {
    gates = JSON.parse(fs.readFileSync(path.resolve(gatesFile), 'utf8'));
  } else {
    gates = mod.probePhase0Gates();
  }

  const result = mod.evaluatePhase0Degradation(gates);
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`[phase0] policy=${result.policyVersion} decision=${result.decision}`);
    if (result.branch) console.log(`[phase0] branch=${result.branch} ${result.branchLabel}`);
    console.log(`[phase0] allowedScope=${result.allowedScope.join(',') || '(full)'}`);
    console.log(`[phase0] forbiddenScope=${result.forbiddenScope.join(',') || '(none)'}`);
    for (const item of result.exitCriteria) {
      console.log(`[phase0] ${item.passed ? 'PASS' : 'FAIL'} ${item.key} — ${item.label}`);
    }
    const failed = result.failedGates;
    if (failed.length) console.log(`[phase0] failedGates=${failed.join(',')}`);
  }
  return result.decision === 'exit_degraded' ? 0 : 1;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`[phase0] check failed: ${error.message}`);
  process.exitCode = 2;
}
