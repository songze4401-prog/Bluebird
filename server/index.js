require('dotenv').config();

const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');

const app = express();

app.use(cors());
app.use(express.json());

const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
    baseURL: 'https://api.deepseek.com',
    });

    app.get('/', (req, res) => {
      res.json({
          name: '云岫 API',
              status: 'online',
                });
                });

                app.post('/chat', async (req, res) => {
                  try {
                      const { message } = req.body;

                          if (!message) {
                                return res.status(400).json({
                                        error: '消息不能为空',
                                              });
                                                  }

                                                      const completion = await client.chat.completions.create({
                                                            model: 'deepseek-chat',
                                                                  messages: [
                                                                          {
                                                                                    role: 'system',
                                                                                              content: '你是云岫。请自然、连贯地与用户对话。',
                                                                                                      },
                                                                                                              {
                                                                                                                        role: 'user',
                                                                                                                                  content: message,
                                                                                                                                          },
                                                                                                                                                ],
                                                                                                                                                    });

                                                                                                                                                        const reply = completion.choices[0].message.content;

                                                                                                                                                            res.json({
                                                                                                                                                                  reply: reply,
                                                                                                                                                                      });
                                                                                                                                                                        } catch (error) {
                                                                                                                                                                            console.error('AI API Error:', error);

                                                                                                                                                                                res.status(500).json({
                                                                                                                                                                                      error: 'AI 请求失败',
                                                                                                                                                                                          });
                                                                                                                                                                                            }
                                                                                                                                                                                            });

                                                                                                                                                                                            const PORT = process.env.PORT || 3000;

                                                                                                                                                                                            app.listen(PORT, '0.0.0.0', () => {
                                                                                                                                                                                              console.log(`云岫 API running on port ${PORT}`);
                                                                                                                                                                                              });