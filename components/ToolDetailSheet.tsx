// 工具调用详情：只展示服务端持久化的真实工具步骤元数据。
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { SheetScaffold } from './SheetScaffold';
import { useUi } from '../app/ui-state';
import type { ToolStepView } from '../lib/types';
import type { V7Tokens } from '../app/ui-theme';

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

export function getToolDetailRows(tool: ToolStepView) {
  return [
    { icon: tool.ok ? '✓' : '✕', label: '状态', value: tool.ok ? '成功' : '失败', div: true },
    { icon: '🛠', label: '工具', value: tool.name, div: false },
    { icon: '📄', label: '结果', value: tool.summary || '—', div: false },
    ...(Number.isFinite(tool.durationMs)
      ? [{ icon: '⏱', label: '耗时', value: `${tool.durationMs} ms`, div: false }]
      : []),
  ];
}

export function ToolDetailSheet(props: {
  visible: boolean;
  onClose: () => void;
  tool: ToolStepView | null;
}) {
  const ui = useUi();
  const styles = createStyles(ui.tokens);
  const rows = props.tool ? getToolDetailRows(props.tool) : null;

  return (
    <SheetScaffold visible={props.visible} onClose={props.onClose} title="工具调用详情" draggable>
      {rows === null ? (
        <View />
      ) : (
        <View>
          {rows.map(row => (
            <React.Fragment key={row.label}>
              <View style={styles.row}>
                <View style={styles.pi}>
                  <Text style={styles.piText}>{row.icon}</Text>
                </View>
                <Text style={styles.pl}>{row.label}</Text>
                <Text style={styles.pv}>{row.value}</Text>
              </View>
              {row.div && <View style={styles.div} />}
            </React.Fragment>
          ))}
        </View>
      )}
    </SheetScaffold>
  );
}
