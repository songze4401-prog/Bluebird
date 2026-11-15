// 蓝鸟 UI 移植 · 主页整屏（原型 .home 的 RN 移植）
// 结构自上而下：问候语 → 双入口卡 → 任务·定时/数据 双卡行 → 我的面板 →
//   四格快捷 → 进行中的任务 → 已完成任务（超过 4 条裁剪 + 底部渐隐）→ 对话记录。
// 四个弹层（添加任务 / 新建面板 / 记忆 / 任务详情）由本屏挂载；
// 全页透明底透出壁纸层，颜色走 tokens，动效只用 RN 内置 Animated。

import React, { useEffect, useState } from 'react';
import {
  Animated,
  Easing,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useUi } from './ui-state';
import { V7_SHADOWS, type V7Tokens } from './ui-theme';
import { Greeting } from '../components/Greeting';
import { TaskRow } from '../components/TaskRow';
import { MyPanels } from '../components/MyPanels';
import { TaskAddSheet } from '../components/TaskAddSheet';
import { VizPanelSheet } from '../components/VizPanelSheet';
import { MemoryPanelSheet } from '../components/MemoryPanelSheet';
import { TaskDetailSheet } from '../components/TaskDetailSheet';
import type { Bot, Conv, DoneTask, RunningTask, VizKind } from '../data/mock';

// 卡片上的白系叠层（原型 .ei / .sq .hd button / .vsel / .trow / .news .n 的底色，
// 只出现在强调色卡上，浅深主题通用）
const ON_CARD_14 = 'rgba(255,255,255,0.14)';
const ON_CARD_12 = 'rgba(255,255,255,0.12)';
const ON_CARD_08 = 'rgba(255,255,255,0.08)';
const ON_CARD_25 = 'rgba(255,255,255,0.25)';

// 原型 --spring：knob 位移等共用的弹簧曲线
const SPRING = Easing.bezier(0.3, 1.1, 0.45, 1);
// 原型 tgStretch 回程的 cubic-bezier(.3,1.08,.5,1)
const STRETCH_OUT_EASE = Easing.bezier(0.3, 1.08, 0.5, 1);
// tgStretch 0.36s 在 38% 处到达顶点 1.18
const STRETCH_IN_MS = 137;
const STRETCH_OUT_MS = 223;

// 数据卡三选一（原型 .vsel 的三个按钮）
const VIZ_SEGS: { k: VizKind; label: string }[] = [
  { k: 'stock', label: '股票' },
  { k: 'weather', label: '天气' },
  { k: 'news', label: '新闻' },
];

// 四格快捷（原型 .quad：连接/项目/搭建为占位，记忆开弹层）
const QUADS: { key: string; icon: string; label: string; placeholder: boolean }[] = [
  { key: 'connect', icon: '🔗', label: '连接', placeholder: true },
  { key: 'project', icon: '🗂', label: '项目', placeholder: true },
  { key: 'build', icon: '🧩', label: '搭建', placeholder: true },
  { key: 'memory', icon: '◉', label: '记忆', placeholder: false },
];

// 迷你柱状图：pts 归一化到 4~56 高度（原型 spark 的 RN 柱状近似）
function barHeights(pts: number[]): number[] {
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const range = max - min || 1;
  return pts.map(p => 4 + ((p - min) / range) * 52);
}

