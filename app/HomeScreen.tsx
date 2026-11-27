// 蓝鸟 UI 移植 · 主页整屏（原型 .home 的 RN 移植）
// 结构自上而下：问候语 → 双入口卡 → 任务·定时/数据 双卡行 → 我的面板 →
//   四格快捷 → 进行中的任务 → 已完成任务（超过 4 条裁剪 + 底部渐隐）→ 对话记录。
// 四个弹层（添加任务 / 新建面板 / 记忆 / 任务详情）由本屏挂载；
// 全页透明底透出壁纸层，颜色走 tokens，动效只用 RN 内置 Animated。

import React, { useCallback, useEffect, useState } from 'react';
import {
  Animated,
  Easing,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useUi } from './ui-state';
import { V7_SHADOWS, type V7Tokens } from './ui-theme';
import { Greeting } from '../components/Greeting';
import { TaskRow, type TaskRowModel } from '../components/TaskRow';
import { MyPanels } from '../components/MyPanels';
import { TaskAddSheet } from '../components/TaskAddSheet';
import { VizPanelSheet } from '../components/VizPanelSheet';
import { MemoryCenterSheet } from '../components/MemoryCenterSheet';
import { TaskDetailSheet } from '../components/TaskDetailSheet';
import { EntryIcon, QuadIcon } from '../components/V7Icons';
import Svg, { Polyline } from 'react-native-svg';
import { apiFetch } from '../lib/api/client';
import { API_PATHS } from '../lib/api/endpoints';
import { formatMessageTime } from '../lib/utils';
import type { AgentTask, AgentTasksResponse } from '../lib/api/types';
import type { SessionMeta } from '../lib/types';
import type { VizKind } from '../data/ui-contract';

// 真实任务状态语义（与旧壳 TasksPanel 同源）：进行中 = 非终态；终态进「已完成」段。
// 注意 recovery（待核对）在服务端是正式终态（status-vocabulary.js S5）——
// 放进运行段会让待核对任务永久卡在「进行中」+ 假成功取消（oracle 复查阻断）
const TASK_STATUS_LABEL: Record<string, string> = {
  queued: '排队中',
  accepted: '已接收',
  running: '执行中',
  waiting_approval: '等待审批',
  retrying: '重试中',
  recovery: '待核对',
  completed: '完成',
  failed: '失败',
  cancelled: '已取消',
  timed_out: '超时',
};
const RUNNING_STATUSES = new Set([
  'queued',
  'accepted',
  'running',
  'waiting_approval',
  'retrying',
]);
const CANCELLABLE_STATUSES = RUNNING_STATUSES;

// 空白会话统一显示「新对话」（与旧壳 HistoryScreen 同语义）；
// 服务端的「新会话」只是占位标题，不对用户暴露。
function sessionDisplayTitle(item: SessionMeta): string {
  if (item.messageCount === 0) return '新对话';

  return item.title || '未命名会话';
}

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
const QUADS: { key: 'connect' | 'project' | 'build' | 'memory'; label: string; placeholder: boolean }[] = [
  { key: 'connect', label: '连接', placeholder: true },
  { key: 'project', label: '项目', placeholder: true },
  { key: 'build', label: '搭建', placeholder: true },
  { key: 'memory', label: '记忆', placeholder: false },
];

