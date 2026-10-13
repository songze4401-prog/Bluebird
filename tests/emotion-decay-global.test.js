/**
 * 云岫 Bluebird — 情绪时间衰减全局化（E3，server/emotion.js）
 *
 * 独立脚本（非 node:test）：与 tests/sessions.test.js 同款极简 runner，测完显式退出。
 * 隔离保证：BLUEBIRD_DATA_DIR 指向系统临时目录，不读写 server/data 的真实情绪文件。
 *
 * 覆盖：以 lastDecayAt 为全局基线的分档衰减、同一间隔不重复衰减（等效于
 *       连续切换会话）、旧状态文件（无 lastDecayAt）回退 updatedAt、
 *       calm 不受影响、衰减结果含 lastDecayAt 一并落盘。
 *
 * 运行：node tests/emotion-decay-global.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-decay-'));
process.env.BLUEBIRD_DATA_DIR = TMP;

const origLog = console.log;
const origErr = console.error;
console.log = () => {};
console.error = () => {};

const emotion = require(path.join(__dirname, '..', 'server', 'emotion.js'));
const STATE_FILE = path.join(TMP, 'emotion-state.json');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, extra = '') {
  if (cond) {
    passed++;
    origLog(`  ✔ ${name}`);
  } else {
    failed++;
    failures.push(name + (extra ? ` — ${extra}` : ''));
    origLog(`  ✖ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

const minutesAgo = m => new Date(Date.now() - m * 60 * 1000).toISOString();

/** 写状态文件并重新加载（模拟服务重启后的读盘） */
function seedState(partial) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(partial, null, 2), 'utf8');
  emotion.loadEmotion();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** 轮询等待异步落盘完成 */
async function waitForFile(predicate, timeout = 1000) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    try {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (predicate(raw)) return raw;
    } catch (_) {
      /* 文件正在被替换，下一轮再试 */
    }

    await sleep(20);
  }

  return null;
}

async function main() {
  // 1) 10 分钟以内：不衰减
  seedState({
    emotion: 'sad',
    intensity: 60,
    updatedAt: minutesAgo(5),
    lastObservedAt: minutesAgo(5),
    lastDecayAt: minutesAgo(5),
  });
  let s = emotion.applyTimeDecay();
  check('5 分钟（<10）不衰减', s.emotion === 'sad' && s.intensity === 60, `${s.emotion} ${s.intensity}`);

  // 2) 1 小时：ratio 0.2 档，60 -> 47
  seedState({
    emotion: 'sad',
    intensity: 60,
    updatedAt: minutesAgo(60),
    lastObservedAt: minutesAgo(60),
    lastDecayAt: minutesAgo(60),
  });
  s = emotion.applyTimeDecay();
  check('1 小时衰减 60 -> 47', s.emotion === 'sad' && s.intensity === 47, `${s.emotion} ${s.intensity}`);

  // 3) 同一间隔不重复衰减：紧接着再检查一次（等效于切到旧会话后立刻又发消息）
  const again = emotion.applyTimeDecay();
  check(
    '同一间隔只衰减一次（连续检查不再降低）',
    again.emotion === 'sad' && again.intensity === 47,
    `${again.emotion} ${again.intensity}`
  );

  // 4) 2 天：ratio 0.85 档，直接回归 calm
  seedState({
    emotion: 'sad',
    intensity: 60,
    updatedAt: minutesAgo(2 * 24 * 60),
    lastObservedAt: minutesAgo(2 * 24 * 60),
    lastDecayAt: minutesAgo(2 * 24 * 60),
  });
  s = emotion.applyTimeDecay();
  check('2 天衰减回归 calm', s.emotion === 'calm' && s.intensity === 0, `${s.emotion} ${s.intensity}`);

  // 5) 10 天：ratio 1，回归 calm
  seedState({
    emotion: 'happy',
    intensity: 80,
    updatedAt: minutesAgo(10 * 24 * 60),
    lastObservedAt: minutesAgo(10 * 24 * 60),
    lastDecayAt: minutesAgo(10 * 24 * 60),
  });
  s = emotion.applyTimeDecay();
  check('10 天回归 calm', s.emotion === 'calm' && s.intensity === 0, `${s.emotion} ${s.intensity}`);

  // 6) calm 状态不产生衰减
  seedState({
    emotion: 'calm',
    intensity: 0,
    updatedAt: minutesAgo(10 * 24 * 60),
    lastObservedAt: null,
    lastDecayAt: minutesAgo(10 * 24 * 60),
  });
  s = emotion.applyTimeDecay();
  check('calm 状态不产生衰减', s.emotion === 'calm' && s.intensity === 0);

  // 7) 旧状态文件（无 lastDecayAt）：回退用 updatedAt 作为基线
  seedState({
    emotion: 'sad',
    intensity: 60,
    updatedAt: minutesAgo(60),
    lastObservedAt: minutesAgo(60),
  });
  s = emotion.applyTimeDecay();
  check(
    '旧数据（无 lastDecayAt）用 updatedAt 作基线衰减',
    s.emotion === 'sad' && s.intensity === 47,
    `${s.emotion} ${s.intensity}`
  );

  // 8) 衰减结果（含 lastDecayAt）异步落盘，重启后基线不丢失
  const persisted = await waitForFile(
    raw => raw.intensity === 47 && typeof raw.lastDecayAt === 'string'
  );
  check('衰减后的状态与 lastDecayAt 已落盘', !!persisted, JSON.stringify(persisted));
}

main()
  .catch(error => {
    failed++;
    failures.push(`未捕获异常：${(error && error.stack) || error}`);
  })
  .then(() => {
    origLog(`\n结果：${passed} 通过，${failed} 失败`);
    if (failures.length) {
      origLog('失败项：');
      for (const item of failures) origLog(`  - ${item}`);
    }
    process.exitCode = failed ? 1 : 0;
  });