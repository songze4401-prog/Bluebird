/**
 * 云岫 Bluebird — P3 真实模型链路验证
 *
 * 目的：用真实 Provider 跑一次完整链路（检索 → 装配 → 真实请求），验证
 *   1. 记忆块确实进入了发给 Provider 的 messages；
 *   2. Provider 返回真实 usage（prompt_tokens 可读）；
 *   3. 本地估算与真实 prompt_tokens 的比值可测（不预设结论）；
 *   4. Trace 的内容指纹等于实际发送内容。
 *
 * 严格声明（不夸大）：
 * - 本脚本验证的是「请求装配 + 真实调用 + 计量」，**不验证**模型是否在语义上
 *   使用了这条记忆（HTTP 成功 ≠ 模型消费了每条内容）。
 * - 没有真实凭证时**什么都不验证**，输出 NOT VERIFIED 并以退出码 2 结束，
 *   绝不打印 PASS，也不写任何"已通过"的结论。
 *
 * 启用方式：
 *   BLUEBIRD_P3_REAL=1 DEEPSEEK_API_KEY=<真实 key> node scripts/p3-real-model-check.js
 * 可选：
 *   BLUEBIRD_P3_MODEL=deepseek-chat   （默认）
 *
 * 退出码：0 = 已验证通过；1 = 已验证失败；2 = 未验证（缺凭证/未启用）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ENABLED = process.env.BLUEBIRD_P3_REAL === '1';
const SELFTEST = process.argv.includes('--selftest');
const REAL_KEY = process.env.DEEPSEEK_API_KEY;

function notVerified(reason) {
  console.log('');
  console.log('NOT VERIFIED — 真实模型链路未验证');
  console.log(`原因：${reason}`);
  console.log('');
  console.log('这不算通过。P3 要求「真实模型链路验证不能由 Mock 测试替代」，');
  console.log('因此这里如实报告未验证，而不是用桩结果冒充真实结论。');
  console.log('启用方式：BLUEBIRD_P3_REAL=1 DEEPSEEK_API_KEY=<真实 key> node scripts/p3-real-model-check.js');
  console.log('自检（桩，不构成真实验证）：node scripts/p3-real-model-check.js --selftest');
  process.exit(2);
}

if (!SELFTEST) {
  if (!ENABLED) {
    notVerified('未设置 BLUEBIRD_P3_REAL=1（真实调用会产生费用，必须显式开启）');
  }
  if (!REAL_KEY || !String(REAL_KEY).trim()) {
    notVerified('缺少 DEEPSEEK_API_KEY（真实 Provider 凭证）');
  }
  // 真实调用不得被标成桩：显式清掉测试用的桩声明。
  delete process.env.BLUEBIRD_PROVIDER_KIND;
  delete process.env.BLUEBIRD_ALLOW_PRIVATE_BASE_URL;
} else {
  // 自检模式：只验证脚本管道能跑通，结论明确标注为非真实验证。
  process.env.BLUEBIRD_ALLOW_PRIVATE_BASE_URL = '1';
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-p3-real-'));
process.env.BLUEBIRD_DATA_DIR = TMP;
process.env.MEMORY_ENABLED = 'true';

const memory = require(path.join(__dirname, '..', 'server', 'memory.js'));
const { runContextRuntime } = require(path.join(__dirname, '..', 'server', 'context', 'engine.js'));
const { config } = require(path.join(__dirname, '..', 'server', 'context', 'config.js'));
const { createChatCompletion } = require(path.join(__dirname, '..', 'server', 'model-adapter.js'));
const { getInstanceUserId } = require(path.join(__dirname, '..', 'server', 'user-scope.js'));
const apiConfigs = require(path.join(__dirname, '..', 'server', 'api-configs.js'));

const MEMORY_FILE = path.join(TMP, 'memory.json');
const USER = getInstanceUserId();
const SESSION = 'sess_p3_real_new';
const MODEL_ID = process.env.BLUEBIRD_P3_MODEL || 'deepseek-chat';

// 自检用：本地桩 Provider。只验证脚本管道，不构成真实验证。
function startStubProvider() {
  const http = require('http');

  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
      });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'stub-completion',
            model: 'stub-model',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: '你只喝美式。' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 240, completion_tokens: 8, total_tokens: 248 },
          })
        );
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const created = apiConfigs.addModelProvider({
        name: 'p3-selftest-stub',
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey: 'stub-key',
        models: [{ id: 'stub-model', name: 'stub-model' }],
      });

      resolve({
        providerId: created.provider ? created.provider.id : null,
        modelId: 'stub-model',
        close: () => new Promise(done => server.close(done)),
      });
    });
  });
}

const FACT = '用户喝咖啡只喝美式，不加糖不加奶';
const QUERY = '我喝咖啡有什么习惯？';

function seed() {
  const now = new Date().toISOString();
  const items = [
    {
      content: FACT,
      type: 'preference',
      keywords: ['咖啡', '美式'],
      confidence: 0.95,
      status: 'active',
      sourceQuote: FACT,
      sessionId: 'sess_p3_real_old',
      validFrom: now,
      validTo: null,
      createdAt: now,
      updatedAt: now,
    },
  ];
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(items, null, 2), 'utf8');
  memory.loadMemories();
}

function hashMessages(list) {
  const canonical = list.map(message => ({
    role: (message && message.role) || null,
    content: message && typeof message.content === 'string' ? message.content : null,
    ...(message && message.tool_calls ? { tool_calls: message.tool_calls } : {}),
  }));
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

async function main() {
  seed();

  const stub = SELFTEST ? await startStubProvider() : null;
  const providerId = stub ? stub.providerId : 'deepseek';
  const modelId = stub ? stub.modelId : MODEL_ID;

  if (SELFTEST) {
    if (!providerId) {
      console.log('自检失败：无法注册本地桩 Provider');
      process.exit(1);
    }
    console.log('⚠ SELF-TEST（本地桩 Provider）— 只验证脚本管道，不构成真实验证');
    console.log('');
  }

  const runtime = await runContextRuntime({
    task: QUERY,
    sessionId: SESSION,
    userId: USER,
    requestId: 'req_p3_real',
    projectedMessages: [],
    renderMessage: () => null,
    renderFinalMessage: () => null,
    systemBlocks: [
      {
        id: 'persona',
        kind: 'system',
        priority: 100,
        text: '你是一个中文助手。',
      },
    ],
    currentMessage: { role: 'user', content: QUERY },
    model: { providerId, modelId, contextWindow: 128000 },
    toolsReserveTokens: 0,
    config,
  });

  const checks = [];
  const check = (name, ok, detail = '') => {
    checks.push({ name, ok, detail });
    console.log(`  ${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
  };

  console.log(SELFTEST ? '真实模型链路验证（自检模式）' : '真实模型链路验证');
  console.log('='.repeat(72));

  // 1) 记忆是否进入请求
  const systemText = String(runtime.systemPrompt || '');
  check('记忆块进入最终 system prompt', systemText.includes(FACT));
  check('检索状态为 ok', runtime.memoryStatus === 'ok', `memoryStatus=${runtime.memoryStatus}`);
  check(
    '记忆块 Token 有归属（估算）',
    Number.isFinite(runtime.measurement.memoryTokens) && runtime.measurement.memoryTokens > 0,
    `memoryTokens=${runtime.measurement.memoryTokens}`
  );

  // 2) Trace 指纹与实际发送内容一致
  //    与生产一致：recordSent 必须在真正调用 Provider 之前、用同一份 messages 调用。
  runtime.traceApi.recordSent({
    round: 1,
    messages: runtime.messages,
    contextIds: runtime.contextIds || [],
    model: { providerId, modelId },
  });

  const sentHash = hashMessages(runtime.messages);
  // runtime.trace 是引擎返回时的快照；recordSent 之后必须重新取一次。
  const traceJson = runtime.traceApi.toJSON();
  const round = traceJson.sent.rounds[traceJson.sent.rounds.length - 1];
  check('Trace 指纹等于实际发送内容', Boolean(round) && round.contentHash === sentHash);

  // 3) 真实调用
  const startedAt = Date.now();
  let completion = null;
  let callError = null;
  try {
    completion = await createChatCompletion({
      providerId,
      modelId,
      messages: runtime.messages,
      temperature: 0.3,
      maxTokens: 120,
      timeout: 60000,
    });
  } catch (error) {
    callError = error;
  }
  const durationMs = Date.now() - startedAt;

  if (callError) {
    check(
      SELFTEST ? 'Provider 调用成功（桩）' : '真实 Provider 调用成功',
      false,
      `${callError.code || ''} ${callError.message || ''}`.trim()
    );
  } else {
    check(SELFTEST ? 'Provider 调用成功（桩）' : '真实 Provider 调用成功', true, `${durationMs}ms`);

    const usage = completion && completion.usage ? completion.usage : null;
    const promptTokens = usage && Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : null;

    check(
      SELFTEST ? '桩返回 usage（仅验证读取链路）' : 'Provider 返回真实 prompt_tokens',
      promptTokens !== null,
      promptTokens === null ? 'usage 缺失' : `prompt_tokens=${promptTokens}`
    );

    if (promptTokens !== null) {
      const estimated = runtime.measurement.estimatedInputTokens;
      const ratio = estimated > 0 ? +(promptTokens / estimated).toFixed(4) : null;
      console.log('');
      console.log('  计量对比：');
      console.log(`    本地估算输入 Token : ${estimated}（heuristic-cjk-ascii-v1）`);
      console.log(`    Provider prompt    : ${promptTokens}`);
      console.log(`    比值（真实/估算）  : ${ratio}`);
      if (SELFTEST) {
        console.log('    结论               : 桩返回的 usage 是固定值，与估算无对应关系，比值无意义');
      } else {
        console.log(
          `    结论               : ${
            ratio !== null && Math.abs(ratio - 1) <= 0.35
              ? '在 0.35 容差内'
              : '超出 0.35 容差，估算器需要按目标模型校准'
          }`
        );
      }
      // 比值只作观测，不作为通过条件：估算器未按目标 tokenizer 校准。
    }

    const reply =
      completion && completion.choices && completion.choices[0] && completion.choices[0].message
        ? String(completion.choices[0].message.content || '')
        : '';
    console.log('');
    console.log('  模型回复（仅信息，不作为通过条件）：');
    console.log(`    ${reply.replace(/\s+/g, ' ').slice(0, 160)}`);
    console.log('');
    console.log('  注意：回复里是否复述该记忆取决于模型行为，本脚本不据此判定「记忆被使用」。');
  }

  const failed = checks.filter(item => !item.ok);
  console.log('');
  console.log('='.repeat(72));
  console.log(`检查项：${checks.length}，失败：${failed.length}`);

  if (stub) await stub.close();
  fs.rmSync(TMP, { recursive: true, force: true });

  if (SELFTEST) {
    // 自检永远不输出 VERIFIED：桩通过 ≠ 真实验证通过。
    console.log(
      failed.length
        ? 'SELF-TEST FAILED — 脚本管道有问题，需修复'
        : 'SELF-TEST PASSED（仅管道自检）— 真实模型链路仍未验证'
    );
    process.exit(failed.length ? 1 : 3);
  }

  if (failed.length) {
    console.log('VERIFIED — 但存在失败项（见上）');
    process.exit(1);
  }
  console.log('VERIFIED — 真实 Provider 链路通过（请求装配 + 真实调用 + 计量一致性）');
  process.exit(0);
}

main().catch(error => {
  console.error('真实链路验证异常：', error && error.message ? error.message : error);
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {
    /* ignore */
  }
  process.exit(1);
});
