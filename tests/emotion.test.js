/**
 * 云岫 Bluebird — 情绪系统 (server/emotion.js) 行为测试
 *
 * 只读外部验证：不改被测源码，仅通过公开 API + 数据文件驱动。
 * 隔离说明：全程使用临时数据目录（BLUEBIRD_DATA_DIR），不读写 server/data 下的真实数据。
 * 运行：node --test --test-concurrency=1 <本文件>
 *
 * 串行说明：本文件所有套件共用同一个 emotion-state.json（临时目录内），且其中
 * 「文件损坏恢复」用例会把它 rename 成 .corrupt 备份。任何并行执行都会让其他套件
 * 在读取时扑空，因此每个 describe 都显式声明 concurrency: 1，并在 before 中清空残留。
 */
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 静音被测模块的日志，保持测试输出可读
const origLog = console.log;
const origErr = console.error;
console.log = () => {};
console.error = () => {};

const SERVER_DIR = path.join(__dirname, '..', 'server');

// 隔离：全部数据落在系统临时目录，绝不触碰 server/data 下的真实情绪文件
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bluebird-emotion-'));
process.env.BLUEBIRD_DATA_DIR = TMP_DIR;

const DATA_DIR = TMP_DIR;
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

/** 套件必须串行执行：共用同一份情绪状态文件 */
const SERIAL = { concurrency: 1 };

/** 清空本套件自己的历史残留（含上一轮留下的 .corrupt 备份），保证每轮从干净状态开始。
 *  只删 emotion-state.json 相关文件：data 目录是共享的，不能整目录清空，
 *  否则会连带删掉 memory.json / chat-history.json，影响并行跑的其他测试文件。
 */
function cleanOwnArtifacts() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const name of fs.readdirSync(DATA_DIR)) {
    if (name === 'emotion-state.json' || name.startsWith('emotion-state.json.corrupt-')) {
      fs.rmSync(path.join(DATA_DIR, name), { force: true });
    }
  }
}

before(() => {
  cleanOwnArtifacts();
});

after(() => {
  console.log = origLog;
  console.error = origErr;
});

