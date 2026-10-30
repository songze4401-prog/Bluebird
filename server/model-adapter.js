/**
 * 云岫 Bluebird — 统一模型适配层（model-adapter.js）
 *
 * 职责：把"服务商配置"变成"可用的模型调用"，对上层（/chat、/chat/stream、
 * 连接测试）只暴露统一入口：
 *
 *   createChatCompletion({ providerId, modelId, messages, stream, ... })
 *     → 非流式返回 completion；stream:true 返回 async iterable（SSE 增量）
 *   classifyError(error) → { kind, status, message }（脱敏，可安全回给客户端）
 *   testProviderConnection(providerId) → 连接与模型可用性探测（限时 + 限体）
 *
 * 设计约束（任务书）：
 * - 服务商配置与调用逻辑解耦：本模块不认识"有哪些服务商"，只认 api-configs
 *   给的 provider 对象（id/baseUrl/models/key）；
 * - 复用 openai SDK（OpenAI Chat Completions 兼容格式，DeepSeek 亦兼容），
 *   不重复实现记忆 / 人格 / 情绪注入——那些仍在 index.js 原有流水里；
 * - 能力不虚报：vision 只在模型显式声明 capabilities.vision === true 时可用；
 * - 自定义 Base URL 的 SSRF 防护：保存校验 + 连接测试 + 调用前解析三重把关，
 *   阻断环回 / 私网 / 链路本地 / 云元数据地址（详见 assertPublicUrl）。
 *
 * 已知限制（交付报告同步说明）：
 * - DNS 解析与真实请求之间存在 TOCTOU 窗口（DNS rebinding），本模块用
 *   "保存时校验 + 每 5 分钟复检"缓解，无法根除；彻底方案是请求时固定 IP，
 *   留待后续。
 * - 测试旁路 BLUEBIRD_ALLOW_PRIVATE_BASE_URL=1 会跳过内网拦截，仅供
 *   本地 mock 服务商测试使用，生产环境绝不允许设置（启动时有警告）。
 */
const dns = require('dns').promises;
const net = require('net');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const OpenAI = require('openai');
const monitoring = require('./monitoring');

const {
  findProvider,
  getProviderKey,
  getDefaults,
  BUILTIN_PROVIDER_ID,
} = require('./api-configs');

// ---- 错误分类 ----
// kind 语义（任务书要求区分连接失败 / 限流 / 超时 / 模型生成失败）：
//   auth        服务商拒绝了密钥（401/403）
//   rate_limit  服务商限流（429）
//   timeout     超时（连接或读取）
//   connection  网络层连不上（DNS / 连接被拒等）
//   server      服务商 5xx
//   model       模型侧错误（上游 4xx 的业务错误，如模型不存在）
//   bad_request 请求格式被拒（如图片放错了消息位）
//   not_configured 没有可用密钥 / 服务商
//   capability  请求了模型未声明支持的能力（本地拦截，未发请求）
const ERROR_STATUS = Object.freeze({
  auth: 502,
  rate_limit: 429,
  timeout: 504,
  connection: 502,
  server: 502,
  model: 502,
  bad_request: 400,
  not_configured: 500,
  capability: 400,
});

const ERROR_MESSAGE = Object.freeze({
  auth: '模型服务商拒绝了 API Key',
  rate_limit: '模型服务商限流，请稍后再试',
  timeout: '模型服务商响应超时',
  connection: '无法连接模型服务商',
  server: '模型服务商内部错误',
  model: '模型返回错误',
  bad_request: '请求格式不被模型服务商接受',
  not_configured: '未配置可用的模型服务商',
  capability: '当前模型不支持该能力',
});

class ModelCallError extends Error {
  constructor(kind, detail, messageOverride) {
    super(messageOverride || ERROR_MESSAGE[kind] || '模型调用失败');
    this.name = 'ModelCallError';
    this.kind = kind;
    this.status = ERROR_STATUS[kind] || 502;
    this.detail = detail || '';
  }
}

// ---- 密钥脱敏 ----
// 任何对外的 message / 日志都过这道 scrub，确保密钥不泄露。
function scrub(text, key) {
  if (!key || typeof text !== 'string') return text;
  return text.split(key).join('***');
}

// ---- SSRF 防护 ----

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'ip6-localhost',
  'ip6-loopback',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
]);

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

