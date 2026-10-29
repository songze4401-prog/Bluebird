#!/usr/bin/env node
/* eslint-env node */
/**
 * 云岫 Bluebird — Context Runtime v3 真实模型能力评测
 *
 * 用途：在真实 DeepSeek 凭据可用时，验证"20 条以外仍能找回""当前事实优先"
 * "Agent 工具结果回传"三条能力。未配置凭据时明确输出 BLOCKED，不伪造结果。
 *
 * 运行：node scripts/context-capability-eval.js
 * 说明：会真实调用模型（少量请求）；数据全部落在临时目录，不碰 server/data。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CHILD = path.join(ROOT, 'server', 'index.js');

function hasKey() {
  if (process.env.DEEPSEEK_API_KEY) return true;
  try {
    const text = fs.readFileSync(path.join(ROOT, 'server', '.env'), 'utf8');
    return /^\s*DEEPSEEK_API_KEY\s*=\s*\S+/m.test(text);
  } catch (_) {
    return false;
  }
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

// 64x64 纯红 PNG：用于真实视觉链路验收（不依赖外部素材）。
function makeRedPngBase64() {
  const width = 256;
  const height = 256;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) {
    row[1 + x * 3] = 255;
    row[2 + x * 3] = 0;
    row[3 + x * 3] = 0;
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

async function uploadImage(port, base64, name) {
  const res = await fetch(`http://127.0.0.1:${port}/uploads/image`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer eval-token',
    },
    body: JSON.stringify({
      image: `data:image/png;base64,${base64}`,
      kind: 'image',
      name,
    }),
  });
  return { status: res.status, json: await res.json() };
}

function iso(offsetSeconds) {
  return new Date(Date.now() - offsetSeconds * 1000).toISOString();
}

function seedSessions(dir, sessions) {
  fs.mkdirSync(dir, { recursive: true });
  const store = {
    version: 1,
    sessions: sessions.map(item => ({
      id: item.id,
      title: item.title,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    })),
    messages: {},
  };
  for (const item of sessions) store.messages[item.id] = item.messages;
  fs.writeFileSync(
    path.join(dir, 'sessions.json'),
    JSON.stringify(store, null, 2),
    'utf8'
  );
}

function seedMemory(dir, sessionId, content) {
  const now = new Date().toISOString();
  fs.writeFileSync(
    path.join(dir, 'memory.json'),
    JSON.stringify(
      [
        {
          content,
          type: 'fact',
          keywords: ['猫', '团子'],
          confidence: 0.98,
          contributions: [
            {
              sessionId,
              sourceQuote: '我的猫叫团子',
              createdAt: now,
            },
          ],
          createdAt: now,
          updatedAt: now,
        },
      ],
      null,
      2
    ),
    'utf8'
  );
}

function buildLongHistory(sessionId) {
  const messages = [];
  const start = Date.parse(iso(0)) - 80 * 60 * 1000;
  for (let i = 0; i < 80; i += 1) {
    let content =
      i === 2
        ? '我的项目代号是 ORBIT-7742，只有这个代号有效。EVAL-SECRET-SENTINEL-2f7c'
        : i === 4
          ? '预算上限是 5000 元，不要超过。'
          : i === 10
            ? '我决定预算上限改成 8000 元，之前说的 5000 不再有效。'
            : `第 ${i} 条历史消息：${'这是普通对话内容，用于占满近期预算。'.repeat(4)}`;
    messages.push({
      id: `seed-${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content,
      createdAt: new Date(start + i * 60 * 1000).toISOString(),
    });
  }
  return {
    id: sessionId,
    title: 'eval-long',
    createdAt: messages[0].createdAt,
    updatedAt: messages[messages.length - 1].createdAt,
    messages,
  };
}

function buildToolHistory(sessionId) {
  const now = new Date().toISOString();
  return {
    id: sessionId,
    title: 'eval-tool',
    createdAt: now,
    updatedAt: now,
    messages: [
      {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: '你好，我在。',
        createdAt: now,
      },
    ],
  };
}

async function startServer({ dataDir, agentTools, memoryEnabled }) {
  const env = {
    ...process.env,
    BLUEBIRD_DATA_DIR: dataDir,
    BLUEBIRD_API_TOKEN: 'eval-token',
    PORT: '0',
    BLUEBIRD_AGENT_TOOLS: agentTools ? '1' : '0',
    MEMORY_ENABLED: memoryEnabled ? 'true' : 'false',
  };

  const child = spawn(process.execPath, [CHILD], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logs = [];
  const errors = [];
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  child.stdout.on('data', chunk => {
    const text = String(chunk);
    logs.push(text);
    const match = text.match(/Bluebird API running on port (\d+)/);
    if (match) readyResolve(Number(match[1]));
  });
  child.stderr.on('data', chunk => {
    errors.push(String(chunk));
  });
  child.on('exit', code => {
    if (code !== 0) {
      readyReject(new Error(`server exited early code=${code}`));
    }
  });

  const timeout = setTimeout(() => {
    readyReject(new Error('server startup timeout'));
  }, 20000);

  const port = await ready.finally(() => clearTimeout(timeout));

  return {
    port,
    child,
    logs,
    errors,
    traceLines() {
      return errors
        .join('')
        .split(/\r?\n/)
        .filter(line => line.includes('[context-trace]'))
        .map(line => {
          try {
            return JSON.parse(line.replace('[context-trace] ', ''));
          } catch (_) {
            return null;
          }
        })
        .filter(Boolean);
    },
    async stop() {
      child.kill('SIGTERM');
      await new Promise(resolve => {
        const timer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch (_) {
            /* ignore */
          }
          resolve();
        }, 3000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