// 定时任务开关（原型 .tg）：knob left 2↔14 260ms 弹簧位移；
// 按下时整条 scaleX 1→1.18→1 弹一下（原型 tgStretch）。
function TimerToggle(props: { on: boolean; label: string; onToggle: () => void }) {
  const t = useUi().tokens;
  // 动画值用 useState 惰性初始化持有（渲染期读 ref.current 被 react-hooks/refs 禁止）
  const [knob] = useState(() => new Animated.Value(props.on ? 14 : 2));
  const [stretch] = useState(() => new Animated.Value(1));

  // on 翻转（本行按下或 store 侧 toggleTask）→ knob 260ms 弹簧位移
  useEffect(() => {
    Animated.timing(knob, {
      toValue: props.on ? 14 : 2,
      duration: 260,
      easing: SPRING,
      useNativeDriver: false,
    }).start();
  }, [props.on, knob]);

  const press = () => {
    stretch.setValue(1);
    Animated.sequence([
      Animated.timing(stretch, {
        toValue: 1.18,
        duration: STRETCH_IN_MS,
        easing: SPRING,
        useNativeDriver: false,
      }),
      Animated.timing(stretch, {
        toValue: 1,
        duration: STRETCH_OUT_MS,
        easing: STRETCH_OUT_EASE,
        useNativeDriver: false,
      }),
    ]).start();
    props.onToggle();
  };

  return (
    <Pressable
      onPress={press}
      accessibilityRole="switch"
      accessibilityState={{ checked: props.on }}
      accessibilityLabel={props.label}
      style={toggleStyles.hit}
      hitSlop={6}
    >
      <Animated.View
        style={[
          toggleStyles.track,
          { backgroundColor: props.on ? t.up : ON_CARD_25 },
          { transform: [{ scaleX: stretch }] },
        ]}
      >
        <Animated.View style={[toggleStyles.knob, { left: knob }]} />
      </Animated.View>
    </Pressable>
  );
}

// 开关的尺寸样式（不随主题，颜色在组件里按 on 状态给）
const toggleStyles = StyleSheet.create({
  hit: { width: 30, height: 18, flexShrink: 0 },
  track: { width: 30, height: 18, borderRadius: 9 },
  knob: {
    position: 'absolute',
    top: 2,
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#ffffff',
  },
});

