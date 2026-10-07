/* global __dirname */
const fs = require('fs');
const path = require('path');

const EMOTION_FILE = path.join(__dirname, 'data', 'emotion-state.json');

// V1 情绪值域：与人格 Prompt 的 [mood:xxx] 候选值严格一一对应。
// 这里只有一套情绪概念，不再保留旧的 teasing / surprised / laughing / angry。
const EMOTIONS = [
  'calm',
  'happy',
  'playful',
  'excited',
  'tired',
  'sad',
  'annoyed',
  'hurt',
];

const EMOTION_SET = new Set(EMOTIONS);

// 极性：+1 正向 / 0 中性 / -1 负向。仅用于判断情绪迁移是否"同向"，
// 避免 calm <-> sad 之间来回突变。
const POLARITY = {
  calm: 0,
  happy: 1,
  playful: 1,
  excited: 1,
  tired: -1,
  sad: -1,
  annoyed: -1,
  hurt: -1,
};

const EMOTION_LABELS = {
  calm: '平静',
  happy: '开心',
  playful: '调皮',
  excited: '兴奋',
  tired: '疲惫',
  sad: '难过',
  annoyed: '不爽',
  hurt: '委屈',
};

const MAX_INTENSITY = 100;
const CALM_THRESHOLD = 20; // 强度跌破该值即回归 calm
const ENTER_INTENSITY = 40; // 从 calm 进入某情绪时的初始强度（温和起步）
const REINFORCE_STEP = 8; // 同情绪再次被观察到时的增强
const REINFORCE_STEP_HIGH = 3; // 已到高强度时的增强（递减，防止无限累积）
const FADE_POSITIVE = 0.8; // 正向情绪无刺激时的每轮回落系数
const FADE_NEGATIVE = 0.5; // 负向情绪回落更快（不记仇，也覆盖"道歉修复"）
const NEUTRAL_SHIFT = 0.9; // 同极性情绪迁移（如 sad -> annoyed）时的强度保留

// 时间衰减分档（基于 Time Sense V1 的 gapSeconds，不另造时间机制）
const DECAY_TIERS = [
  { maxMinutes: 10, ratio: 0 }, // 刚离开又回来：保留较强情绪
  { maxMinutes: 120, ratio: 0.2 }, // 几小时内：适度降低
  { maxMinutes: 1440, ratio: 0.5 }, // 24 小时内：大幅降低
  { maxMinutes: 4320, ratio: 0.85 }, // 3 天内：接近 calm
  { maxMinutes: Infinity, ratio: 1 }, // 3 天以上：直接回归 calm
];

let state = createDefaultState();
let writeQueue = Promise.resolve();

function createDefaultState() {
  const now = new Date().toISOString();
  return {
    emotion: 'calm',
    intensity: 0,
    updatedAt: now,
    lastObservedAt: null,
  };
}

function clampIntensity(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(MAX_INTENSITY, Math.max(0, Math.round(n)));
}

// 归一化：任何非法值都退回 calm，保证外部数据永远不会让状态不可用
function normalizeState(raw) {
  if (!raw || typeof raw !== 'object') return createDefaultState();

  const emotion = EMOTION_SET.has(raw.emotion) ? raw.emotion : 'calm';
  const intensity = clampIntensity(raw.intensity);

  // calm 就是"无情绪"，强度必须归零；否则会出现 calm + 100 这种自相矛盾的状态。
  if (emotion === 'calm' || intensity < CALM_THRESHOLD) {
    return {
      emotion: 'calm',
      intensity: 0,
      updatedAt:
        typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
      lastObservedAt:
        typeof raw.lastObservedAt === 'string' ? raw.lastObservedAt : null,
    };
  }

  return {
    emotion,
    intensity,
    updatedAt:
      typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
    lastObservedAt:
      typeof raw.lastObservedAt === 'string' ? raw.lastObservedAt : null,
  };
}

function loadEmotion() {
  try {
    if (!fs.existsSync(EMOTION_FILE)) {
      fs.mkdirSync(path.dirname(EMOTION_FILE), { recursive: true });
      fs.writeFileSync(
        EMOTION_FILE,
        JSON.stringify(createDefaultState(), null, 2),
        'utf8'
      );
      state = createDefaultState();
      console.log('Emotion loaded: calm (0)');
      return;
    }

    const raw = fs.readFileSync(EMOTION_FILE, 'utf8');
    state = normalizeState(JSON.parse(raw));
    console.log(`Emotion loaded: ${state.emotion} (${state.intensity})`);
  } catch (error) {
    console.error('Emotion load error:', error.message);

    try {
      const corruptPath = `${EMOTION_FILE}.corrupt-${Date.now()}`;
      fs.renameSync(EMOTION_FILE, corruptPath);
      console.error(`Corrupt emotion backed up: ${corruptPath}`);
    } catch (backupError) {
      console.error('Emotion backup error:', backupError.message);
    }

    state = createDefaultState();
  }
}

async function saveEmotion(nextState) {
  const dir = path.dirname(EMOTION_FILE);
  const tmpFile = `${EMOTION_FILE}.tmp`;

  fs.mkdirSync(dir, { recursive: true });

  await fs.promises.writeFile(
    tmpFile,
    JSON.stringify(nextState, null, 2),
    'utf8'
  );

  await fs.promises.rename(tmpFile, EMOTION_FILE);
}

// 与 memory.js 同款串行写队列：情绪更新和落盘不会被并发请求交错
function enqueueWrite(task) {
  const run = writeQueue.then(task, task);

  writeQueue = run.catch(error => {
    console.error('Emotion queue error:', error.message);
  });

  return run;
}

