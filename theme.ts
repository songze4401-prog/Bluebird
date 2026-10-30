// 全局主题：由两个正交维度合成
//   1) 模式（浅色 / 深色）—— 决定背景、表面、文字、边框等语义色
//   2) 强调色（7 套）      —— 决定强调文字、描边、用户气泡、发送按钮
// 所有颜色都集中在这里，组件里不再硬编码任何浅色/深色色值。

export type ThemeMode = 'light' | 'dark';

export type ThemeId =
  | 'black'
  | 'blue'
  | 'purple'
  | 'green'
  | 'pink'
  | 'orange'
  | 'white';

// ---- 模式调色板：与强调色无关的语义色 ----
export type ModePalette = {
  background: string; // 页面底色
  surface: string; // 卡片 / 菜单 / 输入框底
  surfaceAlt: string; // 输入区等次级面
  border: string; // 常规分隔线
  borderStrong: string; // 卡片 / 菜单描边
  textPrimary: string; // 标题
  textBody: string; // 正文
  textSecondary: string; // 次级说明
  textMuted: string; // 弱化文字 / placeholder
  textOnAccent: string; // 铺在强调色上的文字
  bubbleIncoming: string; // Bluebird 气泡底
  bubbleIncomingBorder: string;
  avatarBg: string; // 头像底 / 徽章底
  online: string; // 在线状态（语义绿，不随主题变）
  warning: string; // 等待/需确认（语义琥珀，不随主题变）
  danger: string; // 危险操作（语义红，不随主题变）
  dangerBorder: string;
  scrim: string; // 遮罩
  // ---- 聊天页专用（UI 还原基准：设计图 ui6 白底版）----
  // 与上面的 background / surface 分开是刻意的：聊天页改版不连带改记忆库、
  // 模型、控制面板等页面在用的那套卡片配色，避免一次视觉改动波及五个页面。
  chatBg: string; // 聊天页底色
  pill: string; // 工具 pill / 模型 pill / 输入胶囊底
  pillText: string; // pill 内文字（比正文弱，比时间戳强）
  hairline: string; // 标签栏顶部分隔线
  chatText: string; // 聊天正文
  chatMuted: string; // 时间戳 / placeholder
};

export const MODE_PALETTES: Record<ThemeMode, ModePalette> = {
  dark: {
    // Quiet Instrument 深色基准：近黑画布、低对比表面、单一蓝色强调。
    background: '#08090b',
    surface: '#12151a',
    surfaceAlt: '#0d0f13',
    border: '#1a1d23',
    borderStrong: '#262a32',
    textPrimary: '#f2f3f5',
    textBody: '#d5d8de',
    textSecondary: '#a3a8b2',
    textMuted: '#6c727d',
    textOnAccent: '#08090b',
    bubbleIncoming: '#12151a',
    bubbleIncomingBorder: '#1a1d23',
    avatarBg: '#171b21',
    online: '#6fcf97',
    warning: '#d6b77a',
    danger: '#e07a7a',
    dangerBorder: 'rgba(224,122,122,0.5)',
    scrim: 'rgba(0,0,0,0.62)',
    chatBg: '#08090b',
    pill: '#12151a',
    pillText: '#a3a8b2',
    hairline: 'rgba(255,255,255,0.065)',
    chatText: '#f2f3f5',
    chatMuted: '#6c727d',
  },
  light: {
    background: '#f4f5f7',
    surface: '#ffffff',
    surfaceAlt: '#eceef2',
    border: '#e0e4ea',
    borderStrong: '#ccd3dc',
    textPrimary: '#14181e',
    textBody: '#232a33',
    textSecondary: '#5d6673',
    textMuted: '#8b94a1',
    textOnAccent: '#ffffff',
    bubbleIncoming: '#ffffff',
    bubbleIncomingBorder: '#e3e7ed',
    avatarBg: '#eef1f5',
    online: '#2f9e5a',
    warning: '#9a6b1f',
    danger: '#c0392b',
    dangerBorder: 'rgba(192,57,43,0.45)',
    scrim: 'rgba(0,0,0,0.3)',
    // 以下六项全部取自设计图实测像素值（1080px 截图 ÷ 2.66 缩放）
    chatBg: '#ffffff',
    pill: '#f2f3f5',
    pillText: '#61656b',
    hairline: '#eeeeee',
    chatText: '#17181a',
    chatMuted: '#9b9ea3',
  },
};

// ---- 强调色：同一种颜色在两种模式下需要不同明度才能保证对比度 ----
export type AccentSet = {
  accent: string; // 强调文字 / 图标
  accentBorder: string; // 强调描边
  bubble: string; // 用户消息气泡底 / 次级强调底
  sendButton: string; // 发送按钮底
};

export type AccentTheme = {
  id: ThemeId;
  label: string;
  dark: AccentSet;
  light: AccentSet;
};

