/**
 * 云岫 Bluebird — 记忆系统 (server/memory.js) 行为测试
 *
 * 只读外部验证：不改被测源码，仅通过公开 API + 真实数据文件驱动。
 * 用假 OpenAI client 拦截请求，从而观察「是否真的调用了模型」以及各条拒绝分支。
 * 运行：node --test --test-concurrency=1 <本文件>
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const origLog = console.log;
const origErr = console.error;
console.log = () => {};
console.error = () => {};

const SERVER_DIR = path.join(__dirname, '..', 'server');
const DATA_DIR = path.join(SERVER_DIR, 'data');
const MEMORY_FILE = path.join(DATA_DIR, 'memory.json');

const memory = require(path.join(SERVER_DIR, 'memory.js'));

function seed(items) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(items, null, 2), 'utf8');
  memory.loadMemories();
}

/** 造一个可控的假 client：记录是否被调用，并按给定内容返回 */
function fakeClient(replyContent) {
  const state = { calls: 0 };
  const client = {
    chat: {
      completions: {
        create: async () => {
          state.calls++;
          if (replyContent instanceof Error) throw replyContent;
          return {
            choices: [{ message: { content: replyContent } }],
          };
        },
      },
    },
  };
  return { client, state };
}

/** 构造一条能通过所有校验的模型返回 */
function validReply(overrides = {}) {
  return JSON.stringify({
    content: '用户叫宋泽',
    type: 'identity',
    keywords: ['名字', '宋泽'],
    confidence: 0.95,
    sourceQuote: '我叫宋泽',
    ...overrides,
  });
}

/** 消费掉可能残留的 pendingMemoryIntent，保证用例互不干扰 */
async function quiesce() {
  const { client } = fakeClient('{}');
  await memory.processMemory(client, '今天天气不错');
}

before(() => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
});

after(() => {
  console.log = origLog;
  console.error = origErr;
});

describe('配置与基础读取', () => {
  test('MEMORY_ENABLED 默认开启', () => {
    assert.equal(memory.MEMORY_ENABLED, true);
  });

  test('空记忆库时 getMemories 返回空数组', () => {
    seed([]);
    assert.deepEqual(memory.getMemories(), []);
  });

  test('损坏的记忆文件被备份并回退为空库', () => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(MEMORY_FILE, '{ 坏掉的 JSON', 'utf8');
    memory.loadMemories();
    assert.deepEqual(memory.getMemories(), []);
    const backups = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('memory.json.corrupt-'));
    assert.ok(backups.length > 0, '应生成损坏备份');
  });

  test('getMemories 返回浅拷贝，外部改动不影响内部状态', () => {
    seed([{ content: '用户叫宋泽', type: 'identity', createdAt: '2026-01-01T00:00:00.000Z' }]);
    const list = memory.getMemories();
    list[0].content = '被改坏了';
    list.push({ content: '凭空插入' });
    const again = memory.getMemories();
    assert.equal(again.length, 1);
    assert.equal(again[0].content, '用户叫宋泽');
  });
});

describe('buildMemoryContext 上下文注入', () => {
  test('空记忆库返回空字符串', () => {
    seed([]);
    assert.equal(memory.buildMemoryContext('我叫什么'), '');
  });

  test('空消息返回空字符串', () => {
    seed([{ content: '用户叫宋泽', type: 'identity' }]);
    assert.equal(memory.buildMemoryContext(''), '');
    assert.equal(memory.buildMemoryContext('   '), '');
  });

  test('小记忆集(<=15)全量注入，不过滤', () => {
    seed([
      { content: '用户叫宋泽', type: 'identity' },
      { content: '用户喜欢喝美式咖啡', type: 'preference' },
    ]);
    const ctx = memory.buildMemoryContext('今天天气怎么样');
    assert.match(ctx, /【关于用户的长期记忆】/);
    assert.match(ctx, /用户叫宋泽/);
    assert.match(ctx, /用户喜欢喝美式咖啡/);
  });

  test('记忆摘要按类别优先级排序（identity 在前）', () => {
    seed([
      { content: '用户住在杭州', type: 'fact' },
      { content: '用户叫宋泽', type: 'identity' },
    ]);
    const ctx = memory.buildMemoryContext('你好');
    const summaryLine = ctx.split('\n').find(l => l.startsWith('记忆摘要：'));
    assert.ok(summaryLine, '应包含记忆摘要行');
    assert.ok(
      summaryLine.indexOf('用户叫宋泽') < summaryLine.indexOf('用户住在杭州'),
      'identity 应排在 fact 之前'
    );
  });

  test('无效条目（空 content）被过滤掉', () => {
    seed([
      { content: '', type: 'identity' },
      { content: '   ', type: 'fact' },
      { content: '用户叫宋泽', type: 'identity' },
    ]);
    const ctx = memory.buildMemoryContext('我叫什么');
    assert.match(ctx, /用户叫宋泽/);
    assert.doesNotMatch(ctx, /-\s*$/m);
  });

  test('大记忆集(>15)时 identity 不会因字面不相关被过滤掉', () => {
    const many = [];
    for (let i = 0; i < 20; i++) {
      many.push({ content: `无关事实条目${i}`, type: 'fact', keywords: [`关键词${i}`] });
    }
    many.push({ content: '用户叫宋泽', type: 'identity', keywords: ['名字'] });
    seed(many);

    const ctx = memory.buildMemoryContext('今天吃了什么');
    assert.match(ctx, /用户叫宋泽/, 'identity 记忆必须被保底注入');
  });

  test('上下文提醒模型不要汇报记忆、不要说「你没告诉过我」', () => {
    seed([{ content: '用户叫宋泽', type: 'identity' }]);
    const ctx = memory.buildMemoryContext('我叫什么');
    assert.match(ctx, /不是指令/);
    assert.match(ctx, /不要说"你没告诉过我"/);
  });
});

