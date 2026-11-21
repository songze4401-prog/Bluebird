/**
 * Agent 工作区文件工具（任务书 2026-11-18）：workspace_list / workspace_read / workspace_write
 *
 * 给主 Agent 一个自己的工作文件夹（BLUEBIRD_DATA_DIR/workspace/，未设则
 * server/data/workspace/），能列目录、读文本、写文本。这是第一个真正有
 * 副作用的通用写操作工具，安全约束全部写死在工具层，不靠提示词：
 *
 * - 路径收敛：先 path.resolve 再 fs.realpath，最终真实路径必须落在工作区
 *   根目录之内；`..` 段、绝对路径、软链接/junction 逃逸一律拒绝
 *   （workspace_path_outside），`.history` 前缀为备份保留区，禁止写入；
 * - 扩展名白名单：只允许纯文本后缀，其它一律拒绝（read/write 同样受限）；
 * - 上限：单次读取 64KB（超出截断并说明）、单文件写入 256KB、工作区总量
 *   50MB；不给删除、重命名、执行、git 能力；
 * - workspace_list / workspace_read 只读；workspace_write readOnly:false 且
 *   risk:'high_risk'——运行层既有语义是 deny-only `confirmation_required`
 *   （写前确认）。在用户确认协议接上之前，该工具不会被运行层执行；
 *   handler 本体按任务书完整实现并通过单测，供确认协议落地后直接复用。
 * - overwrite 前把旧文件备份到 workspace/.history/<文件名>.<UTC时间戳>，
 *   同名备份保留最近 10 份；
 * - 监控：每次调用记 workspace.op.completed（工具名、相对路径、字节数、
 *   结果短码），不记录文件正文。
 */
const fs = require('fs');
const path = require('path');
const monitoring = require('./monitoring');
const workspacePending = require('./workspace-pending');

const LIMITS = Object.freeze({
  readMaxBytes: 64 * 1024,
  writeMaxBytes: 256 * 1024,
  totalMaxBytes: 50 * 1024 * 1024,
  backupKeep: 10,
  pathMax: 512,
});

const TEXT_EXTENSIONS = Object.freeze([
  '.md',
  '.txt',
  '.json',
  '.csv',
  '.yaml',
  '.yml',
  '.js',
  '.ts',
  '.tsx',
  '.html',
  '.css',
]);

const DATA_DIR = process.env.BLUEBIRD_DATA_DIR
  ? path.resolve(process.env.BLUEBIRD_DATA_DIR)
  : path.join(__dirname, 'data');
// 工作区根目录可独立指定（BLUEBIRD_WORKSPACE_DIR，便于放到用户可见目录如桌面）；
// 未设置时沿用旧口径 BLUEBIRD_DATA_DIR/workspace/。
const WORKSPACE_ROOT = process.env.BLUEBIRD_WORKSPACE_DIR
  ? path.resolve(process.env.BLUEBIRD_WORKSPACE_DIR)
  : path.join(DATA_DIR, 'workspace');

function isEnabled() {
  return process.env.BLUEBIRD_WORKSPACE_TOOLS === '1';
}

// 写入自动确认（默认关闭）：开启后主聊的 workspace_write 跳过聊天内确认行直接落盘。
function isAutoConfirmEnabled() {
  return process.env.BLUEBIRD_WORKSPACE_AUTO_CONFIRM === '1';
}

function ensureWorkspaceRoot() {
  fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
}

// 启动时不存在就创建（失败不阻塞进程启动，handler 内会再次尝试并结构化报错）。
try {
  ensureWorkspaceRoot();
} catch (error) {
  console.warn(
    `[workspace] 工作区根目录创建失败（${error && error.code || error && error.message || 'unknown'}），将在首次调用时重试`
  );
}

function toolError(code, error, summary) {
  return { ok: false, code, error, summary: summary || error };
}

