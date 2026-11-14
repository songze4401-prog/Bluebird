// 蓝鸟 UI 移植 · 弹层「更换头像」（原型 setAvatar：预设格子 + 从本机选择图片）
// 本组件只负责 sh-body 内容：scrim / 把手 / 标题 / ✕ 由弹层壳 SheetScaffold 统一承担。

import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';

import { SheetScaffold } from './SheetScaffold';
import { useUi } from '../app/ui-state';
import type { V7Tokens } from '../app/ui-theme';
import { AVATAR_PRESETS } from '../data/mock';

export function AvatarSheet(props: { visible: boolean; onClose: () => void }) {
  const ui = useUi();
  const styles = createStyles(ui.tokens);

  // 「从本机选择图片」→ 系统相册选图 → 头像设为图片 uri（原型走文件选择，RN 用 image-picker）
  const pickImage = async () => {
    try {
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: 0.85,
      });
      if (res.canceled) return;
      const uri = res.assets?.[0]?.uri;
      if (!uri) return;
      ui.setUserAvatar({ type: 'image', value: uri });
    } catch {
      ui.toast('图片选择失败');
    }
  };

  return (
    <SheetScaffold visible={props.visible} onClose={props.onClose} title="更换头像">
      <View>
        {/* 预设格子：4 列网格（23% 宽 + space-between 复刻原型 4 列），选中 ink 描边 */}
        <View style={styles.grid}>
          {AVATAR_PRESETS.map(p => {
            const on = ui.user.avatar.type === p.t && ui.user.avatar.value === p.v;
            return (
              <TouchableOpacity
                key={p.t + p.v}
                style={[styles.cell, { borderColor: on ? ui.tokens.ink : 'transparent' }]}
                onPress={() => ui.setUserAvatar({ type: p.t, value: p.v })}
              >
                <Text style={styles.glyph}>{p.v}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* 从本机选择图片（原型 .optrow + .oi） */}
        <TouchableOpacity style={styles.optrow} onPress={pickImage}>
          <View style={styles.oi}>
            <Text style={styles.oiTxt}>🖼</Text>
          </View>
          <Text style={styles.ol}>从本机选择图片</Text>
        </TouchableOpacity>
      </View>
    </SheetScaffold>
  );
}

// 原型 .optgrid/.optrow/.oi/.ol 的 RN 移植
const createStyles = (t: V7Tokens) =>
  StyleSheet.create({
    // 原型 .optgrid：4 列网格 gap12 p4/2/8；RN 用 23% 宽 + space-between + rowGap 复刻
    grid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      justifyContent: 'space-between',
      rowGap: 12,
      paddingVertical: 4,
      paddingHorizontal: 2,
      marginBottom: 8,
    },
    // 格子：23% 宽 1:1 r16 soft 底 24px glyph；描边常驻 2（未选透明，避免选中跳动）
    cell: {
      width: '23%',
      aspectRatio: 1,
      borderRadius: 16,
      backgroundColor: t.soft,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 2,
    },
    glyph: { fontSize: 24, color: t.ink },
    // 原型 .optrow：行 p12/10 r14 gap12
    optrow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingVertical: 12,
      paddingHorizontal: 10,
      borderRadius: 14,
    },
    // 原型 .oi：32 r10 card 底 on 15
    oi: {
      width: 32,
      height: 32,
      borderRadius: 10,
      backgroundColor: t.card,
      alignItems: 'center',
      justifyContent: 'center',
    },
    oiTxt: { fontSize: 15, color: t.on },
    // 原型 .ol：13 w500 ink flex1
    ol: { flex: 1, fontSize: 13, fontWeight: '500', color: t.ink },
  });