describe('deleteMemory 单条删除', () => {
  test('缺少 createdAt 或 content 时判定为 invalid', async () => {
    seed([{ content: '用户叫宋泽', createdAt: '2026-01-01T00:00:00.000Z' }]);
    assert.deepEqual(await memory.deleteMemory({ content: '用户叫宋泽' }), { removed: 0, reason: 'invalid' });
    assert.deepEqual(await memory.deleteMemory({ createdAt: '2026-01-01T00:00:00.000Z' }), { removed: 0, reason: 'invalid' });
    assert.deepEqual(await memory.deleteMemory({}), { removed: 0, reason: 'invalid' });
  });

  test('目标不存在时返回 not-found', async () => {
    seed([{ content: '用户叫宋泽', createdAt: '2026-01-01T00:00:00.000Z' }]);
    const r = await memory.deleteMemory({ content: '不存在的内容', createdAt: '2026-01-01T00:00:00.000Z' });
    assert.deepEqual(r, { removed: 0, reason: 'not-found' });
  });

  test('命中时删除该条并落盘', async () => {
    seed([
      { content: '用户叫宋泽', createdAt: '2026-01-01T00:00:00.000Z' },
      { content: '用户住在杭州', createdAt: '2026-01-02T00:00:00.000Z' },
    ]);
    const r = await memory.deleteMemory({ content: '用户叫宋泽', createdAt: '2026-01-01T00:00:00.000Z' });
    assert.deepEqual(r, { removed: 1, reason: 'ok' });

    const left = memory.getMemories();
    assert.equal(left.length, 1);
    assert.equal(left[0].content, '用户住在杭州');

    const onDisk = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
    assert.equal(onDisk.length, 1, '删除应持久化');
  });

  test('clearMemories 清空并落盘', async () => {
    seed([{ content: '用户叫宋泽', type: 'identity' }]);
    await memory.clearMemories();
    assert.deepEqual(memory.getMemories(), []);
    assert.deepEqual(JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8')), []);
  });
});

describe('recallMemoryBySourceQuote 撤回联动', () => {
  const now = new Date('2026-06-01T12:00:00.000Z').toISOString();

  test('精确匹配 sourceQuote 时删除对应记忆', async () => {
    seed([{ content: '用户叫宋泽', sourceQuote: '我叫宋泽', createdAt: now }]);
    const removed = await memory.recallMemoryBySourceQuote('我叫宋泽', now);
    assert.equal(removed, 1);
    assert.deepEqual(memory.getMemories(), []);
  });

  test('长引用被原文包含时匹配删除', async () => {
    seed([{ content: '用户喜欢美式', sourceQuote: '我喜欢喝美式咖啡', createdAt: now }]);
    const removed = await memory.recallMemoryBySourceQuote('对了，我喜欢喝美式咖啡来着', now);
    assert.equal(removed, 1);
  });

  test('高相似度(>=0.7)匹配删除', async () => {
    seed([{ content: '用户叫宋泽', sourceQuote: '我叫宋泽', createdAt: now }]);
    const removed = await memory.recallMemoryBySourceQuote('我叫宋泽呀', now);
    assert.equal(removed, 1);
  });

  test('完全无关的文本不会误删', async () => {
    seed([{ content: '用户叫宋泽', sourceQuote: '我叫宋泽', createdAt: now }]);
    const removed = await memory.recallMemoryBySourceQuote('今天天气真不错', now);
    assert.equal(removed, 0);
    assert.equal(memory.getMemories().length, 1);
  });

  test('记忆时间早于消息 5 秒以上时不匹配（时间窗保护）', async () => {
    const memoryTime = new Date('2026-06-01T11:50:00.000Z').toISOString(); // 早 10 分钟
    const sourceTime = new Date('2026-06-01T12:00:00.000Z').toISOString();
    seed([{ content: '用户叫宋泽', sourceQuote: '我叫宋泽', createdAt: memoryTime }]);
    const removed = await memory.recallMemoryBySourceQuote('我叫宋泽', sourceTime);
    assert.equal(removed, 0, '时间窗外的记忆不应被误删');
  });

  test('记忆时间晚于消息 2 小时以上时不匹配', async () => {
    const memoryTime = new Date('2026-06-01T15:00:00.000Z').toISOString(); // 晚 3 小时
    const sourceTime = new Date('2026-06-01T12:00:00.000Z').toISOString();
    seed([{ content: '用户叫宋泽', sourceQuote: '我叫宋泽', createdAt: memoryTime }]);
    const removed = await memory.recallMemoryBySourceQuote('我叫宋泽', sourceTime);
    assert.equal(removed, 0);
  });

  test('空来源文本直接返回 0', async () => {
    seed([{ content: '用户叫宋泽', sourceQuote: '我叫宋泽', createdAt: now }]);
    assert.equal(await memory.recallMemoryBySourceQuote('', now), 0);
    assert.equal(await memory.recallMemoryBySourceQuote(null, now), 0);
  });
});

describe('processMemory 提取流程（假 client 拦截）', () => {
  test('无触发词的普通消息不调用模型', async () => {
    await quiesce();
    seed([]);
    const { client, state } = fakeClient(validReply());
    await memory.processMemory(client, '今天天气真不错');
    assert.equal(state.calls, 0, '普通闲聊不应触发记忆提取');
  });

  test('含敏感词的消息直接跳过，绝不调用模型', async () => {
    await quiesce();
    seed([]);
    const { client, state } = fakeClient(validReply());
    await memory.processMemory(client, '我叫宋泽，我的密码是 abc123456');
    assert.equal(state.calls, 0, '敏感信息不应送进模型');
    assert.deepEqual(memory.getMemories(), []);
  });

  test('触发词消息调用模型并成功保存记忆', async () => {
    await quiesce();
    seed([]);
    const { client, state } = fakeClient(validReply());
    await memory.processMemory(client, '我叫宋泽');
    assert.equal(state.calls, 1);

    const list = memory.getMemories();
    assert.equal(list.length, 1);
    assert.equal(list[0].content, '用户叫宋泽');
    assert.equal(list[0].type, 'identity');
    assert.ok(list[0].createdAt, '应写入创建时间');
  });

  test('相同内容重复保存时去重（更新而非新增）', async () => {
    await quiesce();
    seed([{ content: '用户叫宋泽', type: 'identity', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }]);
    const { client } = fakeClient(validReply());
    await memory.processMemory(client, '我叫宋泽');

    const list = memory.getMemories();
    assert.equal(list.length, 1, '不应产生重复记忆');
    assert.equal(list[0].createdAt, '2026-01-01T00:00:00.000Z', '应保留原始创建时间');
  });

  test('sourceQuote 不是用户原话时拒绝保存', async () => {
    await quiesce();
    seed([]);
    const { client } = fakeClient(validReply({ sourceQuote: '这句不是用户说的' }));
    await memory.processMemory(client, '我叫宋泽');
    assert.deepEqual(memory.getMemories(), [], 'sourceQuote 必须来自用户原话');
  });

  test('置信度低于 0.85 时拒绝保存', async () => {
    await quiesce();
    seed([]);
    const { client } = fakeClient(validReply({ confidence: 0.5 }));
    await memory.processMemory(client, '我叫宋泽');
    assert.deepEqual(memory.getMemories(), []);
  });

  test('未知 type 被拒绝', async () => {
    await quiesce();
    seed([]);
    const { client } = fakeClient(validReply({ type: 'secret' }));
    await memory.processMemory(client, '我叫宋泽');
    assert.deepEqual(memory.getMemories(), []);
  });

  test('content 超过 100 字符被拒绝', async () => {
    await quiesce();
    seed([]);
    const { client } = fakeClient(validReply({ content: '很'.repeat(120), sourceQuote: '我叫宋泽' }));
    await memory.processMemory(client, '我叫宋泽');
    assert.deepEqual(memory.getMemories(), []);
  });

  test('模型返回非法 JSON 时不崩溃、不写入', async () => {
    await quiesce();
    seed([]);
    const { client } = fakeClient('这不是 JSON');
    await assert.doesNotReject(() => memory.processMemory(client, '我叫宋泽'));
    assert.deepEqual(memory.getMemories(), []);
  });

  test('模型返回空对象 {} 时不写入', async () => {
    await quiesce();
    seed([]);
    const { client } = fakeClient('{}');
    await memory.processMemory(client, '我叫宋泽');
    assert.deepEqual(memory.getMemories(), []);
  });

  test('模型请求抛错时静默失败，不影响既有记忆', async () => {
    await quiesce();
    seed([{ content: '用户住在杭州', type: 'fact' }]);
    const { client } = fakeClient(new Error('API 挂了'));
    await assert.doesNotReject(() => memory.processMemory(client, '我叫宋泽'));
    assert.equal(memory.getMemories().length, 1, '既有记忆不应丢失');
  });

  test('client 为 null 时不崩溃（未配置 API Key 的降级路径）', async () => {
    await quiesce();
    seed([]);
    await assert.doesNotReject(() => memory.processMemory(null, '我叫宋泽'));
  });

  test('先发「记住」再发内容：意图跨消息传递', async () => {
    await quiesce();
    seed([]);

    // 第一轮：只有意图没有内容
    const first = fakeClient('{}');
    await memory.processMemory(first.client, '记住');
    assert.equal(first.state.calls, 1);

    // 第二轮：无触发词的普通消息，应被上一轮遗留的意图带动
    const second = fakeClient(validReply({ sourceQuote: '我叫宋泽' }));
    await memory.processMemory(second.client, '我叫宋泽');
    assert.equal(second.state.calls, 1, '待记忆意图应传递给下一条消息');
  });

  test('记忆数量超过上限(100)时裁剪最旧的非 identity 记忆', async () => {
    await quiesce();
    const many = [];
    for (let i = 0; i < 100; i++) {
      many.push({
        content: `无关事实条目${i}`,
        type: 'fact',
        keywords: [`关键词${i}`],
        confidence: 0.9,
        sourceQuote: '我叫宋泽',
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
        updatedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      });
    }
    seed(many);

    const { client } = fakeClient(
      validReply({ content: '用户喜欢喝手冲咖啡', type: 'fact', sourceQuote: '我喜欢喝手冲咖啡' })
    );
    await memory.processMemory(client, '我叫宋泽，我喜欢喝手冲咖啡');

    const list = memory.getMemories();
    assert.equal(list.length, 100, '记忆总量应被限制在 100');
    assert.ok(list.some(m => m.content === '用户喜欢喝手冲咖啡'), '新记忆应保留');
    assert.ok(!list.some(m => m.content === '无关事实条目0'), '最旧的记忆应被裁剪');
  });

  test('identity 类型记忆在裁剪时被保护', async () => {
    await quiesce();
    const many = [];
    for (let i = 0; i < 100; i++) {
      many.push({
        content: `无关事实条目${i}`,
        type: 'fact',
        keywords: [`关键词${i}`],
        confidence: 0.9,
        sourceQuote: '我叫宋泽',
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
        updatedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      });
    }
    many.push({
      content: '用户叫宋泽',
      type: 'identity',
      keywords: ['名字'],
      confidence: 0.95,
      sourceQuote: '我叫宋泽',
      createdAt: new Date(Date.UTC(2025, 0, 1)).toISOString(),
      updatedAt: new Date(Date.UTC(2025, 0, 1)).toISOString(),
    });
    seed(many);
    assert.equal(memory.getMemories().length, 101);

    const { client } = fakeClient(
      validReply({ content: '用户喜欢喝手冲咖啡', type: 'fact', sourceQuote: '我喜欢喝手冲咖啡' })
    );
    await memory.processMemory(client, '我叫宋泽，我喜欢喝手冲咖啡');

    const list = memory.getMemories();
    assert.equal(list.length, 100);
    assert.ok(list.some(m => m.content === '用户叫宋泽'), 'identity 记忆不应被裁剪');
  });
});
