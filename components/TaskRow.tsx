// 蓝鸟 UI 移植 · 进行中/已完成共用任务行（原型 .runcard/.run/.pbar）
// R5 起改为视图模型驱动：调用方（主页 mock / 真实 /agent-tasks）各自归一化成
// TaskRowModel——行组件不再关心数据来自哪里。
//   fillPct/fillColor/fillOpacity 决定进度条；rightLabel/rightTone 决定右值。
// fill 宽度用 Animated 过渡（500ms）：useState 存上一次目标值，变化时启动 timing。

import React, { useEffect, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';

import { useUi } from '../app/ui-state';
import { V7_SHADOWS, type V7Tokens } from '../app/ui-theme';

// 原型 .pbar i transition: width .5s ease
const FILL_MS = 500;

export type TaskRowModel = {
  // 任务名（真实任务 = goal）
  n: string;
  // 右值文案与色（真实任务 = STATUS_LABEL[status]）
  rightLabel: string;
  rightTone: 'mut' | 'fail' | 'ok';
  // 进度条：0-100；无真实进度数据的运行态给状态色满条+透明度（状态条，非假进度）
  fillPct: number;
  fillColor: string;
  fillOpacity?: number;
};

export function TaskRow(props: { model: TaskRowModel; onPress: () => void }) {
  const { model, onPress } = props;
  const { tokens: t } = useUi();
  const styles = createStyles(t);

  const rightColor =
    model.rightTone === 'fail' ? t.down : model.rightTone === 'ok' ? t.up : t.mut;

  // fill 宽度过渡：useState 存上一次目标值，变化时启动 500ms timing
  // （setPrevP 放在动画完成回调里——effect 体内同步 setState 会被 react-hooks 禁掉）
  const [prevP, setPrevP] = useState(model.fillPct);
  const [fill] = useState(() => new Animated.Value(prevP));
  useEffect(() => {
    if (prevP === model.fillPct) return;
    // 先停掉在途动画：从当前位置出发去新的目标值，避免两段 timing 并行写帧
    fill.stopAnimation();
    Animated.timing(fill, {
      toValue: model.fillPct,
      duration: FILL_MS,
      useNativeDriver: false,
    }).start(() => setPrevP(model.fillPct));
  }, [model.fillPct, prevP, fill]);
  const fillWidth = fill.interpolate({ inputRange: [0, 100], outputRange: ['0%', '100%'] });

  return (
    <Pressable
      style={[styles.card, V7_SHADOWS.md]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={model.n}
    >
      {/* 行：名 + 右值（原型 .run .rl） */}
      <View style={styles.row}>
        <Text numberOfLines={1} style={styles.name}>
          {model.n}
        </Text>
        <Text style={[styles.right, { color: rightColor }]}>{model.rightLabel}</Text>
      </View>
      {/* 进度条：soft 底 h5 r3，fill 宽度动画（原型 .pbar） */}
      <View style={styles.pbar}>
        <Animated.View
          style={{
            height: 5,
            borderRadius: 3,
            width: fillWidth,
            backgroundColor: model.fillColor,
            opacity: model.fillOpacity ?? 1,
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
      minWidth: 0,
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
