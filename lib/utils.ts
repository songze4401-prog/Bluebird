// 跨模块共享的纯函数工具。
// 刻意不依赖 React / React Native，便于在任何组件或测试中直接引用。

import { Message } from './types';
import { WEEKDAYS, MOOD_EMOJI, MESSAGE_TIME_GAP_MS } from './constants';

// 本地临时消息的 id（服务端返回稳定 id 后会被替换）
export function makeLocalId(): string {
  return Date.now().toString();
}

export async function readJsonResponse(response: Response) {
  const contentType = response.headers.get('content-type') || '';

  if (!contentType.toLowerCase().includes('application/json')) {
    throw new Error('服务器连接失败');
  }

  return response.json();
}

export function moodEmoji(mood?: string) {
  return MOOD_EMOJI[mood ?? 'calm'] ?? MOOD_EMOJI.calm;
}

// 把主题里的不透明 hex 转成带 alpha 的 rgba：气泡的"半透明材质"需要透明度，
// 但 theme.ts 给出的是不透明色值。此处在本地转换，不引入依赖、不改 theme.ts。
// 遇到非 6 位 hex（例如已是 rgba()）时原样返回，避免拼出非法色值。
export function withAlpha(color: string, alpha: number): string {
  const hex6 = /^#?([0-9a-f]{6})$/i.exec(String(color).trim());

  if (!hex6) return color;

  const value = parseInt(hex6[1], 16);

  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

export function formatMessageTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';

  const now = new Date();
  const hm = `${String(date.getHours()).padStart(2, '0')}:${String(
    date.getMinutes()
  ).padStart(2, '0')}`;

  const startOfDay = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = Math.round(
    (startOfDay(now) - startOfDay(date)) / 86400000
  );

  if (dayDiff <= 0) return hm; // 今天：只显示时间
  if (dayDiff === 1) return `昨天 ${hm}`;
  if (dayDiff < 7) return `周${WEEKDAYS[date.getDay()]} ${hm}`;
  if (date.getFullYear() === now.getFullYear()) {
    return `${date.getMonth() + 1}月${date.getDate()}日 ${hm}`;
  }
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${hm}`;
}

export function shouldShowMessageTime(
  current: Message,
  previous?: Message
): boolean {
  if (!current.createdAt) return false;
  if (!previous) return true;
  if (!previous.createdAt) return true;

  const curr = new Date(current.createdAt).getTime();
  const prev = new Date(previous.createdAt).getTime();
  if (Number.isNaN(curr) || Number.isNaN(prev)) return false;

  if (curr - prev >= MESSAGE_TIME_GAP_MS) return true;

  // 间隔短但跨天：新的一天第一条仍显示
  const a = new Date(curr);
  const b = new Date(prev);
  return (
    a.getFullYear() !== b.getFullYear() ||
    a.getMonth() !== b.getMonth() ||
    a.getDate() !== b.getDate()
  );
}
