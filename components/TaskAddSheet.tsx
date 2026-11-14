// 蓝鸟 UI 移植 · 弹层「添加定时任务」（原型 #nSheet）
// 本组件只负责 sh-body 内容：时间 / 任务两个输入 + 保存按钮；
// 把手、标题、关闭按钮与手势由弹层壳 SheetScaffold 统一承担。

import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { SheetScaffold } from './SheetScaffold';
import { useUi } from '../app/ui-state';
import { V7_SHADOWS, type V7Tokens } from '../app/ui-theme';

// 原型 .f label：12px w600 次要色，下边距 7；输入用容器给样式（TextInput 原生无边框）
const createStyles = (t: V7Tokens) =>
  StyleSheet.create({
    // 每个字段包一层，让 form 的 gap 16 只作用于「字段之间」；标签到输入框的距离由 label 的 marginBottom 7 决定
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
    save: {
      backgroundColor: t.card,
      borderRadius: 999,
      paddingVertical: 13,
      alignItems: 'center',
      ...V7_SHADOWS.card,
    },
    saveText: { color: t.on, fontSize: 14, fontWeight: '600' },
  });

export function TaskAddSheet(props: { visible: boolean; onClose: () => void }) {
  const ui = useUi();
  const t = ui.tokens;
  const styles = createStyles(t);
  const [time, setTime] = useState('08:00');
  const [label, setLabel] = useState('');

  // 原型 #ntSave：任务名为空只 toast 不关闭；成功后清空输入并收起弹层
  const submit = () => {
    const l = label.trim();
    if (!l) {
      ui.toast('请填写任务');
      return;
    }
    ui.addTask(time || '08:00', l);
    setLabel('');
    props.onClose();
  };

  return (
    <SheetScaffold visible={props.visible} onClose={props.onClose} title="添加定时任务">
      <View style={styles.form}>
        <View>
          <Text style={styles.label}>时间</Text>
          <View style={styles.inputWrap}>
            <TextInput
              value={time}
              onChangeText={setTime}
              style={styles.input}
              placeholderTextColor={t.mut}
              underlineColorAndroid="transparent"
            />
          </View>
        </View>

        <View>
          <Text style={styles.label}>任务</Text>
          <View style={styles.inputWrap}>
            <TextInput
              value={label}
              onChangeText={setLabel}
              style={styles.input}
              placeholder="例如：早报摘要"
              placeholderTextColor={t.mut}
              underlineColorAndroid="transparent"
            />
          </View>
        </View>

        <Pressable style={styles.save} onPress={submit} accessibilityLabel="添加任务">
          <Text style={styles.saveText}>添加任务</Text>
        </Pressable>
      </View>
    </SheetScaffold>
  );
}