// 测试旁路：仅本地 mock 服务商使用。默认关闭；开启时启动警告（见文件尾部）。
// 运行时逐次读取（非常量）：环境变更即时生效，也便于测试在进程内切换。
function allowPrivateBaseUrl() {
  return process.env.BLUEBIRD_ALLOW_PRIVATE_BASE_URL === '1';
}

function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    value = value * 256 + n;
  }
  return value;
}

function isPrivateIPv4(ip) {
  const value = ipv4ToInt(ip);
  if (value === null) return true; // 解析不了的一律按私网处理（保守）

  const inRange = (base, bits) => {
    // 位运算坑：JS 的 & 返回有符号 int32，>>> 0 才转无符号。
    // 两侧必须都转无符号再比较，否则 base 最高位为 1 的网段
    // （172.16/12、192.168/16、169.254/16 等）会因符号永远不相等，
    // 导致私网拦截静默失效。
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((value & mask) >>> 0) === ((base & mask) >>> 0);
  };

  return (
    inRange(0x00000000, 8) || // 0.0.0.0/8  "本网络"
    inRange(0x0a000000, 8) || // 10.0.0.0/8  私网
    inRange(0x64400000, 10) || // 100.64.0.0/10 CGNAT
    inRange(0x7f000000, 8) || // 127.0.0.0/8 环回
    inRange(0xa9fe0000, 16) || // 169.254.0.0/16 链路本地（云元数据 169.254.169.254 在此）
    inRange(0xac100000, 12) || // 172.16.0.0/12 私网
    inRange(0xc0a80000, 16) || // 192.168.0.0/16 私网
    inRange(0xc0000000, 24) || // 192.0.2.0/24 文档
    inRange(0xf0000000, 4) // 240.0.0.0/4 保留
  );
}

function isPrivateIPv6(ip) {
  const lower = ip.toLowerCase().replace(/^\[|\]$/g, '');

  if (lower === '::' || lower === '::1') return true; // 未指定 / 环回
  if (lower.startsWith('fe80:')) return true; // 链路本地
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA
  if (lower.startsWith('ff')) return true; // 组播
  if (lower.startsWith('::ffff:')) {
    // IPv4-mapped：按内嵌 IPv4 判断
    const mapped = lower.slice(7);
    if (mapped.includes('.')) return isPrivateIPv4(mapped);
    return false;
  }
  return false;
}

function isPrivateAddress(address) {
  if (address.includes(':')) return isPrivateIPv6(address);
  return isPrivateIPv4(address);
}

/**
 * 校验并解析 Base URL。返回 { url, addresses }。
 * 抛出 ModelCallError('bad_request')——URL 非法一律按请求错误，
 * 由路由层转 400，不发出任何请求。
 */
