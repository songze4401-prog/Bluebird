/* global Buffer */
/**
 * 云岫 Bluebird — 检索入口安全（retrieval/security.js）
 *
 * 文件入口：只允许配置的根目录内真实路径，拒绝符号链接逃逸；
 * 网页入口：只允许 http(s)，拒绝环回/私网/链路本地/云元数据地址。
 *
 * DNS rebinding：先解析并对全部地址做私网校验，再把“已校验地址”通过
 * lookup 回调固定给本次连接；连接阶段不再重新解析 DNS，消除了
 * “校验一个地址、连接另一个地址”的 TOCTOU 窗口。重定向每一跳重新解析、
 * 重新校验、重新固定。TLS 使用原 hostname 做 SNI 与证书校验。
 *
 * 已知边界：
 * - 仍只取首个通过校验的地址；多地址故障切换未实现；
 * - 不处理 HTTP 代理（与当前 Node fetch 默认行为一致）；
 * - 重定向链过长、压缩炸弹、超大响应均有显式上限。
 */
const dns = require('dns').promises;
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const path = require('path');
const zlib = require('zlib');

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'metadata.aws.internal',
]);

const ALWAYS_BLOCKED = new Set(['metadata.google.internal', 'metadata.aws.internal']);

function normalizeHostname(value) {
  const host = String(value || '').toLowerCase();
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function ipv4Parts(address) {
  return address.split('.').map(part => Number(part));
}

function isPrivateIpv4(address) {
  const parts = ipv4Parts(address);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part))) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIpv6(address) {
  const value = String(address || '').toLowerCase();
  if (value === '::1' || value === '::') return true;
  if (value.startsWith('fc') || value.startsWith('fd')) return true;
  if (value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb')) {
    return true;
  }
  if (value.startsWith('ff')) return true;
  const mapped = value.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIpv4(mapped[1]);
  const mappedHex = value.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const high = Number.parseInt(mappedHex[1], 16);
    const low = Number.parseInt(mappedHex[2], 16);
    return isPrivateIpv4(
      `${(high >> 8) & 255}.${high & 255}.${(low >> 8) & 255}.${low & 255}`
    );
  }
  return false;
}

function isPrivateAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  return true;
}

/**
 * 解析 URL 并返回已校验的地址列表；调用方必须把 addresses 固定给连接。
 * allowPrivate 只用于本地 fixture，生产默认 false。
 */
