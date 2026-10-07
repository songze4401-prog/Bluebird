// 主题色定义：只负责"强调色"，黑色 UI 背景与文字层级保持不动。
// 这是纯数据模块，不引入任何依赖、不参与任何业务逻辑。

export type ThemeId =
  | 'black'
  | 'blue'
  | 'purple'
  | 'green'
  | 'pink'
  | 'orange'
  | 'white';

export type Theme = {
  id: ThemeId;
  label: string;
  emoji: string;
  /** 强调文字色：顶部时钟、头像字母、记忆库返回/重试/徽章文字 */
  accent: string;
  /** 强调边框：头像描边、记忆库徽章描边 */
  accentBorder: string;
  /** 用户消息气泡底色 / 次要强调底 */
  bubble: string;
  /** 发送按钮底色（同时用作主题色圆点） */
  sendButton: string;
};

// 顺序即菜单展示顺序，第一项为默认。
export const THEMES: Theme[] = [
  {
    // 默认主题：保持 Bluebird 现有观感，不改变任何既有配色
    id: 'black',
    label: '黑色',
    emoji: '🖤',
    accent: '#d9c7a1',
    accentBorder: 'rgba(217,199,161,0.45)',
    bubble: '#2f3d55',
    sendButton: '#303846',
  },
  {
    id: 'blue',
    label: '蓝色',
    emoji: '🩵',
    accent: '#8ab6e8',
    accentBorder: 'rgba(138,182,232,0.45)',
    bubble: '#2b4a6f',
    sendButton: '#2f5b86',
  },
  {
    id: 'purple',
    label: '紫色',
    emoji: '💜',
    accent: '#b9a3e3',
    accentBorder: 'rgba(185,163,227,0.45)',
    bubble: '#443a63',
    sendButton: '#5a4a7d',
  },
  {
    id: 'green',
    label: '绿色',
    emoji: '💚',
    accent: '#8ad4a6',
    accentBorder: 'rgba(138,212,166,0.45)',
    bubble: '#2c5040',
    sendButton: '#33614a',
  },
  {
    id: 'pink',
    label: '粉色',
    emoji: '🩷',
    accent: '#f0a8c0',
    accentBorder: 'rgba(240,168,192,0.45)',
    bubble: '#5c3346',
    sendButton: '#7a4259',
  },
  {
    id: 'orange',
    label: '橙色',
    emoji: '🧡',
    accent: '#f0b478',
    accentBorder: 'rgba(240,180,120,0.45)',
    bubble: '#5c4230',
    sendButton: '#7a5638',
  },
  {
    id: 'white',
    label: '白色/灰色',
    emoji: '🤍',
    accent: '#e6e7ea',
    accentBorder: 'rgba(230,231,234,0.4)',
    bubble: '#3f4249',
    sendButton: '#4a4d55',
  },
];

export const DEFAULT_THEME_ID: ThemeId = 'black';

/** 本地持久化的存储键 */
export const THEME_STORAGE_KEY = 'bluebird.theme';

/** 未知/非法 id 一律回退到默认主题，保证 UI 永远可用 */
export function getTheme(id?: string | null): Theme {
  const found = THEMES.find(item => item.id === id);
  return found || THEMES[0];
}

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && THEMES.some(item => item.id === value);
}
