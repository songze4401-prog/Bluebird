// 蓝鸟 UI 移植 · 原型 SVG 图标（逐条对照 bluebird-home-v7.html 的 path 复制）
// 原型所有图标都是内联 SVG；RN 侧用 react-native-svg 原样渲染，避免 emoji/字符
// 在不同机型上缺字、变形（记忆钮 ◉ 在部分安卓不渲染的踩坑）。
// 尺寸/线宽与原型一致：导航与入口 16×16（stroke 1.8），四格 30×30（fill）。

import React from 'react';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

type NavKind = 'home' | 'chat' | 'settings';

// 底部导航三键（原型 .tb svg：stroke 1.8 round）
export function NavIcon({ kind, color = '#ffffff' }: { kind: NavKind; color?: string }) {
  return (
    <Svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {kind === 'home' && (
        <>
          <Path d="M3 11l9-8 9 8" />
          <Path d="M5 10v10h5v-6h4v6h5V10" />
        </>
      )}
      {kind === 'chat' && (
        <Path d="M21 12a8 8 0 0 1-8 8H4l2-3a8 8 0 1 1 15-5z" />
      )}
      {kind === 'settings' && (
        <>
          <Circle cx="12" cy="12" r="3" />
          <Path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </>
      )}
    </Svg>
  );
}

// 主页双入口卡图标（原型 .entrycard .ei svg：16×16 stroke 1.8）
export function EntryIcon({ kind, color = '#ffffff' }: { kind: 'chat' | 'grid'; color?: string }) {
  return (
    <Svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {kind === 'chat' ? (
        <Path d="M21 12a8 8 0 0 1-8 8H4l2-3a8 8 0 1 1 15-5z" />
      ) : (
        <>
          <Rect x="3.5" y="3.5" width="7.5" height="7.5" rx="2" />
          <Rect x="13" y="3.5" width="7.5" height="7.5" rx="2" />
          <Rect x="3.5" y="13" width="7.5" height="7.5" rx="2" />
          <Path d="M16.75 13v7.5M13 16.75h7.5" />
        </>
      )}
    </Svg>
  );
}

// 四格快捷图标（原型 .qc svg：30×30 fill currentColor）
export function QuadIcon({
  kind,
  color = '#ffffff',
}: {
  kind: 'connect' | 'project' | 'build' | 'memory';
  color?: string;
}) {
  return (
    <Svg width={30} height={30} viewBox="0 0 24 24" fill={color}>
      {kind === 'connect' && (
        <>
          <Path d="M10 7H7a5 5 0 0 0 0 10h3v-3H7a2 2 0 0 1 0-4h3zM14 7v3h3a2 2 0 0 1 0 4h-3v3h3a5 5 0 0 0 0-10z" />
          <Rect x="9" y="10.5" width="6" height="3" rx="1.5" />
        </>
      )}
      {kind === 'project' && (
        <>
          <Path d="M12 2.5 2 8l10 5.5L22 8 12 2.5z" />
          <Path
            d="M2 12.5 12 18l10-5.5-2.2-1.2L12 16.4 4.2 11.3 2 12.5z"
            opacity={0.6}
          />
          <Path
            d="M2 16.8 12 22.3l10-5.5-2.2-1.2-7.8 4.3-7.8-4.3L2 16.8z"
            opacity={0.35}
          />
        </>
      )}
      {kind === 'build' && (
        <>
          <Rect x="2.5" y="2.5" width="8.5" height="8.5" rx="2.6" />
          <Rect x="13" y="2.5" width="8.5" height="8.5" rx="2.6" opacity={0.5} />
          <Rect x="2.5" y="13" width="8.5" height="8.5" rx="2.6" opacity={0.5} />
          <Rect x="13" y="16.2" width="8.5" height="2.7" rx="1.35" />
          <Rect x="15.9" y="13.3" width="2.7" height="8.5" rx="1.35" />
        </>
      )}
      {kind === 'memory' && (
        <>
          <Circle cx="12" cy="12" r="9.5" opacity={0.28} />
          <Circle cx="12" cy="12" r="6" opacity={0.62} />
          <Circle cx="12" cy="12" r="2.6" />
        </>
      )}
    </Svg>
  );
}
