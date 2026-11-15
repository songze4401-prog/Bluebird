// 蓝鸟 UI 移植 · 公共弹层基建 #1：弹簧抽屉手势钩子
// 原型 bluebird-home-v7.html 的 makeDraggable / drawerAnchors 移植：
//   - 两个锚点：full=0（全开）/ half=抽屉高-52%视口高（half 档露出上半屏）
//   - 上缘/下缘橡皮筋：拖出锚点范围后按 25% 阻尼跟随手指
//   - 松手判定：vy>0.85(px/ms，与原型同单位) 直接关闭；否则吸附到更近锚点
// pan 走 JS 驱动（useNativeDriver: false）：拖拽逐帧 setValue + panRef 镜像，
// 且 grant 时 stopAnimation 回调要同步拿到真实当前值——native 驱动两者都做不到。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, PanResponder } from 'react-native';
import type { GestureResponderHandlers } from 'react-native';

// half 锚点（原型 drawerAnchors）：抽屉高 - 52% 视口高
function halfAnchor(viewportHeight: number, sheetHeight: number): number {
  return sheetHeight - Math.round(viewportHeight * 0.52);
}

export function useDrawerGesture(opts: {
  visible: boolean;
  onClose: () => void;
  viewportHeight: number; // 视口高度（useWindowDimensions().height）
  sheetHeight: number; // 抽屉高度（88% 屏高）
}): {
  pan: Animated.Value; // translateY：0=全开
  grabHandlers: GestureResponderHandlers; // 挂在 grab 把手上
  open: () => void; // visible 变 true 时调用：setValue(sheetHeight) 后弹到 half 锚点
  close: () => void; // 弹到 sheetHeight 后调 onClose
} {
  const { visible, onClose, viewportHeight, sheetHeight } = opts;
  const half = halfAnchor(viewportHeight, sheetHeight);

  // translateY：0=全开，sheetHeight=完全滑出屏幕
  // 用 useState 惰性初始化持有（渲染期读 ref.current 被 react-hooks/refs 禁止）
  const [pan] = useState(() => new Animated.Value(0));
  // pan 的 JS 镜像：手势与吸附计算只读它，不读 Animated 私有属性
  const panRef = useRef(0);
  // 拖拽基准（grant 时的 pan 当前值），move 里 o = base + dy
  const baseRef = useRef(0);
  // close() 动画完成时若父级已先行关闭，不再重复上抛 onClose
  const visibleRef = useRef(visible);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  // setValue 后同步镜像（镜像纪律：每次 setValue 紧跟一次 panRef 同步）
  const setPan = useCallback(
    (v: number) => {
      pan.setValue(v);
      panRef.current = v;
    },
    [pan]
  );

  // 打开：先把面板落到底部之外，再弹到 half 锚点
  // （原型 drawerSpring：.34s 弹簧贝塞尔，这里用 timing+bezier 等价移植）
  const open = useCallback(() => {
    pan.stopAnimation();
    setPan(sheetHeight);
    Animated.timing(pan, {
      toValue: half,
      duration: 340,
      easing: Easing.bezier(0.3, 1.1, 0.45, 1),
      useNativeDriver: false,
    }).start(() => {
      panRef.current = half;
    });
  }, [pan, setPan, sheetHeight, half]);

  // 关闭：弹簧滑出屏幕，动画完成后才调 onClose（父级据此把 visible 置 false）
  const close = useCallback(() => {
    pan.stopAnimation();
    Animated.spring(pan, { toValue: sheetHeight, useNativeDriver: false }).start(() => {
      panRef.current = sheetHeight;
      // 与父级关闭竞态：已不可见就不再上抛
      if (visibleRef.current) onCloseRef.current();
    });
  }, [pan, sheetHeight]);

  // grab 把手手势（原型 makeDraggable）
  const grabHandlers = useMemo(
    () =>
      // eslint-disable-next-line react-hooks/refs -- 手势回调仅在事件阶段读写 ref，渲染期不读
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          // 上一次弹簧若被打断，panRef 停在目标值；以 stopAnimation 回调的
          // 真实当前值为拖拽基准（不读 Animated 私有属性）
          pan.stopAnimation(v => {
            setPan(v);
            baseRef.current = v;
          });
        },
        onPanResponderMove: (_e, g) => {
          let o = baseRef.current + g.dy;
          if (o < 0) {
            // 上缘橡皮筋：越过全开锚点后按 25% 阻尼跟随
            o *= 0.25;
          }
          const maxO = half + 60;
          if (o > maxO) {
            // 下缘橡皮筋：half+60 之外按 25% 阻尼跟随
            o = maxO + (o - maxO) * 0.25;
          }
          setPan(o);
        },
        onPanResponderRelease: (_e, g) => {
          // 快速下滑（px/ms，与原型 samples 判速同单位）直接关闭
          if (g.vy > 0.85) {
            close();
            return;
          }
          // 否则吸附到更近锚点（full=0 / half）
          const o = panRef.current;
          const target = Math.abs(o) <= Math.abs(o - half) ? 0 : half;
          Animated.spring(pan, { toValue: target, useNativeDriver: false }).start(() => {
            panRef.current = target;
          });
        },
        onPanResponderTerminate: () => {
          // 手势被父级抢占：按松手逻辑吸附回锚点（原型 pointercancel）
          const o = panRef.current;
          const target = Math.abs(o) <= Math.abs(o - half) ? 0 : half;
          Animated.spring(pan, { toValue: target, useNativeDriver: false }).start(() => {
            panRef.current = target;
          });
        },
      }).panHandlers,
    [pan, setPan, close, half]
  );

  // 整包返回值保持稳定引用（SheetScaffold 的开合 effect 依赖它）
  return useMemo(() => ({ pan, grabHandlers, open, close }), [pan, grabHandlers, open, close]);
}
