// 蓝鸟 UI 移植 · 全局系统 #1 主题（纯函数层）
// 原型 v7 的色板：浅色/深色两档只翻页面底色与文字，卡片色（card）始终取强调色本色，
// 前景 on/onDim 由强调色亮度决定（亮色强调如橙/绿自动换深字，阈值 0.25）。
// 所有界面颜色都从这里取 token，组件里不再硬编码浅/深色值。

import { ACCENT_LIST } from '../data/mock';

export type V7Tokens = {
  isDark: boolean;
  bg: string;
  surface: string;
  ink: string;
  sec: string;
  mut: string;
  soft: string;
  up: string;
  down: string;
  info: string;
  warn: string;
  vio: string;
  card: string;
  on: string;
  onDim: string;
};

// 相对亮度（原型 accentLum：阈值 0.25 只影响橙/绿，蓝红紫黑仍用白字）
export function accentLum(hex: string): number {
  const c = hex.replace('#', '');
  const full = c.length === 3 ? c.split('').map(x => x + x).join('') : c;
  const chan = [0, 2, 4].map(i => {
    const n = parseInt(full.slice(i, i + 2), 16) / 255;
    return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * chan[0] + 0.7152 * chan[1] + 0.0722 * chan[2];
}

export function getTokens(isDark: boolean, accent: string): V7Tokens {
  const light = {
    bg: '#ffffff',
    surface: '#ffffff',
    ink: '#000000',
    sec: '#5f5f5e',
    mut: '#9a9a98',
    soft: '#f4f4f2',
  };
  const dark = {
    bg: '#17171a',
    surface: '#202024',
    ink: '#f2f2ef',
    sec: '#b8b8b3',
    mut: '#8b8b87',
    soft: '#2b2b30',
  };
  const mode = isDark ? dark : light;
  const onDarkAccent = accentLum(accent) < 0.25;
  const on = onDarkAccent ? '#ffffff' : '#141414';
  const onDim = onDarkAccent ? 'rgba(255,255,255,0.6)' : 'rgba(20,20,20,0.62)';
  return {
    isDark,
    ...mode,
    up: '#18a058',
    down: '#e5484d',
    info: '#2f6bff',
    warn: '#f5a623',
    vio: '#8b5cf6',
    card: accent,
    on,
    onDim,
  };
}

// RN 阴影（原型 --sh-lg / --sh-md / --sh-card 的近似移植；
// Android 只有 elevation，iOS 走 shadow* 五件套）
export const V7_SHADOWS = {
  lg: {
    shadowColor: '#000000',
    shadowOpacity: 0.09,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 14 },
    elevation: 6,
  },
  md: {
    shadowColor: '#000000',
    shadowOpacity: 0.08,
    shadowRadius: 13,
    shadowOffset: { width: 0, height: 8 },
    elevation: 4,
  },
  card: {
    shadowColor: '#000000',
    shadowOpacity: 0.2,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 12 },
    elevation: 7,
  },
} as const;
