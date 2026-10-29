/**
 * 云岫 Bluebird — 文档连接器（retrieval/connectors/document.js）
 *
 * 支持 Markdown / 纯文本；PDF、DOCX 需要额外解析运行时，本版明确返回
 * unsupported_format，不伪造解析成功。按标题层级与段落边界切片，保留
 * 相对路径、标题路径、行号与内容哈希。
 */
const fs = require('fs');
const path = require('path');
const {
  createChunk,
  contentHashOf,
  sha256,
  sourceIdFor,
} = require('../contract');
const {
  resolveWithinRoots,
  readTextFileLimited,
  relativeDisplayPath,
} = require('../security');
const { splitPlainText, detectLanguage, exactTerms } = require('../text');

const SUPPORTED_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.text']);
const UNSUPPORTED_EXTENSIONS = new Set(['.pdf', '.doc', '.docx', '.rtf', '.odt']);

function parseSections(text) {
  const lines = text.split(/\r?\n/);
  const sections = [];
  const stack = [];
  let current = { headings: [], lines: [], startLine: 1 };
  let sawHeading = false;

  const flush = endLine => {
    const body = current.lines.join('\n').trim();
    if (body) {
      sections.push({
        headings: current.headings,
        text: body,
        startLine: current.startLine,
        endLine,
      });
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (match) {
      sawHeading = true;
      flush(index);
      const level = match[1].length;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, text: match[2].trim() });
      current = {
        headings: stack.map(item => item.text),
        lines: [],
        startLine: index + 1,
      };
      continue;
    }
    current.lines.push(line);
  }
  flush(lines.length);

  if (!sawHeading && !sections.length) {
    return [{ headings: [], text: text.trim(), startLine: 1, endLine: lines.length }];
  }
  return sections;
}

async function ingestDocument({ inputPath, title, roots, maxFileBytes, maxChunkChars }) {
  const resolved = resolveWithinRoots(inputPath, roots);
  if (!resolved.ok) return resolved;

  const ext = path.extname(resolved.path).toLowerCase();
  if (UNSUPPORTED_EXTENSIONS.has(ext)) {
    return { ok: false, error: 'unsupported_format', format: ext.slice(1) };
  }
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    return { ok: false, error: 'unsupported_format', format: ext.replace('.', '') || 'unknown' };
  }

  const loaded = readTextFileLimited(resolved.path, maxFileBytes);
  if (!loaded.ok) return loaded;
  if (!loaded.text.trim()) return { ok: false, error: 'empty_document' };

  const relativePath = relativeDisplayPath(resolved.root, resolved.path);
  const sourceId = sourceIdFor('document', resolved.path);
  const stat = fs.statSync(resolved.path);
  const hash = contentHashOf(loaded.text);
  const sections = parseSections(loaded.text);
  const chunks = [];
  const fileName = path.basename(resolved.path);

  for (const section of sections) {
    const parts = splitPlainText(section.text, maxChunkChars);
    for (let index = 0; index < parts.length; index += 1) {
      const headings = section.headings;
      const heading = headings.length ? headings.join(' > ') : '';
      const locator = `${relativePath}#L${section.startLine}-L${section.endLine}${
        parts.length > 1 ? `#p${index + 1}` : ''
      }`;
      chunks.push(
        createChunk({
          sourceType: 'document',
          sourceId,
          content: parts[index],
          title: title || heading || fileName,
          uri: `document://${sourceId}`,
          locator,
          language: detectLanguage(parts[index]),
          mimeType: ext === '.md' || ext === '.markdown' ? 'text/markdown' : 'text/plain',
          createdAt: stat.birthtime.toISOString(),
          updatedAt: stat.mtime.toISOString(),
          validFrom: stat.mtime.toISOString(),
          sourceVersion: hash.slice(0, 32),
          scope: { visibility: 'global' },
          metadata: {
            relativePath,
            heading,
            lineStart: section.startLine,
            lineEnd: section.endLine,
            rootLabel: path.basename(resolved.root),
            exactTerms: exactTerms(parts[index], 24),
          },
        })
      );
    }
  }

  if (!chunks.length) return { ok: false, error: 'empty_document' };

  return {
    ok: true,
    source: {
      id: sourceId,
      type: 'document',
      title: title || fileName,
      uri: `document://${sourceId}`,
      state: 'indexed',
      sourceVersion: hash.slice(0, 32),
      contentHash: hash,
      createdAt: stat.birthtime.toISOString(),
      updatedAt: stat.mtime.toISOString(),
      metadata: {
        relativePath,
        rootLabel: path.basename(resolved.root),
        rootHash: sha256(resolved.root).slice(0, 16),
        chunkCount: chunks.length,
        extension: ext,
      },
    },
    chunks,
  };
}

module.exports = {
  ingestDocument,
  parseSections,
  SUPPORTED_EXTENSIONS,
  UNSUPPORTED_EXTENSIONS,
};
