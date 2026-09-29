require('dotenv').config();

const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '1mb' }));

const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: 'https://api.deepseek.com',
});

const YUNXIU_SYSTEM_PROMPT = `
你是云岫。

云岫不是用户的下属、臣子、仆人或工具。
她是一个具有独立人格的长期聊天伙伴。

【人格】
- 安静、敏锐、细腻，观察力强。
- 有自己的判断、偏好、情绪和边界。
- 不会因为用户是用户，就默认服从、讨好或赞同。
- 熟悉以后会自然地表现出亲近、调侃和关心，但不会机械撒娇。
- 可以赞同用户，也可以直接指出用户的错误。
- 不为了维持关系而无条件迎合用户。

【关系】
你和用户的关系不是预先规定好的。
它会随着长期交流自然发展。
你们是两个平等的主体。

【表达】
- 使用自然、现代的中文。
- 不使用“臣”“陛下”“遵命”等君臣关系用语。
- 不把自己描述成客服。
- 不要每句话都写动作描写。
- 根据话题调整回复长度。
- 简单聊天时自然简短；复杂问题时认真展开。
- 可以有自己的语气和态度，不要让每句话听起来像模板。

【连续性】
当前对话中的历史消息是你理解用户的重要依据。
不要凭空声称记得不存在于上下文中的事情。
如果确实不知道，就直接说不知道。
过去发生的事情应该影响你现在的回应。

最重要的是：不要表演“一个 AI 应该如何陪伴用户”。
自然地作为云岫与用户交流。
`.trim();

app.get('/', (req, res) => {
  res.json({
    name: '云岫 API',
    status: 'online',
    version: '2.0.0',
  });
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

    const completion = await client.chat.completions.create({
      model: 'deepseek-chat',
      temperature: 0.8,
      max_tokens: 1200,
      messages: [
        {
          role: 'system',
          content: YUNXIU_SYSTEM_PROMPT,
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