// 原型 .home/.entry/.entrycard/.sq/.hd/.tlist/.trow/.vsel/.stock/.weather/.news/
// .quad/.qc/.sechead/.cv/.donewrap 的 RN 移植
const createStyles = (t: V7Tokens) =>
  StyleSheet.create({
    page: { flex: 1 },
    // 原型 .home：padding 50/18/76 → 上由安全区 +8 承担，左右 18，底 96，块间距 16
    content: { paddingHorizontal: 18, gap: 16 },

    // 双入口卡（原型 .entry/.entrycard）
    entryRow: { flexDirection: 'row', gap: 12 },
    entryCard: {
      flex: 1,
      minWidth: 0,
      backgroundColor: t.card,
      borderRadius: 20,
      padding: 14,
      gap: 8,
      ...V7_SHADOWS.card,
    },
    entryIcon: {
      width: 30,
      height: 30,
      borderRadius: 10,
      backgroundColor: ON_CARD_14,
      alignItems: 'center',
      justifyContent: 'center',
    },
    entryIconTxt: { fontSize: 14 },
    entryName: { fontSize: 14, fontWeight: '700', color: t.on },

    // 任务·定时 + 数据 双卡行（原型 .duo>.sq，RN 版型改为横排两卡）
    duoRow: { flexDirection: 'row', gap: 12 },
    sq: {
      flex: 1,
      minWidth: 0,
      backgroundColor: t.card,
      borderRadius: 22,
      height: 236,
      padding: 14,
      gap: 12,
      overflow: 'hidden',
      ...V7_SHADOWS.card,
    },
    sqHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    sqHeadTxt: { fontSize: 12, fontWeight: '700', color: t.on },
    sqBtn: {
      width: 22,
      height: 22,
      borderRadius: 8,
      backgroundColor: ON_CARD_14,
      alignItems: 'center',
      justifyContent: 'center',
    },
    sqBtnTxt: { fontSize: 12, color: t.on },

    // 任务列表（原型 .tlist/.trow）
    tlist: { flex: 1, gap: 8 },
    trow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      backgroundColor: ON_CARD_08,
      borderRadius: 12,
      paddingVertical: 8,
      paddingHorizontal: 10,
    },
    tm: { fontSize: 10, color: t.onDim, width: 34, flexShrink: 0 },
    tl: { flex: 1, fontSize: 12, color: t.on },

    // 数据卡（原型 .vizbody/.vsel/.stock/.weather/.news）
    vizbody: { flex: 1, gap: 8 },
    vsel: { flexDirection: 'row', gap: 4 },
    vselItem: { flex: 1, paddingVertical: 4, borderRadius: 8, alignItems: 'center' },
    vselTxt: { fontSize: 10 },
    vselOnTxt: { color: '#000000', fontWeight: '700' },
    vselOffTxt: { color: t.onDim },
    stockPrice: { fontSize: 22, fontWeight: '800', color: t.on, letterSpacing: -0.5 },
    stockChg: { fontSize: 12, fontWeight: '700' },
    bars: { flexDirection: 'row', alignItems: 'flex-end', height: 60 },
    bar: { flex: 1, marginHorizontal: 1, borderRadius: 1 },
    weatherTemp: { fontSize: 30, fontWeight: '800', color: t.on, letterSpacing: -1 },
    weatherCond: { fontSize: 12, color: t.onDim },
    weatherIcon: { fontSize: 26 },
    newsItem: {
      backgroundColor: ON_CARD_08,
      borderRadius: 10,
      paddingVertical: 8,
      paddingHorizontal: 10,
    },
    newsSrc: { fontSize: 10, color: t.onDim, marginBottom: 2 },
    newsTitle: { fontSize: 12, lineHeight: 18, color: t.on },

    // 分区标题（原型 .sechead：标题 + 弹性空隙 + 右侧计数）
    sechead: { flexDirection: 'row', alignItems: 'center', padding: 2, gap: 8 },
    secTxt: { fontSize: 12, fontWeight: '700', color: t.sec },
    secCount: { fontSize: 10, color: t.mut },

    // 进行中/已完成/对话记录的纵向列表（原型 .runlist/.donelist/.conv）
    listCol: { gap: 12 },

    // 四格快捷（原型 .quad/.qc）
    quad: { flexDirection: 'row', gap: 12 },
    qc: {
      flex: 1,
      minWidth: 0,
      backgroundColor: t.card,
      borderRadius: 20,
      paddingVertical: 16,
      paddingHorizontal: 4,
      minHeight: 96,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 12,
      ...V7_SHADOWS.card,
    },
    qcIcon: { fontSize: 30 },
    qcLabel: { fontSize: 13, fontWeight: '700', color: t.on, letterSpacing: 0.5 },

    // 已完成任务裁剪容器（原型 .donewrap.clipped 的 RN 简化版）+ 底部渐隐层
    doneWrap: { overflow: 'hidden' },
    fadeLayer: { position: 'absolute', left: 0, right: 0, height: 16, backgroundColor: t.surface },

    // 对话记录行（原型 .cv/.ca/.cc/.ct/.cs/.cm）
    convRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      backgroundColor: t.surface,
      borderRadius: 16,
      paddingVertical: 11,
      paddingHorizontal: 12,
      ...V7_SHADOWS.md,
    },
    convAvatar: {
      width: 36,
      height: 36,
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
    },
    convAvatarTxt: { fontSize: 16, color: '#ffffff' },
    convMid: { flex: 1, minWidth: 0 },
    convTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    convTitle: { fontSize: 13, fontWeight: '600', color: t.ink, flexShrink: 1 },
    convChip: {
      fontSize: 10,
      fontWeight: '700',
      borderRadius: 999,
      paddingVertical: 2,
      paddingHorizontal: 7,
      overflow: 'hidden',
    },
    convSub: { fontSize: 12, color: t.mut, marginTop: 2 },
    convTime: { fontSize: 10, color: t.mut, flexShrink: 0 },
  });

