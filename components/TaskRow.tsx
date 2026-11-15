// 蓝鸟 UI 移植 · 进行中/已完成共用任务行（原型 .runcard/.run/.pbar）
// kind 决定右值与进度条语义：
//   run 非失败 → 右值「{p}%」，fill 跟 p（任务色）；run 失败 → 右值「失败」，fill 100% down 35%；
//   done → 右值「完成」，fill 100% up。
// fill 宽度用 Animated 过渡（500ms）：useState 存上一次目标值，变化时启动 timing。

import React, { useEffect, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';

import { useUi } from '../app/ui-state';
import { V7_SHADOWS, type V7Tokens } from '../app/ui-theme';
import type { DoneTask, RunningTask } from '../data/mock';

// 原型 .pbar i transition: width .5s ease
const FILL_MS = 500;

export function TaskRow(props: {
  task: RunningTask | DoneTask;
  kind: 'run' | 'done';
  onPress: () => void;
}) {
  const { task, kind, onPress } = props;
  const { tokens: t } = useUi();
  const styles = createStyles(t);

  // run→RunningTask / done→DoneTask 一一对应；两个独立 props 无法自动收窄，用 in 判别
  const failed = 'status' in task && task.status === 'failed';
  // fill 目标宽度：done 100%；run 失败 100%；run 正常 = p
  const progress = 'p' in task ? (failed ? 100 : task.p) : 100;
  // fill 颜色：done 用 up；run 用任务色（失败换 down + 35% 透明）
  const fillColor = kind === 'done' ? t.up : failed ? t.down : task.c;
  const fillOpacity = failed ? 0.35 : 1;
  // 右值：done「完成」mut / run 失败「失败」down / run 正常「{p}%」mut
  const rightLabel = kind === 'done' ? '完成' : failed ? '失败' : progress + '%';
  const rightColor = failed ? t.down : t.mut;

  // fill 宽度过渡：useState 存上一次目标值，progress 变化时启动 500ms timing
  // （setPrevP 放在动画完成回调里——effect 体内同步 setState 会被 react-hooks 禁掉）
  const [prevP, setPrevP] = useState(progress);
  const [fill] = useState(() => new Animated.Value(prevP));
  useEffect(() => {
    if (prevP === progress) return;
    // 先停掉在途动画：从当前位置出发去新的目标值，避免两段 timing 并行写帧
    fill.stopAnimation();
    Animated.timing(fill, { toValue: progress, duration: FILL_MS, useNativeDriver: false }).start(
      () => setPrevP(progress)
    );
  }, [progress, prevP, fill]);
  const fillWidth = fill.interpolate({ inputRange: [0, 100], outputRange: ['0%', '100%'] });

  return (
    <Pressable
      style={[styles.card, V7_SHADOWS.md]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={task.n}
    >
      {/* 行：名 + 右值（原型 .run .rl） */}
      <View style={styles.row}>
        <Text numberOfLines={1} style={styles.name}>
          {task.n}
        </Text>
        <Text style={[styles.right, { color: rightColor }]}>{rightLabel}</Text>
      </View>
      {/* 进度条：soft 底 h5 r3，fill 宽度动画（原型 .pbar） */}
      <View style={styles.pbar}>
        <Animated.View
          style={{
            height: 5,
            borderRadius: 3,
            width: fillWidth,
            backgroundColor: fillColor,
            opacity: fillOpacity,
          }}
        />
      </View>
    </Pressable>
  );
}

// 原型 .runcard/.run/.pbar 的 RN 移植
const createStyles = (t: V7Tokens) =>
  StyleSheet.create({
    // 原型 .runcard：surface 底 r18 阴影 md p12/14，列 gap4（一行=名+右值，一行=进度条）
    card: {
      backgroundColor: t.surface,
      borderRadius: 18,
      paddingVertical: 12,
      paddingHorizontal: 14,
      gap: 4,
    },
    // 原型 .run .rl：行居中 gap8
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    // 名：12 w600 ink，一行省略
    name: {
      flex: 1,
      fontSize: 12,
      fontWeight: '600',
      color: t.ink,
    },
    // 原型 .run .pct：10 w700（颜色由调用处给：mut / 失败 down）
    right: {
      fontSize: 10,
      fontWeight: '700',
    },
    // 原型 .pbar：h5 r3 soft 底，裁切 fill
    pbar: {
      height: 5,
      borderRadius: 3,
      backgroundColor: t.soft,
      overflow: 'hidden',
    },
  });
