// 蓝鸟 UI 移植 · 弹簧抽屉「默认模型」（原型 #mSheet）
// 抽屉壳由 SheetScaffold 的 draggable 承担（半屏吸附 / 快速下滑关闭）；
// 本组件只负责模型行列表：真实服务商/模型来自 useModelSelection（/model-providers），
// 不再读 data/mock 的 MODELS。选择动作由父级注入（PUT /model-providers/default）。

import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { SheetScaffold } from './SheetScaffold';
import { useUi } from '../app/ui-state';
import type { V7Tokens } from '../app/ui-theme';
import type { ModelDefaults, ModelProvider } from '../lib/types';

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
    rowDisabled: { opacity: 0.45 },
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
    hint: { fontSize: 12, color: t.mut, textAlign: 'center', paddingVertical: 16 },
  });

export function ModelPickerSheet(props: {
  visible: boolean;
  onClose: () => void;
  providers: ModelProvider[];
  current: ModelDefaults | null;
  loading?: boolean;
  error?: string;
  onSelect: (providerId: string, modelId: string) => Promise<boolean>;
}) {
  const ui = useUi();
  const t = ui.tokens;
  const styles = createStyles(t);
  const [picking, setPicking] = useState(false);

  // 只列启用中的服务商的模型；停用的模型保留但不可点（与服务端校验一致）
  const rows = props.providers
    .filter(provider => provider.enabled)
    .flatMap(provider =>
      provider.models.map(model => ({ provider, model }))
    );

  const pick = async (providerId: string, modelId: string, enabled: boolean) => {
    if (!enabled || picking) return;

    setPicking(true);
    try {
      const ok = await props.onSelect(providerId, modelId);
      if (ok) props.onClose();
    } finally {
      setPicking(false);
    }
  };

  return (
    <SheetScaffold visible={props.visible} onClose={props.onClose} title="默认模型" draggable>
      <View>
        {props.loading && rows.length === 0 && (
          <Text style={styles.hint}>正在读取模型列表…</Text>
        )}
        {!props.loading && rows.length === 0 && (
          <Text style={styles.hint}>{props.error || '暂无可用模型'}</Text>
        )}
        {rows.map(({ provider, model }) => {
          const current =
            props.current?.providerId === provider.id &&
            props.current?.modelId === model.id;
          const label = `${provider.name} · ${model.name || model.id}`;
          return (
            <Pressable
              key={`${provider.id}:${model.id}`}
              onPress={() => void pick(provider.id, model.id, model.enabled)}
              disabled={!model.enabled || picking}
              style={({ pressed }) => [
                styles.row,
                pressed && styles.rowPressed,
                !model.enabled && styles.rowDisabled,
              ]}
              accessibilityLabel={'默认模型：' + label}
            >
              <View style={styles.pi}>
                <Text style={styles.piText}>◉</Text>
              </View>
              <Text style={styles.pl} numberOfLines={1}>
                {label}
              </Text>
              <Text style={styles.pv}>
                {current ? '当前' : model.enabled ? '选择' : '已停用'}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </SheetScaffold>
  );
}
