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
    // 2026-10-30 浅色基准：暖白画布 + 白色卡片，与左侧抽屉同一材质。
    // 聊天页不再用纯白铺底，卡片和气泡才有可见的体积。
    background: '#f5f3ee',
    surface: '#ffffff',
    surfaceAlt: '#eeebe4',
    border: '#e5e0d6',
    borderStrong: '#d6d0c4',
    textPrimary: '#1c1b18',
    textBody: '#2b2a26',
    textSecondary: '#6b665e',
    textMuted: '#979188',
    textOnAccent: '#ffffff',
    bubbleIncoming: '#ffffff',
    bubbleIncomingBorder: '#e5e0d6',
    avatarBg: '#eeebe4',
    online: '#2f8a52',
    warning: '#8a5d18',
    danger: '#b23a2f',
    dangerBorder: 'rgba(178,58,47,0.42)',
    scrim: 'rgba(28,26,22,0.32)',
    chatBg: '#f5f3ee',
    pill: '#eeebe4',
    pillText: '#5f5b53',
    hairline: 'rgba(40,36,30,0.08)',
    chatText: '#1c1b18',
    chatMuted: '#948f86',
  },
};

// ---- 强调色：同一种颜色在两种模式下需要不同明度才能保证对比度 ----
export type AccentSet = {
  accent: string; // 强调文字 / 图标
  accentBorder: string; // 强调描边
  bubble: string; // 深强调底（强调型卡片备用）
  sendButton: string; // 发送按钮底（与强调色同步加深）
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
      accent: '#c2ad82',
      accentBorder: 'rgba(194,173,130,0.50)',
      bubble: '#28364b',
      sendButton: '#c2ad82',
    },
    light: {
      accent: '#2f3540',
      accentBorder: 'rgba(47,53,64,0.32)',
      bubble: '#2f3540',
      sendButton: '#2f3540',
    },
  },
  {
    id: 'blue',
    label: '蓝色',
    dark: {
      accent: '#6382ea',
      accentBorder: 'rgba(99,130,234,0.50)',
      bubble: '#172137',
      sendButton: '#6382ea',
    },
    light: {
      // 2026-10-30：全站强调色加深，浅色蓝从 #5884c5 收深到 #3566a8，
      // 发送按钮与选中态共用同一强调色，避免浅色按钮在白卡上发灰。
      accent: '#3566a8',
      accentBorder: 'rgba(53,102,168,0.32)',
      bubble: '#2a5a96',
      sendButton: '#3566a8',
    },
  },
  {
    id: 'purple',
    label: '紫色',
    dark: {
      accent: '#a58bda',
      accentBorder: 'rgba(165,139,218,0.50)',
      bubble: '#3a3058',
      sendButton: '#a58bda',
    },
    light: {
      accent: '#5a3f96',
      accentBorder: 'rgba(90,63,150,0.32)',
      bubble: '#5a3f96',
      sendButton: '#5a3f96',
    },
  },
  {
    id: 'green',
    label: '绿色',
    dark: {
      accent: '#6fbd8c',
      accentBorder: 'rgba(111,189,140,0.50)',
      bubble: '#244536',
      sendButton: '#6fbd8c',
    },
    light: {
      accent: '#276a46',
      accentBorder: 'rgba(39,106,70,0.32)',
      bubble: '#276a46',
      sendButton: '#276a46',
    },
  },
  {
    id: 'pink',
    label: '粉色',
    dark: {
      accent: '#de8fa9',
      accentBorder: 'rgba(222,143,169,0.50)',
      bubble: '#4f2a3b',
      sendButton: '#de8fa9',
    },
    light: {
      accent: '#9d3b60',
      accentBorder: 'rgba(157,59,96,0.32)',
      bubble: '#9d3b60',
      sendButton: '#9d3b60',
    },
  },
  {
    id: 'orange',
    label: '橙色',
    dark: {
      accent: '#dda05f',
      accentBorder: 'rgba(221,160,95,0.50)',
      bubble: '#503822',
      sendButton: '#dda05f',
    },
    light: {
      accent: '#9f5f25',
      accentBorder: 'rgba(159,95,37,0.32)',
      bubble: '#9f5f25',
      sendButton: '#9f5f25',
    },
  },
  {
    id: 'white',
    label: '白色/灰色',
    dark: {
      accent: '#cfd2d8',
      accentBorder: 'rgba(207,210,216,0.45)',
      bubble: '#34373d',
      sendButton: '#cfd2d8',
    },
    light: {
      accent: '#3d434b',
      accentBorder: 'rgba(61,67,75,0.32)',
      bubble: '#3d434b',
      sendButton: '#3d434b',
    },
  },
];

export type Theme = ModePalette &
  AccentSet & {
    mode: ThemeMode;
    accentId: ThemeId;
    accentLabel: string;
  };

// 2026-10-30：默认浅色 + 蓝色强调，与左侧抽屉的暖白卡片材质一致。
// 强调色整体加深；已保存过主题偏好的用户不受影响（useThemePreference 的本地值优先）。
export const DEFAULT_THEME_ID: ThemeId = 'blue';
export const DEFAULT_THEME_MODE: ThemeMode = 'light';

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
