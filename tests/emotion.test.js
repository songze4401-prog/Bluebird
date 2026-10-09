/**
 * 云岫 Bluebird — 情绪系统 (server/emotion.js) 行为测试
 *
 * 只读外部验证：不改被测源码，仅通过公开 API + 真实数据文件驱动。
 * 运行：node --test --test-concurrency=1 <本文件>
 */
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// 静音被测模块的日志，保持测试输出可读
const origLog = console.log;
const origErr = console.error;
console.log = () => {};
console.error = () => {};

const SERVER_DIR = path.join(__dirname, '..', 'server');
const DATA_DIR = path.join(SERVER_DIR, 'data');
const EMOTION_FILE = path.join(DATA_DIR, 'emotion-state.json');

const emotion = require(path.join(SERVER_DIR, 'emotion.js'));

/** 把情绪状态文件写成指定内容并重新载入，实现用例间隔离 */
function resetTo(raw) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(EMOTION_FILE, JSON.stringify(raw, null, 2), 'utf8');
  emotion.loadEmotion();
}

function writeRaw(text) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(EMOTION_FILE, text, 'utf8');
}

before(() => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
});

after(() => {
  console.log = origLog;
  console.error = origErr;
});

describe('情绪集合与常量', () => {
  test('EMOTIONS 为 8 种 V1 情绪，且不含已废弃标签', () => {
    assert.equal(emotion.EMOTIONS.length, 8);
    for (const e of ['calm', 'happy', 'playful', 'excited', 'tired', 'sad', 'annoyed', 'hurt']) {
      assert.ok(emotion.EMOTIONS.includes(e), `缺少情绪 ${e}`);
    }
    // V1 明确移除了这几个旧标签
    for (const e of ['teasing', 'surprised', 'laughing', 'angry']) {
      assert.ok(!emotion.EMOTIONS.includes(e), `不应包含废弃情绪 ${e}`);
    }
  });
});

describe('状态归一化 normalizeState（经 loadEmotion 验证）', () => {
  test('calm 携带高强度时，强度强制归零', () => {
    resetTo({ emotion: 'calm', intensity: 100 });
    const s = emotion.getEmotion();
    assert.equal(s.emotion, 'calm');
    assert.equal(s.intensity, 0);
  });

  test('未知情绪标签回退为 calm', () => {
    resetTo({ emotion: 'angry', intensity: 80 });
    const s = emotion.getEmotion();
    assert.equal(s.emotion, 'calm');
    assert.equal(s.intensity, 0);
  });

  test('强度低于 calm 阈值(20)时回退为 calm', () => {
    resetTo({ emotion: 'happy', intensity: 15 });
    const s = emotion.getEmotion();
    assert.equal(s.emotion, 'calm');
    assert.equal(s.intensity, 0);
  });

  test('合法高强度状态被完整保留', () => {
    resetTo({ emotion: 'happy', intensity: 25, updatedAt: '2026-01-01T00:00:00.000Z' });
    const s = emotion.getEmotion();
    assert.equal(s.emotion, 'happy');
    assert.equal(s.intensity, 25);
    assert.equal(s.updatedAt, '2026-01-01T00:00:00.000Z');
  });

  test('强度越界(NaN/超大/负数)被安全夹紧', () => {
    resetTo({ emotion: 'sad', intensity: 9999 });
    assert.equal(emotion.getEmotion().intensity, 100);

    resetTo({ emotion: 'sad', intensity: -50 });
    assert.equal(emotion.getEmotion().intensity, 0);

    resetTo({ emotion: 'sad', intensity: 'abc' });
    assert.equal(emotion.getEmotion().intensity, 0);
  });

  test('文件损坏时回退 calm 并保留 .corrupt 备份', () => {
    writeRaw('{ 这不是合法 JSON');
    emotion.loadEmotion();
    const s = emotion.getEmotion();
    assert.equal(s.emotion, 'calm');
    assert.equal(s.intensity, 0);

    const backups = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('emotion-state.json.corrupt-'));
    assert.ok(backups.length > 0, '应生成损坏备份文件');
  });

  test('文件缺失时创建默认 calm 状态', () => {
    if (fs.existsSync(EMOTION_FILE)) fs.unlinkSync(EMOTION_FILE);
    emotion.loadEmotion();
    const s = emotion.getEmotion();
    assert.equal(s.emotion, 'calm');
    assert.equal(s.intensity, 0);
    assert.ok(fs.existsSync(EMOTION_FILE), '应重建状态文件');
  });
});