async function assertPublicUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw new ModelCallError('bad_request', 'baseUrl 为空');
  }

  let url;
  try {
    url = new URL(rawUrl.trim());
  } catch (_) {
    throw new ModelCallError('bad_request', `baseUrl 不是合法 URL：${rawUrl}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ModelCallError('bad_request', `baseUrl 仅支持 http/https：${url.protocol}`);
  }

  if (url.username || url.password) {
    throw new ModelCallError('bad_request', 'baseUrl 不允许携带用户凭据');
  }

  const hostname = url.hostname.toLowerCase();

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new ModelCallError('bad_request', `baseUrl 主机名被禁止：${hostname}`);
  }
  if (BLOCKED_HOST_SUFFIXES.some(suffix => hostname.endsWith(suffix))) {
    throw new ModelCallError('bad_request', `baseUrl 主机名被禁止：${hostname}`);
  }

  // 字面量 IP 直接判断；域名解析后逐一判断（取第一个 A/AAAA 也可能翻车，
  // 必须全量）
  let addresses = [];
  if (net.isIP(hostname)) {
    addresses = [hostname];
  } else {
    try {
      const records = await dns.lookup(hostname, { all: true });
      addresses = records.map(r => r.address);
    } catch (_) {
      throw new ModelCallError('bad_request', `baseUrl 域名无法解析：${hostname}`);
    }
  }

  if (!addresses.length) {
    throw new ModelCallError('bad_request', `baseUrl 域名无法解析：${hostname}`);
  }

  if (allowPrivateBaseUrl()) {
    // 测试旁路：本地 mock 服务商（127.0.0.1 等）放行。生产环境禁止设置
    // 该变量——启动时已有警告（见文件尾部）。
    console.warn(
      `[model-adapter] BLUEBIRD_ALLOW_PRIVATE_BASE_URL=1：已跳过内网拦截（${hostname} -> ${addresses.join(', ')}）——仅限测试`
    );
  } else {
    for (const address of addresses) {
      if (isPrivateAddress(address)) {
        throw new ModelCallError(
          'bad_request',
          `baseUrl 指向内网/保留地址（${address}），已拦截`
        );
      }
    }
  }

  return { url, addresses };
}

// ---- 目标解析 ----

/**
 * 解析一次聊天调用要用的服务商 + 模型。
 * 输入：{ providerId?, modelId?, wantVision? }（缺省用配置默认值）。
 * 返回 { providerId, modelId, model, provider } 或抛出 ModelCallError。
 */
function resolveTarget({ providerId, modelId, wantVision = false, keyOverride = null } = {}) {
  const defaults = getDefaults();

  const pid = providerId || defaults.providerId;
  const provider = findProvider(pid);

  if (!provider) throw new ModelCallError('not_configured', `服务商不存在：${pid}`);
  if (provider.enabled === false) {
    throw new ModelCallError('not_configured', `服务商已禁用：${pid}`);
  }

  const mid = modelId || defaults.modelId;
  const model = provider.models.find(m => m.id === mid);

  if (!model) throw new ModelCallError('not_configured', `模型不存在：${pid}/${mid}`);
  if (model.enabled === false) {
    throw new ModelCallError('not_configured', `模型已禁用：${pid}/${mid}`);
  }

  if (wantVision && model.capabilities && model.capabilities.vision !== true) {
    throw new ModelCallError('capability', `模型 ${mid} 未声明视觉能力`);
  }

  const key = keyOverride || getProviderKey(provider.id);
  if (!key) {
    // 兼容旧文案：默认走内置 DeepSeek 且未配 key 时，保持与改造前逐字
    // 一致的 500 提示（既有测试与用户手册都依赖这段文案）。
    if (provider.id === BUILTIN_PROVIDER_ID) {
      throw new ModelCallError(
        'not_configured',
        '未配置 DEEPSEEK_API_KEY',
        '服务端未配置 DEEPSEEK_API_KEY，请在 server/.env 中填写后重启'
      );
    }
    throw new ModelCallError('not_configured', `服务商未配置 API Key：${provider.id}`);
  }

  return { providerId: provider.id, modelId: model.id, model, provider, key };
}

// 视觉目标解析：优先显式指定；否则取默认服务商里第一个声明 vision 的启用模型。
function resolveVisionTarget({ providerId, modelId, keyOverride = null } = {}) {
  const defaults = getDefaults();
  const pid = providerId || defaults.providerId;
  const provider = findProvider(pid);

  // 显式指定或默认服务商不存在/被禁用：明确报 not_configured，
  // 不落入 capability（那会掩盖"服务商没了"的真实原因）
  if (!provider) throw new ModelCallError('not_configured', `服务商不存在：${pid}`);
  if (provider.enabled === false) {
    throw new ModelCallError('not_configured', `服务商已禁用：${pid}`);
  }

  if (modelId) {
    return resolveTarget({ providerId: pid, modelId, wantVision: true, keyOverride });
  }

  // 未显式指定模型：优先沿用用户选中的默认模型（若它声明了视觉能力）。
  // 否则用户切到默认的视觉模型后，带图请求仍会被换成「第一个视觉模型」，
  // 造成设置里选了 B、实际调用 A。
  const preferredId = pid === defaults.providerId ? defaults.modelId : '';
  const preferredModel = preferredId
    ? provider.models.find(m => m.id === preferredId && m.enabled !== false)
    : null;

  if (preferredModel && preferredModel.capabilities?.vision === true) {
    return resolveTarget({ providerId: pid, modelId: preferredModel.id, wantVision: true, keyOverride });
  }

  const visionModel = provider.models.find(
    m => m.enabled !== false && m.capabilities && m.capabilities.vision === true
  );
  if (visionModel) {
    return resolveTarget({ providerId: pid, modelId: visionModel.id, wantVision: true, keyOverride });
  }

  // 默认服务商没有视觉模型：明确失败，不静默降级到不认图的模型
  // （那会让图片消息被当成乱码理解，比报错更糟）
  throw new ModelCallError(
    'capability',
    `服务商 ${pid} 没有声明视觉能力的模型，无法处理图片消息`
  );
}

// ---- client 缓存 ----
// 同一服务商复用 client（SDK 内部有连接池，按 provider 缓存避免每次新建）。
// 密钥变更后由路由层调 invalidateProviderCache。
const clientCache = new Map();

function getClient(provider, key) {
  const cached = clientCache.get(provider.id);
  if (cached && cached.key === key && cached.baseUrl === provider.baseUrl) {
    return cached.client;
  }

  const client = new OpenAI({
    apiKey: key,
    baseURL: provider.baseUrl,
    maxRetries: 0, // 重试策略由上层决定（V1 不自动重试，避免非幂等重复）
  });

  clientCache.set(provider.id, { key, baseUrl: provider.baseUrl, client });
  return client;
}

function invalidateProviderCache(providerId) {
  clientCache.delete(String(providerId || ''));
}

/**
 * 记忆提取专用 client：固定走内置 DeepSeek（extractMemory 内部硬编码
 * deepseek-chat，与改造前行为逐字节一致，不随用户切换默认模型而变）。
 * 内置不可用时退回默认服务商；都不可用返回 null（调用方跳过提取）。
 */
function getMemoryClient() {
  const builtinKey = getProviderKey(BUILTIN_PROVIDER_ID);
  if (builtinKey) {
    return getClient(findProvider(BUILTIN_PROVIDER_ID), builtinKey);
  }

  try {
    const target = resolveTarget({});
    const key = getProviderKey(target.providerId);
    return getClient(target.provider, key);
  } catch (_) {
    return null;
  }
}

// ---- 统一调用 ----

/**
 * 创建聊天补全。stream:true 时返回 SDK 的 async iterable，
 * 由调用方 for-await 消费（/chat/stream 现有循环原样复用）。
 *
 * tools / tool_choice 为 Agent 工具调用专用：**不传时请求体与改造前
 * 逐字节一致**（条件展开，绝不下发空数组或默认值）。传入时原样透传
 * 给 OpenAI 兼容服务商，响应里的 tool_calls 由调用方（agent-runtime）
 * 解析执行。
 */
async function createChatCompletion({
  providerId,
  modelId,
  messages,
  stream = false,
  temperature = 0.8,
  maxTokens = 1200,
  timeout = 90000,
  wantVision = false,
  tools,
  tool_choice,
  monitoringRound = 1,
  credentialKey = null,
  signal = null,
}) {
  const target = wantVision
    ? resolveVisionTarget({ providerId, modelId, keyOverride: credentialKey })
    : resolveTarget({ providerId, modelId, wantVision: false, keyOverride: credentialKey });

  const key = target.key;
  const startedAt = Date.now();
  const monitor = monitoring.beginModelCall({
    providerId: target.providerId,
    modelId: target.modelId,
    kind: stream ? 'stream' : 'chat',
    round: monitoringRound,
    toolsCount: Array.isArray(tools) ? tools.length : 0,
    stream,
  });

  let result;
  try {
    result = await getClient(target.provider, key).chat.completions.create(
      {
        model: target.modelId,
        temperature,
        max_tokens: maxTokens,
        messages,
        ...(stream ? { stream: true } : {}),
        ...(tools ? { tools } : {}),
        ...(tool_choice ? { tool_choice } : {}),
      },
      {
        timeout,
        ...(signal && typeof signal === 'object' ? { signal } : {}),
      }
    );
  } catch (error) {
    const normalized = normalizeSdkError(error, key);
    monitor.fail({
      status: monitoringStatusForKind(normalized.kind),
      durationMs: Date.now() - startedAt,
      errorCode: normalized.kind,
      errorCategory: 'provider',
    });
    throw normalized;
  }

  if (!stream) {
    monitor.complete({
      status: 'success',
      durationMs: Date.now() - startedAt,
      usage: result && result.usage ? result.usage : null,
    });
    return result;
  }

  return wrapMonitoredStream(result, monitor, startedAt);
}

function monitoringStatusForKind(kind) {
  if (kind === 'timeout') return 'timeout';
  if (kind === 'auth') return 'denied';
  if (kind === 'cancelled') return 'cancelled';
  return 'failed';
}

// 流式响应没有统一的 usage 承诺：能拿到就用供应商真实值，拿不到就明确标 missing。
// 迭代正常结束记 success，调用方提前 return（客户端断连）记 cancelled，
// 迭代抛错记 failed；原始错误对象原样抛回，保持上层错误语义不变。
function wrapMonitoredStream(stream, monitor, startedAt) {
  let settled = false;
  let usage = null;

  const finish = (status, errorCode = null) => {
    if (settled) return;
    settled = true;
    if (status === 'success') {
      monitor.complete({
        status,
        durationMs: Date.now() - startedAt,
        usage,
      });
    } else {
      monitor.fail({
        status,
        durationMs: Date.now() - startedAt,
        errorCode,
        errorCategory: status === 'cancelled' ? null : 'provider',
      });
    }
  };

  return new Proxy(stream, {
    get(target, property) {
      if (property === Symbol.asyncIterator) {
        return function monitoredIterator() {
          const iterator = target[Symbol.asyncIterator]();
          return {
            async next() {
              try {
                const step = await iterator.next();
                if (step.done) {
                  finish('success');
                } else if (step.value && step.value.usage) {
                  usage = step.value.usage;
                }
                return step;
              } catch (error) {
                finish('failed', error && error.code ? String(error.code) : 'stream_error');
                throw error;
              }
            },
            async return(value) {
              finish('cancelled', 'client_closed');
              if (typeof iterator.return === 'function') {
                return iterator.return(value);
              }
              return { done: true, value };
            },
            async throw(error) {
              finish('failed', 'stream_error');
              if (typeof iterator.throw === 'function') {
                return iterator.throw(error);
              }
              throw error;
            },
          };
        };
      }
      return Reflect.get(target, property);
    },
  });
}

/**
 * 目标模型是否声明支持 Tool Calling。
 * 规则（任务书）：只有"已验证"（内置 deepseek-chat，官方文档确认）或
 * "用户显式声明"（自定义服务商模型 capabilities.tools === true）两种来源
 * 返回 true；未声明/未知一律 false——绝不仅因 OpenAI 兼容接口就假定支持。
 * 目标解析失败（服务商/模型不存在）同样返回 false（安全默认）。
 */
function supportsTools(providerId, modelId, { keyOverride = null } = {}) {
  try {
    const target = resolveTarget({ providerId, modelId, keyOverride });
    return Boolean(
      target.model.capabilities && target.model.capabilities.tools === true
    );
  } catch (_) {
    return false;
  }
}

// ---- 错误归一化 ----

function normalizeSdkError(error, key) {
  if (error instanceof ModelCallError) return error;

  const status = error && typeof error.status === 'number' ? error.status : null;
  const name = error && error.name ? error.name : '';
  const rawMessage = error && error.message ? error.message : String(error);
  const message = scrub(rawMessage, key);

  // SDK 超时与连接错误的类名（openai v7）：
  // APIConnectionTimeoutError / APIConnectionError / APITimeoutError
  if (name === 'APIConnectionTimeoutError' || name === 'APITimeoutError') {
    return new ModelCallError('timeout', message);
  }
  if (name === 'APIConnectionError') {
    return new ModelCallError('connection', message);
  }
  if (error && error.code === 'ETIMEDOUT') {
    return new ModelCallError('timeout', message);
  }
  if (
    error &&
    (error.code === 'ECONNREFUSED' ||
      error.code === 'ECONNRESET' ||
      error.code === 'ENOTFOUND' ||
      error.code === 'EAI_AGAIN' ||
      error.code === 'EPIPE')
  ) {
    return new ModelCallError('connection', message);
  }

  if (status === 401 || status === 403) return new ModelCallError('auth', message);
  if (status === 429) return new ModelCallError('rate_limit', message);
  if (status === 408) return new ModelCallError('timeout', message);
  if (status === 400) return new ModelCallError('bad_request', message);
  if (status === 404) return new ModelCallError('model', message); // 多为模型 id 不存在
  if (status !== null && status >= 500) return new ModelCallError('server', message);
  if (status !== null && status >= 400) return new ModelCallError('model', message);

  return new ModelCallError('connection', message);
}

/**
 * 把任意错误转成可安全返回给客户端的结构（绝不含密钥）。
 * 流式路径中途出错也用这个——事件协议里带 { code } 即可。
 */
function classifyError(error) {
  const normalized =
    error instanceof ModelCallError ? error : normalizeSdkError(error, '');

  const detail =
    process.env.NODE_ENV === 'development' && normalized.detail
      ? String(normalized.detail).slice(0, 300)
      : undefined;

  return {
    code: normalized.kind,
    status: normalized.status,
    error: normalized.message,
    ...(detail ? { detail } : {}),
  };
}

// ---- 连接测试 ----
// 约束（任务书）：限制超时与响应体大小；不把用户 URL 当可信地址；
// 错误摘要不得含密钥。探测端点优先 GET {baseUrl}/models（OpenAI 兼容标准），
// 404 时按"可达但无 /models 端点"报告 ok:false + code:'endpoint_missing'。

const TEST_TIMEOUT_MS = 5000;
const TEST_MAX_BODY_BYTES = 64 * 1024;

async function testProviderConnection(providerId, { keyOverride = null } = {}) {
  const started = Date.now();

  let provider;
  try {
    provider = findProvider(String(providerId || ''));
    if (!provider) throw new ModelCallError('not_configured', '服务商不存在');

    // 内置服务商 URL 是硬编码可信常量，跳过 SSRF 解析（省一次 DNS）；
    // 自定义服务商必须先过 SSRF 校验，再发探测请求。
    if (provider.id !== BUILTIN_PROVIDER_ID) {
      await assertPublicUrl(provider.baseUrl);
    }
  } catch (error) {
    const info = classifyError(error);
    return { ok: false, ...info, latencyMs: Date.now() - started };
  }

  const key = keyOverride || getProviderKey(provider.id);
  if (!key) {
    const info = classifyError(new ModelCallError('not_configured', '未配置 API Key'));
    return { ok: false, ...info, latencyMs: Date.now() - started };
  }

  const base = provider.baseUrl.replace(/\/+$/, '');
  let target;
  try {
    target = new URL(`${base}/models`);
  } catch (_) {
    const info = classifyError(
      new ModelCallError('bad_request', `baseUrl 不是合法 URL：${provider.baseUrl}`)
    );
    return { ok: false, ...info, latencyMs: Date.now() - started };
  }

  return new Promise(resolve => {
    const transport = target.protocol === 'https:' ? https : http;
    let settled = false;

    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ latencyMs: Date.now() - started, ...result });
    };

    const timer = setTimeout(() => {
      req.destroy();
      finish({ ok: false, code: 'timeout', error: '连接测试超时' });
    }, TEST_TIMEOUT_MS);

    const req = transport.request(
      target,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: 'application/json',
        },
      },
      res => {
        let size = 0;
        res.on('data', chunk => {
          size += chunk.length;
          if (size > TEST_MAX_BODY_BYTES) {
            req.destroy();
            finish({
              ok: false,
              code: 'response_too_large',
              error: `响应体超过 ${TEST_MAX_BODY_BYTES} 字节上限`,
              httpStatus: res.statusCode,
            });
          }
        });

        res.on('end', () => {
          const status = res.statusCode || 0;
          if (status >= 200 && status < 300) {
            finish({ ok: true, code: 'ok', error: '连接成功', httpStatus: status });
          } else if (status === 401 || status === 403) {
            finish({
              ok: false,
              code: 'auth',
              error: 'API Key 被拒绝',
              httpStatus: status,
            });
          } else if (status === 429) {
            finish({ ok: false, code: 'rate_limit', error: '被限流', httpStatus: status });
          } else if (status === 404) {
            finish({
              ok: false,
              code: 'endpoint_missing',
              error: '服务商可达，但不支持 GET /models（可改用聊天补全探测）',
              httpStatus: status,
            });
          } else if (status >= 500) {
            finish({
              ok: false,
              code: 'server',
              error: '服务商内部错误',
              httpStatus: status,
            });
          } else {
            finish({
              ok: false,
              code: 'model',
              error: `服务商返回 ${status}`,
              httpStatus: status,
            });
          }
        });

        res.on('error', () => {
          finish({ ok: false, code: 'connection', error: '读取响应失败' });
        });
      }
    );

    req.on('error', err => {
      const code =
        err.code === 'ETIMEDOUT' || err.code === 'ECONNABORTED'
          ? 'timeout'
          : 'connection';
      finish({ ok: false, code, error: '无法连接服务商' });
    });

    req.end();
  });
}

module.exports = {
  ModelCallError,
  ERROR_STATUS,
  assertPublicUrl,
  isPrivateAddress,
  resolveTarget,
  resolveVisionTarget,
  createChatCompletion,
  supportsTools,
  classifyError,
  testProviderConnection,
  invalidateProviderCache,
  getMemoryClient,
};

// 启动警告：测试旁路一旦带进生产，自定义 Base URL 就能打内网。
if (process.env.BLUEBIRD_ALLOW_PRIVATE_BASE_URL === '1') {
  console.warn(
    '[model-adapter] ⚠️ BLUEBIRD_ALLOW_PRIVATE_BASE_URL=1 已启用：自定义 Base URL 的内网拦截被跳过。此设置仅供测试，生产环境必须删除。'
  );
}
