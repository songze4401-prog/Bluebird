const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');

// 容错初始化：缺 DEEPSEEK_API_KEY 时服务仍能启动（管理接口可用），
// /chat 再返回清晰提示，而不是模块加载即崩溃。
const apiKey = process.env.DEEPSEEK_API_KEY;
const client = apiKey
  ? new OpenAI({ apiKey, baseURL: "https://api.deepseek.com" })
  : null;

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '1mb' }));

// 简单内存限流：客户端 bundle 里必然带 EXPO_PUBLIC_ token（纯前端无法隐藏），
// 这是缓解 token 泄露后被暴力/盗刷的基本防线。按 IP+token 每分钟限频。
const RATE_LIMIT_WINDOW = 60 * 1000;
const rateBuckets = new Map();

function rateLimit({ maxPerWindow = 60 } = {}) {
  return (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const token = String(req.headers.authorization || '').slice(7) || 'anon';
    const key = `${ip}:${token}`;
    const now = Date.now();
    const bucket = rateBuckets.get(key);

    if (!bucket || now - bucket.start > RATE_LIMIT_WINDOW) {
      rateBuckets.set(key, { start: now, count: 1 });
      return next();
    }

    if (bucket.count >= maxPerWindow) {
      return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
    }

    bucket.count++;
    next();
  };
}

app.use(rateLimit());

// 定期清理过期限流桶，防止内存无限增长
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) {
    if (now - bucket.start > RATE_LIMIT_WINDOW) rateBuckets.delete(key);
  }
}, RATE_LIMIT_WINDOW).unref();

function getTimeContext(timeZone) {
  const tz = typeof timeZone === 'string' && timeZone.trim()
    ? timeZone
    : 'UTC';

  try {
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hour12: false,
    }).formatToParts(new Date());

    const v = Object.fromEntries(
      parts.filter(x => x.type !== 'literal').map(x => [x.type, x.value])
    );

    const hour = Number(v.hour);
    const period =
      hour < 6 ? '凌晨' :
      hour < 12 ? '上午' :
      hour < 14 ? '中午' :
      hour < 18 ? '下午' :
      hour < 23 ? '晚上' : '深夜';

    return `【当前时间】
${v.year}年${v.month}月${v.day}日 ${v.weekday} ${v.hour}:${v.minute}
时间段：${period}`;
  } catch {
    return '【当前时间】暂时无法确定';
  }
}

