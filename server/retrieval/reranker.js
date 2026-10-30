/**
 * 云岫 Bluebird — 可选神经 Reranker（retrieval/reranker.js）
 *
 * 使用 Cohere/Jina 兼容的 POST /rerank 协议对混合召回候选做 cross-encoder
 * 重排。未配置时 available=false，引擎继续使用本地确定性 reranker；
 * 配置后如果调用失败也回退到确定性 reranker，不把失败伪装成神经重排。
 * 密钥只从配置读取，绝不写日志、trace 或索引文件。
 */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const KNOWN_PROVIDERS = new Set(['cohere-compatible', 'jina', 'http']);

function endpointFor(baseUrl) {
  const clean = String(baseUrl || '').replace(/\/+$/, '');
  if (!clean) return '';
  return clean.endsWith('/rerank') ? clean : `${clean}/rerank`;
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
  if (url.protocol === 'http:' && isLocalHost(url.hostname)) return { ok: true, url };
  return { ok: false, reason: 'insecure_base_url' };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createRerankerProvider(cfg) {
  const config = cfg || {};
  const provider = String(config.provider || '');
  const model = String(config.model || '');
  const version = String(config.version || 'v1');
  const topN = Number.isInteger(config.topN) ? config.topN : 20;
  const timeoutMs = Number.isInteger(config.timeoutMs) ? config.timeoutMs : 8000;
  let available = KNOWN_PROVIDERS.has(provider);
  let reason = available ? null : provider ? 'unknown_provider' : 'not_configured';
  let endpoint = '';
  let requests = 0;
  let documents = 0;
  let lastLatencyMs = null;

  if (available) {
    if (!model) {
      available = false;
      reason = 'model_not_configured';
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

  async function request(query, docs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;

    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          query,
          documents: docs,
          top_n: Math.min(topN, docs.length),
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      return { ok: false, status: response.status, errorCode: 'reranker_http_error' };
    }

    const raw = await response.text();
    if (raw.length > MAX_RESPONSE_BYTES) {
      return { ok: false, errorCode: 'reranker_response_too_large' };
    }

    let json;
    try {
      json = JSON.parse(raw);
    } catch (_) {
      return { ok: false, errorCode: 'reranker_invalid_json' };
    }

    const results = Array.isArray(json && json.results) ? json.results : null;
    if (!results) return { ok: false, errorCode: 'reranker_invalid_shape' };

    const scores = [];
    for (const item of results) {
      if (!item || !Number.isInteger(item.index)) continue;
      if (item.index < 0 || item.index >= docs.length) continue;
      const score = Number(item.relevance_score);
      if (!Number.isFinite(score)) continue;
      scores.push({ index: item.index, score });
    }

    if (!scores.length) {
      return { ok: false, errorCode: 'reranker_empty_result' };
    }

    requests += 1;
    documents += docs.length;

    return {
      ok: true,
      scores,
      usage: json.meta && typeof json.meta === 'object' ? json.meta : null,
      model,
      version,
    };
  }

  async function requestWithRetry(query, docs, attempts = 2) {
    let last = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const result = await request(query, docs);
        if (result.ok) return result;
        last = result;
        if (result.status && result.status >= 400 && result.status < 500) break;
      } catch (error) {
        last = {
          ok: false,
          errorCode:
            error && error.name === 'AbortError'
              ? 'reranker_timeout'
              : 'reranker_network_error',
        };
      }
      if (attempt + 1 < attempts) await sleep(150);
    }
    return last || { ok: false, errorCode: 'reranker_failed' };
  }

  async function rerank({ query, documents: docs } = {}) {
    if (!available) {
      return { ok: false, errorCode: reason || 'reranker_unavailable' };
    }

    const cleanQuery = typeof query === 'string' ? query.trim() : '';
    const inputs = (Array.isArray(docs) ? docs : [])
      .map(document => String(document || '').trim())
      .filter(Boolean)
      .slice(0, 64);

    if (!cleanQuery || inputs.length < 2) {
      return { ok: true, scores: [], skipped: true, reason: 'not_enough_candidates' };
    }

    const startedAt = Date.now();
    const result = await requestWithRetry(cleanQuery, inputs);
    lastLatencyMs = Date.now() - startedAt;

    if (!result.ok) return result;

    return {
      ok: true,
      scores: result.scores,
      usage: result.usage,
      model: result.model,
      version: result.version,
      latencyMs: lastLatencyMs,
    };
  }

  return {
    id: provider || 'none',
    model,
    version,
    topN,
    get available() {
      return available;
    },
    get reason() {
      return reason;
    },
    endpoint: endpoint ? endpoint.replace(/[?#].*$/, '') : null,
    rerank,
    stats() {
      return {
        provider: provider || 'none',
        model,
        version,
        topN,
        available,
        reason,
        requests,
        documents,
        lastLatencyMs,
      };
    },
  };
}

module.exports = {
  createRerankerProvider,
  validateBaseUrl,
  endpointFor,
};
