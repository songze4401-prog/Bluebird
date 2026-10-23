import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';

import type { Theme } from '../theme';
import { WEEKDAYS } from '../lib/constants';

// 顶部共享时钟：对齐到分钟边界后每分钟刷新。
// 样式随组件走（只含本组件用到的键），调用方只需传 theme。
export function SharedTime({ theme }: { theme: Theme }) {
  const [now, setNow] = useState(() => new Date());

  const styles = useMemo(() => createStyles(theme), [theme]);

  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined;

    // 对齐到下一分钟边界，之后每分钟刷新
    const timeout = setTimeout(
      () => {
        setNow(new Date());
        interval = setInterval(() => setNow(new Date()), 60000);
      },
      (60 - new Date().getSeconds()) * 1000
    );

    return () => {
      clearTimeout(timeout);
      if (interval) clearInterval(interval);
    };
  }, []);

  const timeText = `${String(now.getHours()).padStart(2, '0')}:${String(
    now.getMinutes()
  ).padStart(2, '0')}`;
  const dateText = `${now.getMonth() + 1}月${now.getDate()}日 周${
    WEEKDAYS[now.getDay()]
  }`;

  return (
    <View style={styles.sharedTime}>
      <Text style={[styles.sharedTimeClock, { color: theme.accent }]}>
        {timeText}
      </Text>
      <Text style={styles.sharedTimeDate}>{dateText}</Text>
    </View>
  );
}

// 样式由主题派生：只包含本组件用到的键
const createStyles = (theme: Theme) =>
  StyleSheet.create({
    sharedTime: {
      alignItems: 'flex-end',
      marginRight: 12,
      // 内容减少后随 header 的 alignItems:'center' 自动垂直居中，
      // 不写死偏移，位置完全交给 flex 自适应
    },

    sharedTimeClock: {
      color: theme.accent,
      fontSize: 15,
      fontWeight: '600',
      fontVariant: ['tabular-nums'],
    },

    sharedTimeDate: {
      color: theme.textMuted,
      fontSize: 10,
      marginTop: 2,
    },
  });
