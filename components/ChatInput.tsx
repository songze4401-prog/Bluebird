import React, { useMemo } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
} from 'react-native';

import type { Theme } from '../theme';
import { BlueAvatar } from './BlueAvatar';

// 底部悬浮输入栏：左头像 / 中间输入框 / 右侧「＋」或发送按钮，全包在同一条大胶囊里。
// 纯受控组件：value / sending / onSend 全部由 App 提供，内部不持有任何聊天状态。
export function ChatInput({
  theme,
  value,
  onChangeText,
  sending,
  onSend,
  onReturnHome,
}: {
  theme: Theme;
  value: string;
  onChangeText: (text: string) => void;
  sending: boolean;
  onSend: () => void;
  onReturnHome: () => void;
}) {
  const styles = useMemo(() => createStyles(theme), [theme]);

  return (
    // 悬浮输入栏 dock：留在正常流里，键盘弹起时仍会被 KeyboardAvoidingView 顶上去
    <View style={styles.inputDock}>
      <View style={styles.inputArea}>
        {/* 整条输入栏是一个大胶囊，左头像 / 中间输入 / 右按钮全包在里面 */}
        <View style={styles.inputCapsule}>
          {/* 左侧圆形头像：复用 BlueAvatar，视觉不变，点击即返回欢迎主页 */}
          <TouchableOpacity
            onPress={onReturnHome}
            activeOpacity={0.75}
            accessibilityLabel="返回主页"
          >
            <BlueAvatar size={48} theme={theme} />
          </TouchableOpacity>

          <TextInput
            value={value}
            onChangeText={onChangeText}
            placeholder="发消息..."
            placeholderTextColor={theme.textMuted}
            cursorColor={theme.accent}
            selectionColor={theme.accentBorder}
            style={styles.input}
            multiline
          />

          {value.trim().length > 0 ? (
            // 有输入内容：右侧变为发送按钮（向上箭头，不显示文字）
            <TouchableOpacity
              style={[
                styles.sendButton,
                sending && styles.sendButtonDisabled,
                { backgroundColor: theme.sendButton },
              ]}
              onPress={onSend}
              disabled={sending}
              activeOpacity={0.75}
              accessibilityLabel="发送"
            >
              <Text style={styles.sendText}>{sending ? '···' : '↑'}</Text>
            </TouchableOpacity>
          ) : (
            // 无输入内容：右侧是白色描边「＋」
            <View style={styles.plusButton}>
              <Text style={styles.plusIcon}>+</Text>
            </View>
          )}
        </View>
      </View>
    </View>
  );
}

// 样式由主题派生：只包含本组件用到的键
const createStyles = (theme: Theme) =>
  StyleSheet.create({
    // ---- 输入栏：整条大胶囊 + 左头像 + 右「＋」（参考图配色，写死色值） ----
    inputDock: {
      height: 80,
      // 上移 80 叠在消息列表底部之上：列表照旧铺满，胶囊浮在消息上面
      marginTop: -80,
      backgroundColor: 'transparent',
    },
    inputArea: {
      // 贴底悬浮：相对 inputDock（底部已在安全区之上），所以 bottom 只要 8
      position: 'absolute',
      left: 12,
      right: 12,
      bottom: 8,
      flexDirection: 'row',
      alignItems: 'center',
      // 整条背景去掉，只留中间的胶囊
      backgroundColor: 'transparent',
    },
    inputCapsule: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      // 成套跟随模式：浅色模式白胶囊，深色模式深色胶囊（深色下 accent 是浅色系，需要深底）
      backgroundColor:
        theme.mode === 'dark' ? 'rgba(24,28,37,0.9)' : 'rgba(255,255,255,0.9)',
      borderRadius: 999,
      paddingHorizontal: 4,
      minHeight: 56,
      // 悬浮阴影
      shadowColor: '#000',
      shadowOpacity: 0.25,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 4 },
      elevation: 8,
    },
    plusButton: {
      width: 40,
      height: 40,
      borderRadius: 20,
      borderWidth: 2,
      // 跟随强调色（与左侧 BlueAvatar 同一套：描边 accentBorder + 内容 accent）
      borderColor: theme.accentBorder,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: 4,
    },
    plusIcon: {
      color: theme.accent,
      fontSize: 26,
      lineHeight: 30,
      fontWeight: '300',
      marginTop: -3,
    },
    input: {
      flex: 1,
      maxHeight: 110,
      minHeight: 40,
      // 去掉独立背景与边框，直接融进胶囊
      backgroundColor: 'transparent',
      paddingHorizontal: 10,
      paddingVertical: 12,
      color: theme.textBody,
      fontSize: 17,
      textAlignVertical: 'center',
    },
    sendButton: {
      width: 40,
      height: 40,
      marginRight: 4,
      borderRadius: 20,
      backgroundColor: theme.sendButton,
      alignItems: 'center',
      justifyContent: 'center',
    },
    sendText: {
      color: theme.textOnAccent,
      fontSize: 17,
      lineHeight: 21,
      fontWeight: '700',
    },
    sendButtonDisabled: {
      opacity: 0.55,
    },
  });