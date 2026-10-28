// App 根容器的样式（阶段 2 从 App.tsx 抽出）。
// 只放「根布局 + 聊天背景层」这几条，组件自身样式仍留在各自文件里。

import { StyleSheet } from 'react-native';

import type { Theme } from './theme';

// 铺满父级的绝对定位层。
// 不用 StyleSheet.absoluteFillObject：当前 RN 的 TS 类型里没有该属性。
const FILL_ABSOLUTE = {
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
} as const;

// 样式由主题派生：所有颜色都来自 theme，组件内不再硬编码浅色/深色色值
export const createAppStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flex: 1,
      // 聊天页底色：设计图是平色底（浅色纯白），不再用全站列表底色 #f4f5f7，
      // 否则消息流会铺在灰底上、与卡片式页面混淆。深色模式下两者同值，
      // 背景光晕层仍按原逻辑生效。
      backgroundColor: theme.chatBg,
    },
    // KeyboardAvoidingView 专用：刻意不设背景，
    // 否则它会在背景光晕层之上再铺一层不透明底，把光晕全部盖掉。
    keyboardArea: {
      flex: 1,
    },
    // ---- 聊天背景（深色模式）：深黑蓝基底 + 柔和渐变 + 两处低亮度环境光晕 ----
    // 静态层，无动画、无粒子。光晕用超大尺寸 + 多段透明度衰减的 radial-gradient 实现
    // 自然模糊的过渡，刻意避免出现"明显的圆形光斑"。
    chatBase: {
      ...FILL_ABSOLUTE,
      // 不用纯黑：保留深灰蓝，并让纵向明暗层次拉开一点
      experimental_backgroundImage:
        'linear-gradient(180deg, #0e1119 0%, #0a0c11 45%, #070810 100%)',
    },
    chatGlowCool: {
      ...FILL_ABSOLUTE,
      // 左上冷蓝环境光
      experimental_backgroundImage:
        'radial-gradient(ellipse 95% 60% at 18% 0%, rgba(62,94,156,0.30) 0%, rgba(62,94,156,0.12) 45%, rgba(62,94,156,0) 75%)',
    },
    chatGlowWarm: {
      ...FILL_ABSOLUTE,
      // 右下紫调余晖，比冷光更弱一些，避免抢主体
      experimental_backgroundImage:
        'radial-gradient(ellipse 85% 55% at 88% 100%, rgba(80,68,128,0.22) 0%, rgba(80,68,128,0.10) 48%, rgba(80,68,128,0) 78%)',
    },
  });
