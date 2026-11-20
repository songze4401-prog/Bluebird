// 蓝鸟 UI · knob 开关（原型 .tg 的共享版）
// 从 app/SettingsScreen.tsx 抽出的通用开关：设置主面板（通知）与技能面板
// （components/SkillsSheet.tsx）复用；视觉与动效完全一致（260ms 弹簧位移 +
// 按下整条 scaleX 弹一下）。颜色走 tokens，尺寸不随主题。
import React, { useEffect, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet } from 'react-native';

import { useUi } from '../app/ui-state';

// 原型 --spring：knob 位移等共用的弹簧曲线
const SPRING = Easing.bezier(0.3, 1.1, 0.45, 1);
const STRETCH_OUT_EASE = Easing.bezier(0.3, 1.08, 0.5, 1);
const STRETCH_IN_MS = 137;
const STRETCH_OUT_MS = 223;

export function KnobToggle(props: {
  on: boolean;
  onToggle: () => void;
  label: string;
}) {
  const { tokens: t } = useUi();
  // 动画值用 useState 惰性初始化持有（渲染期读 ref.current 被 react-hooks/refs 禁止）
  const [knob] = useState(() => new Animated.Value(props.on ? 14 : 2));
  const [stretch] = useState(() => new Animated.Value(1));

  // on 翻转（本行按下或调用方改 state）→ knob 260ms 弹簧位移
  useEffect(() => {
    Animated.timing(knob, {
      toValue: props.on ? 14 : 2,
      duration: 260,
      easing: SPRING,
      useNativeDriver: false,
    }).start();
  }, [props.on, knob]);

  const press = () => {
    stretch.setValue(1);
    Animated.sequence([
      Animated.timing(stretch, {
        toValue: 1.18,
        duration: STRETCH_IN_MS,
        easing: SPRING,
        useNativeDriver: false,
      }),
      Animated.timing(stretch, {
        toValue: 1,
        duration: STRETCH_OUT_MS,
        easing: STRETCH_OUT_EASE,
        useNativeDriver: false,
      }),
    ]).start();
    props.onToggle();
  };

  return (
    <Pressable
      onPress={press}
      accessibilityRole="switch"
      accessibilityState={{ checked: props.on }}
      accessibilityLabel={props.label}
      style={knobStyles.hit}
      hitSlop={6}
    >
      <Animated.View
        style={[
          knobStyles.track,
          { backgroundColor: props.on ? t.up : t.soft },
          { transform: [{ scaleX: stretch }] },
        ]}
      >
        <Animated.View style={[knobStyles.knob, { left: knob }]} />
      </Animated.View>
    </Pressable>
  );
}

// 开关的尺寸样式（不随主题，颜色在组件里按 on 状态给）
const knobStyles = StyleSheet.create({
  hit: { width: 30, height: 18, flexShrink: 0 },
  track: { width: 30, height: 18, borderRadius: 9 },
  knob: {
    position: 'absolute',
    top: 2,
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#ffffff',
  },
});
