// 蓝鸟 UI 移植 · 设置页壁纸横滑行（原型 .wpr/.wp/.wl）
// 内置三张缩略图（默认/蓝色光晕/冰蓝）+「＋上传」；缩略图内容色与 app/ui-state.tsx
// 的 WallpaperLayer 同源（壁纸内容色固定，不随主题 token）。

import React from 'react';
import * as ImagePicker from 'expo-image-picker';
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  type DimensionValue,
} from 'react-native';

import { useUi } from '../app/ui-state';
import { V7_SHADOWS, type V7Tokens } from '../app/ui-theme';
import type { WallpaperId } from '../data/ui-contract';

// 缩略图里的半透明圆层（与 WallpaperLayer 的 deep/light 色值一致，位置按 92x44 近似）
type ThumbCircle = {
  left: DimensionValue;
  top: DimensionValue;
  width: DimensionValue;
  height: DimensionValue;
  color: string;
};

const DEEP_CIRCLES: ThumbCircle[] = [
  { left: '-25%', top: '-18%', width: '80%', height: '52%', color: 'rgba(47,107,255,0.85)' },
  { left: '0%', top: '-5%', width: '60%', height: '38%', color: 'rgba(130,185,255,0.45)' },
];

const LIGHT_CIRCLES: ThumbCircle[] = [
  { left: '-20%', top: '-16%', width: '75%', height: '48%', color: 'rgba(70,120,250,0.38)' },
  { left: '0%', top: '-10%', width: '55%', height: '34%', color: 'rgba(255,255,255,0.55)' },
];

// 内置三张：id 对应 WallpaperId
const BUILTINS: { id: WallpaperId; label: string }[] = [
  { id: 'default', label: '默认' },
  { id: 'deep', label: '蓝色光晕' },
  { id: 'light', label: '冰蓝' },
];

export function WallpaperPicker() {
  const { ui, tokens: t, setWallpaper } = useUi();
  const styles = createStyles(t);

  // 「＋上传」→ 系统相册选图 → setWallpaper('custom', uri)；取消/失败都静默忽略
  const pickWallpaper = async () => {
    try {
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: 0.8,
      });
      if (res.canceled) return;
      const uri = res.assets?.[0]?.uri;
      if (!uri) return;
      setWallpaper('custom', uri);
    } catch {
      // 静默忽略：选图被打断不打断设置页
    }
  };

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
    >
      {BUILTINS.map(w => {
        const on = ui.wallpaper === w.id;
        // 缩略图底色与圆层：default 左浅右深对角分割，deep/light 用圆层近似光晕
        const base =
          w.id === 'default' ? '#f4f6fa' : w.id === 'deep' ? '#060913' : '#e1e9f7';
        const circles =
          w.id === 'deep' ? DEEP_CIRCLES : w.id === 'light' ? LIGHT_CIRCLES : null;
        return (
          <TouchableOpacity
            key={w.id}
            style={[styles.thumb, { borderColor: on ? t.ink : 'transparent' }, V7_SHADOWS.md]}
            activeOpacity={0.9}
            onPress={() => setWallpaper(w.id)}
            accessibilityRole="button"
            accessibilityLabel={'壁纸：' + w.label}
          >
            {/* 内层裁切：阴影挂外层、裁切挂内层，避免 iOS 上 overflow hidden 吃掉阴影 */}
            <View style={[styles.clip, { backgroundColor: base }]}>
              {w.id === 'default' ? (
                // 左浅右深的对角分割：一块旋转 -8° 的深色矩形近似 135° 渐变（原型 .wpdef）
                <View style={styles.defDark} />
              ) : null}
              {circles
                ? circles.map((c, i) => (
                    <View
                      key={i}
                      style={{
                        position: 'absolute',
                        left: c.left,
                        top: c.top,
                        width: c.width,
                        height: c.height,
                        borderRadius: 999,
                        backgroundColor: c.color,
                      }}
                    />
                  ))
                : null}
            </View>
            {/* 角标：白 10 w700 左下 + 深色 textShadow（原型 .wl） */}
            <Text style={styles.wl}>{w.label}</Text>
          </TouchableOpacity>
        );
      })}

      {/* ＋上传：1.5 虚线框；wallpaper==='custom' 时同样显示选中描边（原型 .wpadd） */}
      <TouchableOpacity
        style={[
          styles.thumbAdd,
          {
            borderColor: ui.wallpaper === 'custom' ? t.ink : t.mut,
            borderWidth: ui.wallpaper === 'custom' ? 2 : 1.5,
          },
        ]}
        activeOpacity={0.9}
        onPress={pickWallpaper}
        accessibilityRole="button"
        accessibilityLabel="上传自定义壁纸"
      >
        <Text style={styles.plus}>＋</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

// 原型 .wpr/.wp/.wl/.wpdef/.wpadd 的 RN 移植
const createStyles = (t: V7Tokens) =>
  StyleSheet.create({
    // 原型 .wpr：横滑 gap8，上下留 2/4
    row: {
      flexDirection: 'row',
      gap: 8,
      paddingHorizontal: 2,
      paddingTop: 2,
      paddingBottom: 4,
    },
    // 原型 .wp：92x44 r12，选中描边 2 ink / 未选透明（阴影挂外层，裁切给内层）
    thumb: {
      width: 92,
      height: 44,
      borderRadius: 12,
      borderWidth: 2,
      borderColor: 'transparent',
    },
    // 内层裁切容器：r10 = 外层 r12 - 描边 2
    clip: {
      flex: 1,
      borderRadius: 10,
      overflow: 'hidden',
    },
    // 对角分割的深色块：超出部分由内层裁掉
    defDark: {
      position: 'absolute',
      right: -14,
      top: -12,
      width: 60,
      height: 64,
      backgroundColor: '#17171a',
      transform: [{ rotate: '-8deg' }],
    },
    // 原型 .wl：白 10 w700 左下，textShadow 0 1px 3px 黑 55%
    wl: {
      position: 'absolute',
      left: 6,
      bottom: 3,
      fontSize: 10,
      fontWeight: '700',
      color: '#ffffff',
      textShadowColor: 'rgba(0,0,0,0.55)',
      textShadowOffset: { width: 0, height: 1 },
      textShadowRadius: 3,
    },
    // 原型 .wpadd：虚线框 r12 居中「＋」18 sec（无阴影；边宽/颜色由调用处给）
    thumbAdd: {
      width: 92,
      height: 44,
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
      borderStyle: 'dashed',
    },
    plus: {
      fontSize: 18,
      color: t.sec,
    },
  });
