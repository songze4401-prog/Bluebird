import React, { useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// 固定欢迎主页：只提供三个入口（继续聊天 / 新建聊天 / 历史聊天）。
// 视觉按需求固定为「深空蓝黑 + 蓝色微光」的简洁科幻风格，
// 刻意不随主题变化（主页是固定的品牌落地页，聊天页才跟随主题）。
export function HomeScreen({
  onContinue,
  onNewChat,
  onHistory,
}: {
  onContinue: () => void;
  onNewChat: () => void;
  onHistory: () => void;
}) {
  const styles = useMemo(() => createStyles(), []);
  const insets = useSafeAreaInsets();

  return (
    <View style={styles.container}>
      {/* 深空背景层：基底渐变 + 两处低亮度蓝色光晕，均为静态层、不拦截触摸 */}
      <View pointerEvents="none" style={styles.base} />
      <View pointerEvents="none" style={styles.glowCool} />
      <View pointerEvents="none" style={styles.glowWarm} />

      {/* ScrollView + flexGrow 保证：高屏留白充足、主体居中略偏上，
          小屏可滚动，不会被挤出屏幕；上下再叠加系统安全区 inset。 */}
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.content,
          {
            paddingTop: insets.top + 16,
            paddingBottom: insets.bottom + 28,
          },
        ]}
        showsVerticalScrollIndicator={false}
        bounces={false}
      >
        <View style={styles.spacerTop} />

        <View style={styles.brand}>
          <View style={styles.logoCard}>
            <Text style={styles.logoMark}>B</Text>
          </View>

          <Text style={styles.title}>你好，我是 Blue。</Text>

          <Text style={styles.lede}>
            也许我们来自完全不同的世界，{'\n'}但现在，我们共享同一个频道。
          </Text>

          <Text style={styles.welcome}>欢迎回来。</Text>
        </View>

        <View style={styles.actions}>
          <TouchableOpacity
            style={styles.primaryButton}
            onPress={onContinue}
            activeOpacity={0.82}
          >
            <Text style={styles.primaryLabel}>继续聊天</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.outlineButton}
            onPress={onNewChat}
            activeOpacity={0.82}
          >
            <Text style={styles.outlineLabel}>新建聊天</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.outlineButton}
            onPress={onHistory}
            activeOpacity={0.82}
          >
            <Text style={styles.outlineLabel}>历史聊天</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.footer}>BLUEBIRD · YOUR OWN CHANNEL</Text>

        <View style={styles.spacerBottom} />
      </ScrollView>
    </View>
  );
}

// 样式固定（不依赖主题）：主页是品牌落地页，颜色即需求指定的深空蓝黑方案
const createStyles = () =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: '#070810',
    },
    // ---- 背景层 ----
    base: {
      position: 'absolute',
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      experimental_backgroundImage:
        'linear-gradient(180deg, #0e1119 0%, #0a0c11 45%, #070810 100%)',
    },
    glowCool: {
      position: 'absolute',
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      experimental_backgroundImage:
        'radial-gradient(ellipse 95% 60% at 18% 0%, rgba(62,94,156,0.30) 0%, rgba(62,94,156,0.12) 45%, rgba(62,94,156,0) 75%)',
    },
    glowWarm: {
      position: 'absolute',
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      experimental_backgroundImage:
        'radial-gradient(ellipse 90% 55% at 100% 100%, rgba(58,121,194,0.22) 0%, rgba(58,121,194,0.08) 45%, rgba(58,121,194,0) 75%)',
    },
    // ---- 内容 ----
    scroll: {
      flex: 1,
    },
    content: {
      flexGrow: 1,
      alignItems: 'center',
      paddingHorizontal: 28,
    },
    // 上小下大的弹性留白：主体整体居中略偏上，入口区落在中下部
    spacerTop: {
      flex: 1,
    },
    // 底部强制至少留出 72，避免入口贴近屏幕底边
    spacerBottom: {
      flex: 1.5,
      minHeight: 72,
    },
    brand: {
      alignItems: 'center',
    },
    logoCard: {
      width: 96,
      height: 96,
      borderRadius: 24,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: '#0b0f18',
      borderWidth: 1,
      borderColor: 'rgba(138,182,232,0.28)',
      shadowColor: '#3a79c2',
      shadowOpacity: 0.35,
      shadowRadius: 18,
      shadowOffset: { width: 0, height: 4 },
      elevation: 6,
    },
    logoMark: {
      fontSize: 46,
      fontWeight: '700',
      color: '#8ab6e8',
    },
    title: {
      marginTop: 34,
      fontSize: 30,
      fontWeight: '700',
      color: '#f0f3f8',
      letterSpacing: 1,
    },
    lede: {
      marginTop: 18,
      fontSize: 16,
      lineHeight: 26,
      textAlign: 'center',
      color: '#9aa6bb',
    },
    welcome: {
      marginTop: 14,
      fontSize: 17,
      color: '#8ab6e8',
      letterSpacing: 1,
    },
    actions: {
      width: '100%',
      marginTop: 44,
      gap: 14,
    },
    primaryButton: {
      height: 54,
      borderRadius: 27,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: '#2f6bb0',
      shadowColor: '#3a79c2',
      shadowOpacity: 0.4,
      shadowRadius: 14,
      shadowOffset: { width: 0, height: 4 },
      elevation: 4,
    },
    primaryLabel: {
      fontSize: 17,
      fontWeight: '600',
      color: '#ffffff',
      letterSpacing: 1,
    },
    outlineButton: {
      height: 54,
      borderRadius: 27,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'rgba(19,25,38,0.72)',
      borderWidth: 1,
      borderColor: 'rgba(138,182,232,0.30)',
    },
    outlineLabel: {
      fontSize: 17,
      fontWeight: '600',
      color: '#cfe0f4',
      letterSpacing: 1,
    },
    footer: {
      marginTop: 30,
      fontSize: 11,
      letterSpacing: 3,
      color: '#5b6b82',
    },
  });
