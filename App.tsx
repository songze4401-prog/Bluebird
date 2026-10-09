import React, { useEffect, useMemo, useState } from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  KeyboardAvoidingView,
  Alert,
  Modal,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { Message } from './lib/types';
import { API_TOKEN } from './lib/constants';
import { makeLocalId, readJsonResponse } from './lib/utils';

import { ChatInput } from './components/ChatInput';
import { ChatHeader } from './components/ChatHeader';
import { ChatBubble } from './components/ChatBubble';
import { MessageList } from './components/MessageList';
import { MemoryScreen } from './components/MemoryScreen';

import {
  THEMES,
  getTheme,
  getAccentSet,
  isThemeId,
  isThemeMode,
  DEFAULT_THEME_ID,
  DEFAULT_THEME_MODE,
  THEME_STORAGE_KEY,
  THEME_MODE_STORAGE_KEY,
  type Theme,
  type ThemeId,
  type ThemeMode,
} from './theme';

export default function App() {
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [mood, setMood] = useState('calm');

  // 主题：模式（浅色/深色）+ 强调色，均为纯前端本地偏好，不经过服务器
  const [themeMode, setThemeMode] = useState<ThemeMode>(DEFAULT_THEME_MODE);
  const [themeId, setThemeId] = useState<ThemeId>(DEFAULT_THEME_ID);
  const [themePickerOpen, setThemePickerOpen] = useState(false);

  // 由「模式 + 强调色」合成全局主题
  const theme = useMemo(
    () => getTheme(themeMode, themeId),
    [themeMode, themeId]
  );

  // 样式由主题派生，组件内不再硬编码任何浅色/深色色值
  const styles = useMemo(() => createStyles(theme), [theme]);

  // 记忆库
  const [memoryOpen, setMemoryOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const welcome: Message[] = [
      {
        id: 'welcome-1',
        role: 'assistant',
        content: '我在。',
      },
      {
        id: 'welcome-2',
        role: 'assistant',
        content: '这里是属于Bluebird的地方。想说什么就说吧。',
      },
    ];

    const loadHistory = async () => {
      try {
        const response = await fetch(
          `${process.env.EXPO_PUBLIC_API_URL}/history?limit=200`,
          {
            headers: {
              Authorization: `Bearer ${API_TOKEN}`,
            },
          }
        );

        const data = await readJsonResponse(response);

        if (!response.ok || !Array.isArray(data.history)) {
          throw new Error('读取历史记录失败');
        }

        if (cancelled) return;

        if (data.history.length === 0) {
          setMessages(welcome);
          return;
        }

        setMessages(
          data.history.map(
            (
              item: {
                id?: string;
                role: 'user' | 'assistant';
                content: string;
                createdAt?: string;
              },
              index: number
            ) => ({
              id: item.id ?? `history-${index}`,
              role: item.role,
              content: item.content,
              createdAt: item.createdAt,
            })
          )
        );
      } catch (error) {
        console.error('History load error:', error);
        if (!cancelled) setMessages(welcome);
      } finally {
        if (!cancelled) setLoadingHistory(false);
      }
    };

    loadHistory();

    return () => {
      cancelled = true;
    };
  }, []);

  // 启动时读取服务端持久化的真实情绪状态，让顶部 Emoji 与 Emotion System 保持一致
  useEffect(() => {
    let cancelled = false;

    const loadEmotion = async () => {
      try {
        const response = await fetch(
          `${process.env.EXPO_PUBLIC_API_URL}/emotion`,
          {
            headers: {
              Authorization: `Bearer ${API_TOKEN}`,
            },
          }
        );

        const data = await readJsonResponse(response);

        if (cancelled || !response.ok) return;

        if (typeof data.emotion === 'string') setMood(data.emotion);
      } catch (error) {
        console.error('Load emotion error:', error);
      }
    };

    loadEmotion();

    return () => {
      cancelled = true;
    };
  }, []);

  // 启动时读取本地保存的主题（模式 + 强调色）；读不到就用默认（浅色 + 黑色强调）
  useEffect(() => {
    let cancelled = false;

    const loadTheme = async () => {
      try {
        const [savedMode, savedAccent] = await Promise.all([
          AsyncStorage.getItem(THEME_MODE_STORAGE_KEY),
          AsyncStorage.getItem(THEME_STORAGE_KEY),
        ]);

        if (cancelled) return;

        if (isThemeMode(savedMode)) setThemeMode(savedMode);
        if (isThemeId(savedAccent)) setThemeId(savedAccent);
      } catch (error) {
        console.error('Load theme error:', error);
      }
    };

    loadTheme();

    return () => {
      cancelled = true;
    };
  }, []);

  // 切换强调色：先立即生效（UI 不等 IO），再异步落盘
  const selectTheme = (next: ThemeId) => {
    setThemeId(next);

    AsyncStorage.setItem(THEME_STORAGE_KEY, next).catch(error => {
      console.error('Save theme error:', error);
    });
  };

  // 切换浅色 / 深色模式：同样先立即生效再落盘
  const selectMode = (next: ThemeMode) => {
    setThemeMode(next);

    AsyncStorage.setItem(THEME_MODE_STORAGE_KEY, next).catch(error => {
      console.error('Save theme mode error:', error);
    });
  };

  const openThemePicker = () => {
    setMenuOpen(false);
    setThemePickerOpen(true);
  };

  const clearChatHistory = async () => {
    Alert.alert(
      '清理聊天记录',
      '确定要删除当前保存的全部聊天记录吗？',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '清理',
          style: 'destructive',
          onPress: async () => {
            try {
              const response = await fetch(
                `${process.env.EXPO_PUBLIC_API_URL}/history/clear`,
                {
                  method: 'POST',
                  headers: {
                    Authorization: `Bearer ${API_TOKEN}`,
                  },
                }
              );

              const data = await readJsonResponse(response);

              if (!response.ok) {
                throw new Error(data.error || '清理失败');
              }

              setMessages([]);
              setMenuOpen(false);

              Alert.alert('完成', '聊天记录已经清空。');
            } catch (error) {
              console.error('Clear history error:', error);
              Alert.alert('失败', '清理聊天记录失败，请稍后再试。');
            }
          },
        },
      ]
    );
  };

  // ---- 记忆库 ----
  const openMemoryLibrary = () => {
    setMenuOpen(false);
    setMemoryOpen(true);
  };

  const recallMessage = (message: Message) => {
    Alert.alert('撤回这条消息？', message.content, [
      { text: '取消', style: 'cancel' },
      {
        text: '撤回',
        style: 'destructive',
        onPress: async () => {
          try {
            const response = await fetch(
              `${process.env.EXPO_PUBLIC_API_URL}/history/recall`,
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${API_TOKEN}`,
                },
                body: JSON.stringify({ messageId: message.id }),
              }
            );

            const data = await readJsonResponse(response);

            if (!response.ok) {
              throw new Error(data.error || '撤回失败');
            }

            // 服务端返回真实删除的 id 列表（含配对的 AI 回复），按它移除
            const removedIds: string[] = Array.isArray(data.removedIds)
              ? data.removedIds
              : [message.id];

            setMessages(prev =>
              prev.filter(m => !removedIds.includes(m.id))
            );
          } catch (error) {
            console.error('Recall error:', error);
            Alert.alert('撤回失败', '请稍后再试。');
          }
        },
      },
    ]);
  };

  const sendMessage = async (retryText?: string) => {
    const text = (retryText ?? input).trim();

    if (!text || sending) return;

    const userMessage: Message = {
      id: makeLocalId(),
      role: 'user',
      content: text,
      createdAt: new Date().toISOString(),
    };

    setSending(true);

    const past = messages.filter(item => !item.retryText);
    const history = (retryText ? past.slice(0, -1) : past)
      .slice(-20)
      .map(item => ({ role: item.role, content: item.content }));

    if (retryText) {
      setMessages(prev => prev.filter(m => m.retryText !== retryText));
    } else {
      setMessages(prev => [...prev, userMessage]);
      setInput('');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);

    try {
      const response = await fetch(
        `${process.env.EXPO_PUBLIC_API_URL}/chat`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${API_TOKEN}`,
          },
          signal: controller.signal,
          body: JSON.stringify({
            message: text,
            history,
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          }),
        }
      );

      const data = await readJsonResponse(response);

      if (!response.ok) {
        throw new Error(data.error || '请求失败');
      }

      const replyMood = typeof data.mood === 'string' ? data.mood : 'calm';

      setMessages(prev => {
        // 撤回需要服务端稳定 id：用服务端返回的 id 替换本地临时 id
        const serverUserId =
          typeof data.userMessageId === 'string'
            ? data.userMessageId
            : null;

        let patched = prev;

        if (serverUserId) {
          // 正常发送更新刚发出的气泡；重试时更新最后一条用户消息
          const targetId = retryText
            ? [...prev].reverse().find(m => m.role === 'user')?.id
            : userMessage.id;

          patched = prev.map(m =>
            m.id === targetId ? { ...m, id: serverUserId } : m
          );
        }

        return [
          ...patched,
          {
            id:
              typeof data.assistantMessageId === 'string'
                ? data.assistantMessageId
                : `${makeLocalId()}-ai`,
            role: 'assistant',
            content: data.reply,
            mood: replyMood,
            createdAt: data.createdAt ?? new Date().toISOString(),
          },
        ];
      });

      setMood(replyMood);
    } catch (error) {
      console.error(error);

      const errorMessage =
        error instanceof Error && error.name === 'AbortError'
          ? '连接Bluebird超时了，再试一次。'
          : '连接Bluebird失败了，再试一次。';

      setMessages(prev => [
        ...prev,
        {
          id: `error-${makeLocalId()}`,
          role: 'assistant',
          content: errorMessage,
          retryText: text,
        },
      ]);
    } finally {
      clearTimeout(timeout);
      setSending(false);
    }
  };

  // 「继续说」：让 Bluebird 接着自己上一条回复往下说。
  // 走同一个 /chat，用 mode:'continue' 标记为内部续写请求；
  // 后端不会保存任何"继续说"用户消息，只追加 assistant 消息。
  const sendContinuation = async () => {
    if (continuing || sending) return;

    const last = messages[messages.length - 1];

    if (!last || last.role !== 'assistant' || last.retryText) return;

    const history = messages
      .filter(item => !item.retryText)
      .slice(-20)
      .map(item => ({ role: item.role, content: item.content }));

    setContinuing(true);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);

    try {
      const response = await fetch(
        `${process.env.EXPO_PUBLIC_API_URL}/chat`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${API_TOKEN}`,
          },
          signal: controller.signal,
          body: JSON.stringify({
            mode: 'continue',
            history,
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          }),
        }
      );

      const data = await readJsonResponse(response);

      if (!response.ok) {
        throw new Error(data.error || '请求失败');
      }

      const replyMood = typeof data.mood === 'string' ? data.mood : 'calm';

      setMessages(prev => [
        ...prev,
        {
          id:
            typeof data.assistantMessageId === 'string'
              ? data.assistantMessageId
              : `${makeLocalId()}-ai`,
          role: 'assistant',
          content: data.reply,
          mood: replyMood,
          createdAt: data.createdAt ?? new Date().toISOString(),
        },
      ]);

      setMood(replyMood);
    } catch (error) {
      console.error('Continue error:', error);

      Alert.alert('失败', '继续说失败了，请稍后再试。');
    } finally {
      clearTimeout(timeout);
      setContinuing(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      {/* 基础聊天背景（仅深色模式）。
          必须放在 KeyboardAvoidingView 之前、并让 KAV 不设背景，
          否则 KAV 的不透明底会把光晕整层盖住。
          各层 pointerEvents="none"，不拦截任何触摸。 */}
      {theme.mode === 'dark' && (
        <>
          <View pointerEvents="none" style={styles.chatBase} />
          <View pointerEvents="none" style={styles.chatGlowCool} />
          <View pointerEvents="none" style={styles.chatGlowWarm} />
        </>
      )}

      <KeyboardAvoidingView
        style={styles.keyboardArea}
        behavior="padding"
      >
        <ChatHeader
          theme={theme}
          mood={mood}
          menuOpen={menuOpen}
          onToggleMenu={() => setMenuOpen(prev => !prev)}
          onOpenMemory={openMemoryLibrary}
          onSelectMode={selectMode}
          onOpenThemePicker={openThemePicker}
          onClearHistory={clearChatHistory}
        />

        <MessageList
          theme={theme}
          messages={messages}
          loadingHistory={loadingHistory}
          sending={sending}
          continuing={continuing}
          onRecall={recallMessage}
          onRetry={sendMessage}
          onContinue={sendContinuation}
        />

        {/* 悬浮输入栏：dock 留在正常流里（键盘弹起会被顶上去），胶囊绝对定位贴底 */}
        <ChatInput
          theme={theme}
          value={input}
          onChangeText={setInput}
          sending={sending}
          onSend={() => sendMessage()}
        />
      </KeyboardAvoidingView>

      <MemoryScreen
        visible={memoryOpen}
        onClose={() => setMemoryOpen(false)}
        theme={theme}
      />

      <Modal
        visible={themePickerOpen}
        animationType="slide"
        onRequestClose={() => setThemePickerOpen(false)}
      >
        <SafeAreaView style={styles.memoryContainer}>
          <View style={styles.memoryHeader}>
            <TouchableOpacity
              style={styles.memoryBack}
              onPress={() => setThemePickerOpen(false)}
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
                  onPress={() => selectTheme(item.id)}
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
    </SafeAreaView>
  );
}

// 铺满父级的绝对定位层。
// 不用 StyleSheet.absoluteFillObject：当前 RN 的 TS 类型里没有该属性。
const FILL_ABSOLUTE = {
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
} as const;

// 样式由主题派生：所有颜色都来自 theme，组件内不再硬编码浅色/深色色值
const createStyles = (theme: Theme) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.background,
  },
  // KeyboardAvoidingView 专用：刻意不设背景，
  // 否则它会在背景光晕层之上再铺一层不透明底，把光晕全部盖掉。
  keyboardArea: {
    flex: 1,
  },
  // ---- 聊天背景（深色模式）：深黑蓝基底 + 柔和渐变 + 两处低亮度环境光晕 ----
  // 静态层，无动画、无粒子。光晕用超大尺寸 + 多段透明度衰减的 radial-gradient 实现
  // 自然模糊的过渡，刻意避免出现"明显的圆形光斑"。
  chatBase: {
    ...FILL_ABSOLUTE,
    // 不用纯黑：保留深灰蓝，并让纵向明暗层次拉开一点
    experimental_backgroundImage:
      'linear-gradient(180deg, #0e1119 0%, #0a0c11 45%, #070810 100%)',
  },
  chatGlowCool: {
    ...FILL_ABSOLUTE,
    // 左上冷蓝环境光
    experimental_backgroundImage:
      'radial-gradient(ellipse 95% 60% at 18% 0%, rgba(62,94,156,0.30) 0%, rgba(62,94,156,0.12) 45%, rgba(62,94,156,0) 75%)',
  },
  chatGlowWarm: {
    ...FILL_ABSOLUTE,
    // 右下紫调余晖，比冷光更弱一些，避免抢主体
    experimental_backgroundImage:
      'radial-gradient(ellipse 85% 55% at 88% 100%, rgba(80,68,128,0.22) 0%, rgba(80,68,128,0.10) 48%, rgba(80,68,128,0) 78%)',
  },
  // ---- 记忆库 ----
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
