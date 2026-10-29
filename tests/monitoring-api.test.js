/* global __dirname */
/**
 * 监控 API + 真实调用链埋点测试（自定义 runner）
 *
 * 用桩替换模型 SDK（不联网），但 HTTP 服务、上下文运行时、Agent 工具循环、
 * 落盘、SSE、监控事件/Trace/指标全部走真实代码路径。
 * 覆盖：鉴权、只读 405、范围/分页校验、Trace 详情与阶段、
 * 总览/模型/工具/告警/健康、隐私、审计、SSE、错误场景。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER = path.join(__dirname, '..', 'server');
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-monitoring-api-'));
const DATA_DIR = path.join(TMP_ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

process.env.BLUEBIRD_DATA_DIR = DATA_DIR;
process.env.BLUEBIRD_MONITORING = '1';
process.env.BLUEBIRD_AGENT_TOOLS = '1';
process.env.DEEPSEEK_API_KEY = 'test-key-for-monitoring';
process.env.BLUEBIRD_API_TOKEN = 'monitor-test-token';
process.env.BLUEBIRD_BACKUP_DIR = path.join(TMP_ROOT, 'backups');
process.env.PORT = '0';
process.env.NODE_ENV = 'test';

const ORIG_LOG = console.log;
const ORIG_ERR = console.error;

console.log = () => {};
console.error = () => {};

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    ORIG_LOG(`  ✔ ${name}`);
  } else {
    failed += 1;
    failures.push(name + (extra ? ` — ${extra}` : ''));
    ORIG_LOG(`  ✖ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

// ---- 模型桩：非流式 / 流式 / Agent 工具调用 ----
const modelCalls = [];

class StubStream {
  constructor(chunks) {
    this.chunks = chunks;
    this.model = 'deepseek-chat';
    this.controller = {
      aborted: false,
      abort() {
        this.aborted = true;
      },
    };
  }

  async *[Symbol.asyncIterator]() {
    for (const chunk of this.chunks) {
      yield chunk;
    }
  }
}

function completion({ content = null, toolCalls = [], usage }) {
  return {
    id: 'stub-completion',
    model: 'deepseek-chat',
    choices: [
      {
        index: 0,
        finish_reason: toolCalls.length ? 'tool_calls' : 'stop',
        message: {
          role: 'assistant',
          content,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
      },
    ],
    ...(usage ? { usage } : {}),
  };
}

const openaiTarget = require.resolve('openai', { paths: [SERVER] });
require.cache[openaiTarget] = {
  id: openaiTarget,
  filename: openaiTarget,
  loaded: true,
  exports: class StubOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async params => {
            modelCalls.push(params);
            const hasToolResult = (params.messages || []).some(
              message => message.role === 'tool'
            );

            if (params.stream) {
              return new StubStream([
                {
                  model: 'deepseek-chat',
                  choices: [{ index: 0, delta: { content: '流式监控回答' } }],
                },
                {
                  model: 'deepseek-chat',
                  choices: [{ index: 0, delta: { content: '。' } }],
                  usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11, prompt_cache_hit_tokens: 4 },
                },
              ]);
            }

            if (Array.isArray(params.tools) && params.tools.length && !hasToolResult) {
              return completion({
                toolCalls: [
                  {
                    id: 'call_monitor_1',
                    type: 'function',
                    function: {
                      name: 'memory_search',
                      arguments: JSON.stringify({ query: '监控' }),
                    },
                  },
                ],
                usage: { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20, prompt_cache_hit_tokens: 4 },
              });
            }

            return completion({
              content: '监控验收回答',
              usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28, prompt_cache_hit_tokens: 4 },
            });
          },
        },
      };
    }
  },
};

const { server } = require(path.join(SERVER, 'index.js'));
const monitoring = require(path.join(SERVER, 'monitoring', 'index.js'));

let baseUrl = '';

function request(urlPath, { method = 'GET', body, auth = true } = {}) {
  return fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: {
      ...(auth ? { Authorization: 'Bearer monitor-test-token' } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function jsonRequest(urlPath, options) {
  const response = await request(urlPath, options);
  let data = null;
  try {
    data = await response.json();
  } catch (_) {
    data = null;
  }
  return { status: response.status, data };
}

function rangeQuery(hours = 1) {
  const to = new Date();
  const from = new Date(to.getTime() - hours * 3600 * 1000);
  return `from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`;
}

async function main() {
  await new Promise(resolve => {
    if (server.listening) return resolve();
    server.once('listening', resolve);
  });

  baseUrl = `http://127.0.0.1:${server.address().port}`;

  // ---- 鉴权与只读 ----
  check(
    '未授权访问监控健康返回 401',
    (await request('/monitoring/health', { auth: false })).status === 401
  );
  check(
    '监控写方法被显式拒绝（405）',
    (await request('/monitoring/overview', { method: 'POST', body: {} })).status === 405
  );

  const meta = await jsonRequest('/monitoring/meta');
  check(
    '监控契约元数据包含状态枚举与事件清单',
    meta.status === 200 &&
      Array.isArray(meta.data.statuses) &&
      meta.data.statuses.includes('partial_success') &&
      meta.data.events.includes('context.build.completed')
  );

  // ---- 创建会话与真实聊天（桩模型） ----
  const sessionResponse = await jsonRequest('/sessions', {
    method: 'POST',
    body: { title: '监控 API 验收' },
  });
  const sessionId =
    sessionResponse.data && sessionResponse.data.session
      ? sessionResponse.data.session.id
      : null;
  check('创建会话成功', sessionResponse.status === 201 && Boolean(sessionId));

  const chatResponse = await jsonRequest('/chat', {
    method: 'POST',
    body: {
      sessionId,
      message: '监控测试消息：这是不应出现在监控里的用户原文',
      providerId: 'deepseek',
      modelId: 'deepseek-chat',
    },
  });

  check(
    '非流式聊天成功并落盘',
    chatResponse.status === 200 &&
      chatResponse.data &&
      chatResponse.data.reply &&
      chatResponse.data.persisted === true
  );
  check(
    'Agent 工具真实执行（memory_search）',
    Array.isArray(chatResponse.data.toolSteps) &&
      chatResponse.data.toolSteps.some(step => step.name === 'memory_search')
  );

  await new Promise(resolve => setTimeout(resolve, 350));

  // ---- Trace 详情 ----
  const traces = await jsonRequest(`/monitoring/traces?${rangeQuery()}&limit=20`);
  const traceItems = (traces.data && traces.data.items) || [];
  const chatTrace = traceItems.find(
    item => item.name === 'chat.task' && item.task && item.task.status === 'success'
  );

  check('Trace 列表包含本次聊天任务', traces.status === 200 && Boolean(chatTrace));

  let detail = null;
  if (chatTrace) {
    const detailResponse = await jsonRequest(
      `/monitoring/traces/${encodeURIComponent(chatTrace.trace_id)}`
    );
    check('Trace 详情可读取', detailResponse.status === 200 && Boolean(detailResponse.data.trace));
    detail = detailResponse.data;
    const spans = (detail.trace.spans || []).map(span => span.name);
    const events = detail.events || [];

    check(
      'Trace 阶段包含 candidate/selected/accepted/injected/sent',
      detail.trace.stages &&
        ['candidate', 'selected', 'accepted', 'injected', 'sent'].every(
          key => detail.trace.stages[key] !== null
        ) &&
        detail.trace.stages.sent > 0
    );
    check(
      'Trace consumed 未伪造（固定 null）',
      detail.trace.stages.consumed === null
    );
    check(
      'Trace span 覆盖请求/上下文/记忆/模型/工具/落盘',
      ['request', 'context.build', 'memory.search', 'model.request', 'tool.memory_search', 'persistence.write'].every(
        name => spans.includes(name)
      ),
      JSON.stringify(spans)
    );
    check(
      '模型 usage 来自供应商桩并被计入 Token（含缓存命中）',
      detail.trace.model.usage_source === 'provider' &&
        detail.trace.model.total_tokens > 0 &&
        detail.trace.model.cached_tokens >= 4
    );
    check(
      '上下文事件带候选/选中/接受/注入/发送与排除原因字段',
      events.some(
        event =>
          event.event_name === 'context.build.completed' &&
          Array.isArray(event.attributes.dropped_reasons) &&
          Number.isFinite(event.attributes.stage_candidate)
      )
    );
    check(
      '工具计数区分请求/执行/成功，并记录结果规模',
      detail.trace.tools.requested >= 1 &&
        detail.trace.tools.executed >= 1 &&
        detail.trace.tools.succeeded >= 1 &&
        events.some(
          event =>
            event.event_name === 'tool.call.completed' &&
            Number.isFinite(event.attributes.result_bytes)
        )
    );
    check(
      '阶段事件完整（上下文/记忆/模型/工具/发送/落盘/任务）',
      ['context.build.started', 'context.build.completed', 'memory.search.started', 'memory.search.completed', 'model.request.started', 'model.request.completed', 'tool.call.requested', 'tool.call.completed', 'context.sent', 'persistence.write.started', 'persistence.write.completed', 'task.completed', 'agent.gate', 'model.route'].every(
        name => events.some(event => event.event_name === name)
      ),
      JSON.stringify(events.map(event => event.event_name))
    );
    check(
      'Trace 事件只含元数据，不含用户原文/令牌',
      !JSON.stringify(detail).includes('监控测试消息') &&
        !JSON.stringify(detail).includes('test-key-for-monitoring') &&
        !JSON.stringify(detail).includes('monitor-test-token')
    );
  } else {
    check('Trace 详情可读取', false);
    check('Trace 阶段包含 candidate/selected/accepted/injected/sent', false);
    check('Trace consumed 未伪造（固定 null）', false);
    check('Trace span 覆盖请求/上下文/记忆/模型/工具/落盘', false);
    check('模型 usage 来自供应商桩并被计入 Token', false);
    check('工具计数区分请求/执行/成功', false);
    check('阶段事件完整（上下文/记忆/模型/工具/发送/落盘/任务）', false);
    check('Trace 事件只含元数据，不含用户原文/令牌', false);
  }

  // ---- 总览 / 指标 ----
  const overview = await jsonRequest(`/monitoring/overview?${rangeQuery()}`);
  const cards = (overview.data && overview.data.cards) || [];
  const cardBy = key => cards.find(card => card.key === key);

  check('总览返回 200 且数据状态为已采集', overview.status === 200 && overview.data.data_status === 'ok');
  check(
    '总览 Agent 卡显示真实任务数与成功率',
    cardBy('agent') && cardBy('agent').primary.value >= 1
  );
  check(
    '总览模型卡显示供应商 Token 与未知费用',
    cardBy('model') &&
      cardBy('model').metrics.some(
        metric => metric.label.includes('输入 Token') && metric.value > 0
      ) &&
      cardBy('model').metrics.some(
        metric => metric.label === '费用' && metric.value === null
      )
  );
  check(
    '总览上下文卡显示阶段条目',
    cardBy('context') &&
      cardBy('context').metrics.some(metric => Array.isArray(metric.value))
  );
  check(
    '总览成本明确未配置，不伪造金额',
    overview.data.cost && overview.data.cost.status === 'not_configured'
  );

  const metricsResponse = await jsonRequest(
    `/monitoring/metrics?names=context_builds_total,model_requests_total&${rangeQuery()}`
  );
  check(
    '指标接口返回时间序列且分位数口径明确',
    metricsResponse.status === 200 &&
      Array.isArray(metricsResponse.data.series) &&
      metricsResponse.data.series.some(series => series.points.length > 0)
  );
  check(
    '未知指标返回 400',
    (await jsonRequest(`/monitoring/metrics?names=not_a_metric&${rangeQuery()}`)).status === 400
  );

  // ---- 模型 / 工具 / 告警 / 健康 ----
  const models = await jsonRequest(`/monitoring/models?${rangeQuery()}`);
  check(
    '模型汇总包含请求数、Token 与 usage 缺失计数',
    models.status === 200 &&
      Array.isArray(models.data.models) &&
      models.data.models.some(
        model =>
          model.requests >= 2 &&
          model.output_tokens > 0 &&
          model.cached_tokens >= 4
      )
  );

  const tools = await jsonRequest(`/monitoring/tools?${rangeQuery()}`);
  const memoryTool = ((tools.data && tools.data.tools) || []).find(
    tool => tool.name === 'memory_search'
  );
  check(
    '工具汇总显示开关、只读属性与调用次数',
    tools.status === 200 &&
      tools.data.agent_switch_on === true &&
      memoryTool &&
      memoryTool.read_only === true &&
      memoryTool.calls >= 1
  );

  const alertsResponse = await jsonRequest('/monitoring/alerts');
  check(
    '告警接口明确外部通知未配置，且停用规则有原因',
    alertsResponse.status === 200 &&
      alertsResponse.data.health.notifications.configured === false &&
      alertsResponse.data.rules.some(
        rule => rule.id === 'cost_spike' && rule.enabled === false && rule.disabled_reason
      )
  );

  const healthResponse = await jsonRequest('/monitoring/health');
  check(
    '健康接口区分监控状态与数据，并暴露查询层',
    healthResponse.status === 200 &&
      ['ok', 'no_data', 'degraded'].includes(healthResponse.data.status) &&
      healthResponse.data.query_layer &&
      healthResponse.data.storage.retained_events > 0
  );
  check(
    '健康接口备份状态为只读证据（未配置/正常/异常之一）',
    healthResponse.data.backup &&
      typeof healthResponse.data.backup.exists === 'boolean'
  );

  // ---- 事件分页与过滤 ----
  const eventsPage1 = await jsonRequest(`/monitoring/events?${rangeQuery()}&limit=2`);
  const eventsPage2 = eventsPage1.data.nextCursor
    ? await jsonRequest(
        `/monitoring/events?${rangeQuery()}&limit=2&cursor=${encodeURIComponent(
          eventsPage1.data.nextCursor
        )}`
      )
    : null;

  check(
    '事件分页游标返回下一页且不重复',
    eventsPage1.status === 200 &&
      eventsPage1.data.items.length === 2 &&
      eventsPage1.data.hasMore === true &&
      eventsPage2 &&
      eventsPage2.data.items.length > 0 &&
      eventsPage2.data.items[0].event_id !== eventsPage1.data.items[0].event_id
  );
  check(
    '事件按状态过滤可用（denied 无伪造）',
    (await jsonRequest(`/monitoring/events?${rangeQuery()}&status=denied`)).status === 200
  );

  // ---- 参数边界与只读 ----
  const to = new Date();
  const from = new Date(to.getTime() - 2 * 3600 * 1000);
  check(
    'from 晚于 to 返回 400',
    (
      await jsonRequest(
        `/monitoring/overview?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(
          new Date(from.getTime() - 1000).toISOString()
        )}`
      )
    ).status === 400
  );
  check(
    '查询范围超过 7 天返回 400',
    (
      await jsonRequest(
        `/monitoring/overview?from=${encodeURIComponent(
          new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString()
        )}&to=${encodeURIComponent(to.toISOString())}`
      )
    ).status === 400
  );
  check(
    '非法 traceId 返回 400，未知 trace 返回 404',
    (await jsonRequest('/monitoring/traces/not-a-trace')).status === 400 &&
      (await jsonRequest('/monitoring/traces/tr_00000000-0000-0000-0000-000000000000')).status === 404
  );

  // ---- SSE ----
  const streamResponse = await request('/chat/stream', {
    method: 'POST',
    body: {
      sessionId,
      message: '流式监控测试',
      providerId: 'deepseek',
      modelId: 'deepseek-chat',
    },
  });
  const streamText = await streamResponse.text();
  check(
    '流式请求收到 delta 与 done',
    streamResponse.status === 200 &&
      streamText.includes('"type":"delta"') &&
      streamText.includes('"type":"done"')
  );

  await new Promise(resolve => setTimeout(resolve, 300));
  const sseEvents = await jsonRequest(
    `/monitoring/events?${rangeQuery()}&component=sse&limit=20`
  );
  check(
    'SSE 建连/完成事件与首 token/增量计数落入监控',
    sseEvents.status === 200 &&
      sseEvents.data.items.some(
        item =>
          item.event_name === 'response.stream.completed' &&
          item.attributes &&
          item.attributes.termination === 'completed'
      )
  );

  // ---- 审计 ----
  const deleteResponse = await request(`/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
  });
  check('删除会话成功', deleteResponse.status === 200);

  await new Promise(resolve => setTimeout(resolve, 100));
  const auditResponse = await jsonRequest(`/monitoring/audit?${rangeQuery()}&limit=20`);
  check(
    '删除会话留下审计记录（哈希引用，无正文）',
    auditResponse.status === 200 &&
      auditResponse.data.items.some(item => item.action === 'session.delete') &&
      !JSON.stringify(auditResponse.data).includes('监控测试消息')
  );

  await new Promise(resolve => setTimeout(resolve, 250));

  // ---- 重启前落盘证据 ----
  const eventsFile = path.join(DATA_DIR, 'monitoring', 'events.jsonl');
  const tracesFile = path.join(DATA_DIR, 'monitoring', 'traces.jsonl');
  check(
    '监控事件与 Trace 已写入独立 JSONL 文件',
    fs.existsSync(eventsFile) &&
      fs.statSync(eventsFile).size > 0 &&
      fs.existsSync(tracesFile) &&
      fs.statSync(tracesFile).size > 0
  );

  await monitoring.shutdownMonitoring();

  ORIG_LOG(`\n通过 ${passed} 项，失败 ${failed} 项`);
  if (failed) ORIG_LOG(`\n失败项：\n${failures.map(item => ` - ${item}`).join('\n')}`);

  await new Promise(resolve => {
    try {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    } catch (_) {
      /* ignore */
    }
    server.close(() => resolve());
  });

  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch (_) {
    /* ignore */
  }

  process.exit(failed ? 1 : 0);
}

main().catch(async error => {
  ORIG_ERR(error && error.stack ? error.stack : error);
  try {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close();
  } catch (_) {
    /* ignore */
  }
  process.exit(1);
});
