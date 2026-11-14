// 蓝鸟 UI 移植 · 弹簧抽屉「默认模型」（原型 #mSheet）
// 抽屉壳由 SheetScaffold 的 draggable 承担（半屏吸附 / 快速下滑关闭）；
// 本组件只负责模型行列表：一行一个 MODELS 项，prow 按下泛 soft 底。

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { SheetScaffold } from './SheetScaffold';
import { useUi } from '../app/ui-state';
import { MODELS } from '../data/mock';
import type { V7Tokens } from '../app/ui-theme';

// 原型 .prow 行：flex 行 gap 12，padding 11/10，r14，按下泛 soft 底；
// .pi 方块 32 r10 强调色底；右侧 .pv 12px 弱化色标注「当前 / 选择」。
const createStyles = (t: V7Tokens) =>
  StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingVertical: 11,
      paddingHorizontal: 10,
      borderRadius: 14,
    },
    rowPressed: { backgroundColor: t.soft },
    pi: {
      width: 32,
      height: 32,
      borderRadius: 10,
      backgroundColor: t.card,
      alignItems: 'center',
      justifyContent: 'center',
    },
    piText: { color: t.on, fontSize: 15 },
    pl: { flex: 1, fontSize: 13, fontWeight: '500', color: t.ink },
    pv: { fontSize: 12, color: t.mut },
  });

export function ModelPickerSheet(props: { visible: boolean; onClose: () => void }) {
  const ui = useUi();
  const t = ui.tokens;
  const styles = createStyles(t);

  // 原型 #mList 点击行：写入 state.model → toast → 关抽屉
  const pick = (m: string) => {
    ui.setModel(m);
    ui.toast('已切换默认模型：' + m);
    props.onClose();
  };

  return (
    <SheetScaffold visible={props.visible} onClose={props.onClose} title="默认模型" draggable>
      <View>
        {MODELS.map(m => (
          <Pressable
            key={m}
            onPress={() => pick(m)}
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            accessibilityLabel={'默认模型：' + m}
          >
            <View style={styles.pi}>
              <Text style={styles.piText}>◉</Text>
            </View>
            <Text style={styles.pl} numberOfLines={1}>
              {m}
            </Text>
            <Text style={styles.pv}>{m === ui.model ? '当前' : '选择'}</Text>
          </Pressable>
        ))}
      </View>
    </SheetScaffold>
  );
}