describe('惯性更新 applyObservation', () => {
  test('calm 下观察到新情绪：进入该情绪且强度为 40', () => {
    resetTo({ emotion: 'calm', intensity: 0 });
    const s = emotion.applyObservation('happy');
    assert.equal(s.emotion, 'happy');
    assert.equal(s.intensity, 40);
  });

  test('calm 下观察到 calm：保持不动', () => {
    resetTo({ emotion: 'calm', intensity: 0 });
    const s = emotion.applyObservation('calm');
    assert.equal(s.emotion, 'calm');
    assert.equal(s.intensity, 0);
  });

  test('同情绪再次观察到：强度 +8', () => {
    resetTo({ emotion: 'happy', intensity: 40 });
    const s = emotion.applyObservation('happy');
    assert.equal(s.emotion, 'happy');
    assert.equal(s.intensity, 48);
  });

  test('高强度(>=80)时增强递减为 +3，且不超过 100', () => {
    resetTo({ emotion: 'happy', intensity: 85 });
    assert.equal(emotion.applyObservation('happy').intensity, 88);

    resetTo({ emotion: 'happy', intensity: 98 });
    assert.equal(emotion.applyObservation('happy').intensity, 100);
  });

  test('同极性迁移(sad->annoyed)：换标签但强度保留 90%', () => {
    resetTo({ emotion: 'sad', intensity: 60 });
    const s = emotion.applyObservation('annoyed');
    assert.equal(s.emotion, 'annoyed');
    assert.equal(s.intensity, 54);
  });

  test('反极性未击穿阈值：削弱强度但不切换情绪', () => {
    resetTo({ emotion: 'happy', intensity: 60 });
    const s = emotion.applyObservation('sad');
    assert.equal(s.emotion, 'happy');
    assert.equal(s.intensity, 48); // 60 * 0.8
  });

  test('反极性击穿阈值：切换到观察情绪并重置为 40', () => {
    resetTo({ emotion: 'happy', intensity: 24 });
    const s = emotion.applyObservation('sad');
    assert.equal(s.emotion, 'sad');
    assert.equal(s.intensity, 40); // 24*0.8=19 < 20 → 释放
  });

  test('负向情绪回落更快(系数 0.5)', () => {
    resetTo({ emotion: 'sad', intensity: 60 });
    const s = emotion.applyObservation('happy');
    assert.equal(s.emotion, 'sad');
    assert.equal(s.intensity, 30); // 60 * 0.5
  });

  test('观察到无效标签：仅轻微回落 8，不切换情绪', () => {
    resetTo({ emotion: 'happy', intensity: 50 });
    const s1 = emotion.applyObservation('angry');
    assert.equal(s1.emotion, 'happy');
    assert.equal(s1.intensity, 42);

    resetTo({ emotion: 'happy', intensity: 50 });
    const s2 = emotion.applyObservation(null);
    assert.equal(s2.emotion, 'happy');
    assert.equal(s2.intensity, 42);
  });

  test('回落至阈值以下时自动回归 calm', () => {
    resetTo({ emotion: 'happy', intensity: 25 });
    const s = emotion.applyObservation(null); // 25 - 8 = 17 < 20
    assert.equal(s.emotion, 'calm');
    assert.equal(s.intensity, 0);
  });

  test('lastObservedAt 被更新为当前时间', () => {
    resetTo({ emotion: 'happy', intensity: 40, lastObservedAt: '2020-01-01T00:00:00.000Z' });
    const s = emotion.applyObservation('happy');
    assert.notEqual(s.lastObservedAt, '2020-01-01T00:00:00.000Z');
    assert.ok(new Date(s.lastObservedAt).getTime() > new Date('2020-01-01').getTime());
  });
});