describe('情绪集合与常量', SERIAL, () => {
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

describe('状态归一化 normalizeState（经 loadEmotion 验证）', SERIAL, () => {
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

describe('惯性更新 applyObservation', SERIAL, () => {
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

describe('时间衰减 applyTimeDecay（全局检查基线，E3）', SERIAL, () => {
  /** 以"N 分钟前的 lastDecayAt"为基线重置状态（衰减不再接收 gap 参数） */
  function resetWithBaseline(rawEmotion, intensity, minutes) {
    const baseline = new Date(Date.now() - minutes * 60 * 1000).toISOString();
    resetTo({
      emotion: rawEmotion,
      intensity,
      updatedAt: baseline,
      lastObservedAt: baseline,
      lastDecayAt: baseline,
    });
  }

  test('10 分钟内返回：情绪完全保留', () => {
    resetWithBaseline('happy', 100, 5);
    const s = emotion.applyTimeDecay();
    assert.equal(s.emotion, 'happy');
    assert.equal(s.intensity, 100);
  });

  test('1 小时：按档位 0.2 且强度加成后衰减', () => {
    resetWithBaseline('happy', 100, 60);
    const s = emotion.applyTimeDecay();
    // ratio 0.2 * (0.5 + 1) = 0.3 → 100 * 0.7 = 70
    assert.equal(s.intensity, 70);
    assert.equal(s.emotion, 'happy');
  });

  test('2 天：衰减至阈值以下，回归 calm', () => {
    resetWithBaseline('happy', 100, 2 * 24 * 60);
    const s = emotion.applyTimeDecay();
    assert.equal(s.emotion, 'calm');
    assert.equal(s.intensity, 0);
  });

  test('3 天以上：直接回归 calm', () => {
    resetWithBaseline('excited', 90, 10 * 24 * 60);
    const s = emotion.applyTimeDecay();
    assert.equal(s.emotion, 'calm');
    assert.equal(s.intensity, 0);
  });

  test('本就是 calm 时不做处理', () => {
    resetWithBaseline('calm', 0, 10 * 24 * 60);
    const s = emotion.applyTimeDecay();
    assert.equal(s.emotion, 'calm');
    assert.equal(s.intensity, 0);
  });

  test('同一段间隔只衰减一次：检查基线随每次调用推进', () => {
    resetWithBaseline('happy', 100, 60);
    assert.equal(emotion.applyTimeDecay().intensity, 70);
    // 紧接着再检查一次（等效于切到旧会话后立刻又发一条）：gap≈0，不再衰减
    assert.equal(emotion.applyTimeDecay().intensity, 70);
  });

  test('旧状态文件没有 lastDecayAt 时，回退用 updatedAt 作基线', () => {
    const baseline = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    resetTo({ emotion: 'happy', intensity: 100, updatedAt: baseline });
    assert.equal(emotion.applyTimeDecay().intensity, 70);
  });

  test('基线时间无法解析时不衰减', () => {
    resetTo({ emotion: 'happy', intensity: 60, updatedAt: '不是时间' });
    assert.equal(emotion.applyTimeDecay().intensity, 60);
  });
});

describe('情绪上下文 buildEmotionContext', SERIAL, () => {
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

describe('状态持久化', SERIAL, () => {
  test('applyObservation 的结果被写入磁盘', async () => {
    resetTo({ emotion: 'calm', intensity: 0 });
    emotion.applyObservation('excited');

    // 写入走串行队列且为 fire-and-forget，给足 I/O 时间再断言。
    // 轮询窗口放宽到 3 秒：慢机器上异步落盘可能超过 1 秒，别把超时当成 bug。
    // 读取失败（原子 rename 的瞬间文件可能不在）不视为失败，继续重试。
    let onDisk = null;
    for (let i = 0; i < 300; i++) {
      await new Promise(r => setTimeout(r, 10));
      try {
        onDisk = JSON.parse(fs.readFileSync(EMOTION_FILE, 'utf8'));
      } catch (_) {
        continue;
      }
      if (onDisk && onDisk.emotion === 'excited') break;
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

  test('tmp 文件先 fsync 再原子 rename（a5 回归防护：C2）', async () => {
    resetTo({ emotion: 'calm', intensity: 0 });

    // 记录 open/fsync/rename 的事件序列（与 memory.test.js 同款守卫）。
    // 只数 fsync 次数会被 rename 后的目录 fsync 喂饱，抓不住"文件 fsync 被删掉"
    // 的回归——必须断言 tmp 的 fsync 发生在 rename 之前。
    // 落盘走 server/atomic-write.js 的 writeFileAtomic（异步 FileHandle API）：
    // handle.sync() 不经过 fs.fsyncSync 的 JS 绑定，rename 走 fs.promises.rename，
    // 因此挂钩 fs.promises.open（包装返回的 handle 记录 sync）和 fs.promises.rename。
    const realOpenP = fs.promises.open;
    const realRenameP = fs.promises.rename;
    const events = [];

    fs.promises.open = async (p, ...rest) => {
      const handle = await realOpenP.call(fs.promises, p, ...rest);
      const realSync = handle.sync.bind(handle);

      handle.sync = async () => {
        events.push(['fsync', String(p)]);
        return realSync();
      };

      return handle;
    };
    fs.promises.rename = (from, to) => {
      events.push(['rename', from, to]);
      return realRenameP.call(fs.promises, from, to);
    };

    let onDisk = null;
    try {
      emotion.applyObservation('excited');

      // 写入走串行队列且为 fire-and-forget，轮询等落盘（同邻用例 3 秒窗口）。
      for (let i = 0; i < 300; i++) {
        await new Promise(r => setTimeout(r, 10));
        try {
          onDisk = JSON.parse(fs.readFileSync(EMOTION_FILE, 'utf8'));
        } catch (_) {
          continue;
        }
        if (onDisk && onDisk.emotion === 'excited') break;
      }
    } finally {
      fs.promises.open = realOpenP;
      fs.promises.rename = realRenameP;
    }

    assert.equal(onDisk && onDisk.emotion, 'excited', '情绪状态未落盘');

    const renameIdx = events.findIndex(
      e => e[0] === 'rename' && e[2] === EMOTION_FILE
    );
    assert.ok(renameIdx >= 0, '落盘未走原子 rename');
    const tmpPath = events[renameIdx][1];
    const pidPrefix = `${EMOTION_FILE}.tmp-${process.pid}-`;
    assert.ok(
      tmpPath.startsWith(pidPrefix),
      `临时文件名不符合「带 pid」约定: ${tmpPath}`
    );
    const fsyncIdx = events.findIndex(
      e => e[0] === 'fsync' && e[1] === tmpPath
    );
    assert.ok(
      fsyncIdx >= 0 && fsyncIdx < renameIdx,
      '临时文件未在 rename 之前 fsync——写路径退化为无 fsync 的 writeFile + rename（C2 回归）'
    );
  });
});
