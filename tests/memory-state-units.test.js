/**
 * 阶段3 单元测试：记忆状态标准化与降级语义（引擎层）
 *
 * 用 stub 替换 retriever 验证 runContextRuntime 的降级契约：
 * - 检索抛异常 → memoryState=failed，contextRuntime.ok 仍为 true（不阻断主控）；
 * - 熔断降级 → memoryState=degraded；
 * - 无匹配 → memoryState=empty（与 failed 明确区分）；
 * - 检索成功 → memoryState=ok。
 * 以及 normalizeMemoryState 的映射规则。
 *
 * 运行：node tests/memory-state-units.test.js
 */
const path = require('path');

const SERVER = path.join(__dirname, '..', 'server');
const RETRIEVER_PATH = path.join(SERVER, 'context', 'retriever.js');

let retrieveMemoryStub = null;

// 必须在 require engine.js 之前替换 retriever 模块（engine 在模块加载时解构）。
require.cache[require.resolve(RETRIEVER_PATH)] = {
  id: RETRIEVER_PATH,
  filename: RETRIEVER_PATH,
  loaded: true,
  exports: {
    retrieveMemory: async () => {
      if (typeof retrieveMemoryStub === 'function') return retrieveMemoryStub();
      return { status: 'no_result', count: 0, items: [] };
    },
    computeFreshness: () => ({ status: 'fresh', fetched_at: null, label: 'fresh' }),
    resetBreaker: () => {},
    MEMORY_TYPE_MAP: { preference: 'user_preference' },
  },
};

const { runContextRuntime, normalizeMemoryState } = require(path.join(SERVER, 'context', 'engine.js'));

function baseArgs(overrides = {}) {
  return {
    task: '当前问题',
    sessionId: 's1',
    projectedMessages: [],
    systemBlocks: [{ id: 'core', kind: 'core', priority: 100, critical: true, text: '规则' }],
    currentMessage: { role: 'user', content: '当前问题' },
    model: {},
    toolsReserveTokens: 0,
    ...overrides,
  };
}

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