export const THEMES: AccentTheme[] = [
  {
    id: 'black',
    label: '黑色',
    dark: {
      accent: '#d9c7a1',
      accentBorder: 'rgba(217,199,161,0.45)',
      bubble: '#2f3d55',
      sendButton: '#303846',
    },
    light: {
      accent: '#3a4250',
      accentBorder: 'rgba(58,66,80,0.28)',
      bubble: '#3a4250',
      sendButton: '#3a4250',
    },
  },
  {
    id: 'blue',
    label: '蓝色',
    dark: {
      accent: '#7e9bff',
      accentBorder: 'rgba(126,155,255,0.42)',
      bubble: '#1c2740',
      sendButton: '#7e9bff',
    },
    light: {
      // 按设计图实测：Bluebird 名字 #5884C5、发送按钮与选中标签 #8AB2E3。
      // 只重调蓝色一档，其余六套强调色保持原值（设计图仅给了蓝色浅色一套）。
      accent: '#5884c5',
      accentBorder: 'rgba(88,132,197,0.28)',
      bubble: '#2f6bb0',
      sendButton: '#8ab2e3',
    },
  },
  {
    id: 'purple',
    label: '紫色',
    dark: {
      accent: '#b9a3e3',
      accentBorder: 'rgba(185,163,227,0.45)',
      bubble: '#443a63',
      sendButton: '#5a4a7d',
    },
    light: {
      accent: '#6b4fa8',
      accentBorder: 'rgba(107,79,168,0.28)',
      bubble: '#6b4fa8',
      sendButton: '#7a5cbb',
    },
  },
  {
    id: 'green',
    label: '绿色',
    dark: {
      accent: '#8ad4a6',
      accentBorder: 'rgba(138,212,166,0.45)',
      bubble: '#2c5040',
      sendButton: '#33614a',
    },
    light: {
      accent: '#2e7d51',
      accentBorder: 'rgba(46,125,81,0.28)',
      bubble: '#2e7d51',
      sendButton: '#35915e',
    },
  },
  {
    id: 'pink',
    label: '粉色',
    dark: {
      accent: '#f0a8c0',
      accentBorder: 'rgba(240,168,192,0.45)',
      bubble: '#5c3346',
      sendButton: '#7a4259',
    },
    light: {
      accent: '#b5456f',
      accentBorder: 'rgba(181,69,111,0.28)',
      bubble: '#b5456f',
      sendButton: '#c6527c',
    },
  },
  {
    id: 'orange',
    label: '橙色',
    dark: {
      accent: '#f0b478',
      accentBorder: 'rgba(240,180,120,0.45)',
      bubble: '#5c4230',
      sendButton: '#7a5638',
    },
    light: {
      accent: '#b5702e',
      accentBorder: 'rgba(181,112,46,0.28)',
      bubble: '#b5702e',
      sendButton: '#c67d35',
    },
  },
  {
    id: 'white',
    label: '白色/灰色',
    dark: {
      accent: '#e6e7ea',
      accentBorder: 'rgba(230,231,234,0.4)',
      bubble: '#3f4249',
      sendButton: '#4a4d55',
    },
    light: {
      accent: '#4a5058',
      accentBorder: 'rgba(74,80,88,0.28)',
      bubble: '#4a5058',
      sendButton: '#565d66',
    },
  },
];

export type Theme = ModePalette &
  AccentSet & {
    mode: ThemeMode;
    accentId: ThemeId;
    accentLabel: string;
  };

// 默认强调色改为蓝色：设计图（ui6 白底版）是蓝色一档的浅色渲染，
// 首启视觉需要直接对上设计图。已保存过主题偏好的用户不受影响
// （useThemePreference 读到的本地值优先）。
export const DEFAULT_THEME_ID: ThemeId = 'blue';
export const DEFAULT_THEME_MODE: ThemeMode = 'dark';

/** 强调色的本地持久化键（沿用历史键名，不破坏已保存的偏好） */
export const THEME_STORAGE_KEY = 'bluebird.theme';
/** 浅色/深色的本地持久化键 */
export const THEME_MODE_STORAGE_KEY = 'bluebird.themeMode';

export const MODE_OPTIONS: { id: ThemeMode; label: string }[] = [
  { id: 'light', label: '浅色模式' },
  { id: 'dark', label: '深色模式' },
];

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && THEMES.some(item => item.id === value);
}

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'light' || value === 'dark';
}

export function getAccentTheme(id?: string | null): AccentTheme {
  return THEMES.find(item => item.id === id) || THEMES[0];
}

export function getAccentSet(id: ThemeId | string, mode: ThemeMode): AccentSet {
  return getAccentTheme(id)[mode];
}

/** 由「模式 + 强调色」合成最终主题；任何非法输入都回退到默认值 */
export function getTheme(mode?: string | null, accentId?: string | null): Theme {
  const safeMode: ThemeMode = isThemeMode(mode) ? mode : DEFAULT_THEME_MODE;
  const accent = getAccentTheme(isThemeId(accentId) ? accentId : DEFAULT_THEME_ID);

  return {
    ...MODE_PALETTES[safeMode],
    ...accent[safeMode],
    mode: safeMode,
    accentId: accent.id,
    accentLabel: accent.label,
  };
}
