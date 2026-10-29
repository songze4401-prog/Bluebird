/**
 * 云岫 Bluebird — 代码仓库连接器（retrieval/connectors/code.js）
 *
 * 只读扫描配置根目录内的代码文件；优先保留文件路径、符号名、行范围、
 * commit/branch，作为精确检索与版本追溯的依据。解析是确定性的轻量启发式，
 * 不是完整语言 AST；无法识别的语言只做文件级切片，并在能力表里标明。
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const {
  createChunk,
  contentHashOf,
  sha256,
  sourceIdFor,
} = require('../contract');
const { resolveWithinRoots, readTextFileLimited, relativeDisplayPath } = require('../security');
const { exactTerms } = require('../text');

const execFileAsync = promisify(execFile);

const LANGUAGE_BY_EXT = Object.freeze({
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.swift': 'swift',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.rb': 'ruby',
  '.php': 'php',
  '.sh': 'shell',
  '.sql': 'sql',
  '.css': 'css',
  '.scss': 'scss',
  '.html': 'html',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
});

const SKIPPED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.expo',
  '.next',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
  'target',
  'data',
  'uploads',
  'snapshots',
]);

function symbolPatterns(ext) {
  if (['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'].includes(ext)) {
    return [
      /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
      /(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/g,
      /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g,
      /(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
    ];
  }
  if (ext === '.py') {
    return [/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/gm, /^\s*class\s+([A-Za-z_]\w*)/gm];
  }
  if (ext === '.go') {
    return [/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm, /^type\s+([A-Za-z_]\w*)/gm];
  }
  if (ext === '.rs') {
    return [
      /(?:pub\s+)?fn\s+([A-Za-z_]\w*)/g,
      /(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/g,
    ];
  }
  if (['.java', '.kt', '.cs', '.swift'].includes(ext)) {
    return [
      /(?:public|private|protected|internal)?\s*(?:static\s+)?(?:final\s+)?class\s+([A-Za-z_]\w*)/g,
      /(?:public|private|protected|internal)?\s*(?:static\s+)?(?:interface|enum)\s+([A-Za-z_]\w*)/g,
      /(?:public|private|protected|internal)\s+(?:static\s+)?(?:[\w<>[\]]+\s+)+([A-Za-z_]\w*)\s*\(/g,
    ];
  }
  return [];
}

function extractSymbols(content, ext) {
  const found = [];
  const seen = new Set();
  for (const pattern of symbolPatterns(ext)) {
    pattern.lastIndex = 0;
    let match = pattern.exec(content);
    while (match) {
      const name = match[1];
      if (name && !seen.has(name)) {
        seen.add(name);
        found.push({ name, index: match.index });
      }
      match = pattern.exec(content);
    }
  }
  return found.slice(0, 80);
}

function lineNumberAt(content, index) {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i += 1) {
    if (content[i] === '\n') line += 1;
  }
  return line;
}

function splitCode(content, maxChars) {
  const lines = content.split(/\r?\n/);
  const chunks = [];
  let current = [];
  let size = 0;
  let startLine = 1;

  const flush = endLine => {
    const text = current.join('\n').trim();
    if (text) chunks.push({ text, startLine, endLine });
    current = [];
    size = 0;
    startLine = endLine + 1;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineSize = line.length + 1;
    if (current.length && size + lineSize > maxChars) {
      flush(index);
    }
    if (!current.length) startLine = index + 1;
    current.push(line);
    size += lineSize;
  }
  flush(lines.length);
  return chunks;
}

function walkFiles(root, { maxFiles, maxTotalBytes, maxFileBytes }) {
  const files = [];
  let totalBytes = 0;
  let truncated = false;

  const visit = dir => {
    if (truncated || files.length >= maxFiles) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (truncated || files.length >= maxFiles) {
        truncated = true;
        return;
      }
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name)) continue;
        visit(path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!LANGUAGE_BY_EXT[ext]) continue;
      const full = path.join(dir, entry.name);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch (_) {
        continue;
      }
      if (stat.size > maxFileBytes) continue;
      if (totalBytes + stat.size > maxTotalBytes) {
        truncated = true;
        return;
      }
      totalBytes += stat.size;
      files.push({ full, ext, size: stat.size, mtime: stat.mtime.toISOString() });
    }
  };

  visit(root);
  return { files, totalBytes, truncated };
}

async function gitInfo(root) {
  try {
    const commit = await execFileAsync('git', ['-C', root, 'rev-parse', 'HEAD'], {
      timeout: 3000,
      windowsHide: true,
      maxBuffer: 64 * 1024,
    });
    const branch = await execFileAsync(
      'git',
      ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'],
      { timeout: 3000, windowsHide: true, maxBuffer: 64 * 1024 }
    );
    const status = await execFileAsync('git', ['-C', root, 'status', '--porcelain'], {
      timeout: 3000,
      windowsHide: true,
      maxBuffer: 512 * 1024,
    });
    return {
      commit: commit.stdout.trim() || null,
      branch: branch.stdout.trim() || null,
      dirty: Boolean(status.stdout.trim()),
    };
  } catch (_) {
    return { commit: null, branch: null, dirty: null };
  }
}

async function ingestCode({
  inputPath,
  roots,
  maxFileBytes,
  maxTotalBytes,
  maxFiles,
  maxChunkChars,
}) {
  const resolved = resolveWithinRoots(inputPath, roots);
  if (!resolved.ok) return resolved;

  let stat;
  try {
    stat = fs.statSync(resolved.path);
  } catch (_) {
    return { ok: false, error: 'path_not_found' };
  }
  if (!stat.isDirectory()) return { ok: false, error: 'not_a_directory' };

  const walked = walkFiles(resolved.path, {
    maxFiles,
    maxTotalBytes,
    maxFileBytes,
  });
  if (!walked.files.length) return { ok: false, error: 'no_indexable_files' };

  const git = await gitInfo(resolved.path);
  const sourceId = sourceIdFor('code', resolved.path);
  const rootLabel = path.basename(resolved.path);
  const fileHashes = [];
  const chunks = [];
  let symbolCount = 0;
  let skipped = 0;

  for (const file of walked.files) {
    const loaded = readTextFileLimited(file.full, maxFileBytes);
    if (!loaded.ok) {
      skipped += 1;
      continue;
    }
    const relativePath = relativeDisplayPath(resolved.path, file.full);
    const language = LANGUAGE_BY_EXT[file.ext] || '';
    const symbols = extractSymbols(loaded.text, file.ext);
    symbolCount += symbols.length;
    const symbolsWithLines = symbols.map(symbol => ({
      name: symbol.name,
      line: lineNumberAt(loaded.text, symbol.index),
    }));
    const fileHash = contentHashOf(loaded.text);
    fileHashes.push(`${relativePath}:${fileHash}`);

    for (const part of splitCode(loaded.text, maxChunkChars)) {
      const rangeSymbols = symbolsWithLines
        .filter(symbol => symbol.line >= part.startLine && symbol.line <= part.endLine)
        .map(symbol => symbol.name);
      chunks.push(
        createChunk({
          sourceType: 'code',
          sourceId,
          content: part.text,
          title: relativePath,
          uri: `repo://${rootLabel}`,
          locator: `${relativePath}#L${part.startLine}-L${part.endLine}`,
          language,
          mimeType: 'text/plain',
          createdAt: file.mtime,
          updatedAt: file.mtime,
          validFrom: null,
          sourceVersion: '',
          scope: { visibility: 'global' },
          metadata: {
            filePath: relativePath,
            language,
            lineStart: part.startLine,
            lineEnd: part.endLine,
            symbols: rangeSymbols,
            exactTerms: exactTerms(`${relativePath}\n${part.text}`, 32),
            commit: git.commit || null,
            branch: git.branch || null,
          },
        })
      );
    }
  }

  if (!chunks.length) return { ok: false, error: 'no_indexable_files' };

  const versionHash = sha256(
    [
      git.commit || 'worktree',
      git.branch || '',
      String(git.dirty),
      ...fileHashes,
    ].join('|')
  ).slice(0, 32);

  for (const chunk of chunks) {
    chunk.sourceVersion = versionHash;
  }

  return {
    ok: true,
    truncated: walked.truncated,
    source: {
      id: sourceId,
      type: 'code',
      title: `代码仓库：${rootLabel}`,
      uri: `repo://${rootLabel}`,
      state: 'indexed',
      sourceVersion: versionHash,
      contentHash: sha256(fileHashes.join('|')),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {
        rootLabel,
        rootHash: sha256(resolved.path).slice(0, 16),
        commit: git.commit || null,
        branch: git.branch || null,
        dirty: git.dirty,
        fileCount: walked.files.length - skipped,
        chunkCount: chunks.length,
        symbolCount,
        truncated: walked.truncated,
      },
    },
    chunks,
    stats: {
      files: walked.files.length - skipped,
      skipped,
      chunks: chunks.length,
      symbols: symbolCount,
      truncated: walked.truncated,
    },
  };
}

module.exports = {
  ingestCode,
  extractSymbols,
  splitCode,
  walkFiles,
  LANGUAGE_BY_EXT,
};
