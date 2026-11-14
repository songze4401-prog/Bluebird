// 蓝鸟 UI 移植 · 弹簧抽屉「工具调用详情」（原型 #tSheet）
// 抽屉壳由 SheetScaffold 的 draggable 承担（半屏吸附 / 快速下滑关闭）。
// tool 文案来自消息里的 tool pill（如「理解意图 · 已接上下文」），
// 按「 · 」拆段展示；耗时是原型同款演示值（140 + 长度*37 % 260），不是真实计时。

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { SheetScaffold } from './SheetScaffold';
import { useUi } from '../app/ui-state';
import type { V7Tokens } from '../app/ui-theme';

// 原型 .prow 行：flex 行 gap 12，padding 11/10，r14（本页为只读展示，无按压态）；
// .pdiv 分隔线：1px soft 底，左右留 8、上下留 4。
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
    pi: {
      width: 32,
      height: 32,
      borderRadius: 10,
      backgroundColor: t.card,
      alignItems: 'center',
      justifyContent: 'center',
    },
    piText: { color: t.on, fontSize: 14 },
    pl: { flex: 1, fontSize: 13, fontWeight: '500', color: t.ink },
    pv: { fontSize: 12, color: t.mut },
    div: { height: 1, backgroundColor: t.soft, marginVertical: 4, marginHorizontal: 8 },
  });

// 详情四行的纯数据视图（tool 为 null 时返回 null，由调用处决定渲染空壳）
function detailRows(tool: string) {
  const seg = tool.split(' · ');
  const ms = 140 + (tool.length * 37) % 260;
  return [
    { icon: '✓', label: '状态', value: '成功', div: true },
    { icon: '🛠', label: '工具', value: seg[0] || 'memory_search', div: false },
    { icon: '📄', label: '结果', value: seg[1] || '—', div: false },
    { icon: '⏱', label: '耗时', value: ms + ' ms', div: false },
  ];
}

export function ToolDetailSheet(props: {
  visible: boolean;
  onClose: () => void;
  tool: string | null;
}) {
  const ui = useUi();
  const t = ui.tokens;
  const styles = createStyles(t);
  const rows = props.tool ? detailRows(props.tool) : null;

  return (
    <SheetScaffold visible={props.visible} onClose={props.onClose} title="工具调用详情" draggable>
      {/* tool 为 null 时给空 View，壳体照常可拖拽/关闭，只是没有内容 */}
      {rows === null ? (
        <View />
      ) : (
        <View>
          {rows.map(r => (
            <React.Fragment key={r.label}>
              <View style={styles.row}>
                <View style={styles.pi}>
                  <Text style={styles.piText}>{r.icon}</Text>
                </View>
                <Text style={styles.pl}>{r.label}</Text>
                <Text style={styles.pv}>{r.value}</Text>
              </View>
              {r.div && <View style={styles.div} />}
            </React.Fragment>
          ))}
        </View>
      )}
    </SheetScaffold>
  );
}
