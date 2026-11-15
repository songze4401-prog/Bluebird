// 蓝鸟 UI 移植 · 全局骨架：共享 UI 状态（假数据版）
// 原型把全部状态塞在顶层 state 对象里；这里换成 React context：
//   - state：原型 state 对象的逐字段镜像（user/ui/bot/model/tasks/running/done/
//     viz/stock/weather/news/bots/convs/messages/panels/persona/customModels + mems）
//   - 动作：原型每个 addEventListener 的一一移植
//   - 全局系统：主题圆形扩散动画、Toast、壁纸层由 Provider 统一渲染，
//     三屏与弹层只通过 useUi() 取数据与动作。
// 不接任何真实后端；接后端时只需替换本文件的数据来源。

import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  Animated,
  Easing,
  Image,
  Text,
  useColorScheme,
  useWindowDimensions,
  View,
} from 'react-native';

import {
  INITIAL_MEMS,
  createInitialState,
  genPts,
  nowStr,
  type AttachmentChip,
  type Bot,
  type ChatMessage,
  type Conv,
  type DoneTask,
  type FontPref,
  type Mem,
  type Persona,
  type RunningTask,
  type Stage,
  type TaskTimer,
  type ThemePref,
  type UiPanel,
  type UiState,
  type UserAvatar,
  type VizKind,
  type ViewId,
  type WallpaperId,
} from '../data/mock';

import { getTokens, V7_SHADOWS, type V7Tokens } from './ui-theme';

// 全屏绝对定位（本仓库 RN 版型的 StyleSheet 类型里没有 absoluteFillObject）
const ABS_FILL = {
  position: 'absolute',
  left: 0,
  right: 0,
  top: 0,
  bottom: 0,
} as const;

// ---- Store 类型：数据 + 派生 + 动作 ----
export type UiStore = {
  // ---- 数据（原型 state 的镜像）----
  view: ViewId;
  bot: string;
  user: UiState['user'];
  ui: UiState['ui'];
  tone: string;
  model: string;
  tasks: TaskTimer[];
  running: RunningTask[];
  done: DoneTask[];
  viz: VizKind;
  stock: UiState['stock'];
  weather: UiState['weather'];
  news: UiState['news'];
  bots: Bot[];
  convs: Conv[];
  messages: ChatMessage[];
  panels: UiPanel[];
  persona: Persona;
  customModels: string[];
  mems: Mem[];
  busy: boolean;
  // ---- 派生 ----
  tokens: V7Tokens;
  isDark: boolean;
  fontDelta: number;
  // ---- 动作 ----
  setView: (v: ViewId) => void;
  openConv: (i: number) => void;
  send: (text: string, attach?: AttachmentChip) => void;
  toggleTask: (i: number) => void;
  addTask: (t: string, l: string) => void;
  refreshViz: () => void;
  setViz: (v: VizKind) => void;
  createPanel: (n: string, t: VizKind) => void;
  confirmMem: (i: number) => void;
  rejectMem: (i: number) => void;
  deleteMem: (i: number) => void;
  renameBot: (n: string) => void;
  setBotAvatar: (uri: string) => void;
  setModel: (m: string) => void;
  addCustomModel: (m: string) => void;
  setPersonaPrompt: (s: string) => void;
  requestTheme: (next: ThemePref, origin?: Origin) => void;
  setWallpaper: (w: WallpaperId, uri?: string) => void;
  setAccent: (c: string) => void;
  setFont: (f: FontPref) => void;
  setLanguage: (l: string) => void;
  setNotify: (on: boolean) => void;
  switchAccount: (a: string) => void;
  setUserAvatar: (a: UserAvatar) => void;
  cancelTask: (t: RunningTask) => void;
  retryTask: (t: RunningTask) => void;
  resumeTask: (t: RunningTask) => void;
  redoDone: (t: DoneTask) => void;
  toast: (msg: string) => void;
};

// 主题揭示的圆心坐标
type Origin = { x: number; y: number };

const UiCtx = createContext<UiStore | null>(null);

export function useUi(): UiStore {
  const v = useContext(UiCtx);
  if (!v) throw new Error('useUi 必须在 <UiStateProvider> 内使用');
  return v;
}

