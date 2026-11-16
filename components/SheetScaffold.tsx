// 蓝鸟 UI 移植 · 公共弹层基建 #2：九个弹层的公共壳
// 原型 .scrim + .sheet + .grab + .sh-head 的移植：
//   - Scrim：全屏黑 30%，250ms 淡入淡出，点按调 onClose
//   - Sheet：底部全宽圆角面板；普通弹层 maxHeight 86% 视口高、300ms 滑入滑出；
//     draggable（弹簧抽屉）height 88% 视口高，位移交给 useDrawerGesture
//   - 内容：grab 把手 → sh-head（返回箭头 / 标题 / ✕）→ children（sh-body 各弹层自理）
// 关闭动画播完才卸载（内部 mounted state）；退出期间遮罩不再吃点击。

import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Pressable,
  ScrollView,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';

import { useUi } from '../app/ui-state';
import { V7_SHADOWS } from '../app/ui-theme';

import { useDrawerGesture } from './useDrawerGesture';

// 全屏绝对定位（与 app/ui-state.tsx 同款写法：本仓库 RN 版型没有 absoluteFillObject）
const ABS_FILL = {
  position: 'absolute',
  left: 0,
  right: 0,
  top: 0,
  bottom: 0,
} as const;

// 滑入/滑出（原型 .sheet transition：transform .3s cubic-bezier(.32,.72,.28,1)）
const SHEET_SLIDE_MS = 300;
const SHEET_SLIDE_EASING = Easing.bezier(0.32, 0.72, 0.28, 1);
// 遮罩淡入淡出（原型 .scrim transition：opacity .25s）
const SCRIM_FADE_MS = 250;