function isAbsoluteLike(relPath) {
  return path.isAbsolute(relPath) || /^[a-zA-Z]:/.test(relPath) || /^\\\\/.test(relPath);
}

/**
 * 把模型给的相对路径收敛到工作区根目录之内，返回绝对路径。
 * 词法检查（绝对路径 / `..` 段 / 空字节 / 长度）+ 真实路径检查
 * （最深存在祖先 realpath 后必须仍在根内，拦下软链接逃逸）。
 */
function resolveWithinRoot(relPath) {
  if (typeof relPath !== 'string') {
    throw toolError('workspace_path_invalid', '路径必须是字符串');
  }
  const trimmed = relPath.trim();
  if (trimmed.length > LIMITS.pathMax) {
    throw toolError('workspace_path_invalid', `路径超过 ${LIMITS.pathMax} 字符上限`);
  }
  if (trimmed.includes('\0')) {
    throw toolError('workspace_path_invalid', '路径包含非法空字节');
  }
  if (isAbsoluteLike(trimmed)) {
    throw toolError('workspace_path_outside', '不接受绝对路径，只允许工作区内的相对路径');
  }
  const segments = trimmed.split(/[\\/]+/).filter(Boolean);
  if (segments.includes('..')) {
    throw toolError('workspace_path_outside', '路径不允许包含 `..` 段');
  }
  // Windows 文件系统大小写不敏感：.HISTORY 也会命中真实 .history，必须按小写判保留区。
  if (segments.length && segments[0].toLowerCase() === '.history') {
    throw toolError('workspace_path_reserved', '.history 是备份保留目录，工具不可写入');
  }
  // NTFS 备用数据流（ADS）：`a.md:hidden.js` 的 extname 是 .js，能过白名单，
  // 但写入不可见、不计 usage，配额与审计双绕过——含 `:` 的相对路径一律拒绝。
  if (trimmed.includes(':')) {
    throw toolError('workspace_path_invalid', '路径不允许包含冒号');
  }

  ensureWorkspaceRoot();
  const rootReal = fs.realpathSync(WORKSPACE_ROOT);
  const rootWithSep = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep;
  const resolvedRelative = segments.length ? segments.join(path.sep) : '';
  const candidate = resolvedRelative
    ? path.join(rootReal, resolvedRelative)
    : rootReal;

  // 最深存在祖先 realpath：拦截「软链接指向工作区外」的逃逸。
  const suffix = [];
  let anchor = candidate;
  while (!fs.existsSync(anchor)) {
    const parent = path.dirname(anchor);
    if (parent === anchor) break;
    suffix.unshift(path.basename(anchor));
    anchor = parent;
  }
  const anchorReal = fs.realpathSync(anchor);
  const rebuilt = suffix.length
    ? path.join(anchorReal, ...suffix)
    : anchorReal;
  if (rebuilt !== rootReal && !rebuilt.startsWith(rootWithSep)) {
    throw toolError('workspace_path_outside', '真实路径逃逸出工作区根目录（软链接或重定向）');
  }
  return { rootReal, absolutePath: rebuilt, relativePath: resolvedRelative || '.' };
}

function assertTextExtension(absolutePath) {
  const ext = path.extname(absolutePath).toLowerCase();
  if (!TEXT_EXTENSIONS.includes(ext)) {
    throw toolError(
      'workspace_extension_not_allowed',
      `只允许文本扩展名（${TEXT_EXTENSIONS.join(' ')}），收到「${ext || '(无后缀)'}」`
    );
  }
}

/** 递归汇总工作区内所有普通文件的字节数（含 .history 备份）。 */
function workspaceUsage() {
  let total = 0;
  const walk = dir => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        try {
          total += fs.statSync(full).size;
        } catch (_) {
          // 统计失败的文件不计入，不能让一次 stat 异常炸掉整个调用。
        }
      }
    }
  };
  try {
    ensureWorkspaceRoot();
  } catch (error) {
    throw toolError('workspace_io_failed', `工作区根目录不可用：${error && error.code || 'io_error'}`);
  }
  walk(WORKSPACE_ROOT);
  return total;
}

