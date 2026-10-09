import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';

import type { Theme } from '../theme';

// Bluebird 头像：聊天消息、「正在输入」提示、输入栏共用同一个头像。
// 样式随组件走（只含本组件用到的键），调用方只需传 theme 与可选 size。
export function BlueAvatar({
  size = 38,
  theme,
}: {
  size?: number;
  theme: Theme;
}) {
  const styles = useMemo(() => createStyles(theme), [theme]);

  return (
    <View
      style={[
        styles.avatar,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          borderColor: theme.accentBorder,
        },
      ]}
    >
      <Text
        style={[
          styles.avatarText,
          { fontSize: size * 0.45, color: theme.accent },
        ]}
      >
        B
      </Text>
    </View>
  );
}

// 样式由主题派生：只包含本组件用到的键
const createStyles = (theme: Theme) =>
  StyleSheet.create({
    avatar: {
      backgroundColor: theme.avatarBg,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: 8,
      borderWidth: 1,
      borderColor: theme.accentBorder,
    },
    avatarText: {
      color: theme.accent,
      fontWeight: '700',
    },
  });
