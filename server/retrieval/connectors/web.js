/* global Buffer */
/**
 * 云岫 Bluebird — 网页连接器（retrieval/connectors/web.js）
 *
 * 抓取后保存正文快照与抓取时间；HTML 只做确定性去标签，不执行脚本。
 * 来源是“可能过时的网页”，证据包会单独标注 freshness，不把它当永久事实。
 */
const fs = require('fs');
const path = require('path');
const { writeFileAtomicSync } = require('../../atomic-write');
const {
  createChunk,
  contentHashOf,
  sourceIdFor,
} = require('../contract');
const { fetchTextLimited } = require('../security');
const {
  splitPlainText,
  detectLanguage,
  exactTerms,
  htmlToText,
  extractHtmlTitle,
} = require('../text');

const SECRET_QUERY_RE = /(token|key|secret|auth|signature|sig|password|session)/i;

function normalizeUrl(raw) {
  const url = new URL(String(raw || ''));
  url.hash = '';
  return url;
}

function displayUrl(url) {
  const copy = new URL(url.toString());
  for (const key of [...copy.searchParams.keys()]) {
    if (SECRET_QUERY_RE.test(key)) copy.searchParams.set(key, '[redacted]');
  }
  return copy.toString();
}

function snapshotBytes(dir) {
  let total = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      try {
        total += fs.statSync(path.join(dir, name)).size;
      } catch (_) {
        // ignore
      }
    }
  } catch (_) {
    return 0;
  }
  return total;
}

async function ingestWeb({
  url,
  title,
  snapshotsDir,
  maxBytes,
  maxSnapshotBytes,
  maxChunkChars,
  timeoutMs,
  allowPrivate,
}) {
  let parsed;
  try {
    parsed = normalizeUrl(url);
  } catch (_) {
    return { ok: false, error: 'invalid_url' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'unsupported_protocol' };
  }

  const fetched = await fetchTextLimited(parsed.toString(), {
    maxBytes,
    timeoutMs,
    allowPrivate,
  });
  if (!fetched.ok) return fetched;

  const contentType = fetched.contentType.toLowerCase();
  const isHtml =
    contentType.includes('text/html') || contentType.includes('application/xhtml');
  const body = isHtml ? htmlToText(fetched.text) : fetched.text.trim();
  if (!body) return { ok: false, error: 'empty_content' };

  const fetchedAt = new Date().toISOString();
  const pageTitle =
    title ||
    (isHtml ? extractHtmlTitle(fetched.text) : '') ||
    parsed.hostname;
  const sourceId = sourceIdFor('web', fetched.url);
  const hash = contentHashOf(body);
  const display = displayUrl(new URL(fetched.url));
  const parts = splitPlainText(body, maxChunkChars);
  if (!parts.length) return { ok: false, error: 'empty_content' };

  fs.mkdirSync(snapshotsDir, { recursive: true });
  const snapshotName = `web-${sourceId.slice(4)}.txt`;
  const snapshotPath = path.join(snapshotsDir, snapshotName);
  const snapshotBody = [
    `Title: ${pageTitle}`,
    `URL: ${display}`,
    `FetchedAt: ${fetchedAt}`,
    `ContentHash: ${hash}`,
    '',
    body,
  ].join('\n');

  const existing = snapshotBytes(snapshotsDir);
  const existingSize = fs.existsSync(snapshotPath) ? fs.statSync(snapshotPath).size : 0;
  if (existing - existingSize + Buffer.byteLength(snapshotBody) > maxSnapshotBytes) {
    return { ok: false, error: 'snapshot_storage_limit' };
  }
  writeFileAtomicSync(snapshotPath, snapshotBody);

  const chunks = parts.map((part, index) =>
    createChunk({
      sourceType: 'web',
      sourceId,
      content: part,
      title: pageTitle,
      uri: display,
      locator: `web/${sourceId.slice(4)}${parts.length > 1 ? `#p${index + 1}` : ''}`,
      language: detectLanguage(part),
      mimeType: isHtml ? 'text/html' : contentType || 'text/plain',
      createdAt: fetchedAt,
      updatedAt: fetchedAt,
      validFrom: fetchedAt,
      sourceVersion: hash.slice(0, 32),
      scope: { visibility: 'global' },
      metadata: {
        canonicalUrl: display,
        fetchedAt,
        contentHash: hash,
        snapshotFile: snapshotName,
        exactTerms: exactTerms(part, 20),
      },
    })
  );

  return {
    ok: true,
    source: {
      id: sourceId,
      type: 'web',
      title: pageTitle,
      uri: display,
      state: 'indexed',
      sourceVersion: hash.slice(0, 32),
      contentHash: hash,
      createdAt: fetchedAt,
      updatedAt: fetchedAt,
      metadata: {
        canonicalUrl: display,
        fetchedAt,
        contentType,
        bytes: fetched.bytes,
        snapshotFile: snapshotName,
        chunkCount: chunks.length,
      },
    },
    chunks,
  };
}

module.exports = {
  ingestWeb,
  normalizeUrl,
  displayUrl,
  snapshotBytes,
};
