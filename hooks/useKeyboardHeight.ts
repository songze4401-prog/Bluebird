// 键盘高度感知：底部输入条/导航是绝对定位的悬浮层，必须自己避让键盘。
// iOS 用 willShow/willHide（动画更跟手），Android 用 didShow/didHide。
// 返回 0 表示键盘关闭。

import { useEffect, useState } from 'react';
import { Keyboard, Platform } from 'react-native';

export function useKeyboardHeight(): number {
  const [height, setHeight] = useState(0);

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const show = Keyboard.addListener(showEvent, event =>
      setHeight(event.endCoordinates.height)
    );
    const hide = Keyboard.addListener(hideEvent, () => setHeight(0));

    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  return height;
}
