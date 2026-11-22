/**
 * Bluebird 文件页工作区 API：服务级回归测试。
 * 所有测试都指向独立临时工作区，避免触碰实际个人文件。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const test = require('node:test');
const assert = require('node:assert/strict');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-workspace-files-'));
process.env.BLUEBIRD_DATA_DIR = TMP;
process.env.BLUEBIRD_WORKSPACE_DIR = path.join(TMP, 'workspace');
process.env.BLUEBIRD_MONITORING = '0';

const workspace = require('../server/tool-workspace');
const { createWorkspaceFileService, UPLOAD_MAX_BYTES } = require('../server/routes/workspace-files');
const service = createWorkspaceFileService();
const ROOT = workspace.WORKSPACE_ROOT;
const full = relative => path.join(ROOT, ...relative.split('/'));
const version = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

test('浏览/搜索：按修改时间倒序、递归匹配，隐藏 .history 与符号链接', async () => {
  fs.mkdirSync(full('notes'), { recursive: true });
  fs.mkdirSync(full('.history'), { recursive: true });
  fs.writeFileSync(full('older.md'), 'old');
  fs.writeFileSync(full('notes/newest.md'), 'new');
  fs.writeFileSync(full('.history/secret.md'), 'backup');
  const oldDate = new Date('2025-01-01T00:00:00Z');
  const newDate = new Date('2026-01-01T00:00:00Z');
  fs.utimesSync(full('older.md'), oldDate, oldDate);
  fs.utimesSync(full('notes/newest.md'), newDate, newDate);
  fs.utimesSync(full('notes'), newDate, newDate);
  const outside = path.join(TMP, 'outside.md');
  fs.writeFileSync(outside, 'outside');
  try { fs.symlinkSync(outside, full('linked.md')); } catch (_) {}

  const listed = await service.list({ path: '.' });
  assert.deepEqual(listed.entries.slice(0, 2).map(item => item.path), ['notes', 'older.md']);
  assert.equal(listed.entries.some(item => item.path.startsWith('.history/')), false);
  assert.equal(listed.entries.some(item => item.name === 'linked.md'), false);
  const found = await service.list({ path: '.', search: 'newest' });
  assert.equal(found.entries.length, 1);
  assert.equal(found.entries[0].path, 'notes/newest.md');
});

test('所有文件 API 路径均受工作区 realpath 沙箱约束', async () => {
  await assert.rejects(service.list({ path: '../outside' }), error => error.code === 'workspace_path_outside');
  assert.throws(() => service.readText({ path: '../outside.md' }), error => error.code === 'workspace_path_outside');
  assert.throws(() => service.deleteFile({ path: '../outside.md', confirm: true }), error => error.code === 'workspace_path_outside');
  await assert.rejects(service.upload({ directory: '../', name: 'escape.bin', base64: Buffer.from('x').toString('base64') }), error => error.code === 'workspace_path_outside');
  assert.equal(fs.existsSync(path.join(TMP, 'outside', 'escape.bin')), false);

  const outsideDir = path.join(TMP, 'external');
  fs.mkdirSync(outsideDir, { recursive: true });
  try { fs.symlinkSync(outsideDir, full('escape'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (process.platform !== 'win32') throw error; }
  if (fs.existsSync(full('escape'))) {
    await assert.rejects(service.list({ path: 'escape' }), error => error.code === 'workspace_path_outside');
  }
});

test('文本保存：成功备份旧稿；保存前后版本不符时保护 Blue 的改动', async () => {
  fs.writeFileSync(full('editable.md'), '原稿');
  const opened = service.readText({ path: 'editable.md' });
  assert.equal(opened.version, version(Buffer.from('原稿')));
  assert.equal(opened.editable, true);
  const saved = await service.saveText({ path: 'editable.md', content: '用户修改', expectedVersion: opened.version });
  assert.equal(fs.readFileSync(full('editable.md'), 'utf8'), '用户修改');
  assert.equal(saved.version, version(Buffer.from('用户修改')));
  assert.ok(saved.backup);
  assert.equal(fs.readFileSync(full(`.history/${saved.backup}`), 'utf8'), '原稿');

  const beforeRace = service.readText({ path: 'editable.md' });
  const originalReadFileSync = fs.readFileSync;
  let injectedBlueWrite = false;
  fs.readFileSync = function (filePath, ...args) {
    const isTarget = path.resolve(String(filePath)) === path.resolve(full('editable.md'));
    const bytes = originalReadFileSync.call(fs, filePath, ...args);
    if (isTarget && !injectedBlueWrite) {
      injectedBlueWrite = true;
      fs.writeFileSync(full('editable.md'), 'Blue 在保存临界区改了文件');
    }
    return bytes;
  };
  try {
    await assert.rejects(
      service.saveText({ path: 'editable.md', content: '不应覆盖 Blue', expectedVersion: beforeRace.version }),
      error => error.code === 'workspace_version_conflict' && error.status === 409
    );
    assert.equal(fs.readFileSync(full('editable.md'), 'utf8'), 'Blue 在保存临界区改了文件');
  } finally {
    fs.readFileSync = originalReadFileSync;
  }

  fs.writeFileSync(full('note.markdown'), 'markdown');
  assert.equal(service.readText({ path: 'note.markdown' }).editable, true);
  const latest = service.readText({ path: 'note.markdown' });
  await service.saveText({ path: 'note.markdown', content: 'saved markdown', expectedVersion: latest.version });
  assert.equal(fs.readFileSync(full('note.markdown'), 'utf8'), 'saved markdown');
});

test('删除：未显式确认拒绝，确认后仅删除工作区普通文件', () => {
  fs.writeFileSync(full('delete-me.txt'), 'bye');
  assert.throws(() => service.deleteFile({ path: 'delete-me.txt' }), error => error.code === 'workspace_delete_confirmation_required');
  assert.equal(fs.existsSync(full('delete-me.txt')), true);
  assert.deepEqual(service.deleteFile({ path: 'delete-me.txt', confirm: true }), { ok: true, path: 'delete-me.txt' });
  assert.equal(fs.existsSync(full('delete-me.txt')), false);
  fs.mkdirSync(full('folder'), { recursive: true });
  assert.throws(() => service.deleteFile({ path: 'folder', confirm: true }), error => error.code === 'workspace_not_a_file');
});

test('上传：重名先冲突，用户选择保留两份或覆盖后内容完整', async () => {
  fs.writeFileSync(full('asset.bin'), Buffer.from([0, 1, 2, 250, 255]));
  const incoming = Buffer.from([255, 0, 17, 128, 42]);
  const base64 = incoming.toString('base64');
  await assert.rejects(service.upload({ name: 'asset.bin', base64 }), error => error.code === 'workspace_file_exists' && error.status === 409);
  assert.deepEqual(fs.readFileSync(full('asset.bin')), Buffer.from([0, 1, 2, 250, 255]));

  const kept = await service.upload({ name: 'asset.bin', base64, onConflict: 'keep-both' });
  assert.equal(kept.name, 'asset (2).bin');
  assert.deepEqual(fs.readFileSync(full(kept.path)), incoming);
  const overwritten = await service.upload({ name: 'asset.bin', base64, onConflict: 'overwrite' });
  assert.equal(overwritten.path, 'asset.bin');
  assert.deepEqual(fs.readFileSync(full('asset.bin')), incoming);
  const backups = fs.readdirSync(full('.history')).filter(name => name.startsWith('asset.bin.'));
  assert.equal(backups.length, 1);
  assert.deepEqual(fs.readFileSync(full(`.history/${backups[0]}`)), Buffer.from([0, 1, 2, 250, 255]));
  const binary = service.readBinary({ path: 'asset.bin' });
  const chunks = [];
  for await (const chunk of binary.stream) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), incoming);
  assert.equal(Object.hasOwn(binary, 'bytes'), false);
});

test('上传配额检查先于备份，超限不会改变旧文件或留下备份', async () => {
  fs.writeFileSync(full('quota.bin'), 'original');
  const oldAssertQuota = workspace.assertQuota;
  workspace.assertQuota = () => { const error = new Error('quota'); error.code = 'workspace_quota_exceeded'; throw error; };
  try {
    await assert.rejects(
      service.upload({ name: 'quota.bin', base64: Buffer.from('replacement').toString('base64'), onConflict: 'overwrite' }),
      error => error.code === 'workspace_quota_exceeded' && error.status === 413
    );
  } finally {
    workspace.assertQuota = oldAssertQuota;
  }
  assert.equal(fs.readFileSync(full('quota.bin'), 'utf8'), 'original');
  assert.equal(fs.readdirSync(full('.history')).some(name => name.startsWith('quota.bin.')), false);
});

test('覆盖时拒绝被替换为外部符号链接的 .history，不写入或删除工作区外文件', async () => {
  const history = full('.history');
  const savedHistory = full('.history-saved-for-symlink-test');
  const externalHistory = path.join(TMP, 'external-history');
  fs.rmSync(savedHistory, { recursive: true, force: true });
  if (fs.existsSync(history)) fs.renameSync(history, savedHistory);
  fs.mkdirSync(externalHistory, { recursive: true });
  const externalMarker = path.join(externalHistory, 'keep.txt');
  fs.writeFileSync(externalMarker, 'must remain');
  fs.writeFileSync(full('symlink-protected.bin'), 'original');
  fs.symlinkSync(externalHistory, history, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    await assert.rejects(
      service.upload({
        name: 'symlink-protected.bin',
        base64: Buffer.from('replacement').toString('base64'),
        onConflict: 'overwrite',
      }),
      error => error.code === 'workspace_upload_failed'
    );
    assert.equal(fs.readFileSync(full('symlink-protected.bin'), 'utf8'), 'original');
    assert.deepEqual(fs.readdirSync(externalHistory), ['keep.txt']);
    assert.equal(fs.readFileSync(externalMarker, 'utf8'), 'must remain');
  } finally {
    fs.unlinkSync(history);
    if (fs.existsSync(savedHistory)) fs.renameSync(savedHistory, history);
    else fs.mkdirSync(history);
  }
});

test('上传拒绝非法 base64、路径分隔符与超过 10 MiB 的正文', async () => {
  await assert.rejects(service.upload({ name: '../escape.bin', base64: Buffer.from('x').toString('base64') }), error => error.code === 'workspace_path_invalid');
  await assert.rejects(service.upload({ name: 'bad.bin', base64: 'not base64!' }), error => error.code === 'bad_request');
  const oversized = 'A'.repeat(Math.ceil(UPLOAD_MAX_BYTES / 3) * 4 + 12);
  await assert.rejects(service.upload({ name: 'large.bin', base64: oversized }), error => error.code === 'bad_request');
  assert.equal(fs.existsSync(full('large.bin')), false);
});