// 数据卡走势图（原型 spark 的 RN 移植）：SVG 折线，与原型曲线视觉一致
function SparkLine({ pts, color }: { pts: number[]; color: string }) {
  const w = 300;
  const h = 60;
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const range = max - min || 1;
  const points = pts
    .map((p, i) => {
      const x = (i / (pts.length - 1)) * w;
      const y = h - 6 - ((p - min) / range) * (h - 12);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <Svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`}>
      <Polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
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
    // 原型 .home：padding 50/18/76 → 上由安全区 +8 承担，左右 18，底 76，块间距 16
    content: { paddingHorizontal: 18, gap: 16 },

    // 双入口卡（原型 .entry/.entrycard）
    entryRow: { flexDirection: 'row', gap: 12 },
    entryCard: {
      flex: 1,
      minWidth: 0,
      backgroundColor: t.card,
      borderRadius: 20,
      padding: 14,
      // 原型 .entrycard > .er：图标块与标题同一行（紧凑单行卡）
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
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

    // 任务·定时 + 数据：原型 .duo 是纵向排列（两张通栏卡），不是横排半宽
    duoRow: { gap: 12 },
    sq: {
      width: '100%',
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
    tl: { flex: 1, minWidth: 0, fontSize: 12, color: t.on },

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
    // 对话记录空态 / 读取中 / 读取失败：同一张卡片内居中弱化文字
    convEmpty: {
      backgroundColor: t.surface,
      borderRadius: 16,
      paddingVertical: 16,
      paddingHorizontal: 12,
      ...V7_SHADOWS.md,
    },
    convEmptyTxt: { fontSize: 12, color: t.mut, textAlign: 'center' },
    convChipCur: { backgroundColor: t.soft, color: t.sec },
  });

export function HomeScreen({
  sessions,
  currentSessionId,
  loadingSessions,
  sessionsError,
  onSelectSession,
  onNewChat,
  onSheetOpenChange,
}: {
  sessions: SessionMeta[];
  currentSessionId: string;
  loadingSessions: boolean;
  sessionsError: string;
  onSelectSession: (sessionId: string) => void;
  // 首页「对话」入口 = 新开一条空会话（打开历史请走下方「对话记录」）
  onNewChat: () => void;
  // 弹层打开/关闭通知：壳层悬浮导航在 pane 之上，弹层打开时需要它临时收起
  onSheetOpenChange?: (open: boolean) => void;
}) {
  const ui = useUi();
  const t = ui.tokens;
  const styles = createStyles(t);
  const insets = useSafeAreaInsets();

  // 本屏挂载的弹层开关
  const [taskAddOpen, setTaskAddOpen] = useState(false);
  const [vizOpen, setVizOpen] = useState(false);
  const [memOpen, setMemOpen] = useState(false);
  // 任务详情（真实任务）：点行开详情，可取消状态给「取消任务」入口（live 状态在后面派生）
  const [realDetailId, setRealDetailId] = useState<string | null>(null);

  // 任一弹层打开时收起壳层悬浮导航（弹层在 pane 内，盖不过壳层导航）
  useEffect(() => {
    onSheetOpenChange?.(taskAddOpen || vizOpen || memOpen || realDetailId !== null);
  }, [taskAddOpen, vizOpen, memOpen, realDetailId, onSheetOpenChange]);

  // ---- 真实任务（/agent-tasks，与旧壳 TasksPanel 同源）----
  // 主页是全局视图：拉 memory Bot 的任务（不挂 parentSessionId）。
  // 轮询只在主页视图进行（双 pane 常挂载，聊天/设置/弹层打开时不打请求）；
  // 6s 是主页自己的节奏（旧壳任务页 4s，两 pane 常挂载下更省）。
  const [agentTasks, setAgentTasks] = useState<AgentTask[]>([]);
  const loadAgentTasks = useCallback(() => {
    apiFetch(API_PATHS.agentTasks('memory', 30))
      .then(async response => {
        if (!response.ok) throw new Error('failed');
        const data = (await response.json()) as AgentTasksResponse;
        setAgentTasks(data.tasks || []);
      })
      .catch(() => {
        // 拉取失败保持上一次列表（或空），不弹框打断主页
      });
  }, []);
  useEffect(() => {
    if (ui.view !== 'home') return undefined;
    loadAgentTasks();
    const timer = setInterval(loadAgentTasks, 6000);
    return () => clearInterval(timer);
  }, [ui.view, loadAgentTasks]);

  const runningTasks = agentTasks.filter(t => RUNNING_STATUSES.has(t.status));

  const realRowModel = (t: AgentTask): TaskRowModel => {
    const label = TASK_STATUS_LABEL[t.status] ?? t.status;
    if (RUNNING_STATUSES.has(t.status)) {
      // 运行态没有真实百分比数据：状态色满条 + 35% 透明（状态条，不伪造进度）
      return {
        n: t.goal,
        rightLabel: label,
        rightTone: 'mut',
        fillPct: 100,
        fillColor: ui.tokens.info,
        fillOpacity: 0.35,
      };
    }
    const failed = t.status !== 'completed';
    return {
      n: t.goal,
      rightLabel: label,
      rightTone: failed ? 'fail' : 'ok',
      fillPct: 100,
      fillColor: failed ? ui.tokens.down : ui.tokens.up,
      fillOpacity: failed ? 0.35 : 1,
    };
  };

  // 任务详情 live 状态：轮询每 6s 重建 agentTasks——详情按 taskId 从最新列表派生，
  // 打开期间任务终态化时 statusLabel/cancellable 跟着变（不持陈旧引用）
  const realDetailLive = agentTasks.find(t => t.taskId === realDetailId) ?? null;

  // 股票涨跌配色（柱状图与涨跌幅共用）
  const chgColor = ui.stock.chg >= 0 ? t.up : t.down;

  return (
    <>
      <ScrollView
        style={styles.page}
        contentContainerStyle={[styles.content, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 74 }]}
        showsVerticalScrollIndicator={false}
      >
        {/* 1. 问候语 */}
        <Greeting />

        {/* 2. 双入口卡（原型 .entry：对话 / 创建面板） */}
        <View style={styles.entryRow}>
          <Pressable
            style={styles.entryCard}
            onPress={onNewChat}
            accessibilityRole="button"
            accessibilityLabel="新对话"
          >
            <View style={styles.entryIcon}>
              <EntryIcon kind="chat" />
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
              <EntryIcon kind="grid" />
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
                    <SparkLine pts={ui.stock.pts} color={chgColor} />
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
              <QuadIcon kind={q.key} />
              <Text style={styles.qcLabel}>{q.label}</Text>
            </Pressable>
          ))}
        </View>

        {/* 6. 进行中的任务（真实 /agent-tasks；无任务时整段隐藏——不展示假数据） */}
        {runningTasks.length > 0 && (
          <>
            <View style={styles.sechead}>
              <Text style={styles.secTxt}>进行中的任务</Text>
              <View style={{ flex: 1 }} />
              <Text style={styles.secCount}>{runningTasks.length} 个进行中</Text>
            </View>
            <View style={styles.listCol}>
              {runningTasks.map(t => (
                <TaskRow
                  key={t.taskId}
                  model={realRowModel(t)}
                  onPress={() => setRealDetailId(t.taskId)}
                />
              ))}
            </View>
          </>
        )}

        {/* 7. 对话记录（真实会话列表：数据由 useSessionList 注入，点击切换会话） */}
        <View style={styles.sechead}>
          <Text style={styles.secTxt}>对话记录</Text>
          {sessions.length > 0 && (
            <>
              <View style={{ flex: 1 }} />
              <Text style={styles.secCount}>{sessions.length} 个对话</Text>
            </>
          )}
        </View>
        <View style={styles.listCol}>
          {/* 列表已有内容但刷新失败：保留列表，同时如实提示错误（不静默吞掉） */}
          {!!sessionsError && sessions.length > 0 && (
            <Text style={styles.convEmptyTxt}>{sessionsError}</Text>
          )}
          {sessions.length === 0 ? (
            <View style={styles.convEmpty}>
              <Text style={styles.convEmptyTxt}>
                {loadingSessions ? '正在读取对话记录…' : sessionsError || '还没有对话记录'}
              </Text>
            </View>
          ) : (
            sessions.map(item => {
              const current = item.id === currentSessionId;
              const title = sessionDisplayTitle(item);
              return (
                <Pressable
                  key={item.id}
                  style={styles.convRow}
                  onPress={() => onSelectSession(item.id)}
                  accessibilityRole="button"
                  accessibilityLabel={'打开对话：' + title}
                >
                  <View style={[styles.convAvatar, { backgroundColor: ui.bots[0]?.bg ?? '#000000' }]}>
                    <Text style={styles.convAvatarTxt}>{ui.bots[0]?.icon ?? '🐦'}</Text>
                  </View>
                  <View style={styles.convMid}>
                    <View style={styles.convTitleRow}>
                      <Text style={styles.convTitle} numberOfLines={1}>
                        {title}
                      </Text>
                      {current && (
                        <Text style={[styles.convChip, styles.convChipCur]}>当前</Text>
                      )}
                    </View>
                    <Text style={styles.convSub} numberOfLines={1}>
                      {`Bluebird · ${item.messageCount} 条消息`}
                    </Text>
                  </View>
                  <Text style={styles.convTime}>{formatMessageTime(item.updatedAt)}</Text>
                </Pressable>
              );
            })
          )}
        </View>
      </ScrollView>

      {/* 本屏弹层：添加任务 / 新建面板 / 记忆 / 任务详情 */}
      <TaskAddSheet visible={taskAddOpen} onClose={() => setTaskAddOpen(false)} />
      <VizPanelSheet visible={vizOpen} onClose={() => setVizOpen(false)} />
      <MemoryCenterSheet visible={memOpen} onClose={() => setMemOpen(false)} />
      <TaskDetailSheet
        visible={realDetailLive !== null}
        onClose={() => setRealDetailId(null)}
        realTask={
          realDetailLive
            ? {
                taskId: realDetailLive.taskId,
                goal: realDetailLive.goal,
                botId: realDetailLive.botId,
                statusLabel: TASK_STATUS_LABEL[realDetailLive.status] ?? realDetailLive.status,
                cancellable: CANCELLABLE_STATUSES.has(realDetailLive.status),
                cancelRequested: realDetailLive.cancelRequested,
                resultSummary: realDetailLive.result?.summary ?? '',
                errorCode: realDetailLive.errorCode ?? '',
                result: realDetailLive.result ?? null,
              }
            : null
        }
        onRealCancelled={() => {
          setRealDetailId(null);
          loadAgentTasks();
        }}
      />
    </>
  );
}