export function UiStateProvider({ children }: { children: React.ReactNode }) {
  const [s, setS] = useState<UiState>(createInitialState);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [mems, setMems] = useState<Mem[]>(() => INITIAL_MEMS.map(m => ({ ...m })));
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const scheme = useColorScheme();
  const isDark =
    s.ui.theme === 'dark' || (s.ui.theme === 'system' && scheme === 'dark');
  const tokens = getTokens(isDark, s.ui.accent);
  const fontDelta = s.ui.font === '小' ? -2 : s.ui.font === '大' ? 2 : 0;

  const patch = (fn: (prev: UiState) => UiState) => setS(prev => fn(prev));

  // ---- Toast（原型 .toast：强调色 pill，2.2s 自动消失）----
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [toastAnim] = useState(() => new Animated.Value(0));
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toast = (msg: string) => {
    setToastMsg(msg);
    toastAnim.setValue(0);
    Animated.timing(toastAnim, { toValue: 1, duration: 250, useNativeDriver: true }).start();
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => {
      Animated.timing(toastAnim, { toValue: 0, duration: 250, useNativeDriver: true }).start(
        () => setToastMsg(null)
      );
    }, 2200);
  };

  // ---- 主题圆形扩散（原型 setThemeWithReveal 的移植）----
  // 切深色：深色圆从选项中心扩散覆盖全屏，动画结束后才提交主题；
  // 切浅色：主题立即提交，深色圆沿同一圆心（revealOrigin 原路）收回。
  const [reveal, setReveal] = useState<{ toDark: boolean; x: number; y: number } | null>(null);
  const [revealAnim] = useState(() => new Animated.Value(0));
  const [revealOrigin, setRevealOrigin] = useState<Origin | null>(null);

  const requestTheme = (next: ThemePref, origin?: Origin) => {
    const willDark = next === 'dark' || (next === 'system' && scheme === 'dark');
    const cur = s.ui.theme;
    const curDark = cur === 'dark' || (cur === 'system' && scheme === 'dark');
    if (willDark === curDark) {
      // 只翻分段高亮，不需要动画
      patch(prev => ({ ...prev, ui: { ...prev.ui, theme: next } }));
      return;
    }
    if (!willDark) {
      // 切浅色：主题立即提交，深色圆在上层沿原路收回
      patch(prev => ({ ...prev, ui: { ...prev.ui, theme: next } }));
    }
    const o = origin ?? revealOrigin ?? { x: 0, y: 0 };
    if (willDark) setRevealOrigin(o);
    setReveal({ toDark: willDark, x: o.x, y: o.y });
    revealAnim.setValue(willDark ? 0 : 1);
    Animated.timing(revealAnim, {
      toValue: willDark ? 1 : 0,
      duration: 800,
      easing: Easing.bezier(0.3, 1.1, 0.45, 1),
      useNativeDriver: true,
    }).start(() => {
      if (willDark) {
        // 盖满全屏后才提交深色主题
        patch(prev => ({ ...prev, ui: { ...prev.ui, theme: next } }));
      }
      setReveal(null);
    });
  };

  // ---- 演示层回复（原型 fakeReply：不接接口，但让模型/人设设置真的体现在对话里）----
  const fakeReply = (q: string): string => {
    const st = s;
    const p = (st.persona.customPrompt || '').trim();
    const core = /你好|您好|hi|hello|在吗|嗨/i.test(q)
      ? '我在。有什么要我处理的？'
      : /任务|进度|状态|完成/.test(q)
        ? '当前 ' + st.running.length + ' 个进行中、' + st.done.length + ' 个已完成。'
        : /记忆|记住|忘了/.test(q)
          ? '记忆面板里还有 ' + mems.filter(m => m.p).length + ' 条候选等你确认。'
          : '收到。按「' + st.tone + '」处理：先结论后依据。';
    return core + '\n— ' + st.model + (p ? ' · 人设已应用' : '');
  };

  // ---- 发送（原型 send/pushReply：用户消息 → 打字点 650ms → 演示回复）----
  const send = (text: string, attach?: AttachmentChip) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setMessages(prev => [...prev, { role: 'user', text, time: nowStr(), attach }]);
    setTimeout(() => {
      setMessages(prev => [
        ...prev,
        {
          role: 'blue' as const,
          text: fakeReply(text),
          tool: '理解意图 · 已接上下文',
          time: nowStr(),
        },
      ]);
      busyRef.current = false;
      setBusy(false);
    }, 650);
  };

  // ---- 进度 tick（原型 1.5s：走完的移入「已完成」并 toast）----
  useEffect(() => {
    const timer = setInterval(() => {
      setS(prev => {
        let moved = false;
        const stillRunning: RunningTask[] = [];
        const justDone: DoneTask[] = [];
        for (const r of prev.running) {
          if (r.status !== 'failed' && r.p < 100) {
            const np = Math.min(100, r.p + 1 + Math.floor(Math.random() * 3));
            if (np >= 100) {
              moved = true;
              justDone.push({
                n: r.n,
                bot: r.bot,
                c: r.c,
                result: '已完成，全部阶段通过审校。',
                arts: r.arts || [],
                stages: r.stages.map((st: Stage): Stage => [st[0], 'done']),
              });
            } else {
              stillRunning.push({ ...r, p: np });
            }
          } else {
            stillRunning.push(r);
          }
        }
        if (!moved) return prev;
        return { ...prev, running: stillRunning, done: [...justDone, ...prev.done] };
      });
    }, 1500);
    return () => clearInterval(timer);
  }, []);

  // ---- 动作区（原型各 addEventListener 的一一移植）----
  const setView = (v: ViewId) => setS(prev => ({ ...prev, view: v }));

  const openConv = (i: number) => {
    const c = s.convs[i];
    if (!c) return;
    // 打开对话：设定 bot 名并铺两条演示消息，切到聊天页
    setS(prev => ({ ...prev, bot: c.bot, view: 'chat' }));
    setMessages([
      { role: 'user', text: c.t, time: c.m },
      { role: 'blue', text: c.s, time: c.m },
    ]);
  };

  const toggleTask = (i: number) =>
    setS(prev => ({
      ...prev,
      tasks: prev.tasks.map((t, idx) => (idx === i ? { ...t, on: !t.on } : t)),
    }));

  const addTask = (t: string, l: string) => {
    setS(prev => ({ ...prev, tasks: [...prev.tasks, { t, l, on: true }] }));
    toast('已添加定时任务');
  };

  const refreshViz = () => {
    setS(prev => ({
      ...prev,
      stock: {
        price: Math.round((120 + Math.random() * 20) * 10) / 10,
        chg: Math.round((Math.random() * 4 - 2) * 100) / 100,
        pts: genPts(),
      },
      weather: { ...prev.weather, temp: 18 + Math.floor(Math.random() * 12) },
    }));
    toast('数据已刷新');
  };

  const setViz = (v: VizKind) => setS(prev => ({ ...prev, viz: v }));

  const createPanel = (n: string, t: VizKind) => {
    setS(prev => ({ ...prev, panels: [...prev.panels, { n, t }] }));
    toast('已创建面板');
  };

  const confirmMem = (i: number) => {
    setMems(prev => prev.map((m, idx) => (idx === i ? { ...m, p: false } : m)));
    toast('已记住');
  };

  const rejectMem = (i: number) => {
    setMems(prev => prev.filter((_, idx) => idx !== i));
    toast('好的，忽略了');
  };

  const deleteMem = (i: number) => {
    setMems(prev => prev.filter((_, idx) => idx !== i));
    toast('已删除');
  };

  const renameBot = (n: string) =>
    setS(prev => ({
      ...prev,
      bot: n,
      bots: prev.bots.map((b, i) => (i === 0 ? { ...b, n } : b)),
      convs: prev.convs.map((c, i) => (i === 0 ? { ...c, bot: n } : c)),
    }));

  const setBotAvatar = (uri: string) =>
    setS(prev => ({
      ...prev,
      bots: prev.bots.map((b, i) => (i === 0 ? { ...b, avatarImg: uri } : b)),
    }));

  const setModel = (m: string) => setS(prev => ({ ...prev, model: m }));

  const addCustomModel = (m: string) => {
    setS(prev => ({ ...prev, customModels: [...prev.customModels, m], model: m }));
    toast('已添加自定义模型 ' + m);
  };

  const setPersonaPrompt = (text: string) =>
    setS(prev => ({ ...prev, persona: { ...prev.persona, customPrompt: text } }));

  const setWallpaper = (w: WallpaperId, uri?: string) => {
    setS(prev => ({
      ...prev,
      ui: { ...prev.ui, wallpaper: w, customWall: uri ?? prev.ui.customWall },
    }));
    if (w === 'custom') toast('自定义壁纸已应用');
  };

  const setAccent = (c: string) =>
    setS(prev => ({ ...prev, ui: { ...prev.ui, accent: c } }));

  const setFont = (f: FontPref) =>
    setS(prev => ({ ...prev, ui: { ...prev.ui, font: f } }));

  const setLanguage = (l: string) =>
    setS(prev => ({ ...prev, ui: { ...prev.ui, language: l } }));

  const setNotify = (on: boolean) =>
    setS(prev => ({ ...prev, ui: { ...prev.ui, notify: on } }));

  const switchAccount = (a: string) =>
    setS(prev => ({ ...prev, user: { ...prev.user, account: a } }));

  const setUserAvatar = (a: UserAvatar) =>
    setS(prev => ({ ...prev, user: { ...prev.user, avatar: a } }));

  const cancelTask = (t: RunningTask) => {
    setS(prev => ({ ...prev, running: prev.running.filter(x => x !== t) }));
    toast('「' + t.n + '」已取消');
  };

  const retryTask = (t: RunningTask) => {
    setS(prev => ({
      ...prev,
      running: prev.running.map(x =>
        x === t
          ? {
              ...x,
              status: undefined,
              fail: undefined,
              p: 10,
              stages: x.stages.map((st, si) => [st[0], si === 0 ? 'active' : 'wait'] as Stage),
              result: '进行中：已重试，从头执行。',
            }
          : x
      ),
    }));
    toast('「' + t.n + '」已重试，从头执行');
  };

  const resumeTask = (t: RunningTask) => toast('「' + t.n + '」继续执行当前阶段');

  const redoDone = (t: DoneTask) => {
    setS(prev => ({
      ...prev,
      done: prev.done.filter(x => x !== t),
      running: [...prev.running, {
        n: t.n, bot: t.bot, p: 10, c: t.c,
        stages: [['计划', 'active'], ['收集 Worker', 'wait'], ['撰写', 'wait'], ['审校', 'wait'], ['交付', 'wait']] as Stage[],
        result: '进行中：已重新发起。',
        arts: [],
      }],
    }));
    toast('「' + t.n + '」已重新发起');
  };

  // ---- Store 装配：每次渲染重建（消费方随 Provider 渲染而更新，与原型全局状态语义一致）----
  const store: UiStore = {
    view: s.view,
    bot: s.bot,
    user: s.user,
    ui: s.ui,
    tone: s.tone,
    model: s.model,
    tasks: s.tasks,
    running: s.running,
    done: s.done,
    viz: s.viz,
    stock: s.stock,
    weather: s.weather,
    news: s.news,
    bots: s.bots,
    convs: s.convs,
    messages,
    panels: s.panels,
    persona: s.persona,
    customModels: s.customModels,
    mems,
    busy,
    tokens,
    isDark,
    fontDelta,
    setView,
    openConv,
    send,
    toggleTask,
    addTask,
    refreshViz,
    setViz,
    createPanel,
    confirmMem,
    rejectMem,
    deleteMem,
    renameBot,
    setBotAvatar,
    setModel,
    addCustomModel,
    setPersonaPrompt,
    requestTheme,
    setWallpaper,
    setAccent,
    setFont,
    setLanguage,
    setNotify,
    switchAccount,
    setUserAvatar,
    cancelTask,
    retryTask,
    resumeTask,
    redoDone,
    toast,
  };

  return (
    <UiCtx.Provider value={store}>
      <View style={{ flex: 1 }}>
        {/* 壁纸层：铺在最底层，内容页透明即可透出（全局系统 #2） */}
        <WallpaperLayer tokens={tokens} wallpaper={s.ui.wallpaper} customWall={s.ui.customWall} />
        {children}
        {/* 主题圆形扩散覆盖层 */}
        {reveal && (
          <View pointerEvents="none" style={{ ...ABS_FILL, zIndex: 98 }}>
            <RevealCircle anim={revealAnim} toDark={reveal.toDark} x={reveal.x} y={reveal.y} />
          </View>
        )}
        {/* Toast：强调色 pill（原型 .toast） */}
        {toastMsg !== null && (
          <Animated.View
            pointerEvents="none"
            style={{
              ...ABS_FILL,
              zIndex: 99,
              alignItems: 'center',
              justifyContent: 'flex-end',
              paddingBottom: 80,
              opacity: toastAnim,
              transform: [
                { translateY: toastAnim.interpolate({ inputRange: [0, 1], outputRange: [20, 0] }) },
              ],
            }}
          >
            <View
              style={{
                backgroundColor: tokens.card,
                borderRadius: 999,
                paddingHorizontal: 16,
                paddingVertical: 9,
                ...V7_SHADOWS.card,
              }}
            >
              <Text style={{ color: tokens.on, fontSize: 12 }}>{toastMsg}</Text>
            </View>
          </Animated.View>
        )}
      </View>
    </UiCtx.Provider>
  );
}

