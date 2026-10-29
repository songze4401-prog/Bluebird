/**
 * 云岫 Bluebird — EmbeddingProvider（retrieval/embedding.js）
 *
 * 明确的可替换接口：embedQuery(text) / embedDocuments(texts)，返回模型名、
 * 版本、维度与用量/耗时。默认未配置时 available=false，检索降级到
 * 词法/精确通道，不把“没有向量”伪装成向量检索成功。
 *
 * 支持 OpenAI-compatible /v1/embeddings 端点；本地服务允许 http，
 * 远端必须 https。密钥只从配置读取，绝不写日志、trace 或索引文件。
 */
const { normalizeContent } = require('./contract');

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

function endpointFor(baseUrl) {
  const clean = String(baseUrl || '').replace(/\/+$/, '');
  if (!clean) return '';
  return clean.endsWith('/embeddings') ? clean : `${clean}/embeddings`;
}

function isLocalHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

function validateBaseUrl(baseUrl) {
  let url;
  try {
    url = new URL(endpointFor(baseUrl));
  } catch (_) {
    return { ok: false, reason: 'invalid_base_url' };
  }
  if (url.username || url.password) return { ok: false, reason: 'credentials_in_url' };
  if (url.protocol === 'https:') return { ok: true, url };
  if (url.protocol === 'http:' && isLocalHost(url.hostname)) {
    return { ok: true, url };
  }
  return { ok: false, reason: 'insecure_base_url' };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 已知供应商：openai-compatible 是通用入口，其余是在 config.js 里
// 解析成 baseUrl/model/dimension 的预设；未知 provider 直接判不可用，
// 避免拼错名字后静默降级却看不出来。
const KNOWN_PROVIDERS = new Set([
  'openai-compatible',
  'dashscope',
  'siliconflow',
  'openai',
]);

function createEmbeddingProvider(cfg) {
  const config = cfg || {};
  const provider = String(config.provider || '');
  const model = String(config.model || '');
  const version = String(config.version || 'v1');
  const dimension = Number.isInteger(config.dimension) ? config.dimension : 0;
  const cacheMax = Number.isInteger(config.cacheMax) ? config.cacheMax : 0;
  const cache = new Map();
  let cacheHits = 0;
  let cacheMisses = 0;

  let available = KNOWN_PROVIDERS.has(provider);
  let reason = available ? null : provider ? 'unknown_provider' : 'not_configured';
  let endpoint = '';

  // 用量与成本估算：只统计真实发出的请求，估算值明确标注为 estimated
  let requests = 0;
  let textsSent = 0;
  let tokensReported = 0;
  let estimatedTokens = 0;

  if (available) {
    if (!model) {
      available = false;
      reason = 'model_not_configured';
    } else if (!(dimension > 0 && dimension <= 4096)) {
      available = false;
      reason = 'dimension_not_configured';
    } else {
      const checked = validateBaseUrl(config.baseUrl);
      if (!checked.ok) {
        available = false;
        reason = checked.reason;
      } else {
        endpoint = checked.url.toString();
      }
    }
  }

  function cacheKey(text) {
    return `${model}\u0000${version}\u0000${dimension}\u0000${text}`;
  }

  function getCached(text) {
    const key = cacheKey(text);
    if (!cache.has(key)) {
      cacheMisses += 1;
      return null;
    }
    const value = cache.get(key);
    cache.delete(key);
    cache.set(key, value);
    cacheHits += 1;
    return value;
  }

  function setCached(text, vector) {
    if (!cacheMax) return;
    const key = cacheKey(text);
    if (cache.has(key)) cache.delete(key);
    cache.set(key, vector);
    while (cache.size > cacheMax) {
      const oldest = cache.keys().next().value;
      cache.delete(oldest);
    }
  }

  async function requestBatch(texts) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    let response;

    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify({ model, input: texts }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      return { ok: false, status: response.status, errorCode: 'embedding_http_error' };
    }

    const raw = await response.text();
    if (raw.length > MAX_RESPONSE_BYTES) {
      return { ok: false, errorCode: 'embedding_response_too_large' };
    }

    let json;
    try {
      json = JSON.parse(raw);
    } catch (_) {
      return { ok: false, errorCode: 'embedding_invalid_json' };
    }

    const data = Array.isArray(json && json.data) ? json.data : null;
    if (!data || data.length !== texts.length) {
      return { ok: false, errorCode: 'embedding_invalid_shape' };
    }

    const vectors = new Array(texts.length);
    for (let index = 0; index < data.length; index += 1) {
      const entry = data[index];
      const vector = entry && Array.isArray(entry.embedding) ? entry.embedding : null;
      if (!vector || vector.length !== dimension) {
        return { ok: false, errorCode: 'embedding_dimension_mismatch' };
      }
      if (!vector.every(value => typeof value === 'number' && Number.isFinite(value))) {
        return { ok: false, errorCode: 'embedding_non_finite' };
      }
      vectors[index] = vector;
    }

    requests += 1;
    textsSent += texts.length;
    const usageTokens =
      json && json.usage && Number.isFinite(json.usage.total_tokens)
        ? json.usage.total_tokens
        : 0;
    if (usageTokens) tokensReported += usageTokens;
    // 供应商没回 usage 时用「字符数/4」做保守估算，只用于成本展示
    estimatedTokens += texts.reduce(
      (sum, text) => sum + Math.ceil(String(text).length / 4),
      0
    );

    return {
      ok: true,
      vectors,
      usage: json && json.usage && typeof json.usage === 'object' ? json.usage : null,
    };
  }

  async function requestBatchWithRetry(texts, attempts = 2) {
    let last = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const result = await requestBatch(texts);
        if (result.ok) return result;
        last = result;
        if (result.status && result.status >= 400 && result.status < 500) break;
      } catch (error) {
        last = {
          ok: false,
          errorCode:
            error && error.name === 'AbortError'
              ? 'embedding_timeout'
              : 'embedding_network_error',
        };
      }
      if (attempt + 1 < attempts) await sleep(150);
    }
    return last || { ok: false, errorCode: 'embedding_failed' };
  }

  async function embedDocuments(texts) {
    if (!available) {
      return { ok: false, errorCode: reason || 'embedding_unavailable' };
    }

    const inputs = (Array.isArray(texts) ? texts : []).map(value =>
      truncateInput(normalizeContent(value))
    );
    if (!inputs.length) return { ok: true, vectors: [], usage: null };

    const vectors = new Array(inputs.length);
    const pending = [];
    let usage = { prompt_tokens: 0, total_tokens: 0 };

    for (let index = 0; index < inputs.length; index += 1) {
      const cached = getCached(inputs[index]);
      if (cached) {
        vectors[index] = cached;
      } else {
        pending.push(index);
      }
    }

    const batchSize = Math.max(1, config.batchSize || 16);
    for (let start = 0; start < pending.length; start += batchSize) {
      const batchIndexes = pending.slice(start, start + batchSize);
      const batchTexts = batchIndexes.map(index => inputs[index]);
      const result = await requestBatchWithRetry(batchTexts);
      if (!result.ok) return result;
      for (let i = 0; i < batchIndexes.length; i += 1) {
        const index = batchIndexes[i];
        vectors[index] = result.vectors[i];
        setCached(inputs[index], result.vectors[i]);
      }
      if (result.usage && Number.isFinite(result.usage.total_tokens)) {
        usage = {
          prompt_tokens: usage.prompt_tokens + (result.usage.prompt_tokens || 0),
          total_tokens: usage.total_tokens + result.usage.total_tokens,
        };
      }
    }

    return {
      ok: true,
      vectors,
      usage: usage.total_tokens ? usage : null,
    };
  }

  async function embedQuery(text) {
    const result = await embedDocuments([text]);
    if (!result.ok) return result;
    return { ok: true, vector: result.vectors[0], usage: result.usage };
  }

  return {
    id: provider || 'none',
    model,
    version,
    dimension,
    get available() {
      return available;
    },
    get reason() {
      return reason;
    },
    endpoint: endpoint ? endpoint.replace(/[?#].*$/, '') : null,
    embedDocuments,
    embedQuery,
    stats() {
      return {
        provider: provider || 'none',
        model,
        version,
        dimension,
        available,
        reason,
        cacheHits,
        cacheMisses,
        cacheSize: cache.size,
        requests,
        texts: textsSent,
        tokensReported,
        estimatedTokens,
        pricePerMillionTokens: config.pricePerMillionTokens || 0,
        estimatedCostUsd: Number(
          (
            ((tokensReported || estimatedTokens) / 1000000) *
            (config.pricePerMillionTokens || 0)
          ).toFixed(6)
        ),
      };
    },
    resetCache() {
      cache.clear();
    },
  };
}

function truncateInput(text) {
  const max = 8000;
  return text.length <= max ? text : text.slice(0, max);
}

module.exports = {
  createEmbeddingProvider,
  validateBaseUrl,
  endpointFor,
};