export function SheetScaffold(props: {
  visible: boolean;
  onClose: () => void;
  title: string;
  onBack?: () => void; // 二级面板返回箭头（‹，30 圆形无边框）
  draggable?: boolean; // true=拖拽抽屉：height 88%、内建 useDrawerGesture
  children: React.ReactNode;
}): React.JSX.Element | null {
  const { visible, onClose, title, onBack, draggable = false, children } = props;
  const { tokens } = useUi();
  const { height } = useWindowDimensions();

  // 尺寸（原型 .sheet max-height:86% / .sheet.drag height:88%）
  const maxSheetHeight = Math.round(height * 0.86);
  const sheetHeight = Math.round(height * 0.88);
  // 普通弹层自身高度未知，滑出距离用视口高度兜底（原型 translateY(102%)）
  const slideDistance = height;

  // 拖拽抽屉手势（pan：0=全开 → sheetHeight=完全滑出）
  const gesture = useDrawerGesture({
    visible,
    onClose,
    viewportHeight: height,
    sheetHeight,
  });

  // 普通弹层的滑入滑出位移（draggable 时不用它）
  // 动画值用 useState 惰性初始化持有（渲染期读 ref.current 被 react-hooks/refs 禁止）
  const [slide] = useState(() => new Animated.Value(0));
  const [scrim] = useState(() => new Animated.Value(0));

  // 关闭动画播完再卸载：visible=false 先播退出动画，完成后才 return null
  const [mounted, setMounted] = useState(visible);
  const mountedRef = useRef(visible);
  useEffect(() => {
    mountedRef.current = mounted;
  }, [mounted]);

  // visibleRef 供 finish 竞态守卫读取（声明与同步都放在使用它的 effect 之前）
  const visibleRef = useRef(visible);
  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);

  // 开合 effect：只响应 visible 翻转；旋转等尺寸变化不重播动画
  // （prevVisibleRef 对比出「这次真的翻转了」）
  const prevVisibleRef = useRef(visible);
  useEffect(() => {
    const wasVisible = prevVisibleRef.current;
    prevVisibleRef.current = visible;
    if (visible) {
      if (!wasVisible) {
        setMounted(true);
        if (draggable) {
          gesture.open();
        } else {
          slide.stopAnimation();
          slide.setValue(slideDistance);
          Animated.timing(slide, {
            toValue: 0,
            duration: SHEET_SLIDE_MS,
            easing: SHEET_SLIDE_EASING,
            useNativeDriver: true,
          }).start();
        }
      }
      Animated.timing(scrim, { toValue: 1, duration: SCRIM_FADE_MS, useNativeDriver: true }).start();
      return;
    }
    if (!wasVisible || !mountedRef.current) return;
    // 关闭：面板滑出 + 遮罩淡出，滑出动画完成后卸载
    Animated.timing(scrim, { toValue: 0, duration: SCRIM_FADE_MS, useNativeDriver: true }).start();
    const finish = () => {
      // 关闭动画中途被重新打开：不卸载
      if (!visibleRef.current) setMounted(false);
    };
    if (draggable) {
      gesture.pan.stopAnimation();
      Animated.spring(gesture.pan, { toValue: sheetHeight, useNativeDriver: false }).start(finish);
    } else {
      Animated.timing(slide, {
        toValue: slideDistance,
        duration: SHEET_SLIDE_MS,
        easing: SHEET_SLIDE_EASING,
        useNativeDriver: true,
      }).start(finish);
    }
  }, [visible, draggable, gesture, slide, scrim, slideDistance, sheetHeight]);

  if (!mounted) return null;

  const translateY = draggable ? gesture.pan : slide;

  return (
    <View style={ABS_FILL} pointerEvents={visible ? 'box-none' : 'none'}>
      {/* Scrim：黑 30%，点按关闭（原型 .scrim） */}
      <Animated.View
        pointerEvents={visible ? 'auto' : 'none'}
        style={{
          ...ABS_FILL,
          zIndex: 9,
          backgroundColor: 'rgba(0,0,0,0.3)',
          opacity: scrim,
        }}
      >
        <Pressable
          style={ABS_FILL}
          accessibilityRole="button"
          accessibilityLabel="关闭弹层"
          onPress={onClose}
        />
      </Animated.View>

      {/* Sheet：底部全宽圆角面板（原型 .sheet / .sheet.drag） */}
      <Animated.View
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 10,
          backgroundColor: tokens.surface,
          borderTopLeftRadius: 26,
          borderTopRightRadius: 26,
          // 原型 .sheet 是内容高度 + max-height 86%：内容超高时由 sh-body 滚动。
          // RN 里 ScrollView 用 flexShrink:1（而非 flex:1/flexBasis 0）才能在
          // 未定高的 sheet 里正确取内容高度并被 maxHeight 截断，避免真机上
          // 顶部内容被挤出可视区（设置页用户卡被裁的根因）。
          overflow: 'hidden',
          maxHeight: draggable ? undefined : maxSheetHeight,
          height: draggable ? sheetHeight : undefined,
          // 原型 box-shadow: 0 -14px 44px（负 y 向上投影）：复用 card 阴影、翻转偏移
          ...V7_SHADOWS.card,
          shadowOffset: { width: 0, height: -V7_SHADOWS.card.shadowOffset.height },
          transform: [{ translateY }],
        }}
      >
        {/* grab 把手：拖拽抽屉时接管手势（原型 .grab，固定浅灰不随主题） */}
        <View
          style={{
            width: 36,
            height: 4,
            borderRadius: 2,
            backgroundColor: '#e6e6e3',
            marginTop: 10,
            marginBottom: 4,
            alignSelf: 'center',
            flexShrink: 0,
          }}
          {...(draggable ? gesture.grabHandlers : null)}
        />

        {/* sh-head：返回箭头 + 标题 + ✕（原型 .sh-head） */}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            paddingLeft: 20,
            paddingRight: 20,
            paddingTop: 10,
            paddingBottom: 14,
            flexShrink: 0,
          }}
        >
          {onBack ? (
            <TouchableOpacity
              style={{
                width: 30,
                height: 30,
                borderRadius: 15,
                marginRight: 2,
                alignItems: 'center',
                justifyContent: 'center',
              }}
              onPress={onBack}
              accessibilityRole="button"
              accessibilityLabel="返回"
            >
              <Text style={{ fontSize: 24, color: tokens.ink }}>‹</Text>
            </TouchableOpacity>
          ) : null}
          <Text
            numberOfLines={1}
            style={{ flex: 1, fontSize: 16, fontWeight: '700', color: tokens.ink }}
          >
            {title}
          </Text>
          <TouchableOpacity
            style={{
              width: 34,
              height: 34,
              borderRadius: 17,
              backgroundColor: tokens.surface,
              alignItems: 'center',
              justifyContent: 'center',
              ...V7_SHADOWS.md,
            }}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="关闭"
          >
            <Text style={{ fontSize: 16, color: tokens.ink }}>✕</Text>
          </TouchableOpacity>
        </View>

        {/* sh-body：滚动由壳统一提供（原型 .sh-body overflow-y:auto），内边距由各弹层自己排。
            用 flexShrink 而不是 flex:1：sheet 未定高（只有 maxHeight），flexBasis 0 会让
            ScrollView 在真机上量不到内容高度，内容可能从顶部被裁。 */}
        <ScrollView
          style={{ flexShrink: 1 }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {children}
        </ScrollView>
      </Animated.View>
    </View>
  );
}
