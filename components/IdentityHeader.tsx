// 蓝鸟 UI 移植 · 聊天页悬浮身份组（原型 .chatbrand/.brand/.idrow：圆形图标压胶囊 8px）
// 上=品牌圆 44（card 底 + card 阴影），下=身份 pill（marginTop -8 压在圆下）；
// pill 可点开资料，带按压缩放反馈（原型 .idpill:active scale .96）。

import React, { useState } from 'react';
import { Animated, Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { useUi } from '../app/ui-state';
import { V7_SHADOWS, type V7Tokens } from '../app/ui-theme';

export function IdentityHeader(props: { onOpenProfile: () => void }) {
  const ui = useUi();
  const t = ui.tokens;
  const bot = ui.bots[0];
  const styles = createStyles(t);

  // pill 按压缩放反馈：1 → 0.96 → 1（useNativeDriver 只动 transform）
  const [scale] = useState(() => new Animated.Value(1));
  const pressIn = () =>
    Animated.timing(scale, { toValue: 0.96, duration: 90, useNativeDriver: true }).start();
  const pressOut = () =>
    Animated.timing(scale, { toValue: 1, duration: 160, useNativeDriver: true }).start();

  return (
    <View style={styles.wrap}>
      {/* 品牌圆 44：bots[0] 有自定义头像则铺满圆，否则用应用图标 34 圆角（原型 .brand） */}
      <View style={styles.brand} pointerEvents="none">
        <Image
          style={bot.avatarImg ? styles.brandImgFull : styles.brandImg}
          source={bot.avatarImg ? { uri: bot.avatarImg } : require('../assets/icon.png')}
          resizeMode="cover"
        />
      </View>

      {/* 身份 pill：surface 底 r999，绿点 + 名字 + ›（原型 .idpill/.chdot） */}
      <Pressable
        style={styles.pillWrap}
        onPress={props.onOpenProfile}
        onPressIn={pressIn}
        onPressOut={pressOut}
        accessibilityRole="button"
        accessibilityLabel="Agent 资料"
      >
        <Animated.View style={[styles.pill, { transform: [{ scale }] }]}>
          <View style={styles.dot} />
          <Text numberOfLines={1} style={styles.pillName}>
            {bot.n}
          </Text>
          <Text style={styles.pillChev}>›</Text>
        </Animated.View>
      </Pressable>
    </View>
  );
}

// 原型 .chatbrand/.brand/.idpill/.chdot 的 RN 移植
const createStyles = (t: V7Tokens) =>
  StyleSheet.create({
    // 列居中：图标在上、pill 在下（绝对定位与点击穿透由父级承担，原型 .chatbrand）
    wrap: {
      alignItems: 'center',
    },
    // 原型 .brand：44 圆 card 底 + card 阴影；zIndex 2 让图标底缘压在 pill 上
    brand: {
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: t.card,
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 2,
      ...V7_SHADOWS.card,
    },
    // 自定义头像：铺满 44 圆（Image 自带 borderRadius 裁切，不靠 overflow hidden）
    brandImgFull: {
      width: 44,
      height: 44,
      borderRadius: 22,
    },
    // 应用图标：34 圆角（原型 .brand img 34x34）
    brandImg: {
      width: 34,
      height: 34,
      borderRadius: 8,
    },
    // 原型 .idrow：marginTop -8 把 pill 顶部压到圆下 8px
    pillWrap: {
      marginTop: -8,
      alignSelf: 'center',
    },
    // 原型 .idpill：surface 底 r999 p7/14 阴影 md，行 gap 8
    pill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      backgroundColor: t.surface,
      borderRadius: 999,
      paddingVertical: 7,
      paddingHorizontal: 14,
      ...V7_SHADOWS.md,
    },
    // 原型 .chdot：8 圆 up 绿点
    dot: {
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: t.up,
    },
    // 原型 .idpill b：13 w700 ink
    pillName: {
      fontSize: 13,
      fontWeight: '700',
      color: t.ink,
    },
    // 原型 .idpill .chev：12 mut
    pillChev: {
      fontSize: 12,
      color: t.mut,
    },
  });
