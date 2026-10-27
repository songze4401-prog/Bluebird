import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { Theme } from '../theme';
import { CHAT_LAYOUT, CHAT_TYPE } from '../lib/design';

// 「任务」标签页的内容。
//
// 刻意做成一个说明面板而不是画一列假任务：后端目前没有任何任务/待办接口
// （server/index.js 里没有 /tasks 之类路由），用静态占位卡片会把「功能已存在」
// 演成真的，违反「不允许用静态图片伪装真实界面」。
// 这里明确写清现状，并为后续任务详情留出容器结构（列表头 + 说明体）。
export function TasksPanel({ theme }: { theme: Theme }) {
  const styles = useMemo(() => createStyles(theme), [theme]);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>任务</Text>

      <Text style={styles.body}>
        还没有任务能力：后端未提供任务的创建、执行与记录接口。
      </Text>

      <Text style={styles.hint}>
        接入后，这里会列出正在跑与已完成的 Agent 任务，并可以点开看每一步。
      </Text>
    </View>
  );
}

// 样式由主题派生：只包含本组件用到的键
const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flex: 1,
      paddingHorizontal: CHAT_LAYOUT.gutter,
      paddingTop: CHAT_LAYOUT.threadTopPad + CHAT_LAYOUT.turnGap,
    },
    title: {
      color: theme.chatText,
      fontSize: CHAT_TYPE.title,
      fontWeight: '700',
    },
    body: {
      color: theme.chatText,
      fontSize: CHAT_TYPE.body,
      lineHeight: CHAT_TYPE.bodyLine,
      marginTop: CHAT_LAYOUT.nameToText,
    },
    hint: {
      color: theme.chatMuted,
      fontSize: CHAT_TYPE.meta,
      lineHeight: 18,
      marginTop: CHAT_LAYOUT.tsToText,
    },
  });