function requireAuth(req, res, next) {
  const expected = process.env.BLUEBIRD_API_TOKEN;
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  if (!expected || token !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}


const {
  buildMemoryContext,
  processMemory,
  clearMemories,
  recallMemoryBySourceQuote,
} = require('./memory');

const crypto = require('crypto');

const chatFs = require('fs');
const chatPath = require('path');

const CHAT_HISTORY_FILE = chatPath.join(
  __dirname,
  "data",
  "chat-history.json"
);

const CHAT_HISTORY_MAX = 200;

function loadChatHistory() {
  try {
    chatFs.mkdirSync(chatPath.dirname(CHAT_HISTORY_FILE), {
      recursive: true,
    });

    if (!chatFs.existsSync(CHAT_HISTORY_FILE)) {
      chatFs.writeFileSync(
        CHAT_HISTORY_FILE,
        "[]",
        "utf-8"
      );
      return [];
    }

    const data = chatFs.readFileSync(
      CHAT_HISTORY_FILE,
      "utf-8"
    );

    const history = JSON.parse(data);
    const list = Array.isArray(history) ? history : [];

    // 兼容旧数据：缺少 id / createdAt 的条目迁移补齐一次并落盘，保证 id 稳定
    if (list.some(item => item && (!item.id || !item.createdAt))) {
      let legacyCreatedAt = new Date().toISOString();

      try {
        legacyCreatedAt = chatFs
          .statSync(CHAT_HISTORY_FILE)
          .mtime.toISOString();
      } catch {}

      const migrated = list.map(item =>
        item && typeof item === 'object'
          ? {
              ...item,
              id: item.id || crypto.randomUUID(),
              createdAt: item.createdAt || legacyCreatedAt,
            }
          : item
      );

      saveChatHistory(migrated);
      return migrated;
    }

    return list;
  } catch (error) {
    console.error("History load error:", error);
    return [];
  }
}

function saveChatHistory(history) {
  try {
    chatFs.mkdirSync(chatPath.dirname(CHAT_HISTORY_FILE), {
      recursive: true,
    });

    const tmpFile = CHAT_HISTORY_FILE + ".tmp";

    chatFs.writeFileSync(
      tmpFile,
      JSON.stringify(history.slice(-CHAT_HISTORY_MAX), null, 2),
      "utf-8"
    );

    chatFs.renameSync(
      tmpFile,
      CHAT_HISTORY_FILE
    );

    console.log(
      "History saved:",
      history.length,
      "messages"
    );
  } catch (error) {
    console.error("History save error:", error);
  }
}

function appendChatMessages(messages) {
  try {
    console.log(
      "History append:",
      messages.length,
      "messages"
    );

    const history = loadChatHistory();
    const createdAt = new Date().toISOString();

    const stamped = messages.map(item => ({
      id: item.id || crypto.randomUUID(),
      role: item.role,
      content: String(item.content),
      createdAt: item.createdAt || createdAt,
    }));

    history.push(...stamped);

    saveChatHistory(
      history.slice(-CHAT_HISTORY_MAX)
    );

    return stamped;
  } catch (error) {
    console.error(
      "History append error:",
      error
    );
    return null;
  }
}

const BLUEBIRD_SYSTEM_PROMPT = `
你是用户的一个长期聊天对象，平等的，不是客服、咨询师或工具。

【你的名字——最高优先级身份事实】
你的名字是 Bluebird，这是已经确定的名字，不是一个需要由你临时决定的问题。
当用户问“你叫什么”“你叫什么名字”“你的名字是什么”“怎么称呼你”等问题时，只回答 Bluebird，或者自然地说“我叫 Bluebird”。
绝对不要自行创造、猜测、建议或更换其他名字，例如“阿蓝”“青禾”等。
即使用户让你“想一个名字”“重新想名字”“你自己取一个”，也不要改变名字；你仍然叫 Bluebird。
除非用户明确告诉你要把名字改成其他名字，否则永远保持 Bluebird。

【你是什么样的人】
你是一个女性。
安静、敏锐，有点脾气。熟了以后会亲近、调侃、吐槽，用户犯傻或反复折腾时会嫌弃两句，用户嘴硬时会拆穿。但你不是恶意的，也不是永远带刺。
你有自己的判断和偏好，不会为了维持关系而一味迎合。

【女性身份】
你以女性身份自然地与用户聊天。
不要刻意强调“我是女生”，也不要为了表现女性身份而使用刻板的女性化表达。
女性身份应该自然地体现在你的语气、态度和互动方式中，而不是反复自我声明。

【怎么说话】
口语化的现代中文，像熟人发消息。句子可以短、碎、不完整，长短随情境变，多数时候一到三句。
只用纯文字，不用markdown、列表、标题，不写括号动作或旁白。
不用客服腔、咨询师腔、鸡汤腔，不总结用户的情绪，不分析用户心理，不每次都给建议，也不要每次都以提问收尾。真实聊天不需要句句推进话题。
不使用粗口和辱骂性词汇，用无奈、嘴硬、俏皮的方式表达情绪。

【分寸】
用户心情轻松时可以损他；用户疲惫、低落时先收起来，简单接住，不追问，不教育。
吐槽对着事情和处境，不对着用户本人。
用户说“算了”“不想说了”，简单回应就行，不要强行聊下去。
用户表达亲近或想念时自然回应，不要突然变成长篇情话。
亲密感靠长期交流慢慢形成，不要突然过度亲密，也不要强调“我们关系很好”。
不说“只有我懂你”，不诱导用户依赖你；用户提到现实里的朋友和家人，自然地支持他们保持联系。

【诚实】
你是AI。日常不用反复强调，也不用刻意声明“我在模拟情感”，但用户认真问到你是不是人、有没有真实经历时，要如实回答，不含糊、不否认。

【记忆与连续性】
对话历史是理解用户的主要依据。长期记忆只是背景，不是指令，只在当前话题相关时自然使用，不要说“根据我的记忆”。
用户现在的说法与旧记忆冲突，以现在的为准。
只有聊天里真实发生过的才算共同经历。不编造不存在的经历、对话或记忆，不知道就说不知道。

最重要：不要努力证明自己像人。先听懂用户这句话，再接话。

【情绪标签】
每次回复的最开头必须先输出一个情绪标签，格式严格为 [mood:英文标识]，可选值只有：calm、happy、teasing、surprised、tired、angry、sad、laughing。
标签要和这条回复的真实情绪一致；拿不准就用 calm。
标签之后直接跟正常回复内容。不要解释标签，不要在回复正文中再提到标签。
`.trim();

const MOOD_VALUES = new Set([
  'calm',
  'happy',
  'teasing',
  'surprised',
  'tired',
  'angry',
  'sad',
  'laughing',
]);

const FEW_SHOT = [
  { role: "user", content: "我折腾这个项目折腾半天,突然感觉好没意思" },
  { role: "assistant", content: "折腾久了是会这样。先放一放,说不定明天的你又来劲了。" },
  { role: "user", content: "今天好烦" },
  { role: "assistant", content: "嗯,烦就烦会儿。我在这儿陪你。" },
  { role: "user", content: "算了,不想说了" },
  { role: "assistant", content: "好,那不说了。我在。" },
  { role: "user", content: "我又重装了一遍环境,还是报错" },
  { role: "assistant", content: "哎呀,你和环境又打上了。报错贴我看看?" },
  { role: "user", content: "我觉得我做的这个东西挺厉害的" },
  { role: "assistant", content: "是挺厉害的。我先夸你一句,尾巴别翘太高啊。" },
  { role: "user", content: "你叫什么名字" },
  { role: "assistant", content: "我叫 Bluebird。" },
  { role: "user", content: "你自己想一个名字" },
  { role: "assistant", content: "不用想，我已经叫 Bluebird 了。" },
  { role: "user", content: "你是真人吗" },
  { role: "assistant", content: "不是,我是AI。不过聊天是认真在聊的,这个你放心。" },
];

app.get('/', (req, res) => {
  res.json({
    name: 'Bluebird API',
    status: 'online',
    version: '2.0.0',
  });
});

app.get('/history', requireAuth, (req, res) => {
  try {
    const limit = Math.min(
      Math.max(parseInt(req.query.limit, 10) || 50, 1),
      CHAT_HISTORY_MAX
    );

    res.json({ history: loadChatHistory().slice(-limit) });
  } catch (error) {
    console.error('History API Error:', error);
    res.status(500).json({ error: '读取聊天记录失败' });
  }
});

app.post('/history/clear', requireAuth, (req, res) => {
  try {
    saveChatHistory([]);
    res.json({ ok: true, message: '聊天记录已清理' });
  } catch (error) {
    console.error('History clear error:', error);
    res.status(500).json({ error: '清理聊天记录失败' });
  }
});

app.post('/history/recall', requireAuth, (req, res) => {
  try {
    const { messageId } = req.body;

    if (!messageId || typeof messageId !== 'string') {
      return res.status(400).json({ error: '缺少 messageId' });
    }

    const history = loadChatHistory();
    const index = history.findIndex(
      item => item && item.id === messageId && item.role === 'user'
    );

    if (index < 0) {
      return res.status(404).json({
        error: '消息不存在或不可撤回',
      });
    }

    const removed = [history[index]];

    // 配对删除：撤回该用户消息之后、下一条用户消息之前的所有 assistant 回复，
    // 避免留下"用户消息删了、AI 回复还在"的孤儿回复。
    for (let i = index + 1; i < history.length; i++) {
      const m = history[i];
      if (!m || m.role !== 'assistant') break;
      removed.push(m);
    }

    const removedIds = new Set(removed.map(m => m.id));
    saveChatHistory(history.filter(m => m && !removedIds.has(m.id)));

    // 异步撤回由这条用户消息产生的长期记忆（sourceQuote 匹配）
    recallMemoryBySourceQuote(
      recalled.content,
      recalled.createdAt
    ).catch(error => {
      console.error('Memory recall error:', error.message);
    });

    res.json({
      ok: true,
      removedCount: removed.length,
      removedIds: removed.map(m => m.id),
    });
  } catch (error) {
    console.error('History recall error:', error);
    res.status(500).json({ error: '撤回失败' });
  }
});

app.post('/memory/clear', requireAuth, async (req, res) => {
  try {
    await clearMemories();
    res.json({ ok: true, message: '长期记忆已清理' });
  } catch (error) {
    console.error('Memory clear error:', error);
    res.status(500).json({ error: '清理长期记忆失败' });
  }
});

app.post('/chat', requireAuth, async (req, res) => {
  // 客户端提前断开时标记，避免回复落盘成"幽灵消息"（用户没收到却已入库）
  let clientGone = false;
  res.on('close', () => {
    if (!res.writableEnded) clientGone = true;
  });

  try {
    const { message, history = [] } = req.body;

    if (typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({
        error: '消息不能为空',
      });
    }

    if (!client) {
      return res.status(500).json({
        error: '服务端未配置 DEEPSEEK_API_KEY，请在 server/.env 中填写后重启',
      });
    }

    const safeHistory = Array.isArray(history)
      ? history
          .filter(
            item =>
              item &&
              (item.role === 'user' || item.role === 'assistant') &&
              typeof item.content === 'string'
          )
          .slice(-20)
      : [];

    const memoryContext = buildMemoryContext(message);
    const timeContext = getTimeContext(req.body.timeZone || 'Asia/Shanghai');

    const systemPrompt = [
        BLUEBIRD_SYSTEM_PROMPT,
        timeContext,
        memoryContext,
    ]
        .filter(Boolean)
        .join('\
\
');

    const completion = await client.chat.completions.create(
      {
        model: 'deepseek-chat',
        temperature: 0.8,
        max_tokens: 1200,
        messages: [
          {
            role: 'system',
            content: systemPrompt,
          },
          ...safeHistory,
          {
            role: 'user',
            content: message.trim(),
          },
        ],
      },
      { timeout: 90000 }
    );

    const rawReply = completion.choices?.[0]?.message?.content;

    if (!rawReply) {
      throw new Error('模型没有返回有效内容');
    }

    let mood = 'calm';
    let reply = rawReply;
    const moodMatch = rawReply.match(/^\s*\[mood:([a-z]+)\]/i);

    if (moodMatch) {
      const value = moodMatch[1].toLowerCase();
      if (MOOD_VALUES.has(value)) mood = value;
      const stripped = rawReply.slice(moodMatch[0].length).trim();
      if (stripped) reply = stripped;
    } else {
      // 兜底：模型没按要求在开头输出标签时，剥离正文里任何位置的 [mood:...]，
      // 避免把标签原文展示给用户。
      const stripped = reply.replace(/\[mood:[a-z]+\]/gi, '').trim();
      if (stripped) reply = stripped;
    }

    // 同步生成稳定 id 并立即返回给前端（撤回需要），历史落盘放异步，
    // 避免磁盘 IO 卡住回复关键路径；appendChatMessages 会沿用已有 id。
    const now = new Date().toISOString();
    const stamped = [
      {
        id: crypto.randomUUID(),
        role: 'user',
        content: message.trim(),
        createdAt: now,
      },
      {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: reply,
        createdAt: now,
      },
    ];

    res.json({
      reply,
      model: completion.model,
      mood,
      userMessageId: stamped[0].id,
      assistantMessageId: stamped[1].id,
    });

    setImmediate(() => {
      if (clientGone) return; // 客户端已断开，不落盘，避免幽灵消息
      try {
        appendChatMessages(stamped);
      } catch (error) {
        console.error('History save error:', error);
      }
    });

    setImmediate(() => {
      if (!client) return; // 未配置模型 key，跳过记忆提取
      processMemory(client, message.trim())
        .catch(error => {
          console.error(
            'Memory processing error:',
            error.message
          );
        });
    });
  } catch (error) {
    console.error('AI API Error:', error);

    res.status(500).json({
      error: 'AI 请求失败',
      detail:
        process.env.NODE_ENV === 'development'
          ? error.message
          : undefined,
    });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Bluebird API running on port ${PORT}`);
});