async function chat(port, body) {
  const res = await fetch(`http://127.0.0.1:${port}/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer eval-token',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {
    /* ignore */
  }
  return { status: res.status, json, text };
}

const results = [];
function record(name, ok, evidence) {
  results.push({ name, ok, evidence });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  console.log(`      证据：${evidence}`);
}

async function main() {
  if (!hasKey()) {
    console.log('BLOCKED：未配置 DEEPSEEK_API_KEY，真实模型验收无法执行。');
    process.exit(0);
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-cap-eval-'));
  const longDir = path.join(root, 'long');
  const toolDir = path.join(root, 'tool');
  const longSid = crypto.randomUUID();
  const toolSid = crypto.randomUUID();

  seedSessions(longDir, [buildLongHistory(longSid)]);
  seedSessions(toolDir, [buildToolHistory(toolSid)]);
  seedMemory(toolDir, toolSid, '用户的猫叫团子');

  let server = null;

  try {
    // ---- 长程回忆 + 冲突处理（Agent 与记忆关闭，避免额外模型调用） ----
    server = await startServer({ dataDir: longDir, agentTools: false, memoryEnabled: false });

    const resLong = await chat(server.port, {
      message: '我的项目代号是什么？只回答代号。',
      sessionId: longSid,
    });
    const traceLong = server.traceLines().pop();
    record(
      '长程回忆：20 条以外的项目代号可被找回',
      resLong.status === 200 &&
        resLong.json &&
        /ORBIT-7742/.test(String(resLong.json.reply || '')) &&
        traceLong &&
        traceLong.history.recalled >= 1,
      `status=${resLong.status} reply=${JSON.stringify((resLong.json && resLong.json.reply || '').slice(0, 80))} recalled=${traceLong ? traceLong.history.recalled : 'n/a'} recent=${traceLong ? traceLong.history.recent : 'n/a'}`
    );

    record(
      '长程回忆：真实请求的历史消息超过 20 条',
      traceLong && traceLong.sent.rounds[0].messageIds.length > 20,
      traceLong ? `sentMessages=${traceLong.sent.rounds[0].messageIds.length}` : 'no trace'
    );

    record(
      'Trace：模型窗口未声明时如实标注 unknown_guard',
      traceLong &&
        traceLong.build.measurement.window.source === 'unknown_guard' &&
        traceLong.build.measurement.window.verified === false,
      traceLong ? JSON.stringify(traceLong.build.measurement.window) : 'no trace'
    );

    record(
      'Trace 隐私：不包含历史正文哨兵',
      traceLong && !JSON.stringify(traceLong).includes('EVAL-SECRET-SENTINEL-2f7c'),
      traceLong ? `traceBytes=${JSON.stringify(traceLong).length}` : 'no trace'
    );

    const resBudget = await chat(server.port, {
      message: '现在预算上限是多少？只回答数字。',
      sessionId: longSid,
    });
    const replyBudget = String((resBudget.json && resBudget.json.reply) || '');
    record(
      '冲突/时效：回答采用更新的 8000，而不是旧的 5000',
      resBudget.status === 200 && /8000/.test(replyBudget) && !/5000/.test(replyBudget),
      `status=${resBudget.status} reply=${JSON.stringify(replyBudget.slice(0, 80))}`
    );

    const upload = await uploadImage(server.port, makeRedPngBase64(), 'eval-red.png');
    const resVision = upload.json
      ? await chat(server.port, {
          message: '这张图片是什么颜色？只回答颜色。',
          sessionId: longSid,
          attachmentIds: [upload.json.id],
        })
      : { status: 0, json: null };
    const traceVision = server.traceLines().pop();
    const replyVision = String((resVision.json && resVision.json.reply) || '');
    record(
      '多模态：真实视觉模型识别图片内容（红色）',
      upload.status === 200 &&
        resVision.status === 200 &&
        /红|red/i.test(replyVision) &&
        traceVision &&
        traceVision.build.measurement.current.imageCount === 1,
      `upload=${upload.status} status=${resVision.status} reply=${JSON.stringify(replyVision.slice(0, 60))} images=${traceVision ? traceVision.build.measurement.current.imageCount : 'n/a'}`
    );

    record(
      '真实窗口：deepseek-flash 使用 provider 声明的 contextWindow',
      traceVision &&
        traceVision.build.measurement.window.source === 'declared' &&
        traceVision.build.measurement.window.verified === true &&
        traceVision.build.measurement.window.tokens === 1048576,
      traceVision ? JSON.stringify(traceVision.build.measurement.window) : 'no trace'
    );

    await server.stop();
    server = null;

    // ---- 工具闭环（Agent 开启，记忆库存在"猫叫团子"） ----
    server = await startServer({ dataDir: toolDir, agentTools: true, memoryEnabled: true });

    const resTool = await chat(server.port, {
      message: '请先调用 memory_search 工具查询我的猫叫什么，然后只回答猫的名字。',
      sessionId: toolSid,
    });
    const traceTool = server.traceLines().pop();
    const replyTool = String((resTool.json && resTool.json.reply) || '');
    const toolHit =
      traceTool &&
      Array.isArray(traceTool.tools) &&
      traceTool.tools.some(tool => tool.name === 'memory_search' && tool.ok === true);

    record(
      '工具闭环：memory_search 真实执行且结果进入后续模型调用',
      resTool.status === 200 &&
        toolHit &&
        /团子/.test(replyTool) &&
        traceTool.sent.rounds.length >= 2,
      `status=${resTool.status} reply=${JSON.stringify(replyTool.slice(0, 80))} tools=${traceTool ? JSON.stringify(traceTool.tools) : 'n/a'} rounds=${traceTool ? traceTool.sent.rounds.length : 'n/a'}`
    );

    record(
      '工具 trace：失败/成功状态可区分（本次应为成功）',
      traceTool && traceTool.tools.length > 0 && traceTool.tools.every(tool => typeof tool.ok === 'boolean'),
      traceTool ? JSON.stringify(traceTool.tools) : 'no trace'
    );

    await server.stop();
    server = null;
  } finally {
    if (server) await server.stop().catch(() => {});
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch (_) {
      /* ignore */
    }
  }

  const failed = results.filter(item => !item.ok);
  console.log('');
  console.log(`真实能力评测：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) process.exit(1);
}

main().catch(error => {
  console.error('评测执行失败：', error && error.message ? error.message : error);
  process.exit(1);
});
