import React, { useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  Modal,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { THEMES, getAccentSet, type Theme, type ThemeId } from '../theme';

// 主题色选择弹窗：状态与持久化留在父级（App），
// 这里只按当前主题渲染列表，把选中的强调色 id 通过 onSelect 上抛。
export function ThemeScreen({
  visible,
  onClose,
  theme,
  onSelect,
}: {
  visible: boolean;
  onClose: () => void;
  theme: Theme;
  onSelect: (next: ThemeId) => void;
}) {
  const styles = useMemo(() => createStyles(theme), [theme]);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={onClose}
    >
      <SafeAreaView style={styles.memoryContainer}>
        <View style={styles.memoryHeader}>
          <TouchableOpacity
            style={styles.memoryBack}
            onPress={onClose}
          >
            <Text style={[styles.memoryBackText, { color: theme.accent }]}>
              ‹ 返回
            </Text>
          </TouchableOpacity>

          <Text style={styles.memoryTitle}>主题色</Text>

          <View style={styles.memoryHeaderSpacer} />
        </View>

        <Text style={styles.memoryCaption}>
          只切换强调色，黑色背景与文字层级保持不变
        </Text>

        <FlatList
          data={THEMES}
          keyExtractor={item => item.id}
          contentContainerStyle={styles.memoryList}
          renderItem={({ item }) => {
            const selected = item.id === theme.accentId;

            return (
              <TouchableOpacity
                style={[
                  styles.memoryCard,
                  selected && { borderColor: theme.accentBorder },
                ]}
                onPress={() => onSelect(item.id)}
              >
                <View style={styles.themeRow}>
                  <View
                    style={[
                      styles.themeSwatch,
                      { backgroundColor: getAccentSet(item.id, theme.mode).sendButton },
                    ]}
                  />

                  <Text style={styles.themeLabel}>
                    {item.emoji} {item.label}
                  </Text>

                  {selected && (
                    <Text
                      style={[styles.themeCheck, { color: theme.accent }]}
                    >
                      ✓
                    </Text>
                  )}
                </View>
              </TouchableOpacity>
            );
          }}
        />
      </SafeAreaView>
    </Modal>
  );
}

// 样式由主题派生：只包含本组件用到的键
const createStyles = (theme: Theme) => StyleSheet.create({
  memoryContainer: {
    flex: 1,
    backgroundColor: theme.background,
  },
  memoryHeader: {
    height: 72,
    paddingHorizontal: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
  },
  memoryBack: {
    minWidth: 64,
    paddingVertical: 6,
  },
  memoryBackText: {
    color: theme.accent,
    fontSize: 16,
  },
  memoryTitle: {
    color: theme.textPrimary,
    fontSize: 20,
    fontWeight: '700',
  },
  memoryHeaderSpacer: {
    minWidth: 64,
  },
  memoryCaption: {
    color: theme.textSecondary,
    fontSize: 13,
    lineHeight: 19,
    paddingHorizontal: 20,
    paddingTop: 14,
    paddingBottom: 6,
  },
  memoryList: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 24,
  },
  memoryCard: {
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.borderStrong,
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
  },
  // ---- 主题色选择（复用记忆库的容器/卡片样式） ----
  themeRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  themeSwatch: {
    width: 22,
    height: 22,
    borderRadius: 11,
    marginRight: 12,
    borderWidth: 1,
    borderColor: theme.borderStrong,
  },
  themeLabel: {
    flex: 1,
    color: theme.textBody,
    fontSize: 16,
  },
  themeCheck: {
    fontSize: 18,
    fontWeight: '700',
  },
});