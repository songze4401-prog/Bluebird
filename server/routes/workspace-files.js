/**
 * Bluebird 实际工作区文件 API（单用户 LAN 应用）。
 * 所有路径复用 tool-workspace 的工作区根目录与 realpath 沙箱校验；
 * 文件正文不会写入监控或日志。上传只接收显式 base64 JSON，最大 10 MiB。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const toolWorkspace = require('../tool-workspace');

const TEXT_EDIT_EXTENSIONS = new Set(['.txt', '.md', '.markdown']);
const TEXT_READ_MAX_BYTES = 256 * 1024;
const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
const MAX_SEARCH_RESULTS = 500;
const MAX_WALK_ENTRIES = 10000;
const MIME_TYPES = Object.freeze({
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.json': 'application/json',
  '.csv': 'text/csv; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.tsx': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.zip': 'application/zip',
});

class WorkspaceFileError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

function fail(status, code, message, extra) {
  throw new WorkspaceFileError(status, code, message, extra);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function relativePathOf(absolutePath, rootReal) {
  const rel = path.relative(rootReal, absolutePath).split(path.sep).join('/');
  return rel || '.';
}

function safeName(name) {
  if (typeof name !== 'string' || !name.trim() || name.length > 255) {
    fail(400, 'bad_request', '文件名必须为 1–255 个字符');
  }
  const trimmed = name.trim();
  if (
    trimmed === '.' || trimmed === '..' ||
    trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('\0') ||
    trimmed.includes(':') || trimmed.toLowerCase() === '.history' ||
    trimmed.startsWith('.history/')
  ) {
    fail(400, 'workspace_path_invalid', '文件名包含不允许的路径字符');
  }
  return trimmed;
}

function isHiddenHistory(name) {
  return name.toLowerCase() === '.history';
}

function makeEntry(absolutePath, rootReal, name, type, stat) {
  const relativePath = relativePathOf(absolutePath, rootReal);
  const ext = type === 'file' ? path.extname(name).toLowerCase() : '';
  return {
    name,
    path: relativePath,
    type,
    size: type === 'file' ? stat.size : 0,
    mtime: stat.mtime.toISOString(),
    editable: type === 'file' && TEXT_EDIT_EXTENSIONS.has(ext),
    mimeType: type === 'file' ? (MIME_TYPES[ext] || 'application/octet-stream') : null,
  };
}

function createWorkspaceFileService() {
  const writeLocks = new Map();
  const resolve = rel => {
    try {
      return toolWorkspace.resolveWithinRoot(rel);
    } catch (error) {
      if (error && String(error.code || '').startsWith('workspace_')) {
        fail(400, error.code, error.error || '路径不在工作区内');
      }
      throw error;
    }
  };

  const requireRegularFile = (absolutePath, relativePath) => {
    let stat;
    try {
      stat = fs.lstatSync(absolutePath);
    } catch (_) {
      fail(404, 'workspace_not_found', `文件不存在：${relativePath}`);
    }
    if (stat.isSymbolicLink()) fail(400, 'workspace_symlink_not_allowed', '不支持通过符号链接访问文件');
    if (!stat.isFile()) fail(400, 'workspace_not_a_file', '目标不是普通文件');
    return stat;
  };

  // 异步遍历：工作区可能上万项，同步 readdir/lstat 会阻塞 Express 主线程，
  // 拖慢同一进程上的聊天流式响应。上限与结果集口径保持不变。
  const list = async ({ path: requestedPath = '.', search = '' } = {}) => {
    const query = typeof search === 'string' ? search.trim().toLocaleLowerCase() : '';
    const requested = typeof requestedPath === 'string' && requestedPath.trim() ? requestedPath : '.';
    const { absolutePath, relativePath, rootReal } = resolve(requested);
    let rootStat;
    try {
      rootStat = await fs.promises.lstat(absolutePath);
    } catch (_) {
      fail(404, 'workspace_not_found', '目录不存在');
    }
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      fail(400, 'workspace_not_a_directory', '目标不是工作区目录');
    }

    const entries = [];
    let visited = 0;
    const walk = async (dir, depth = 0) => {
      if (depth > 32 || visited >= MAX_WALK_ENTRIES) return;
      let names;
      try {
        names = await fs.promises.readdir(dir);
      } catch (_) {
        return;
      }
      for (const name of names) {
        if (visited >= MAX_WALK_ENTRIES) break;
        if (isHiddenHistory(name)) continue;
        const full = path.join(dir, name);
        let stat;
        try {
          stat = await fs.promises.lstat(full);
        } catch (_) {
          continue;
        }
        visited += 1;
        if (stat.isSymbolicLink()) continue;
        const type = stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : null;
        if (!type) continue;
        const entry = makeEntry(full, rootReal, name, type, stat);
        if (!query || entry.name.toLocaleLowerCase().includes(query) || entry.path.toLocaleLowerCase().includes(query)) {
          entries.push(entry);
        }
        if (query && type === 'dir') await walk(full, depth + 1);
      }
    };
    await walk(absolutePath);
    entries.sort((a, b) => Date.parse(b.mtime) - Date.parse(a.mtime) || a.path.localeCompare(b.path));
    const sliced = entries.slice(0, MAX_SEARCH_RESULTS);
    return {
      path: relativePath,
      search: query || null,
      count: sliced.length,
      truncated: entries.length > MAX_SEARCH_RESULTS || visited >= MAX_WALK_ENTRIES,
      entries: sliced,
    };
  };

  const readText = ({ path: requestedPath } = {}) => {
    if (typeof requestedPath !== 'string' || !requestedPath.trim()) fail(400, 'bad_request', '缺少文件路径');
    const resolved = resolve(requestedPath);
    const ext = path.extname(resolved.absolutePath).toLowerCase();
    if (!toolWorkspace.TEXT_EXTENSIONS.includes(ext)) fail(415, 'workspace_not_text', '此文件格式不支持文本预览');
    const stat = requireRegularFile(resolved.absolutePath, resolved.relativePath);
    if (stat.size > TEXT_READ_MAX_BYTES) fail(413, 'workspace_file_too_large', `文本文件超过 ${TEXT_READ_MAX_BYTES} 字节预览限制`);
    const bytes = fs.readFileSync(resolved.absolutePath);
    return {
      path: resolved.relativePath,
      content: bytes.toString('utf8'),
      version: sha256(bytes),
      size: bytes.length,
      mtime: stat.mtime.toISOString(),
      editable: TEXT_EDIT_EXTENSIONS.has(ext),
    };
  };

  const withWriteLock = async (key, action) => {
    const previous = writeLocks.get(key) || Promise.resolve();
    let unlock;
    const current = new Promise(resolveUnlock => { unlock = resolveUnlock; });
    writeLocks.set(key, current);
    await previous.catch(() => {});
    try {
      return await action();
    } finally {
      unlock();
      if (writeLocks.get(key) === current) writeLocks.delete(key);
    }
  };

  const saveText = async ({ path: requestedPath, content, expectedVersion } = {}) => {
    if (typeof requestedPath !== 'string' || !requestedPath.trim()) fail(400, 'bad_request', '缺少文件路径');
    if (typeof content !== 'string') fail(400, 'bad_request', 'content 必须是字符串');
    if (typeof expectedVersion !== 'string' || !/^[a-f0-9]{64}$/.test(expectedVersion)) {
      fail(428, 'workspace_version_required', '保存文本必须提供打开时的文件版本');
    }
    if (Buffer.byteLength(content, 'utf8') > toolWorkspace.LIMITS.writeMaxBytes) {
      fail(413, 'workspace_file_too_large', `单文件保存上限为 ${toolWorkspace.LIMITS.writeMaxBytes} 字节`);
    }
    const resolved = resolve(requestedPath);
    const ext = path.extname(resolved.absolutePath).toLowerCase();
    if (!TEXT_EDIT_EXTENSIONS.has(ext)) fail(415, 'workspace_not_editable', '仅支持编辑 .txt、.md 和 .markdown 文件');

    return withWriteLock(resolved.absolutePath, async () => {
      const stat = requireRegularFile(resolved.absolutePath, resolved.relativePath);
      const currentBytes = fs.readFileSync(resolved.absolutePath);
      const currentVersion = sha256(currentBytes);
      if (currentVersion !== expectedVersion) {
        fail(409, 'workspace_version_conflict', '文件已在编辑期间发生变化；本次内容没有保存', { currentVersion });
      }
      const saved = await toolWorkspace.workspaceWriteDefinition.handler({
        path: resolved.relativePath,
        content,
        mode: 'overwrite',
        expectedVersion,
      });
      if (!saved || !saved.ok) {
        const code = saved && saved.code || 'workspace_save_failed';
        const status = code === 'workspace_quota_exceeded' ? 413 : ['workspace_exists', 'workspace_version_conflict'].includes(code) ? 409 : 500;
        fail(status, code, saved && saved.error || '保存文件失败', saved && saved.currentVersion ? { currentVersion: saved.currentVersion } : undefined);
      }
      const bytes = fs.readFileSync(resolved.absolutePath);
      const after = fs.statSync(resolved.absolutePath);
      return {
        ok: true,
        path: resolved.relativePath,
        version: sha256(bytes),
        size: bytes.length,
        mtime: after.mtime.toISOString(),
        backup: saved.backup || null,
      };
    });
  };

  const deleteFile = ({ path: requestedPath, confirm } = {}) => {
    if (confirm !== true) fail(400, 'workspace_delete_confirmation_required', '删除文件必须显式确认');
    if (typeof requestedPath !== 'string' || !requestedPath.trim() || requestedPath === '.') {
      fail(400, 'bad_request', '必须提供工作区内的文件路径');
    }
    const resolved = resolve(requestedPath);
    requireRegularFile(resolved.absolutePath, resolved.relativePath);
    fs.unlinkSync(resolved.absolutePath);
    return { ok: true, path: resolved.relativePath };
  };

  const upload = async ({ directory = '.', name, base64, onConflict } = {}) => {
    const cleanName = safeName(name);
    if (typeof base64 !== 'string' || !base64.length || base64.length > Math.ceil(UPLOAD_MAX_BYTES / 3) * 4 + 8 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
      fail(400, 'bad_request', '上传文件内容不是有效的 base64');
    }
    const buffer = Buffer.from(base64, 'base64');
    if (!buffer.length) fail(400, 'bad_request', '不接受空文件');
    if (buffer.length > UPLOAD_MAX_BYTES) fail(413, 'workspace_upload_too_large', `单个上传文件不能超过 ${UPLOAD_MAX_BYTES} 字节`);
    if (onConflict !== undefined && !['overwrite', 'keep-both'].includes(onConflict)) {
      fail(400, 'bad_request', 'onConflict 只能是 overwrite 或 keep-both');
    }
    if (typeof directory !== 'string' || !directory.trim()) fail(400, 'bad_request', '目录路径无效');
    const parent = resolve(directory);
    let parentStat;
    try {
      parentStat = fs.lstatSync(parent.absolutePath);
    } catch (_) {
      fail(404, 'workspace_not_found', '上传目标目录不存在');
    }
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) fail(400, 'workspace_not_a_directory', '上传目标不是普通目录');

    const originalRelative = parent.relativePath === '.' ? cleanName : `${parent.relativePath}/${cleanName}`;
    let target = resolve(originalRelative);
    let exists = false;
    try {
      const st = fs.lstatSync(target.absolutePath);
      if (st.isSymbolicLink()) fail(400, 'workspace_symlink_not_allowed', '不能覆盖符号链接');
      if (!st.isFile()) fail(409, 'workspace_name_conflict_directory', '同名目标不是普通文件，不能覆盖');
      exists = true;
    } catch (error) {
      if (error instanceof WorkspaceFileError) throw error;
      if (!error || error.code !== 'ENOENT') throw error;
    }
    if (exists && !onConflict) {
      fail(409, 'workspace_file_exists', '工作区中已有同名文件，请选择覆盖或保留两份', { existingPath: target.relativePath });
    }
    if (exists && onConflict === 'keep-both') {
      const ext = path.extname(cleanName);
      const stem = ext ? cleanName.slice(0, -ext.length) : cleanName;
      let suffix = 2;
      while (suffix <= 1000) {
        const candidateName = `${stem} (${suffix})${ext}`;
        const candidateRel = parent.relativePath === '.' ? candidateName : `${parent.relativePath}/${candidateName}`;
        const candidate = resolve(candidateRel);
        if (!fs.existsSync(candidate.absolutePath)) {
          target = candidate;
          break;
        }
        suffix += 1;
      }
      if (suffix > 1000) fail(409, 'workspace_name_generation_failed', '无法生成不冲突的副本文件名');
    }

    return withWriteLock(target.absolutePath, async () => {
      // 上传期间再次检查冲突，避免并发创建覆盖对方文件。
      let existingStat = null;
      try {
        existingStat = fs.lstatSync(target.absolutePath);
      } catch (error) {
        if (!error || error.code !== 'ENOENT') throw error;
      }
      if (existingStat && existingStat.isSymbolicLink()) fail(400, 'workspace_symlink_not_allowed', '不能覆盖符号链接');
      if (existingStat && !existingStat.isFile()) fail(409, 'workspace_name_conflict_directory', '同名目标不是普通文件，不能覆盖');
      if (existingStat && !onConflict) fail(409, 'workspace_file_exists', '工作区中已有同名文件，请选择覆盖或保留两份', { existingPath: target.relativePath });
      if (existingStat && onConflict === 'keep-both') {
        // keep-both 选择的名字也可能被另一个请求抢先创建；返回冲突而不覆写。
        fail(409, 'workspace_file_exists', '生成的副本名刚被占用，请重试');
      }
      const usage = toolWorkspace.workspaceUsage();
      try {
        // 覆盖时原目标会被替换，而历史备份保留一份；最终净增量仍只是本次内容。
        toolWorkspace.assertQuota(usage + buffer.length);
      } catch (error) {
        if (error && error.code === 'workspace_quota_exceeded') {
          fail(413, error.code, error.error || '超过工作区总量上限');
        }
        throw error;
      }
      fs.mkdirSync(path.dirname(target.absolutePath), { recursive: true });
      const tmp = path.join(path.dirname(target.absolutePath), `.bluebird-upload-${crypto.randomUUID()}.tmp`);
      try {
        fs.writeFileSync(tmp, buffer, { flag: 'wx', mode: 0o600 });
        if (existingStat) {
          if (onConflict === 'overwrite') toolWorkspace.backupExistingFile(target.absolutePath);
          fs.renameSync(tmp, target.absolutePath);
        }
        else {
          // wx 把「不存在才创建」做成原子条件，防止并发同名文件被覆盖。
          try {
            fs.linkSync(tmp, target.absolutePath);
            fs.unlinkSync(tmp);
          } catch (error) {
            if (error && error.code === 'EEXIST') fail(409, 'workspace_file_exists', '工作区中已有同名文件，请选择覆盖或保留两份');
            throw error;
          }
        }
      } catch (error) {
        try { fs.unlinkSync(tmp); } catch (_) {}
        if (error instanceof WorkspaceFileError) throw error;
        throw new WorkspaceFileError(500, 'workspace_upload_failed', '上传文件写入失败');
      }
      const stat = fs.statSync(target.absolutePath);
      return {
        ok: true,
        path: target.relativePath,
        name: path.basename(target.absolutePath),
        size: stat.size,
        mtime: stat.mtime.toISOString(),
        version: sha256(fs.readFileSync(target.absolutePath)),
      };
    });
  };

  const readBinary = ({ path: requestedPath } = {}) => {
    if (typeof requestedPath !== 'string' || !requestedPath.trim()) fail(400, 'bad_request', '缺少文件路径');
    const resolved = resolve(requestedPath);
    requireRegularFile(resolved.absolutePath, resolved.relativePath);
    let fd;
    try {
      const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
      fd = fs.openSync(resolved.absolutePath, flags);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) fail(400, 'workspace_not_a_file', '目标不是普通文件');
      return {
        path: resolved.relativePath,
        name: path.basename(resolved.absolutePath),
        size: stat.size,
        mtime: stat.mtime.toISOString(),
        mimeType: MIME_TYPES[path.extname(resolved.absolutePath).toLowerCase()] || 'application/octet-stream',
        stream: fs.createReadStream(resolved.absolutePath, { fd, autoClose: true }),
      };
    } catch (error) {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch (_) {}
      }
      if (error instanceof WorkspaceFileError) throw error;
      fail(404, 'workspace_not_found', '文件不存在');
    }
  };

  return { list, readText, saveText, deleteFile, upload, readBinary };
}

function sendError(res, error) {
  if (error instanceof WorkspaceFileError) {
    return res.status(error.status).json({ error: error.message, code: error.code, ...error.extra });
  }
  console.error('[workspace-files] request failed:', error && error.code || 'io_error');
  return res.status(500).json({ error: '工作区文件操作失败', code: 'workspace_io_failed' });
}

function createWorkspaceFilesRouter({ requireAuth, service = createWorkspaceFileService() } = {}) {
  if (typeof requireAuth !== 'function') throw new TypeError('[workspace-files] createWorkspaceFilesRouter 需要 requireAuth');
  const router = express.Router();

  router.get('/files', requireAuth, async (req, res) => {
    try {
      return res.json(await service.list({ path: req.query.path, search: req.query.search }));
    } catch (error) { return sendError(res, error); }
  });

  router.get('/files/text', requireAuth, (req, res) => {
    try {
      const result = service.readText({ path: req.query.path });
      return res.json(result);
    } catch (error) { return sendError(res, error); }
  });

  router.put('/files/text', requireAuth, async (req, res) => {
    try {
      const result = await service.saveText(req.body || {});
      return res.json(result);
    } catch (error) { return sendError(res, error); }
  });

  router.get('/files/download', requireAuth, (req, res) => {
    try {
      const result = service.readBinary({ path: req.query.path });
      const encodedName = encodeURIComponent(result.name).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
      res.set({
        'Content-Type': result.mimeType,
        'Content-Length': String(result.size),
        'Content-Disposition': `attachment; filename*=UTF-8''${encodedName}`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      });
      result.stream.on('error', error => {
        if (res.headersSent) res.destroy(error);
        else sendError(res, error);
      });
      return result.stream.pipe(res);
    } catch (error) { return sendError(res, error); }
  });

  router.post('/files/upload', requireAuth, async (req, res) => {
    try {
      return res.status(201).json(await service.upload(req.body || {}));
    } catch (error) { return sendError(res, error); }
  });

  router.delete('/files', requireAuth, (req, res) => {
    try {
      return res.json(service.deleteFile(req.body || {}));
    } catch (error) { return sendError(res, error); }
  });

  return router;
}

module.exports = {
  TEXT_EDIT_EXTENSIONS,
  TEXT_READ_MAX_BYTES,
  UPLOAD_MAX_BYTES,
  WorkspaceFileError,
  createWorkspaceFileService,
  createWorkspaceFilesRouter,
};