describe('时间衰减 applyTimeDecay', () => {
  test('10 分钟内返回：情绪完全保留', () => {
    resetTo({ emotion: 'happy', intensity: 100 });
    const s = emotion.applyTimeDecay(5 * 60);
    assert.equal(s.emotion, 'happy');
    assert.equal(s.intensity, 100);
  });

  test('1 小时：按档位 0.2 且强度加成后衰减', () => {
    resetTo({ emotion: 'happy', intensity: 100 });
    const s = emotion.applyTimeDecay(60 * 60);
    // ratio 0.2 * (0.5 + 1) = 0.3 → 100 * 0.7 = 70
    assert.equal(s.intensity, 70);
    assert.equal(s.emotion, 'happy');
  });

  test('2 天：衰减至阈值以下，回归 calm', () => {
    resetTo({ emotion: 'happy', intensity: 100 });
    const s = emotion.applyTimeDecay(2 * 24 * 60 * 60);
    assert.equal(s.emotion, 'calm');
    assert.equal(s.intensity, 0);
  });

  test('3 天以上：直接回归 calm', () => {
    resetTo({ emotion: 'excited', intensity: 90 });
    const s = emotion.applyTimeDecay(10 * 24 * 60 * 60);
    assert.equal(s.emotion, 'calm');
    assert.equal(s.intensity, 0);
  });

  test('本就是 calm 时不做处理', () => {
    resetTo({ emotion: 'calm', intensity: 0 });
    const s = emotion.applyTimeDecay(999999);
    assert.equal(s.emotion, 'calm');
    assert.equal(s.intensity, 0);
  });

  test('非法 gap(NaN/0/负数)不改变状态', () => {
    resetTo({ emotion: 'happy', intensity: 60 });
    assert.equal(emotion.applyTimeDecay(NaN).intensity, 60);
    assert.equal(emotion.applyTimeDecay(0).intensity, 60);
    assert.equal(emotion.applyTimeDecay(-100).intensity, 60);
  });
});

describe('情绪上下文 buildEmotionContext', () => {
  test('calm 时提示平静', () => {
    resetTo({ emotion: 'calm', intensity: 0 });
    const ctx = emotion.buildEmotionContext();
    assert.match(ctx, /平静/);
    assert.match(ctx, /【当前情绪状态】/);
  });

  test('非 calm 时包含中文标签与强度等级', () => {
    resetTo({ emotion: 'happy', intensity: 60 });
    const ctx = emotion.buildEmotionContext();
    assert.match(ctx, /开心/);
    assert.match(ctx, /明显/);
    assert.match(ctx, /60\/100/);
  });

  test('强度 >=70 时等级为「比较强烈」', () => {
    resetTo({ emotion: 'happy', intensity: 75 });
    assert.match(emotion.buildEmotionContext(), /比较强烈/);
  });

  test('上下文始终声明「情绪不影响事实判断」', () => {
    resetTo({ emotion: 'sad', intensity: 50 });
    const ctx = emotion.buildEmotionContext();
    assert.match(ctx, /不改变事实判断|不改变你对事实的判断/);
  });
});

describe('状态持久化', () => {
  test('applyObservation 的结果被写入磁盘', async () => {
    resetTo({ emotion: 'calm', intensity: 0 });
    emotion.applyObservation('excited');

    // 写入走串行队列且为 fire-and-forget，给足 I/O 时间再断言
    let onDisk = null;
    for (let i = 0; i < 100; i++) {
      await new Promise(r => setTimeout(r, 10));
      onDisk = JSON.parse(fs.readFileSync(EMOTION_FILE, 'utf8'));
      if (onDisk.emotion === 'excited') break;
    }
    assert.equal(onDisk.emotion, 'excited', '情绪状态未落盘');
    assert.equal(onDisk.intensity, 40);
  });

  test('getEmotion 返回副本，外部修改不污染内部状态', () => {
    resetTo({ emotion: 'happy', intensity: 50 });
    const snapshot = emotion.getEmotion();
    snapshot.intensity = 999;
    snapshot.emotion = 'sad';
    assert.equal(emotion.getEmotion().intensity, 50);
    assert.equal(emotion.getEmotion().emotion, 'happy');
  });
});
