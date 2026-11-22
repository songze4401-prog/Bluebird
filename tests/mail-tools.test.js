/**
 * R9（邮件工具）纯函数面回归：tool-mail 的解析/校验/组装。
 *
 * spawn 链（runParsed→agently-cli）不经真实网络与真实邮箱；子进程链路
 * 由手工冒烟探针另行补证（本文件聚焦纯函数面，刻意不写子进程 stub）。
 * 覆盖：
 *  a) 只读硬拦：白名单 + 黑名单双重防护（写类子命令/写类参数全拦）；
 *  b) parseCliJson：混合输出容错（tip 行过滤 + 大括号截取）；
 *  c) assertSendArgs：多收件人清洗、非法邮箱/空主题/空正文拦截；
 *  d) buildSendArgs：+send 与 +reply 的 CLI 参数组装形态；
 *  e) cleanText：HTML 清洗（style/script/标签/实体）。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 子路径 imports 别名（package.json #server/* → ./server/*.js）：静态字面量加载
const toolMail = require('#server/tool-mail');
const { normalize } = toolMail;

test('a. 只读硬拦：白名单 + 黑名单双重防护', async () => {
  // 白名单外一律拒绝
  assert.throws(() => normalize.assertReadonly(['message', '+send', '--to', 'a@b.com']), /只读工具禁止/);
  assert.throws(() => normalize.assertReadonly(['message', '+reply', '--id', 'm1']), /只读工具禁止/);
  assert.throws(() => normalize.assertReadonly(['+send', '--to', 'a@b.com']), /只读工具禁止/);
  // 白名单内放行
  assert.doesNotThrow(() => normalize.assertReadonly(['message', '+list']));
  assert.doesNotThrow(() => normalize.assertReadonly(['message', '+search', '--q', 'x']));
  assert.doesNotThrow(() => normalize.assertReadonly(['message', '+read', '--id', 'm1']));
  // 黑名单词即使混在参数里也拦（mail-watch 同款）
  assert.throws(() => normalize.assertReadonly(['message', '+list', '--dry-run', '+delete']), /只读工具禁止/);
  assert.throws(() => normalize.assertReadonly(['message', '+list', '--body-file', '+upload']), /只读工具禁止/);
  for (const token of ['--confirmation-token', '--confirmation-token=secret', '--body-file', '--body-file=body.txt', '+attachment', '--attachment', '--attachment-file']) {
    assert.throws(() => normalize.assertReadonly(['message', '+list', token]), /只读工具禁止/);
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-tools-'));
  const cliFile = path.join(tempDir, 'fake-cli.js');
  const argsFile = path.join(tempDir, 'args.json');
  const previousCli = process.env.AGENTLY_CLI;
  const previousArgsFile = process.env.MAIL_ARGS_FILE;
  fs.writeFileSync(cliFile, [
    "require('fs').writeFileSync(process.env.MAIL_ARGS_FILE, JSON.stringify(process.argv.slice(2)));",
    "process.stdout.write(JSON.stringify({ok:true,data:{data:[],pagination:{next_cursor:'next-page',has_more:true}}}));",
  ].join('\n'));
  process.env.AGENTLY_CLI = cliFile;
  process.env.MAIL_ARGS_FILE = argsFile;
  try {
    const search = toolMail.mailDefinitions.find(definition => definition.name === 'mail_search');
    assert.equal(search.parameters.properties.cursor.type, 'string');
    const result = await search.handler({ query: 'project', cursor: 'page-2' });
    assert.equal(result.nextCursor, 'next-page');
    assert.equal(result.hasMore, true);
    const cliArgs = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
    assert.deepEqual(cliArgs.slice(-2), ['--cursor', 'page-2']);

    fs.unlinkSync(argsFile);
    await assert.rejects(search.handler({ query: 'project', cursor: '--body-file' }), /只读工具禁止/);
    assert.equal(fs.existsSync(argsFile), false, '拒绝危险游标前不应启动 CLI');
  } finally {
    if (previousCli === undefined) delete process.env.AGENTLY_CLI;
    else process.env.AGENTLY_CLI = previousCli;
    if (previousArgsFile === undefined) delete process.env.MAIL_ARGS_FILE;
    else process.env.MAIL_ARGS_FILE = previousArgsFile;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('b. parseCliJson：混合输出容错', () => {
  assert.deepEqual(
    normalize.parseCliJson('tip: loading\n{"ok":true,"data":{"data":[1]}}'),
    { ok: true, data: { data: [1] } }
  );
  assert.deepEqual(normalize.parseCliJson('{"ok":true}'), { ok: true });
  assert.deepEqual(
    normalize.parseCliJson('noise before {"ok":false,"error":{"message":"x"}} noise after'),
    { ok: false, error: { message: 'x' } }
  );
  assert.equal(normalize.parseCliJson('no json here'), null);
  assert.equal(normalize.parseCliJson(''), null);
  assert.equal(normalize.parseCliJson(null), null);
});

test('c. assertSendArgs：清洗与拦截', () => {
  assert.deepEqual(
    normalize.assertSendArgs({ to: ['a@b.com', ' c@d.com '], subject: ' Hi ', body: ' hello ' }, true),
    { to: ['a@b.com', 'c@d.com'], subject: 'Hi', body: 'hello' }
  );
  assert.throws(() => normalize.assertSendArgs({ to: [], subject: 's', body: 'b' }, true), /to 不能为空/);
  assert.throws(() => normalize.assertSendArgs({ to: ['not-an-email'], subject: 's', body: 'b' }, true), /邮箱格式非法/);
  assert.throws(() => normalize.assertSendArgs({ to: ['a@b.com'], subject: '', body: 'b' }, true), /subject 不能为空/);
  assert.throws(() => normalize.assertSendArgs({ to: ['a@b.com'], subject: 's', body: '' }, true), /body 不能为空/);
});

test('d. buildSendArgs：CLI 参数组装形态', () => {
  assert.deepEqual(
    normalize.buildSendArgs('send', { to: ['a@b.com', 'c@d.com'], subject: 'Hi', body: 'hello', cc: ['x@y.com'] }),
    ['message', '+send', '--to', 'a@b.com', '--to', 'c@d.com', '--cc', 'x@y.com', '--subject', 'Hi', '--body', 'hello']
  );
  assert.deepEqual(
    normalize.buildSendArgs('reply', { id: 'msg_1', to: [], body: '回', cc: [] }),
    ['message', '+reply', '--id', 'msg_1', '--body', '回']
  );
  assert.deepEqual(
    normalize.buildSendArgs('send', { to: ['a@b.com'], subject: 's', body: 'b', cc: ['bad', 'ok@x.com'] }),
    ['message', '+send', '--to', 'a@b.com', '--cc', 'ok@x.com', '--subject', 's', '--body', 'b']
  );
});

test('e. cleanText：HTML 清洗', () => {
  assert.equal(normalize.cleanText('<p>正文</p>'), '正文');
  assert.equal(normalize.cleanText('<style>x{}</style><script>y()</script>保留'), '保留');
  assert.equal(normalize.cleanText('&amp;&lt;&gt;&nbsp;'), '&<>');
  assert.equal(normalize.cleanText('  多   空格  '), '多 空格');
});