// ---- 壁纸层（全局系统 #2）：default 跟随主题底色；内置两张用半透明圆层近似
// 原型的 radial-gradient（不引依赖）；custom 渲染用户选的图。 ----
function WallpaperLayer({
  tokens,
  wallpaper,
  customWall,
}: {
  tokens: V7Tokens;
  wallpaper: WallpaperId;
  customWall: string | null;
}) {
  if (wallpaper === 'custom' && customWall) {
    return (
      <Image
        source={{ uri: customWall }}
        style={{ ...ABS_FILL }}
        resizeMode="cover"
      />
    );
  }
  const base = wallpaper === 'deep' ? '#060913' : '#e1e9f7';
  return (
    <View style={{ ...ABS_FILL, backgroundColor: tokens.bg }}>
      {(wallpaper === 'deep' || wallpaper === 'light') && (
        <View style={{ ...ABS_FILL, backgroundColor: base }}>
          {(wallpaper === 'deep'
            ? [
                { l: '-25%', t: '-18%', w: '80%', h: '52%', c: 'rgba(47,107,255,0.85)' },
                { l: '0%', t: '-5%', w: '60%', h: '38%', c: 'rgba(130,185,255,0.45)' },
                { l: '55%', t: '18%', w: '70%', h: '46%', c: 'rgba(55,182,255,0.5)' },
                { l: '-5%', t: '62%', w: '90%', h: '52%', c: 'rgba(56,70,178,0.55)' },
              ]
            : [
                { l: '-20%', t: '-16%', w: '75%', h: '48%', c: 'rgba(70,120,250,0.38)' },
                { l: '0%', t: '-10%', w: '55%', h: '34%', c: 'rgba(255,255,255,0.55)' },
                { l: '60%', t: '20%', w: '60%', h: '40%', c: 'rgba(90,175,255,0.3)' },
                { l: '55%', t: '62%', w: '90%', h: '52%', c: 'rgba(130,150,248,0.3)' },
              ]
          ).map((c, i) => (
            <View
              key={i}
              style={{
                position: 'absolute',
                left: c.l,
                top: c.t,
                width: c.w,
                height: c.h,
                borderRadius: 999,
                backgroundColor: c.c,
              }}
            />
          ))}
        </View>
      )}
    </View>
  );
}

// ---- 主题揭示圆（全局系统 #1 的动画本体）----
function RevealCircle({
  anim,
  toDark,
  x,
  y,
}: {
  anim: Animated.Value;
  toDark: boolean;
  x: number;
  y: number;
}) {
  const { width, height } = useWindowDimensions();
  const R = Math.sqrt(Math.max(x, width - x) ** 2 + Math.max(y, height - y) ** 2);
  // 圆恒为深色底：切深色时从 0 放大盖满；切浅色时从盖满收回到 0（露出底下浅色）
  const scale = anim.interpolate({
    inputRange: [0, 1],
    outputRange: toDark ? [0.001, 1] : [1, 0.001],
  });
  return (
    <Animated.View
      style={{
        position: 'absolute',
        left: x - R,
        top: y - R,
        width: R * 2,
        height: R * 2,
        borderRadius: R,
        backgroundColor: '#17171a',
        transform: [{ scale }],
      }}
    />
  );
}