export function HomeScreen() {
  const ui = useUi();
  const t = ui.tokens;
  const styles = createStyles(t);
  const insets = useSafeAreaInsets();

  // 本屏挂载的弹层开关
  const [taskAddOpen, setTaskAddOpen] = useState(false);
  const [vizOpen, setVizOpen] = useState(false);
  const [memOpen, setMemOpen] = useState(false);
  const [taskDetail, setTaskDetail] = useState<{
    task: RunningTask | DoneTask;
    kind: 'run' | 'done';
  } | null>(null);

  // 已完成任务裁剪：每张卡 onLayout 记高度（按任务名记，避免下标位移拿错卡）；
  // 超过 4 条时容器 maxHeight = 前 4 张卡累计 + 3*12 gap + 64
  // （原型第 4 张卡底边 +64px 的简化实现）
  const [doneHeights, setDoneHeights] = useState<Record<string, number>>({});
  const [doneAtBottom, setDoneAtBottom] = useState(false);

  const measureDone = (name: string) => (e: LayoutChangeEvent) => {
    const h = Math.round(e.nativeEvent.layout.height);
    setDoneHeights(prev => (prev[name] === h ? prev : { ...prev, [name]: h }));
  };

  // 前 4 张卡的实测高度（量齐才启用裁剪，首帧不裁）
  const first4Heights = ui.done
    .slice(0, 4)
    .map(d => doneHeights[d.n])
    .filter((h): h is number => typeof h === 'number');
  const doneHeightsReady = ui.done.length > 4 && first4Heights.length === 4;
  const doneMaxHeight = doneHeightsReady
    ? first4Heights.reduce((a, b) => a + b, 0) + 3 * 12 + 64
    : undefined;
  const showDoneFade = doneHeightsReady && !doneAtBottom;

  // 页面滚动接近底部时隐藏渐隐层（原型 .donewrap.at-bottom 的简化）
  const onPageScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
    const atBottom = contentOffset.y + layoutMeasurement.height >= contentSize.height - 2;
    setDoneAtBottom(prev => (prev === atBottom ? prev : atBottom));
  };

  // 对话行的 bot 资料（原型按名字回查 bots，找不到时退回第一个）
  const botOf = (c: Conv): Bot | undefined => ui.bots.find(b => b.n === c.bot) ?? ui.bots[0];

  // 股票涨跌配色（柱状图与涨跌幅共用）
  const chgColor = ui.stock.chg >= 0 ? t.up : t.down;

  return (
    <>
      <ScrollView
        style={styles.page}
        contentContainerStyle={[styles.content, { paddingTop: insets.top + 8, paddingBottom: 96 }]}
        showsVerticalScrollIndicator={false}
        onScroll={onPageScroll}
        scrollEventThrottle={16}
      >
        {/* 1. 问候语 */}
        <Greeting />

        {/* 2. 双入口卡（原型 .entry：对话 / 创建面板） */}
        <View style={styles.entryRow}>
          <Pressable
            style={styles.entryCard}
            onPress={() => (ui.convs.length ? ui.openConv(0) : ui.toast('还没有对话记录'))}
            accessibilityRole="button"
            accessibilityLabel="对话"
          >
            <View style={styles.entryIcon}>
              <Text style={styles.entryIconTxt}>💬</Text>
            </View>
            <Text style={styles.entryName}>对话</Text>
          </Pressable>
          <Pressable
            style={styles.entryCard}
            onPress={() => setVizOpen(true)}
            accessibilityRole="button"
            accessibilityLabel="创建面板"
          >
            <View style={styles.entryIcon}>
              <Text style={styles.entryIconTxt}>⌗</Text>
            </View>
            <Text style={styles.entryName}>创建面板</Text>
          </Pressable>
        </View>

        {/* 3. 任务·定时 + 数据 双卡行 */}
        <View style={styles.duoRow}>
          {/* 任务 · 定时（原型第一个 .sq：头行 + tlist） */}
          <View style={styles.sq}>
            <View style={styles.sqHead}>
              <Text style={styles.sqHeadTxt}>任务 · 定时</Text>
              <View style={{ flex: 1 }} />
              <Pressable
                style={styles.sqBtn}
                onPress={() => setTaskAddOpen(true)}
                accessibilityRole="button"
                accessibilityLabel="添加定时任务"
              >
                <Text style={styles.sqBtnTxt}>＋</Text>
              </Pressable>
            </View>
            <View style={styles.tlist}>
              {ui.tasks.map((task, i) => (
                <View key={i} style={styles.trow}>
                  <Text style={styles.tm}>{task.t}</Text>
                  <Text style={styles.tl} numberOfLines={1} ellipsizeMode="tail">
                    {task.l}
                  </Text>
                  <TimerToggle on={task.on} label={task.l} onToggle={() => ui.toggleTask(i)} />
                </View>
              ))}
            </View>
          </View>

          {/* 数据（原型第二个 .sq：vsel 三分段 + vizbody） */}
          <View style={styles.sq}>
            <View style={styles.sqHead}>
              <Text style={styles.sqHeadTxt}>数据</Text>
              <View style={{ flex: 1 }} />
              <Pressable
                style={styles.sqBtn}
                onPress={ui.refreshViz}
                accessibilityRole="button"
                accessibilityLabel="刷新数据"
              >
                <Text style={styles.sqBtnTxt}>⟳</Text>
              </Pressable>
            </View>
            <View style={styles.vizbody}>
              <View style={styles.vsel}>
                {VIZ_SEGS.map(seg => {
                  const on = seg.k === ui.viz;
                  return (
                    <Pressable
                      key={seg.k}
                      style={[styles.vselItem, { backgroundColor: on ? '#ffffff' : ON_CARD_12 }]}
                      onPress={() => ui.setViz(seg.k)}
                      accessibilityRole="button"
                      accessibilityLabel={'数据：' + seg.label}
                    >
                      <Text style={[styles.vselTxt, on ? styles.vselOnTxt : styles.vselOffTxt]}>
                        {seg.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              {ui.viz === 'stock' && (
                <>
                  <Text style={styles.stockPrice}>{ui.stock.price.toFixed(1)}</Text>
                  <Text style={[styles.stockChg, { color: chgColor }]}>
                    {(ui.stock.chg >= 0 ? '+' : '') + ui.stock.chg.toFixed(2) + '%'}
                  </Text>
                  {ui.stock.pts.length > 0 && (
                    <View style={styles.bars}>
                      {barHeights(ui.stock.pts).map((h, i) => (
                        <View key={i} style={[styles.bar, { height: h, backgroundColor: chgColor }]} />
                      ))}
                    </View>
                  )}
                </>
              )}
              {ui.viz === 'weather' && (
                <>
                  <Text style={styles.weatherTemp}>{ui.weather.temp}°</Text>
                  <Text style={styles.weatherCond}>
                    {ui.weather.cond} · 最高 {ui.weather.hi}° / 最低 {ui.weather.lo}°
                  </Text>
                  <Text style={styles.weatherIcon}>⛅</Text>
                </>
              )}
              {ui.viz === 'news' &&
                ui.news.map(n => (
                  <View key={n.s + n.t} style={styles.newsItem}>
                    <Text style={styles.newsSrc}>{n.s}</Text>
                    <Text style={styles.newsTitle}>{n.t}</Text>
                  </View>
                ))}
            </View>
          </View>
        </View>

        {/* 4. 我的面板（原型 myPanelsWrap：没有面板时整块隐藏） */}
        {ui.panels.length > 0 && (
          <>
            <View style={styles.sechead}>
              <Text style={styles.secTxt}>我的面板</Text>
            </View>
            <MyPanels />
          </>
        )}

        {/* 5. 四格快捷（原型 .quad：连接/项目/搭建占位，记忆开弹层） */}
        <View style={styles.quad}>
          {QUADS.map(q => (
            <Pressable
              key={q.key}
              style={styles.qc}
              onPress={() => (q.placeholder ? ui.toast('演示版：暂未接入') : setMemOpen(true))}
              accessibilityRole="button"
              accessibilityLabel={q.label}
            >
              <Text style={styles.qcIcon}>{q.icon}</Text>
              <Text style={styles.qcLabel}>{q.label}</Text>
            </Pressable>
          ))}
        </View>

        {/* 6. 进行中的任务 */}
        <View style={styles.sechead}>
          <Text style={styles.secTxt}>进行中的任务</Text>
          <View style={{ flex: 1 }} />
          <Text style={styles.secCount}>{ui.running.length} 个进行中</Text>
        </View>
        <View style={styles.listCol}>
          {ui.running.map(r => (
            <TaskRow
              key={r.n}
              kind="run"
              task={r}
              onPress={() => setTaskDetail({ task: r, kind: 'run' })}
            />
          ))}
        </View>

        {/* 7. 已完成任务：超过 4 条时裁剪 + 底部渐隐，不超过则原样铺开 */}
        <View style={styles.sechead}>
          <Text style={styles.secTxt}>已完成任务</Text>
          <View style={{ flex: 1 }} />
          <Text style={styles.secCount}>{ui.done.length} 个已完成</Text>
        </View>
        {ui.done.length > 4 ? (
          <View style={doneMaxHeight !== undefined ? [styles.doneWrap, { maxHeight: doneMaxHeight }] : undefined}>
            <View style={styles.listCol}>
              {ui.done.map((d, i) => (
                <View key={d.n} onLayout={measureDone(d.n)}>
                  <TaskRow
                    kind="done"
                    task={d}
                    onPress={() => setTaskDetail({ task: d, kind: 'done' })}
                  />
                </View>
              ))}
            </View>
            {/* 底部 64px 渐隐层：三层 surface 叠出近似的 mask 渐隐（原型 mask-image） */}
            {showDoneFade && (
              <>
                <View pointerEvents="none" style={[styles.fadeLayer, { bottom: 0, opacity: 0.75 }]} />
                <View pointerEvents="none" style={[styles.fadeLayer, { bottom: 16, opacity: 0.45 }]} />
                <View pointerEvents="none" style={[styles.fadeLayer, { bottom: 32, opacity: 0.2 }]} />
              </>
            )}
          </View>
        ) : (
          <View style={styles.listCol}>
            {ui.done.map(d => (
              <TaskRow
                key={d.n}
                kind="done"
                task={d}
                onPress={() => setTaskDetail({ task: d, kind: 'done' })}
              />
            ))}
          </View>
        )}

        {/* 8. 对话记录 */}
        <View style={styles.sechead}>
          <Text style={styles.secTxt}>对话记录</Text>
        </View>
        <View style={styles.listCol}>
          {ui.convs.map((c, i) => {
            const bot = botOf(c);
            if (!bot) return null;
            return (
              <Pressable
                key={c.bot + c.t}
                style={styles.convRow}
                onPress={() => ui.openConv(i)}
                accessibilityRole="button"
                accessibilityLabel={'打开对话：' + c.t}
              >
                <View style={[styles.convAvatar, { backgroundColor: bot.bg }]}>
                  <Text style={styles.convAvatarTxt}>{bot.icon}</Text>
                </View>
                <View style={styles.convMid}>
                  <View style={styles.convTitleRow}>
                    <Text style={styles.convTitle} numberOfLines={1}>
                      {c.t}
                    </Text>
                    {bot.created && bot.role !== '' && (
                      <Text style={[styles.convChip, { backgroundColor: `${bot.bg}1a`, color: bot.bg }]}>
                        {bot.role}
                      </Text>
                    )}
                  </View>
                  <Text style={styles.convSub} numberOfLines={1}>
                    {c.bot} · {c.s}
                  </Text>
                </View>
                <Text style={styles.convTime}>{c.m}</Text>
              </Pressable>
            );
          })}
        </View>
      </ScrollView>

      {/* 本屏弹层：添加任务 / 新建面板 / 记忆 / 任务详情 */}
      <TaskAddSheet visible={taskAddOpen} onClose={() => setTaskAddOpen(false)} />
      <VizPanelSheet visible={vizOpen} onClose={() => setVizOpen(false)} />
      <MemoryPanelSheet visible={memOpen} onClose={() => setMemOpen(false)} />
      <TaskDetailSheet
        visible={taskDetail !== null}
        onClose={() => setTaskDetail(null)}
        kind={taskDetail?.kind ?? 'run'}
        task={taskDetail?.task ?? null}
      />
    </>
  );
}