async function resolveTarget(raw, { allowPrivate = false } = {}) {
  let url;
  try {
    url = new URL(String(raw || ''));
  } catch (_) {
    return { ok: false, error: 'invalid_url' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'unsupported_protocol' };
  }
  if (url.username || url.password) {
    return { ok: false, error: 'credentials_in_url' };
  }

  const hostname = normalizeHostname(url.hostname);
  if (ALWAYS_BLOCKED.has(hostname)) {
    return { ok: false, error: 'blocked_host' };
  }
  if (BLOCKED_HOSTNAMES.has(hostname) && !allowPrivate) {
    return { ok: false, error: 'blocked_host' };
  }

  const literalFamily = net.isIP(hostname);
  if (literalFamily) {
    if (!allowPrivate && isPrivateAddress(hostname)) {
      return { ok: false, error: 'private_address' };
    }
    return {
      ok: true,
      url,
      addresses: [{ address: hostname, family: literalFamily }],
    };
  }

  let resolved;
  try {
    resolved = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch (_) {
    return { ok: false, error: 'dns_lookup_failed' };
  }
  if (!resolved.length) return { ok: false, error: 'dns_no_address' };

  const addresses = resolved
    .filter(item => item && net.isIP(item.address))
    .map(item => ({ address: item.address, family: item.family || net.isIP(item.address) }));
  if (!addresses.length) return { ok: false, error: 'dns_no_address' };
  if (!allowPrivate && addresses.some(item => isPrivateAddress(item.address))) {
    return { ok: false, error: 'private_address' };
  }

  // IPv4 优先，减少“只有 AAAA 记录”的环境连接失败；不改变安全校验。
  addresses.sort((a, b) => (a.family === 4 ? -1 : 1) - (b.family === 4 ? -1 : 1));
  return { ok: true, url, addresses };
}

async function assertPublicHttpUrl(raw, { allowPrivate = false } = {}) {
  const target = await resolveTarget(raw, { allowPrivate });
  return target.ok
    ? { ok: true, url: target.url, addresses: target.addresses }
    : target;
}

/**
 * 把已校验地址固定给 http(s).request 的 lookup 回调。
 * 连接阶段不会再发 DNS 查询，DNS rebinding 无法把连接换成另一个地址。
 */
function createPinnedLookup(addresses) {
  const list = (Array.isArray(addresses) ? addresses : []).filter(
    item => item && item.address
  );
  return (hostname, options, callback) => {
    const family = options && options.family;
    const candidates = family ? list.filter(item => item.family === family) : list;
    const chosen = candidates[0] || list[0];
    if (!chosen) {
      const error = new Error('no_validated_address');
      error.code = 'ENOTFOUND';
      callback(error);
      return;
    }
    if (options && options.all) {
      callback(null, [chosen]);
      return;
    }
    callback(null, chosen.address, chosen.family);
  };
}

const ALLOWED_CONTENT_TYPES = [
  'text/html',
  'application/xhtml+xml',
  'text/plain',
  'text/markdown',
  'application/json',
  'application/xml',
  'text/xml',
];

function contentTypeAllowed(value) {
  const type = String(value || '').split(';')[0].trim().toLowerCase();
  return !type || ALLOWED_CONTENT_TYPES.includes(type);
}

function decodeBody(buffer, contentEncoding, maxBytes) {
  const encoding = String(contentEncoding || '').trim().toLowerCase();
  if (!encoding || encoding === 'identity') return { ok: true, buffer };

  const options = { maxOutputLength: maxBytes };
  try {
    if (encoding === 'gzip' || encoding === 'x-gzip') {
      return { ok: true, buffer: zlib.gunzipSync(buffer, options) };
    }
    if (encoding === 'deflate') {
      return { ok: true, buffer: zlib.inflateSync(buffer, options) };
    }
    if (encoding === 'br') {
      return { ok: true, buffer: zlib.brotliDecompressSync(buffer, options) };
    }
  } catch (_) {
    return { ok: false, error: 'response_decode_failed' };
  }
  return { ok: false, error: 'unsupported_content_encoding' };
}

function requestOnce(url, addresses, { maxBytes, timeoutMs }) {
  return new Promise(resolve => {
    let settled = false;
    let timer = null;

    const finish = value => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };

    const isHttps = url.protocol === 'https:';
    const hostname = normalizeHostname(url.hostname);
    const options = {
      method: 'GET',
      hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      headers: {
        Accept: 'text/html,text/plain,text/markdown,application/json;q=0.9,*/*;q=0.1',
        'Accept-Encoding': 'identity',
        'User-Agent': 'Bluebird-Retrieval/1.0',
        Host: url.host,
      },
      lookup: createPinnedLookup(addresses),
    };
    if (isHttps) {
      options.rejectUnauthorized = true;
      if (!net.isIP(hostname)) options.servername = hostname;
    }

    const transport = isHttps ? https : http;
    let request;
    try {
      request = transport.request(options, response => {
        const status = response.statusCode || 0;
        const headers = response.headers || {};

        if ([301, 302, 303, 307, 308].includes(status)) {
          response.resume();
          finish({
            ok: false,
            error: 'redirect',
            status,
            location: headers.location || null,
          });
          return;
        }
        if (status < 200 || status >= 300) {
          response.resume();
          finish({ ok: false, error: 'http_error', status });
          return;
        }
        if (!contentTypeAllowed(headers['content-type'])) {
          response.resume();
          finish({ ok: false, error: 'unsupported_content_type' });
          return;
        }

        const declared = Number(headers['content-length']);
        if (Number.isFinite(declared) && declared > maxBytes) {
          response.resume();
          finish({ ok: false, error: 'response_too_large' });
          return;
        }

        const parts = [];
        let total = 0;
        response.on('data', chunk => {
          if (settled) return;
          total += chunk.length;
          if (total > maxBytes) {
            response.destroy();
            finish({ ok: false, error: 'response_too_large' });
            return;
          }
          parts.push(chunk);
        });
        response.on('end', () => {
          if (settled) return;
          const decoded = decodeBody(
            Buffer.concat(parts),
            headers['content-encoding'],
            maxBytes
          );
          if (!decoded.ok) {
            finish(decoded);
            return;
          }
          if (decoded.buffer.length > maxBytes) {
            finish({ ok: false, error: 'response_too_large' });
            return;
          }
          finish({
            ok: true,
            status,
            contentType: headers['content-type'] || '',
            buffer: decoded.buffer,
          });
        });
        response.on('error', () => finish({ ok: false, error: 'fetch_failed' }));
      });
    } catch (_) {
      finish({ ok: false, error: 'fetch_failed' });
      return;
    }

    timer = setTimeout(() => {
      finish({ ok: false, error: 'fetch_timeout' });
      request.destroy();
    }, Math.max(100, timeoutMs));
    request.on('error', () => finish({ ok: false, error: 'fetch_failed' }));
    request.end();
  });
}