/**
 * 总量闸：projectedUsage 必须 ≤ totalMaxBytes。纯计算 + 真实 usage，
 * 供单测直接断言（不必真写 50MB）。
 */
function assertQuota(projectedUsage) {
  if (projectedUsage > LIMITS.totalMaxBytes) {
    throw toolError(
      'workspace_quota_exceeded',
      `超过工作区总量上限：预计 ${projectedUsage} 字节 > 上限 ${LIMITS.totalMaxBytes} 字节`
    );
  }
}

function backupStamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}` +
    `-${String(d.getUTCMilliseconds()).padStart(3, '0')}`
  );
}

function backupExistingFile(absolutePath) {
  const historyDir = path.join(WORKSPACE_ROOT, '.history');
  fs.mkdirSync(historyDir, { recursive: true });
  const base = path.basename(absolutePath);
  let name = `${base}.${backupStamp()}`;
  while (fs.existsSync(path.join(historyDir, name))) {
    name = `${name}-${Math.floor(Math.random() * 90 + 10)}`;
  }
  fs.copyFileSync(absolutePath, path.join(historyDir, name));
  pruneHistory(base);
  return name;
}

function pruneHistory(base) {
  const historyDir = path.join(WORKSPACE_ROOT, '.history');
  const prefix = `${base}.`;
  let names = [];
  try {
    names = fs.readdirSync(historyDir).filter(n => n.startsWith(prefix)).sort();
  } catch (_) {
    return;
  }
  const excess = names.length - LIMITS.backupKeep;
  for (let i = 0; i < excess; i += 1) {
    try {
      fs.unlinkSync(path.join(historyDir, names[i]));
    } catch (_) {
      // 删最旧备份失败不影响本次写入。
    }
  }
}

function recordOp({ tool, relPath, mode = null, bytes = null, truncated = null, status, code = null, confirmed = null }) {
  try {
    monitoring.recordWorkspaceOp({
      tool,
      path: typeof relPath === 'string' ? relPath.slice(0, 200) : null,
      mode,
      bytes,
      truncated,
      status,
      code,
      confirmed,
    });
  } catch (_) {
    // 监控失败不影响工具结果。
  }
}

const workspaceListDefinition = Object.freeze({
  name: 'workspace_list',
  description:
    '列出 Agent 工作区里的文件和子目录（名字、类型、大小、修改时间）。' +
    'path 省略时列根目录。只能看，不能改。',
  parameters: Object.freeze({
    type: 'object',
    properties: Object.freeze({
      path: Object.freeze({
        type: 'string',
        description: '可选：工作区内相对路径，默认根目录',
        maxLength: LIMITS.pathMax,
      }),
    }),
  }),
  timeoutMs: 5000,
  readOnly: true,

  validate(args) {
    if (args !== undefined && args !== null && (typeof args !== 'object' || Array.isArray(args))) {
      return { ok: false, error: '参数必须是 JSON 对象' };
    }
    const relPath = args && typeof args.path === 'string' ? args.path : '.';
    if (typeof args?.path === 'string' && !args.path.trim()) {
      return { ok: false, error: 'path 不能是空字符串（省略即列根目录）' };
    }
    if (typeof args?.path === 'string' && args.path.length > LIMITS.pathMax) {
      return { ok: false, error: `path 超过 ${LIMITS.pathMax} 字符上限` };
    }
    return { ok: true, args: { path: relPath } };
  },

  async handler(args) {
    try {
      const { absolutePath, relativePath } = resolveWithinRoot(args.path);
      let stat;
      try {
        stat = fs.statSync(absolutePath);
      } catch (_) {
        const result = toolError('workspace_not_found', `工作区内不存在：${relativePath}`);
        recordOp({ tool: 'workspace_list', relPath: relativePath, status: 'failed', code: result.code });
        return result;
      }
      if (!stat.isDirectory()) {
        const result = toolError('workspace_not_a_directory', `不是目录：${relativePath}`);
        recordOp({ tool: 'workspace_list', relPath: relativePath, status: 'failed', code: result.code });
        return result;
      }
      const dirents = fs.readdirSync(absolutePath, { withFileTypes: true });
      const entries = dirents
        .map(entry => {
          const full = path.join(absolutePath, entry.name);
          let size = 0;
          let mtime = null;
          try {
            const s = fs.statSync(full);
            size = s.size;
            mtime = s.mtime.toISOString();
          } catch (_) {
            // 拿不到 stat 的条目仍列出，值为 0/null。
          }
          return {
            name: entry.name,
            type: entry.isDirectory() ? 'dir' : 'file',
            size,
            mtime,
          };
        })
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      recordOp({ tool: 'workspace_list', relPath: relativePath, status: 'success', bytes: entries.length });
      return {
        ok: true,
        path: relativePath,
        count: entries.length,
        entries,
        summary: `工作区 ${relativePath} 共 ${entries.length} 项`,
      };
    } catch (error) {
      if (error && typeof error === 'object' && String(error.code || '').startsWith('workspace_')) {
        recordOp({ tool: 'workspace_list', relPath: null, status: 'denied', code: error.code });
        return error;
      }
      const result = toolError('workspace_io_failed', `列目录失败：${error && error.code || 'io_error'}`);
      recordOp({ tool: 'workspace_list', relPath: null, status: 'failed', code: result.code });
      return result;
    }
  },
});

const workspaceReadDefinition = Object.freeze({
  name: 'workspace_read',
  description:
    '读取 Agent 工作区里的一个文本文件。单次最多 64KB，超出部分截断并在结果里说明。' +
    '只允许白名单文本扩展名（.md .txt .json .csv .yaml .yml .js .ts .tsx .html .css）。',
  parameters: Object.freeze({
    type: 'object',
    properties: Object.freeze({
      path: Object.freeze({
        type: 'string',
        description: '工作区内相对路径（必填）',
        maxLength: LIMITS.pathMax,
      }),
    }),
    required: Object.freeze(['path']),
  }),
  timeoutMs: 5000,
  readOnly: true,

  validate(args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return { ok: false, error: '参数必须是 JSON 对象' };
    }
    if (typeof args.path !== 'string' || !args.path.trim()) {
      return { ok: false, error: '缺少必填参数 path' };
    }
    if (args.path.length > LIMITS.pathMax) {
      return { ok: false, error: `path 超过 ${LIMITS.pathMax} 字符上限` };
    }
    return { ok: true, args: { path: args.path } };
  },

  async handler(args) {
    try {
      const { absolutePath, relativePath } = resolveWithinRoot(args.path);
      assertTextExtension(absolutePath);
      let stat;
      try {
        stat = fs.statSync(absolutePath);
      } catch (_) {
        const result = toolError('workspace_not_found', `工作区内不存在：${relativePath}`);
        recordOp({ tool: 'workspace_read', relPath: relativePath, status: 'failed', code: result.code });
        return result;
      }
      if (!stat.isFile()) {
        const result = toolError('workspace_is_a_directory', `不是文件：${relativePath}`);
        recordOp({ tool: 'workspace_read', relPath: relativePath, status: 'failed', code: result.code });
        return result;
      }

      let fd;
      try {
        fd = fs.openSync(absolutePath, 'r');
      } catch (error) {
        const result = toolError('workspace_io_failed', `打开文件失败：${error && error.code || 'io_error'}`);
        recordOp({ tool: 'workspace_read', relPath: relativePath, status: 'failed', code: result.code });
        return result;
      }
      try {
        const size = stat.size;
        const cap = LIMITS.readMaxBytes;
        const buffer = Buffer.alloc(Math.min(size, cap));
        const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
        const truncated = size > cap;
        const content = buffer.subarray(0, read).toString('utf8');
        const bytes = read;
        recordOp({ tool: 'workspace_read', relPath: relativePath, status: 'success', bytes, truncated });
        return {
          ok: true,
          path: relativePath,
          bytes,
          totalSize: size,
          truncated,
          content,
          summary: truncated
            ? `已读取前 ${bytes} 字节（文件共 ${size} 字节，超出部分被截断）`
            : `已读取 ${bytes} 字节`,
        };
      } finally {
        fs.closeSync(fd);
      }
    } catch (error) {
      if (error && typeof error === 'object' && String(error.code || '').startsWith('workspace_')) {
        recordOp({ tool: 'workspace_read', relPath: null, status: 'denied', code: error.code });
        return error;
      }
      const result = toolError('workspace_io_failed', `读取失败：${error && error.code || 'io_error'}`);
      recordOp({ tool: 'workspace_read', relPath: null, status: 'failed', code: result.code });
      return result;
    }
  },
});

const workspaceWriteDefinition = Object.freeze({
  name: 'workspace_write',
  description:
    '在 Agent 工作区里写一个文本文件。mode：create（新建，已存在则报错）/ ' +
    'overwrite（覆盖，旧文件自动备份到 .history，保留最近 10 份）/ append（追加，文件不存在则新建）。' +
    '只允许文本扩展名；单文件上限 256KB，工作区总量上限 50MB。' +
    '该工具为高风险写入，需要用户确认流程放行后才会真正执行。',
  parameters: Object.freeze({
    type: 'object',
    properties: Object.freeze({
      path: Object.freeze({
        type: 'string',
        description: '工作区内相对路径（必填），父目录会自动创建',
        maxLength: LIMITS.pathMax,
      }),
      content: Object.freeze({
        type: 'string',
        description: '要写入的完整文本内容（UTF-8）',
      }),
      mode: Object.freeze({
        type: 'string',
        enum: Object.freeze(['create', 'overwrite', 'append']),
        description: '写入模式，默认 create',
      }),
    }),
    required: Object.freeze(['path', 'content']),
  }),
  timeoutMs: 5000,
  readOnly: false,
  risk: 'high_risk',
  // 任务书接法 a：主聊直连路径走待确认往返（executeToolCall 据此放行到
  // handler 创建 pending），任务执行器/无来源上下文仍 deny-only。
  pendingConfirmation: true,

  validate(args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return { ok: false, error: '参数必须是 JSON 对象' };
    }
    if (typeof args.path !== 'string' || !args.path.trim()) {
      return { ok: false, error: '缺少必填参数 path' };
    }
    if (typeof args.content !== 'string') {
      return { ok: false, error: '缺少必填参数 content（必须是字符串）' };
    }
    if (args.path.length > LIMITS.pathMax) {
      return { ok: false, error: `path 超过 ${LIMITS.pathMax} 字符上限` };
    }
    const mode = args.mode === undefined || args.mode === null ? 'create' : args.mode;
    if (!['create', 'overwrite', 'append'].includes(mode)) {
      return { ok: false, error: 'mode 必须是 create / overwrite / append' };
    }
    return { ok: true, args: { path: args.path, content: args.content, mode } };
  },

  async handler(args, context = {}) {
    // 任务书接法 a（2026-11-19）：主聊直连路径（运行层注入 workspacePendingFlow）
    // 默认不直接落盘——创建待确认写入，用户在聊天里确认后才由确认路由执行真写入。
    // BLUEBIRD_WORKSPACE_AUTO_CONFIRM=1 时跳过确认往返，直接走同一套沙箱执行体
    // （任务执行器/无来源上下文的 deny-only 判定在上游，不受此开关影响）。
    if (context && context.workspacePendingFlow === true) {
      if (isAutoConfirmEnabled()) {
        // 未经过用户确认往返，监控标记保持 confirmed=false（口径见 executeWrite 注释）
        return executeWrite(args, { confirmed: false });
      }
      return createPendingWriteResult(args, context);
    }
    return executeWrite(args, { confirmed: false });
  },
});

// 直写执行体（原 handler 主体抽到这里）：确认路由与单测共用同一条沙箱路径。
// confirmed 只影响监控标记（true = 经用户确认往返执行）。
async function executeWrite(args, { confirmed = false } = {}) {
    let resolved = null;
    try {
      const incoming = Buffer.byteLength(args.content, 'utf8');
      if (incoming > LIMITS.writeMaxBytes) {
        const result = toolError(
          'workspace_file_too_large',
          `单文件写入上限 ${LIMITS.writeMaxBytes} 字节，本次 ${incoming} 字节`
        );
        recordOp({ tool: 'workspace_write', relPath: args.path.slice(0, 200), mode: args.mode, status: 'failed', code: result.code, confirmed });
        return result;
      }

      resolved = resolveWithinRoot(args.path);
      const { absolutePath, relativePath, rootReal } = resolved;
      assertTextExtension(absolutePath);
      const rootWithSep = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep;
      if (absolutePath === rootReal || !absolutePath.startsWith(rootWithSep)) {
        const result = toolError('workspace_path_invalid', '写入目标必须是根目录内的文件路径');
        recordOp({ tool: 'workspace_write', relPath: relativePath, mode: args.mode, status: 'failed', code: result.code, confirmed });
        return result;
      }

      let stat = null;
      try {
        stat = fs.statSync(absolutePath);
      } catch (_) {
        // 不存在是合法状态（create / append）。
      }

      if (stat && stat.isDirectory()) {
        const result = toolError('workspace_is_a_directory', `目标是目录，不能当文件写：${relativePath}`);
        recordOp({ tool: 'workspace_write', relPath: relativePath, mode: args.mode, status: 'failed', code: result.code, confirmed });
        return result;
      }

      if (args.mode === 'create' && stat) {
        const result = toolError('workspace_exists', `文件已存在（改用 overwrite 或 append）：${relativePath}`);
        recordOp({ tool: 'workspace_write', relPath: relativePath, mode: args.mode, status: 'failed', code: result.code, confirmed });
        return result;
      }
      if (args.mode === 'append' && !stat) {
        // append 到不存在的文件等同 create。
      }

      // 配额投影按「写入后最坏情况」计：overwrite 还会往 .history 复制一份旧
      // 文件（净增量 = incoming，旧内容转存备份仍在总量内），三种模式一致。
      const usageBefore = workspaceUsage();
      const projected = usageBefore + incoming;
      assertQuota(projected);

      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      let backupName = null;
      if (args.mode === 'overwrite' && stat) {
        backupName = backupExistingFile(absolutePath);
      }

      try {
        if (args.mode === 'append') {
          fs.appendFileSync(absolutePath, args.content, 'utf8');
        } else {
          fs.writeFileSync(absolutePath, args.content, 'utf8');
        }
      } catch (error) {
        const result = toolError('workspace_io_failed', `写入失败：${error && error.code || 'io_error'}`);
        recordOp({ tool: 'workspace_write', relPath: relativePath, mode: args.mode, status: 'failed', code: result.code, confirmed });
        return result;
      }

      recordOp({
        tool: 'workspace_write',
        relPath: relativePath,
        mode: args.mode,
        bytes: incoming,
        status: 'success',
        confirmed,
      });
      return {
        ok: true,
        path: relativePath,
        mode: args.mode,
        bytes: incoming,
        backup: backupName,
        summary:
          args.mode === 'append'
            ? `已追加 ${incoming} 字节到 ${relativePath}`
            : args.mode === 'overwrite'
              ? `已覆盖 ${relativePath}${backupName ? `（旧文件备份为 .history/${backupName}）` : ''}`
              : `已创建 ${relativePath}`,
      };
    } catch (error) {
      const relForLog = resolved ? resolved.relativePath : args.path.slice(0, 200);
      // 只透传工具层结构化错误（workspace_* 短码）；裸 fs 错误的消息可能带
      // 绝对路径，统一包成 workspace_io_failed，不外泄路径，也不误记为 denied。
      if (error && typeof error === 'object' && String(error.code || '').startsWith('workspace_')) {
        recordOp({
          tool: 'workspace_write',
          relPath: relForLog,
          mode: args.mode,
          status: 'denied',
          code: error.code,
          confirmed,
        });
        return error;
      }
      const result = toolError('workspace_io_failed', `写入失败：${error && error.code || 'io_error'}`);
      recordOp({ tool: 'workspace_write', relPath: relForLog, mode: args.mode, status: 'failed', code: result.code, confirmed });
      return result;
    }
}

// 主聊 pending 流（接法 a）：把写入参数存进待确认存储，返回带 confirmationId 的
// 结构化结果，模型据此告知用户去聊天里确认。沙箱在这里预检一次（给模型即时
// 反馈）；确认执行时会用同一套逻辑重查（防创建→确认之间目录状态变化）。
function createPendingWriteResult(args, context) {
  const relForLog = typeof args.path === 'string' ? args.path.slice(0, 200) : null;
  const incoming = Buffer.byteLength(args.content, 'utf8');
  if (incoming > LIMITS.writeMaxBytes) {
    const result = toolError(
      'workspace_file_too_large',
      `单文件写入上限 ${LIMITS.writeMaxBytes} 字节，本次 ${incoming} 字节`
    );
    recordOp({ tool: 'workspace_write', relPath: relForLog, mode: args.mode, status: 'failed', code: result.code });
    return result;
  }
  try {
    // 沙箱预检（含扩展名白名单，oracle 低-2）：给模型即时反馈；
    // 确认执行时会用同一套逻辑重查（防创建→确认之间目录状态变化）。
    const precheck = resolveWithinRoot(args.path);
    assertTextExtension(precheck.absolutePath);
    const record = workspacePending.createPendingWrite({
      sessionId: context.sessionId,
      userId: context.userId || null,
      path: args.path,
      mode: args.mode,
      content: args.content,
    });
    recordOp({
      tool: 'workspace_write',
      relPath: relForLog,
      mode: args.mode,
      bytes: incoming,
      status: 'needs_confirmation',
      code: 'workspace_write_pending',
    });
    return {
      ok: true,
      pending: true,
      code: 'workspace_write_pending',
      confirmationId: record.id,
      path: record.path,
      mode: record.mode,
      bytes: incoming,
      expiresAt: record.expiresAt,
      summary: '已创建待确认写入，等用户在聊天里确认后才会落盘',
    };
  } catch (error) {
    if (error && typeof error === 'object' && String(error.code || '').startsWith('workspace_')) {
      recordOp({ tool: 'workspace_write', relPath: relForLog, mode: args.mode, status: 'denied', code: error.code });
      return error;
    }
    // 确认存储写不下 → fail-closed：不推进流程，也不落盘。
    const result = toolError('workspace_pending_unavailable', `确认存储不可用：${error && error.code || 'io_error'}`);
    recordOp({ tool: 'workspace_write', relPath: relForLog, mode: args.mode, status: 'failed', code: result.code });
    return result;
  }
}

// 确认路由专用：按待确认记录里的原参数执行真写入（confirmed=true 打监控标记）。
function executeConfirmedWrite(args) {
  return executeWrite(args, { confirmed: true });
}

module.exports = {
  LIMITS,
  TEXT_EXTENSIONS,
  WORKSPACE_ROOT,
  isEnabled,
  ensureWorkspaceRoot,
  workspaceUsage,
  assertQuota,
  workspaceListDefinition,
  workspaceReadDefinition,
  workspaceWriteDefinition,
  executeConfirmedWrite,
};
