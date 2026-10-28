import React, { useMemo } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import type { Theme } from '../theme';
import type { ToolStepView } from '../lib/types';
import { toolLabel } from '../lib/constants';
import { CHAT_LAYOUT, CHAT_TYPE } from '../lib/design';

// 「调用工具」pill：Agent 本轮真实跑过的工具，一条一个 pill。
// 数据有两个来源，都是后端事实，不是占位装饰：
//   - 流式期：/chat/stream 的 tool_start / tool_end 事件（running=true 表示还在跑）
//   - 落盘后：done 响应与 GET /history 的 toolSteps 字段
// 文案沿用设计图的「调用工具 · <工具名>」；工具名中文映射见 lib/constants 的 TOOL_LABEL。
export function ToolCallPill({
  theme,
  step,
}: {
  theme: Theme;
  step: ToolStepView;
}) {
  const styles = useMemo(() => createStyles(theme), [theme]);

  return (
    <View style={styles.pill}>
      <Text style={styles.glyph}>✎</Text>

      <Text style={styles.text} numberOfLines={1}>
        {step.running ? '调用工具中' : '调用工具'} · {toolLabel(step.name)}
      </Text>

      {step.running ? (
        <ActivityIndicator size="small" color={theme.pillText} />
      ) : (
        <Text
          style={[styles.glyph, step.ok ? styles.stateOk : styles.stateFail]}
          accessibilityLabel={step.ok ? '调用成功' : '调用失败'}
        >
          {step.ok ? '✓' : '✕'}
        </Text>
      )}
    </View>
  );
}

// 一行工具 pill（本轮没有工具调用时不占任何高度）
export function ToolCallPillRow({
  theme,
  steps,
}: {
  theme: Theme;
  steps: ToolStepView[];
}) {
  const styles = useMemo(() => createStyles(theme), [theme]);

  if (steps.length === 0) return null;

  return (
    <View style={styles.row}>
      {steps.map((step, index) => (
        // 同名工具可能被重复调用，用「名字 + 序号」做 key 保证稳定
        <ToolCallPill key={`${step.name}-${index}`} theme={theme} step={step} />
      ))}
    </View>
  );
}

// 样式由主题派生：只包含本组件用到的键
const createStyles = (theme: Theme) =>
  StyleSheet.create({
    row: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 8,
      marginTop: CHAT_LAYOUT.nameToText,
    },
    pill: {
      height: CHAT_LAYOUT.toolPillHeight,
      paddingHorizontal: 14,
      borderRadius: CHAT_LAYOUT.toolPillHeight / 2,
      backgroundColor: theme.pill,
      flexDirection: 'row',
      alignItems: 'center',
      // 实测：pill 无描边、无阴影，纯灰底；宽度随内容，最长不超过正文列
      maxWidth: '100%',
    },
    glyph: {
      color: theme.pillText,
      fontSize: CHAT_TYPE.pill,
      marginRight: 8,
    },
    text: {
      color: theme.pillText,
      fontSize: CHAT_TYPE.pill,
      flexShrink: 1,
    },
    // 设计图里的 ✓ 与文字同灰（不是强调色），失败才用语义红提醒
    stateOk: {
      color: theme.pillText,
      fontSize: CHAT_TYPE.pill,
      fontWeight: '700',
      marginLeft: 10,
    },
    stateFail: {
      color: theme.danger,
      fontSize: CHAT_TYPE.pill,
      fontWeight: '700',
      marginLeft: 10,
    },
  });
