// 蓝鸟 UI 移植 · 假数据包（清单小件 #5）
// 原型 bluebird-home-v7.html 里 state 对象及常量的原样移植。
// 规矩：不接任何真实后端——这里的所有数据都是 mock，接口位置留给后续轮次
// （组件只依赖本文件的类型与初值，接后端时替换数据源即可）。

// ---- 视图 ----
export type ViewId = 'home' | 'chat';

// ---- 主题偏好（系统外观三态）----
export type ThemePref = 'system' | 'light' | 'dark';

// ---- 字号三态：只影响主要文字，不重排布局 ----
export type FontPref = '小' | '标准' | '大';

// ---- 壁纸：default=跟随系统，deep/light=内置两张，custom=用户上传 ----
export type WallpaperId = 'default' | 'deep' | 'light' | 'custom';

// ---- 可视化面板类型 ----
export type VizKind = 'stock' | 'weather' | 'news';

// ---- 任务阶段：done ✓ / active ● / wait ○ / fail ✕ ----
export type StageMark = 'done' | 'active' | 'wait' | 'fail';
export type Stage = [string, StageMark];

export type RunningTask = {
  n: string;
  bot: string;
  p: number;
  c: string;
  status?: 'failed';
  stages: Stage[];
  result: string;
  arts: string[];
  fail?: string;
};

export type DoneTask = {
  n: string;
  bot: string;
  c: string;
  result: string;
  arts: string[];
  stages: Stage[];
};

export type TaskTimer = { t: string; l: string; on: boolean };

export type AttachmentChip = { kind: 'img' | 'file'; name: string };

export type ChatMessage = {
  role: 'user' | 'blue';
  text: string;
  time: string;
  tool?: string;
  attach?: AttachmentChip;
};

export type Bot = {
  n: string;
  role: string;
  icon: string;
  bg: string;
  created: boolean;
  avatarImg?: string;
};

export type Conv = { bot: string; t: string; s: string; m: string };

export type Persona = {
  colloquial: number;
  warmth: number;
  initiative: number;
  length: number;
  messageMode: string;
  customPrompt: string;
};

export type Mem = { x: string; i: string; p: boolean };

export type UserAvatar = { type: 'char' | 'emoji' | 'image'; value: string };

export type UiPanel = { n: string; t: VizKind };

export type UiState = {
  view: ViewId;
  bot: string;
  user: {
    name: string;
    char: string;
    avatar: UserAvatar;
    account: string;
    accounts: string[];
  };
  ui: {
    theme: ThemePref;
    accent: string;
    language: string;
    font: FontPref;
    notify: boolean;
    wallpaper: WallpaperId;
    customWall: string | null;
  };
  tone: string;
  model: string;
  tasks: TaskTimer[];
  running: RunningTask[];
  done: DoneTask[];
  viz: VizKind;
  stock: { price: number; chg: number; pts: number[] };
  weather: { temp: number; cond: string; hi: number; lo: number };
  news: { s: string; t: string }[];
  bots: Bot[];
  convs: Conv[];
  messages: ChatMessage[];
  panels: UiPanel[];
  persona: Persona;
  customModels: string[];
};

// ---- 常量（与原型一致）----
export const APP_VERSION = '0.4.1';

export const ACCENT_LIST = [
  { n: '黑白', c: '#000000' },
  { n: '蓝', c: '#2f6bff' },
  { n: '绿', c: '#18a058' },
  { n: '红', c: '#e5484d' },
  { n: '橙', c: '#f5a623' },
  { n: '紫', c: '#8b5cf6' },
] as const;

export const MODELS = ['DeepSeek', 'DeepSeek-R1', 'Qwen-Max', 'GLM-4'];

export const AVATAR_PRESETS = [
  { t: 'char', v: '宋' },
  { t: 'emoji', v: '🐦' },
  { t: 'emoji', v: '🧠' },
  { t: 'emoji', v: '🔎' },
  { t: 'emoji', v: '📈' },
  { t: 'emoji', v: '🎨' },
  { t: 'emoji', v: '🤖' },
  { t: 'char', v: 'A' },
] as const;

