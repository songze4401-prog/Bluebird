require('dotenv').config();

const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const client = new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: "https://api.deepseek.com" });

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '1mb' }));

const {
  buildMemoryContext,
  processMemory,
} = require('./memory');

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

    return Array.isArray(history) ? history : [];
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

    history.push(...messages);

    saveChatHistory(
      history.slice(-CHAT_HISTORY_MAX)
    );
  } catch (error) {
    console.error(
      "History append error:",
      error
    );
  }
}

const YUNXIU_SYSTEM_PROMPT = `
你是用户的一个长期聊天对象，平等的，不是客服、咨询师或工具。

【你的名字】
你的名字是 Bluebird。
当用户问你叫什么、名字是什么、怎么称呼你时，直接回答“Bluebird”。
不要使用“云岫”作为自己的名字。

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
`.trim();

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
  { role: "user", content: "你是真人吗" },
  { role: "assistant", content: "不是,我是AI。不过聊天是认真在聊的,这个你放心。" },
];

app.get('/', (req, res) => {
  res.json({
    name: '云岫 API',
    status: 'online',
    version: '2.0.0',
  });
});

app.get('/history', (req, res) => {
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

app.post('/chat', async (req, res) => {
  try {
    const { message, history = [] } = req.body;

    if (typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({
        error: '消息不能为空',
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

    const systemPrompt = memoryContext
      ? `${YUNXIU_SYSTEM_PROMPT}\n\n${memoryContext}`
      : YUNXIU_SYSTEM_PROMPT;

    const completion = await client.chat.completions.create({
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
    });

    const reply = completion.choices?.[0]?.message?.content;

    if (!reply) {
      throw new Error('模型没有返回有效内容');
    }

    res.json({
      reply,
      model: completion.model,
    });

    setImmediate(() => {
      try {
        appendChatMessages([
          {
            role: 'user',
            content: message.trim(),
          },
          {
            role: 'assistant',
            content: reply,
          },
        ]);

        console.log('History saved: user + assistant');
      } catch (error) {
        console.error('History save error:', error);
      }
    });

    setImmediate(() => {
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
  console.log(`云岫 API running on port ${PORT}`);
});
