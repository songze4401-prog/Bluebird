/**
 * Agent 工作区文件工具回归（任务书 2026-11-18）。
 *
 * 口径：
 *  a) 根目录 BLUEBIRD_DATA_DIR/workspace/ 随模块加载自动创建；
 *  b) workspace_list / workspace_read / workspace_write 快乐路径（list 默认根、
 *     create 自动建父目录、append 追加/缺失即建、overwrite 备份到 .history）；
 *  c) 安全闸：`..` 段与绝对路径一律 workspace_path_outside；软链接/junction
 *     逃逸走 realpath 检查同样拒绝；扩展名白名单（read/write 双侧）；
 *     `.history` 前缀禁止写入；
 *  d) 上限：单文件 256KB、读取 64KB 截断说明、工作区总量 50MB（assertQuota
 *     语义 + usage 汇总真实文件含 .history，不真写 50MB）；
 *  e) 注册面：BLUEBIRD_WORKSPACE_TOOLS=1 才注册三个工具；list/read 只读
 *     risk=read，write readOnly=false 且 risk=high_risk；
 *  f) 运行层写前确认：executeToolCall('workspace_write') 走既有 high_risk
 *     deny-only 语义返回 confirmation_required，文件不产生；
 *  g) 监控：每次调用记 workspace.op.completed（tool/path/mode/bytes），
 *     文件正文绝不进入事件流。
 *
 * 测试只用临时目录（BLUEBIRD_DATA_DIR 指向 mkdtemp），不碰真实 server/data。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const test = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-workspace-tools-'));
process.env.BLUEBIRD_DATA_DIR = TMP;
process.env.BLUEBIRD_WORKSPACE_TOOLS = '1';
// run-tests.js / verify-test-coverage.js 会给所有测试进程注入 BLUEBIRD_MONITORING=0；
// 本文件是监控专项断言（用例 r），按仓库约定在文件内显式打开（同 monitoring.test.js）。
process.env.BLUEBIRD_MONITORING = '1';

const toolWorkspace = require('../server/tool-workspace');
const agentRuntime = require('../server/agent-runtime');
const monitoring = require('../server/monitoring');

monitoring.initMonitoring({ dataDir: path.join(TMP, 'monitoring') });

test.after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {
    // ignore
  }
});

function runTool(definition, args) {
  const checked = definition.validate(args);
  if (!checked.ok) return { ok: false, code: 'validation_failed', error: checked.error };
  return definition.handler(checked.args);
}

function workspacePath(rel) {
  return path.join(toolWorkspace.WORKSPACE_ROOT, ...rel.split('/'));
}

test('a. 工作区根目录随模块加载自动创建', () => {
  assert.equal(fs.existsSync(toolWorkspace.WORKSPACE_ROOT), true);
  assert.ok(toolWorkspace.WORKSPACE_ROOT.startsWith(TMP), '根目录必须落在临时 BLUEBIRD_DATA_DIR 内');
});

test('b. workspace_list：默认根目录 + 子目录条目含 name/type/size/mtime', async () => {
  const empty = await runTool(toolWorkspace.workspaceListDefinition, {});
  assert.equal(empty.ok, true);
  assert.equal(empty.path, '.');
  assert.equal(empty.count, 0);

  await runTool(toolWorkspace.workspaceWriteDefinition, { path: 'notes/todo.md', content: '# 今日\n' });
  const listed = await runTool(toolWorkspace.workspaceListDefinition, { path: 'notes' });
  assert.equal(listed.ok, true);
  assert.equal(listed.count, 1);
  const entry = listed.entries[0];
  assert.equal(entry.name, 'todo.md');
  assert.equal(entry.type, 'file');
  assert.ok(entry.size > 0);
  assert.ok(typeof entry.mtime === 'string' && entry.mtime.includes('T'));

  const root = await runTool(toolWorkspace.workspaceListDefinition, {});
  const dirEntry = root.entries.find(item => item.name === 'notes');
  assert.ok(dirEntry, '根目录列表应包含 notes 目录');
  assert.equal(dirEntry.type, 'dir');
});

test('c. workspace_write create 快乐路径：父目录自动创建 + 字节数正确', async () => {
  const content = '# Bluebird 工作区\n第一条。\n';
  const result = await runTool(toolWorkspace.workspaceWriteDefinition, {
    path: 'deep/nested/plan.md',
    content,
  });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'create');
  assert.equal(result.bytes, Buffer.byteLength(content, 'utf8'));
  assert.equal(fs.readFileSync(workspacePath('deep/nested/plan.md'), 'utf8'), content);
});

test('d. create 已存在 → workspace_exists 且原内容不变', async () => {
  const first = await runTool(toolWorkspace.workspaceWriteDefinition, {
    path: 'keep.md',
    content: 'v1',
  });
  assert.equal(first.ok, true);
  const second = await runTool(toolWorkspace.workspaceWriteDefinition, {
    path: 'keep.md',
    content: 'v2-should-not-land',
  });
  assert.equal(second.ok, false);
  assert.equal(second.code, 'workspace_exists');
  assert.equal(fs.readFileSync(workspacePath('keep.md'), 'utf8'), 'v1');
});

test('e. append：追加到已有文件；文件不存在时等同创建', async () => {
  await runTool(toolWorkspace.workspaceWriteDefinition, { path: 'log.md', content: 'A', mode: 'create' });
  const appended = await runTool(toolWorkspace.workspaceWriteDefinition, {
    path: 'log.md',
    content: 'B',
    mode: 'append',
  });
  assert.equal(appended.ok, true);
  assert.equal(fs.readFileSync(workspacePath('log.md'), 'utf8'), 'AB');

  const fresh = await runTool(toolWorkspace.workspaceWriteDefinition, {
    path: 'log2.md',
    content: 'X',
    mode: 'append',
  });
  assert.equal(fresh.ok, true);
  assert.equal(fs.readFileSync(workspacePath('log2.md'), 'utf8'), 'X');
});

test('f. overwrite：覆盖生效 + 旧文件备份进 .history', async () => {
  await runTool(toolWorkspace.workspaceWriteDefinition, { path: 'doc.md', content: '旧内容-MARKER' });
  const overwritten = await runTool(toolWorkspace.workspaceWriteDefinition, {
    path: 'doc.md',
    content: '新内容',
    mode: 'overwrite',
  });
  assert.equal(overwritten.ok, true);
  assert.ok(overwritten.backup, '必须返回备份文件名');
  assert.equal(fs.readFileSync(workspacePath('doc.md'), 'utf8'), '新内容');
  const backupFull = workspacePath(`.history/${overwritten.backup}`);
  assert.equal(fs.existsSync(backupFull), true);
  assert.equal(fs.readFileSync(backupFull, 'utf8'), '旧内容-MARKER');
});

test('g. overwrite 备份保留最近 10 份', async () => {
  await runTool(toolWorkspace.workspaceWriteDefinition, { path: 'counter.md', content: 'c0' });
  for (let i = 1; i <= 12; i += 1) {
    const result = await runTool(toolWorkspace.workspaceWriteDefinition, {
      path: 'counter.md',
      content: `c${i}`,
      mode: 'overwrite',
    });
    assert.equal(result.ok, true);
  }
  const backups = fs
    .readdirSync(workspacePath('.history'))
    .filter(name => name.startsWith('counter.md.'));
  assert.ok(backups.length <= toolWorkspace.LIMITS.backupKeep, `备份份数 ${backups.length} 不得超过 10`);
  assert.equal(fs.readFileSync(workspacePath('counter.md'), 'utf8'), 'c12');
});

test('h. `..` 逃逸一律拒绝（write 与 read 同口径），且不产生工作区外文件', async () => {
  const evilWrite = await runTool(toolWorkspace.workspaceWriteDefinition, {
    path: '../evil.md',
    content: 'nope',
  });
  assert.equal(evilWrite.ok, false);
  assert.equal(evilWrite.code, 'workspace_path_outside');

  const evilRead = await runTool(toolWorkspace.workspaceReadDefinition, { path: '../.env' });
  assert.equal(evilRead.ok, false);
  assert.equal(evilRead.code, 'workspace_path_outside');

  const nestedEscape = await runTool(toolWorkspace.workspaceWriteDefinition, {
    path: 'a/../../b.md',
    content: 'nope',
  });
  assert.equal(nestedEscape.code, 'workspace_path_outside');

  assert.equal(fs.existsSync(path.join(TMP, 'evil.md')), false, '工作区外不得出现文件');
  assert.equal(fs.existsSync(path.join(TMP, 'b.md')), false);
});

test('i. 绝对路径一律拒绝（Windows 盘符与 POSIX 根路径两种形态）', async () => {
  const winStyle = await runTool(toolWorkspace.workspaceReadDefinition, {
    path: 'C:\\Windows\\system32\\drivers\\etc\\hosts',
  });
  assert.equal(winStyle.code, 'workspace_path_outside');
  const posixStyle = await runTool(toolWorkspace.workspaceReadDefinition, { path: '/etc/passwd' });
  assert.equal(posixStyle.code, 'workspace_path_outside');
  const absWrite = await runTool(toolWorkspace.workspaceWriteDefinition, {
    path: '/tmp/bluebird-escape.md',
    content: 'nope',
  });
  assert.equal(absWrite.code, 'workspace_path_outside');
});

test('j. 软链接/junction 逃逸：realpath 检查拒绝，读和写都拦', async () => {
  const outsideDir = path.join(TMP, 'outside-target');
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'outside-content-MARKER', 'utf8');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  fs.symlinkSync(outsideDir, workspacePath('escape'), linkType);

  const readEscape = await runTool(toolWorkspace.workspaceReadDefinition, {
    path: 'escape/secret.txt',
  });
  assert.equal(readEscape.ok, false);
  assert.equal(readEscape.code, 'workspace_path_outside');

  const writeEscape = await runTool(toolWorkspace.workspaceWriteDefinition, {
    path: 'escape/planted.md',
    content: 'nope',
  });
  assert.equal(writeEscape.ok, false);
  assert.equal(writeEscape.code, 'workspace_path_outside');
  assert.equal(
    fs.existsSync(path.join(outsideDir, 'planted.md')),
    false,
    '逃逸目标里不得出现新文件'
  );
});

test('k. 扩展名白名单：write 与 read 双侧拒绝非文本后缀', async () => {
  const envWrite = await runTool(toolWorkspace.workspaceWriteDefinition, {
    path: 'notes.env',
    content: 'KEY=value',
  });
  assert.equal(envWrite.code, 'workspace_extension_not_allowed');

  const exeWrite = await runTool(toolWorkspace.workspaceWriteDefinition, {
    path: 'run.exe',
    content: 'MZ',
  });
  assert.equal(exeWrite.code, 'workspace_extension_not_allowed');

  const noExt = await runTool(toolWorkspace.workspaceWriteDefinition, {
    path: 'README',
    content: 'x',
  });
  assert.equal(noExt.code, 'workspace_extension_not_allowed');

  fs.writeFileSync(workspacePath('real.env'), 'LEAK=1', 'utf8');
  const envRead = await runTool(toolWorkspace.workspaceReadDefinition, { path: 'real.env' });
  assert.equal(envRead.code, 'workspace_extension_not_allowed');
});

test('l. 单文件写入上限 256KB：超出即拒绝，文件不落盘', async () => {
  const tooBig = 'A'.repeat(toolWorkspace.LIMITS.writeMaxBytes + 1);
  const result = await runTool(toolWorkspace.workspaceWriteDefinition, {
    path: 'big.md',
    content: tooBig,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'workspace_file_too_large');
  assert.equal(fs.existsSync(workspacePath('big.md')), false);

  const exact = await runTool(toolWorkspace.workspaceWriteDefinition, {
    path: 'exact-256k.md',
    content: 'B'.repeat(toolWorkspace.LIMITS.writeMaxBytes),
  });
  assert.equal(exact.ok, true, '恰好 256KB 应当放行');
});

test('m. 总量上限：usage 汇总真实文件（含 .history），assertQuota 语义正确', async () => {
  const usage = toolWorkspace.workspaceUsage();
  const expected =
    fs.statSync(workspacePath('keep.md')).size +
    fs.statSync(workspacePath('log.md')).size +
    fs.statSync(workspacePath('log2.md')).size +
    fs.statSync(workspacePath('doc.md')).size +
    fs.statSync(workspacePath('counter.md')).size +
    fs.statSync(workspacePath('exact-256k.md')).size +
    fs.readdirSync(workspacePath('.history')).reduce(
      (sum, name) => sum + fs.statSync(workspacePath(`.history/${name}`)).size,
      0
    );
  assert.ok(usage >= expected, `usage ${usage} 至少应包含已写文件与备份 ${expected}`);
  assert.ok(usage > 0);

  // 不抛：当前 usage + 小增量。
  toolWorkspace.assertQuota(usage + 1024);
  // 抛：超过 50MB 上限（不真写 50MB，直接断言阈值语义）。
  assert.throws(
    () => toolWorkspace.assertQuota(toolWorkspace.LIMITS.totalMaxBytes + 1),
    error => error.code === 'workspace_quota_exceeded'
  );
  assert.throws(
    () => toolWorkspace.assertQuota(usage + toolWorkspace.LIMITS.totalMaxBytes),
    error => error.code === 'workspace_quota_exceeded'
  );
});

test('n. 读取上限 64KB：超出截断并在结果里说明', async () => {
  const content = 'C'.repeat(64 * 1024 + 100);
  const written = await runTool(toolWorkspace.workspaceWriteDefinition, {
    path: 'long.md',
    content,
  });
  assert.equal(written.ok, true, '70KB 在 256KB 写入上限内，应可创建');

  const read = await runTool(toolWorkspace.workspaceReadDefinition, { path: 'long.md' });
  assert.equal(read.ok, true);
  assert.equal(read.truncated, true);
  assert.equal(read.bytes, toolWorkspace.LIMITS.readMaxBytes);
  assert.equal(read.totalSize, Buffer.byteLength(content, 'utf8'));
  assert.ok(read.content.length <= toolWorkspace.LIMITS.readMaxBytes);
  assert.ok(read.summary.includes('截断'));

  const small = await runTool(toolWorkspace.workspaceReadDefinition, { path: 'keep.md' });
  assert.equal(small.truncated, false);
});

test('o. 注册面：三个工具注册，list/read 只读 risk=read，write high_risk', () => {
  const metadata = agentRuntime.listToolMetadata();
  const list = metadata.find(item => item.name === 'workspace_list');
  const read = metadata.find(item => item.name === 'workspace_read');
  const write = metadata.find(item => item.name === 'workspace_write');
  assert.ok(list && read && write, 'BLUEBIRD_WORKSPACE_TOOLS=1 时三个工具必须注册');
  assert.equal(list.readOnly, true);
  assert.equal(list.risk, 'read');
  assert.equal(read.readOnly, true);
  assert.equal(read.risk, 'read');
  assert.equal(write.readOnly, false);
  assert.equal(write.risk, 'high_risk');
});

test('p. 开关关闭时工具不注册（子进程验证两种开关态）', () => {
  const runtimePath = JSON.stringify(path.join(__dirname, '..', 'server', 'agent-runtime.js'));
  const outPath = path.join(TMP, 'child-registered.json');
  const script = `
    process.env.BLUEBIRD_DATA_DIR = process.env.CHILD_TMP;
    process.env.BLUEBIRD_MONITORING = '0';
    const fs = require('fs');
    const rt = require(${runtimePath});
    const names = rt.listToolMetadata().map(item => item.name);
    fs.writeFileSync(process.env.CHILD_OUT, JSON.stringify(names.filter(name => name.startsWith('workspace_'))));
  `;
  const baseEnv = {
    ...process.env,
    CHILD_TMP: path.join(TMP, 'child-env'),
    CHILD_OUT: outPath,
  };

  execFileSync(process.execPath, ['-e', script], {
    env: { ...baseEnv, BLUEBIRD_WORKSPACE_TOOLS: '0' },
    encoding: 'utf8',
  });
  const off = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.deepEqual(off, [], 'BLUEBIRD_WORKSPACE_TOOLS=0 时不得注册任何 workspace 工具');

  execFileSync(process.execPath, ['-e', script], {
    env: { ...baseEnv, BLUEBIRD_WORKSPACE_TOOLS: '1' },
    encoding: 'utf8',
  });
  const on = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.deepEqual(on.sort(), ['workspace_list', 'workspace_read', 'workspace_write']);
});

test('q. 运行层确认往返：主聊建 pending 不落盘；worker/无来源仍 deny-only', async () => {
  // 主聊直连（sessionId+userText、无 sideEffect）：pending 流（接法 a）——
  // 不写文件，返回确认凭据，参数进入待确认存储。
  const pending = await agentRuntime.executeToolCall(
    'workspace_write',
    { path: 'confirmed.md', content: 'should-not-write-yet' },
    { cache: new Map(), sessionId: 'session-1', userText: '在工作区建一个文件' }
  );
  assert.equal(pending.ok, true);
  assert.equal(pending.pending, true);
  assert.equal(pending.code, 'workspace_write_pending');
  assert.match(pending.confirmationId, /^wsw_[0-9a-f]{24}$/);
  assert.equal(
    fs.existsSync(workspacePath('confirmed.md')),
    false,
    '确认前绝不落盘'
  );
  const storePath = path.join(TMP, 'workspace-pending.json');
  const storeAfterCreate = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  assert.equal(storeAfterCreate.pending.length, 1);
  assert.equal(storeAfterCreate.pending[0].sessionId, 'session-1');
  assert.equal(storeAfterCreate.pending[0].path, 'confirmed.md');

  // 任务执行器路径（sideEffect 注入）：维持 deny-only，也不建 pending。
  const beforeWorker = storeAfterCreate.pending.length;
  const denied = await agentRuntime.executeToolCall(
    'workspace_write',
    { path: 'worker.md', content: 'x' },
    {
      cache: new Map(),
      sessionId: 'session-1',
      userText: 'x',
      sideEffect: {
        splitOverride: a => ({ args: a, override: null }),
        before: () => ({ mode: 'execute', opKey: 'k' }),
        blocked: () => false,
      },
    }
  );
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'confirmation_required');
  assert.equal(
    JSON.parse(fs.readFileSync(storePath, 'utf8')).pending.length,
    beforeWorker,
    'worker 路径不产生 pending'
  );

  // 缺来源上下文：维持 deny-only（ungrounded 不得进入确认流）。
  const ungrounded = await agentRuntime.executeToolCall(
    'workspace_write',
    { path: 'g.md', content: 'x' },
    { cache: new Map() }
  );
  assert.equal(ungrounded.ok, false);
  assert.equal(ungrounded.code, 'confirmation_required');

  // 只读工具不受影响：list 在同一运行层可正常执行。
  const listed = await agentRuntime.executeToolCall('workspace_list', {}, { cache: new Map() });
  assert.equal(listed.ok, true);
});

test('r. 监控埋点：workspace.op.completed 记 tool/path/mode/bytes，正文绝不入事件流', async () => {
  const marker = 'MONITOR-CONTENT-MARKER-9f3a';
  await runTool(toolWorkspace.workspaceWriteDefinition, {
    path: 'watched.md',
    content: `body ${marker}`,
  });
  await runTool(toolWorkspace.workspaceReadDefinition, { path: 'watched.md' });
  await runTool(toolWorkspace.workspaceWriteDefinition, {
    path: 'watched.md',
    content: 'replaced',
    mode: 'overwrite',
  });
  const deniedWrite = await runTool(toolWorkspace.workspaceWriteDefinition, {
    path: '../blocked.md',
    content: 'nope',
  });
  assert.equal(deniedWrite.ok, false);
  // list/read 的结构化拒绝同样要留痕（任务书④：每次调用记一条）。
  const deniedRead = await runTool(toolWorkspace.workspaceReadDefinition, {
    path: '../blocked-read.md',
  });
  assert.equal(deniedRead.ok, false);

  const events = monitoring
    .getEvents({ from: 0, to: Date.now(), limit: 500 })
    .items.filter(item => item.event_name === 'workspace.op.completed');
  assert.ok(events.length >= 5, `至少应记录 5 条工作区事件，实际 ${events.length}`);

  const writeEvent = events.find(
    item => item.attributes.tool === 'workspace_write' && item.status === 'success' && item.attributes.mode === 'create'
  );
  assert.ok(writeEvent, '必须有 create 成功事件');
  assert.equal(writeEvent.attributes.path, 'watched.md');
  assert.equal(writeEvent.attributes.bytes, Buffer.byteLength(`body ${marker}`, 'utf8'));

  const overwriteEvent = events.find(
    item => item.attributes.tool === 'workspace_write' && item.attributes.mode === 'overwrite'
  );
  assert.ok(overwriteEvent, 'overwrite 也要留痕');

  const deniedEvent = events.find(
    item => item.attributes.tool === 'workspace_write' && item.status === 'denied'
  );
  assert.ok(deniedEvent, '路径逃逸拒绝也要留痕');
  assert.equal(deniedEvent.attributes.code, 'workspace_path_outside');

  const deniedReadEvent = events.find(
    item => item.attributes.tool === 'workspace_read' && item.status === 'denied'
  );
  assert.ok(deniedReadEvent, 'read 的结构化拒绝也要留痕');
  assert.equal(deniedReadEvent.attributes.code, 'workspace_path_outside');

  const readEvent = events.find(
    item => item.attributes.tool === 'workspace_read' && item.status === 'success'
  );
  assert.ok(readEvent, 'read 成功也要留痕');
  assert.equal(readEvent.attributes.path, 'watched.md');

  const serialized = JSON.stringify(events);
  assert.equal(serialized.includes(marker), false, '文件正文绝不进入监控事件');
  assert.equal(serialized.includes('nope'), false, '被拒内容也不得进入监控事件');
  assert.equal(serialized.includes('C:\\') && serialized.includes('bluebird-workspace-tools'), false, '监控不得泄露绝对路径');
});

test('s. 参数校验：缺参 / 非法 mode / 超长路径 / 空字节', () => {
  assert.equal(toolWorkspace.workspaceWriteDefinition.validate({ path: 'a.md' }).ok, false);
  assert.equal(toolWorkspace.workspaceWriteDefinition.validate({ content: 'x' }).ok, false);
  assert.equal(
    toolWorkspace.workspaceWriteDefinition.validate({ path: 'a.md', content: 'x', mode: 'delete' }).ok,
    false
  );
  assert.equal(
    toolWorkspace.workspaceWriteDefinition.validate({ path: `${'a'.repeat(600)}`, content: 'x' }).ok,
    false
  );
  assert.equal(
    toolWorkspace.workspaceReadDefinition.validate({}).ok,
    false,
    'read 缺 path 必须拒绝'
  );
  assert.equal(
    toolWorkspace.workspaceListDefinition.validate({ path: '   ' }).ok,
    false,
    'list 的 path 不能是空字符串'
  );
});

test('t. 空字节路径：validate 放行，执行闸结构化拒绝', async () => {
  const result = await runTool(toolWorkspace.workspaceWriteDefinition, {
    path: 'a\0b.md',
    content: 'x',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'workspace_path_invalid');
  assert.equal(fs.existsSync(workspacePath('a\0b.md')), false);
});

test('u. Windows 专有绕过：.HISTORY 大小写与 NTFS ADS（含冒号路径）一律拒绝', async () => {
  const caseBypass = await runTool(toolWorkspace.workspaceWriteDefinition, {
    path: '.HISTORY/evil.md',
    content: 'nope',
  });
  assert.equal(caseBypass.code, 'workspace_path_reserved', '大小写变体必须命中保留区检查');

  const adsWrite = await runTool(toolWorkspace.workspaceWriteDefinition, {
    path: 'notes.md:hide.js',
    content: 'nope',
  });
  assert.equal(adsWrite.code, 'workspace_path_invalid', 'NTFS ADS（含冒号）必须拒绝');

  const adsRead = await runTool(toolWorkspace.workspaceReadDefinition, {
    path: 'notes.md:hide.js',
  });
  assert.equal(adsRead.code, 'workspace_path_invalid');
});

test('v. pending 预检：非白名单扩展名在建 pending 时即拒绝（oracle 低-2）', async () => {
  const pending = await agentRuntime.executeToolCall(
    'workspace_write',
    { path: 'run.exe', content: 'MZ' },
    { cache: new Map(), sessionId: 'session-1', userText: '建一个 exe' }
  );
  assert.equal(pending.ok, false);
  assert.equal(pending.code, 'workspace_extension_not_allowed');
  const storePath = path.join(TMP, 'workspace-pending.json');
  const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  assert.equal(
    store.pending.some(item => item.path === 'run.exe'),
    false,
    '预检拒绝的写入不得进入待确认存储'
  );
});