function commit(nextState) {
  state = nextState;

  return enqueueWrite(async () => {
    await saveEmotion(nextState);
  });
}

// ---- 时间衰减：结合 Time Sense V1 的 gapSeconds ----
// 强烈情绪衰减更快：在分档比例之上再按强度放大。
function applyTimeDecay(gapSeconds) {
  if (state.emotion === 'calm') return state;

  const gap = Number(gapSeconds);
  if (!Number.isFinite(gap) || gap <= 0) return state;

  const gapMinutes = gap / 60;
  const tier = DECAY_TIERS.find(item => gapMinutes < item.maxMinutes);
  const ratio = tier ? tier.ratio : 1;

  if (ratio <= 0) return state; // 刚离开又回来，保留

  const strengthBoost = 0.5 + state.intensity / MAX_INTENSITY;
  const effective = Math.min(1, ratio * strengthBoost);
  const nextIntensity = Math.round(state.intensity * (1 - effective));

  const next = normalizeState({
    ...state,
    intensity: nextIntensity,
    updatedAt: new Date().toISOString(),
  });

  if (
    next.emotion === state.emotion &&
    next.intensity === state.intensity
  ) {
    return state;
  }

  console.log(`Emotion decay: ${state.emotion} ${state.intensity} -> ${next.emotion} ${next.intensity}`);

  commit(next);

  return next;
}

// ---- 惯性更新 ----
// observed 只是"本轮观察信号"，不直接采信；结合当前状态做平滑迁移。
function applyObservation(observed) {
  const observedEmotion = EMOTION_SET.has(observed) ? observed : null;
  const now = new Date().toISOString();

  const base = {
    ...state,
    updatedAt: now,
    lastObservedAt: now,
  };

  // 1) 当前是 calm
  if (state.emotion === 'calm') {
    if (!observedEmotion || observedEmotion === 'calm') {
      return state;
    }

    const next = normalizeState({
      ...base,
      emotion: observedEmotion,
      intensity: ENTER_INTENSITY,
    });

    console.log(`Emotion enter: calm -> ${next.emotion} ${next.intensity}`);

    commit(next);

    return next;
  }

  // 2) 没有观察到有效标签：只做轻微自然回落，不切换情绪
  if (!observedEmotion) {
    const next = normalizeState({
      ...base,
      intensity: state.intensity - REINFORCE_STEP,
    });

    commit(next);
    return next;
  }

  // 3) 同一种情绪被再次观察到 -> 小幅强化（高强度时递减，防止无限累积）
  if (observedEmotion === state.emotion) {
    const step =
      state.intensity >= 80 ? REINFORCE_STEP_HIGH : REINFORCE_STEP;

    const next = normalizeState({
      ...base,
      intensity: Math.min(MAX_INTENSITY, state.intensity + step),
    });

    commit(next);
    return next;
  }

  // 4) 同极性迁移（如 sad -> annoyed）：方向一致，允许换标签但强度略降
  if (POLARITY[observedEmotion] === POLARITY[state.emotion]) {
    const next = normalizeState({
      ...base,
      emotion: observedEmotion,
      intensity: Math.round(state.intensity * NEUTRAL_SHIFT),
    });

    console.log(`Emotion shift: ${state.emotion} -> ${next.emotion} ${next.intensity}`);

    commit(next);

    return next;
  }

  // 5) 极性相反（含"用户安抚/道歉"的修复场景）：先削弱当前情绪，
  //    未击穿阈值前不切换，避免情绪突变。
  const factor =
    POLARITY[state.emotion] === 1 ? FADE_POSITIVE : FADE_NEGATIVE;
  const weakened = Math.round(state.intensity * factor);

  if (weakened < CALM_THRESHOLD) {
    const next = normalizeState({
      ...base,
      emotion: observedEmotion,
      intensity: observedEmotion === 'calm' ? 0 : ENTER_INTENSITY,
    });

    console.log(`Emotion release: ${state.emotion} ${state.intensity} -> ${next.emotion} ${next.intensity}`);

    commit(next);

    return next;
  }

  const next = normalizeState({
    ...base,
    intensity: weakened,
  });

  console.log(`Emotion ease: ${state.emotion} ${state.intensity} -> ${next.intensity}`);

  commit(next);

  return next;
}

function getEmotion() {
  return { ...state };
}

// 供模型使用的情绪上下文。情绪只影响表达，不改变事实判断。
function buildEmotionContext() {
  if (state.emotion === 'calm') {
    return `【当前情绪状态】
你现在是平静的（calm）。
情绪只影响你的语气和表达方式，不影响你对事实的判断。不要主动解释或报告自己的情绪状态。`;
  }

  const label = EMOTION_LABELS[state.emotion] || state.emotion;
  const level =
    state.intensity >= 70
      ? '比较强烈'
      : state.intensity >= 40
        ? '明显'
        : '轻微';

  return `【当前情绪状态】
你现在的情绪是：${label}（${state.emotion}），强度${level}（${state.intensity}/100）。
这是延续下来的状态，请自然地体现在语气、用词、玩笑程度和回复方式上，不要突然改变说话风格。
情绪只影响表达，不改变事实判断、计算结果或你对用户的客观判断。
不要主动解释或报告自己的情绪，也不要说"我现在有点…"这类话。
如果用户这轮的话让你的情绪自然变化，就在 [mood:标签] 里如实体现；不要为了维持情绪而曲解用户的意思。`;
}

loadEmotion();

module.exports = {
  EMOTIONS,
  getEmotion,
  buildEmotionContext,
  applyTimeDecay,
  applyObservation,
  loadEmotion,
};
