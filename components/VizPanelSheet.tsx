// 蓝鸟 UI 移植 · 弹层「新建可视化面板」（原型 #pSheet）
// 本组件只负责 sh-body 内容：名称输入 + 类型三选一分段 + 创建按钮；
// 原型此处是 <select>，按 RN 版型改为横向分段（选中项强调底/未选项弱底）。

import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { SheetScaffold } from './SheetScaffold';
import { useUi } from '../app/ui-state';
import { V7_SHADOWS, type V7Tokens } from '../app/ui-theme';
import type { VizKind } from '../data/mock';

// 面板类型三选一（与原型 select 的三个 option 一一对应）
const VIZ_TYPES: { k: VizKind; label: string }[] = [
  { k: 'stock', label: '股票' },
  { k: 'weather', label: '天气' },
  { k: 'news', label: '新闻' },
];

// 原型 .f label：12px w600 次要色，下边距 7；输入用容器给样式（TextInput 原生无边框）
const createStyles = (t: V7Tokens) =>
  StyleSheet.create({
    form: { gap: 16 },
    label: { fontSize: 12, fontWeight: '600', color: t.sec, marginBottom: 7 },
    inputWrap: {
      backgroundColor: t.soft,
      borderRadius: 12,
      paddingVertical: 10,
      paddingHorizontal: 12,
      ...V7_SHADOWS.md,
    },
    input: { fontSize: 14, color: t.ink, padding: 0 },
    segRow: { flexDirection: 'row', gap: 4 },
    segItem: {
      flex: 1,
      alignItems: 'center',
      paddingVertical: 8,
      borderRadius: 12,
    },
    segText: { fontSize: 12 },
    segOn: { backgroundColor: t.card },
    segOff: { backgroundColor: t.soft },
    segTextOn: { color: t.on, fontWeight: '700' },
    segTextOff: { color: t.sec },
    save: {
      backgroundColor: t.card,
      borderRadius: 999,
      paddingVertical: 13,
      alignItems: 'center',
      ...V7_SHADOWS.card,
    },
    saveText: { color: t.on, fontSize: 14, fontWeight: '600' },
  });

export function VizPanelSheet(props: { visible: boolean; onClose: () => void }) {
  const ui = useUi();
  const t = ui.tokens;
  const styles = createStyles(t);
  const [name, setName] = useState('');
  const [type, setType] = useState<VizKind>('stock');

  // 原型 #pnSave：名称留空时用「未命名面板」兜底，创建后直接收起
  const submit = () => {
    ui.createPanel(name.trim() || '未命名面板', type);
    props.onClose();
  };

  return (
    <SheetScaffold visible={props.visible} onClose={props.onClose} title="新建可视化面板">
      <View style={styles.form}>
        <View>
          <Text style={styles.label}>面板名称</Text>
          <View style={styles.inputWrap}>
            <TextInput
              value={name}
              onChangeText={setName}
              style={styles.input}
              placeholder="例如：持仓概览"
              placeholderTextColor={t.mut}
              underlineColorAndroid="transparent"
            />
          </View>
        </View>

        <View>
          <Text style={styles.label}>类型</Text>
          <View style={styles.segRow}>
            {VIZ_TYPES.map(v => {
              const on = v.k === type;
              return (
                <Pressable
                  key={v.k}
                  onPress={() => setType(v.k)}
                  style={[styles.segItem, on ? styles.segOn : styles.segOff]}
                  accessibilityLabel={'面板类型：' + v.label}
                >
                  <Text style={[styles.segText, on ? styles.segTextOn : styles.segTextOff]}>
                    {v.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        <Pressable style={styles.save} onPress={submit} accessibilityLabel="创建面板">
          <Text style={styles.saveText}>创建面板</Text>
        </Pressable>
      </View>
    </SheetScaffold>
  );
}
