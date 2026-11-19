// 蓝鸟 UI 移植 · 主页两行问候语（原型 .greet）
// 第一行「问候词，称呼」32 w800；第二行「今天有 N 个定时任务」缩进 = 问候词的测量宽度
// （原型靠文字排版自然对齐；RN 用隐藏 Text + onLayout 量出问候词宽，再给第二行 paddingLeft。
//   隐藏文本用 absolute + opacity 0——不能用 display:none，拿不到 layout。）

import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useUi } from '../app/ui-state';
import type { V7Tokens } from '../app/ui-theme';
import { greetingWord } from '../data/ui-contract';

export function Greeting() {
  const { user, tasks, tokens: t } = useUi();
  const styles = createStyles(t);
  const g = greetingWord();

  // 第二行缩进 = 问候词（不含「，称呼」）的测量宽度，首帧为 0、onLayout 后立刻校正
  const [greetW, setGreetW] = useState(0);
  // 开启中的定时任务数（原型 greet 只数 on 的）
  const enabledCount = tasks.filter(task => task.on).length;

  return (
    <View style={styles.wrap}>
      <Text style={styles.g1}>
        {g}，{user.name}
      </Text>
      <Text style={[styles.g2, { paddingLeft: greetW }]}>
        今天有 <Text style={styles.g2b}>{enabledCount}</Text> 个定时任务
      </Text>
      {/* 隐藏测量文本：与第一行问候词同款式，只负责量宽度 */}
      <Text style={styles.measure} onLayout={e => setGreetW(e.nativeEvent.layout.width)}>
        {g}
      </Text>
    </View>
  );
}

// 原型 .greet/.g1/.g2/.g2 b 的 RN 移植
const createStyles = (t: V7Tokens) =>
  StyleSheet.create({
    // 原型 .greet：列 gap4，块底 padding 12
    wrap: {
      gap: 4,
      paddingBottom: 12,
      alignItems: 'flex-start',
    },
    // 原型 .g1：32 w800 ink，letterSpacing -0.2
    g1: {
      fontSize: 32,
      fontWeight: '800',
      color: t.ink,
      letterSpacing: -0.2,
    },
    // 原型 .g2：17 w500 ink（paddingLeft 由问候词测量宽度动态给出）
    g2: {
      fontSize: 17,
      fontWeight: '500',
      color: t.ink,
    },
    // 原型 .g2 b：N 用 w700
    g2b: {
      fontWeight: '700',
      color: t.ink,
    },
    // 隐藏测量文本：absolute + opacity 0（display:none 拿不到 layout），款式与 .g1 一致
    measure: {
      position: 'absolute',
      left: 0,
      top: 0,
      opacity: 0,
      fontSize: 32,
      fontWeight: '800',
      letterSpacing: -0.2,
    },
  });