async function fetchTextLimited(
  rawUrl,
  {
    maxBytes = 2 * 1024 * 1024,
    timeoutMs = 10000,
    allowPrivate = false,
    maxRedirects = 3,
  } = {}
) {
  let current = String(rawUrl || '');
  let redirects = 0;

  for (;;) {
    const target = await resolveTarget(current, { allowPrivate });
    if (!target.ok) return target;

    const result = await requestOnce(target.url, target.addresses, {
      maxBytes,
      timeoutMs,
    });

    if (!result.ok && result.error === 'redirect') {
      if (!result.location) return { ok: false, error: 'redirect_without_location' };
      redirects += 1;
      if (redirects > maxRedirects) return { ok: false, error: 'too_many_redirects' };
      try {
        current = new URL(result.location, target.url).toString();
      } catch (_) {
        return { ok: false, error: 'invalid_redirect' };
      }
      continue;
    }

    if (!result.ok) {
      return result.status
        ? { ok: false, error: result.error, status: result.status }
        : { ok: false, error: result.error };
    }
    if (result.buffer.includes(0)) return { ok: false, error: 'binary_content' };

    return {
      ok: true,
      url: target.url.toString(),
      contentType: result.contentType,
      text: result.buffer.toString('utf8'),
      bytes: result.buffer.length,
    };
  }
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function resolveWithinRoots(rawPath, roots) {
  const list = Array.isArray(roots) ? roots : [];
  if (!list.length) return { ok: false, error: 'roots_not_configured' };
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    return { ok: false, error: 'path_required' };
  }

  const raw = rawPath.trim();
  const candidates = path.isAbsolute(raw)
    ? [path.resolve(raw)]
    : list.map(root => path.resolve(root, raw));

  for (const input of candidates) {
    for (const root of list) {
      if (!isInside(root, input)) continue;
      let realRoot;
      let realPath;
      try {
        realRoot = fs.realpathSync(root);
        realPath = fs.realpathSync(input);
      } catch (_) {
        continue;
      }
      if (!isInside(realRoot, realPath)) continue;
      return { ok: true, root: realRoot, path: realPath };
    }
  }
  return { ok: false, error: 'path_outside_allowed_roots' };
}

function readTextFileLimited(file, maxBytes) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) return { ok: false, error: 'not_a_file' };
  if (stat.size > maxBytes) return { ok: false, error: 'file_too_large' };
  const buffer = fs.readFileSync(file);
  if (buffer.includes(0)) return { ok: false, error: 'binary_file' };
  return { ok: true, text: buffer.toString('utf8'), size: stat.size };
}

function relativeDisplayPath(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

module.exports = {
  isPrivateAddress,
  resolveTarget,
  assertPublicHttpUrl,
  createPinnedLookup,
  fetchTextLimited,
  resolveWithinRoots,
  readTextFileLimited,
  relativeDisplayPath,
  isInside,
};