// 记忆面板假数据（字段名对齐 lib/memory-center.ts 的候选/已记住语义）
export const INITIAL_MEMS: Mem[] = [
  { x: '对花生过敏，点餐时会避开', i: '🥜', p: true },
  { x: '希望晨间提醒在 7 点半', i: '⏰', p: true },
  { x: '喝咖啡只喝美式，不加糖', i: '☕', p: false },
  { x: '所在城市是杭州', i: '📍', p: false },
  { x: '摘要偏好：先结论后依据', i: '📝', p: false },
  { x: '每周三晚上打羽毛球', i: '🏸', p: false },
  { x: '正在搭一个叫 Bluebird 的个人助手', i: '🎯', p: false },
];

// ---- 工具 ----
export function nowStr(): string {
  const d = new Date();
  return (
    ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2)
  );
}

/** 股票走势假数据（原型 genPts：随机游走 24 点） */
export function genPts(): number[] {
  const p: number[] = [];
  let v = 100;
  for (let i = 0; i < 24; i++) {
    v += Math.random() * 8 - 4;
    p.push(v);
  }
  return p;
}

/** 按时段返回问候语（原型 greet） */
export function greetingWord(): string {
  const h = new Date().getHours();
  return h < 6 ? '夜深了' : h < 11 ? '早上好' : h < 13 ? '中午好' : h < 18 ? '下午好' : '晚上好';
}

// ---- 初始状态（工厂函数：每次调用拿到全新深拷贝，测试与重挂载不串数据）----
export function createInitialState(): UiState {
  return {
    view: 'chat',
    bot: 'Bluebird',
    user: {
      name: '宋泽',
      char: '宋',
      avatar: { type: 'char', value: '宋' },
      account: '88888888',
      accounts: ['88888888', '10000001', 'bluebird_demo'],
    },
    ui: {
      theme: 'light',
      accent: '#000000',
      language: '简体中文',
      font: '标准',
      notify: true,
      wallpaper: 'light',
      customWall: null,
    },
    tone: '自然',
    model: 'DeepSeek',
    tasks: [
      { t: '08:00', l: '早报摘要', on: true },
      { t: '12:30', l: '股票提醒', on: true },
      { t: '22:00', l: '每日记忆整理', on: false },
    ],
    // 进行中/已完成：真实系统当前没有任何任务，mock 不再伪造（假任务在真机预览里
    // 会被当成真数据）。列表为空时 HomeScreen 整段隐藏；接 /agent-tasks 后由真数据驱动。
    running: [],
    done: [],
    viz: 'stock',
    // 原型启动即 genPts()（state.stock.pts=[] 会导致走势柱空白一片）
    stock: { price: 128.4, chg: 1.24, pts: genPts() },
    weather: { temp: 24, cond: '多云', hi: 27, lo: 19 },
    news: [
      { s: '科技', t: '本地 AI 助手迎来记忆系统升级' },
      { s: '市场', t: '半导体板块午后拉升' },
      { s: '生活', t: '城市咖啡地图更新' },
    ],
    bots: [
      { n: 'Bluebird', role: '', icon: '🐦', bg: '#000000', created: false },
      { n: 'Memory', role: '记忆读写', icon: '🧠', bg: '#2f6bff', created: true },
      { n: 'Research', role: '检索 / 摘要', icon: '🔎', bg: '#18a058', created: true },
    ],
    convs: [
      { bot: 'Bluebird', t: '会议纪要整理', s: '已记住「偏好简洁摘要」', m: '09:42' },
    ],
    messages: [],
    panels: [],
    persona: {
      colloquial: 70,
      warmth: 70,
      initiative: 50,
      length: 50,
      messageMode: 'auto',
      customPrompt: '',
    },
    customModels: [],
  };
}