(async () => {
  console.log('\n1) normalizeMemoryState 映射规则');
  check('ok → ok', normalizeMemoryState('ok') === 'ok');
  check('no_result → empty', normalizeMemoryState('no_result') === 'empty');
  check('source_unavailable → empty', normalizeMemoryState('source_unavailable') === 'empty');
  check('retrieval_error → failed', normalizeMemoryState('retrieval_error') === 'failed');
  check(
    'retrieval_error + breaker → degraded',
    normalizeMemoryState('retrieval_error', { breaker: true }) === 'degraded'
  );
  check(
    'retrieval_error + timeout → degraded',
    normalizeMemoryState('retrieval_error', { timeout: true }) === 'degraded'
  );
  check(
    'ok + timeout（已拿到部分结果但超预算）→ degraded',
    normalizeMemoryState('ok', { timeout: true }) === 'degraded'
  );

  console.log('\n2) 检索抛异常 → failed，不阻断主控');
  retrieveMemoryStub = async () => {
    throw new Error('模拟记忆检索故障');
  };
  const failedRun = await runContextRuntime(baseArgs());
  check(
    'contextRuntime.ok 仍为 true（记忆故障不阻断普通对话）',
    failedRun.ok === true,
    JSON.stringify(failedRun)
  );
  check(
    'memoryState=failed',
    failedRun.memoryState === 'failed',
    JSON.stringify(failedRun.memoryState)
  );
  check(
    'memoryStatus=retrieval_error',
    failedRun.memoryStatus === 'retrieval_error',
    JSON.stringify(failedRun.memoryStatus)
  );
  check(
    'memoryError 携带原因',
    typeof failedRun.memoryError === 'string' && failedRun.memoryError.length > 0,
    JSON.stringify(failedRun.memoryError)
  );

  console.log('\n3) 熔断降级 → degraded');
  retrieveMemoryStub = async () => ({
    status: 'retrieval_error',
    count: 0,
    items: [],
    error: '记忆检索已熔断（暂时不可用）',
    breaker: true,
  });
  const breakerRun = await runContextRuntime(baseArgs());
  check(
    'memoryState=degraded（熔断可恢复）',
    breakerRun.memoryState === 'degraded',
    JSON.stringify(breakerRun.memoryState)
  );
  check(
    'memoryStatus=retrieval_error',
    breakerRun.memoryStatus === 'retrieval_error',
    JSON.stringify(breakerRun.memoryStatus)
  );
  check('不阻断主控', breakerRun.ok === true);

  console.log('\n3b) 超出时间预算 → degraded（不伪装成健康/空结果）');
  retrieveMemoryStub = async () => ({
    status: 'ok',
    count: 1,
    items: [
      {
        id: 'mem-timeout',
        content: '用户喜欢喝美式咖啡',
        source: 'memory',
        type: 'user_preference',
        freshness: { status: 'fresh', fetched_at: new Date().toISOString(), label: 'fresh' },
        relevance: 0.9,
      },
    ],
    timeout: true,
    error: '记忆检索超出时间预算，已降级',
  });
  const timeoutRun = await runContextRuntime(baseArgs());
  check(
    'memoryState=degraded（超预算）',
    timeoutRun.memoryState === 'degraded',
    JSON.stringify(timeoutRun.memoryState)
  );
  check(
    '已拿到的结果照常注入（不因超时丢结果）',
    timeoutRun.memory.accepted.length === 1,
    JSON.stringify(timeoutRun.memory)
  );
  check(
    'memoryError 暴露超时原因',
    typeof timeoutRun.memoryError === 'string' && timeoutRun.memoryError.includes('时间预算'),
    JSON.stringify(timeoutRun.memoryError)
  );
  check('不阻断主控', timeoutRun.ok === true);

  console.log('\n4) 无匹配 → empty（与 failed 明确区分）');
  retrieveMemoryStub = async () => ({ status: 'no_result', count: 0, items: [] });
  const emptyRun = await runContextRuntime(baseArgs());
  check(
    'memoryState=empty（真无相关记忆，非故障）',
    emptyRun.memoryState === 'empty',
    JSON.stringify(emptyRun.memoryState)
  );
  check(
    'memoryStatus=no_result',
    emptyRun.memoryStatus === 'no_result',
    JSON.stringify(emptyRun.memoryStatus)
  );
  check('不阻断主控', emptyRun.ok === true);

  console.log('\n5) 检索成功 → ok');
  retrieveMemoryStub = async () => ({
    status: 'ok',
    count: 1,
    items: [
      {
        id: 'mem-1',
        content: '用户喜欢喝美式咖啡',
        source: 'memory',
        type: 'user_preference',
        freshness: { status: 'fresh', fetched_at: new Date().toISOString(), label: 'fresh' },
        relevance: 0.9,
      },
    ],
  });
  const okRun = await runContextRuntime(baseArgs());
  check(
    'memoryState=ok',
    okRun.memoryState === 'ok',
    JSON.stringify(okRun.memoryState)
  );
  check(
    '记忆进入上下文',
    okRun.memory.accepted.length === 1,
    JSON.stringify(okRun.memory)
  );

  console.log('\n6) requestId 贯穿引擎返回与 trace');
  const tracedRun = await runContextRuntime(
    baseArgs({ requestId: 'req_unit_test_0001' })
  );
  check(
    '返回值携带 requestId',
    tracedRun.requestId === 'req_unit_test_0001',
    JSON.stringify(tracedRun.requestId)
  );
  check(
    'trace 根节点携带 requestId',
    tracedRun.trace.requestId === 'req_unit_test_0001',
    JSON.stringify(tracedRun.trace.requestId)
  );
  check(
    '未传入时 requestId 为 null（不伪造）',
    okRun.requestId === null && okRun.trace.requestId === null,
    JSON.stringify([okRun.requestId, okRun.trace.requestId])
  );

  console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);

  if (failures.length) {
    console.log(`失败明细：\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }
  process.exit(0);
})().catch(error => {
  console.error('测试运行异常：', error && error.stack ? error.stack : error);
  process.exit(1);
});
