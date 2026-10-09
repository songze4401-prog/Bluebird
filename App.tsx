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
  ActivityIndicator,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { Message } from './lib/types';
import { API_TOKEN } from './lib/constants';
import { makeLocalId, readJsonResponse } from './lib/utils';

import { ChatInput } from './components/ChatInput';
import { ChatHeader } from './components/ChatHeader';
import { ChatBubble } from './components/ChatBubble';
import { MessageList } from './components/MessageList';

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

// 长期记忆条目（与服务端 memory.json 的结构一致，无 id 字段）
type MemoryItem = {
  content: string;
  type?: string;
  keywords?: string[];
  confidence?: number;
  sourceQuote?: string;
  createdAt?: string;
  updatedAt?: string;
};

// 记忆库单条定位键：与后端删除接口的 createdAt + content 保持一致
function memoryKey(item: MemoryItem): string {
  return `${item.createdAt || ''}::${item.content}`;
}

function formatMemoryTime(iso?: string): string {
  if (!iso) return '';

  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) return '';

  const pad = (value: number) => String(value).padStart(2, '0');

  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    ` ${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

// 记忆类型 -> 中文徽章（仅展示，不参与任何逻辑）
const MEMORY_TYPE_LABELS: Record<string, string> = {
  identity: '身份',
  preference: '偏好',
  fact: '事实',
  goal: '目标',
  relationship: '关系',
};

// 记忆摘要：只做展示，由已有记忆就地归并生成（不调接口、不改写任何记忆数据）。
// 优先展示"核心"类别，最多取前几条，避免摘要变成第二个完整列表。
const SUMMARY_TYPE_ORDER = ['identity', 'relationship', 'goal', 'preference', 'fact'];
const MEMORY_SUMMARY_MAX = 6;

function buildMemorySummary(items: MemoryItem[]): string {
  if (!items.length) return '';

  const rank = (type?: string) => {
    const index = SUMMARY_TYPE_ORDER.indexOf(type || '');
    return index < 0 ? SUMMARY_TYPE_ORDER.length : index;
  };

  // 注意：先 slice() 拷贝再排序，绝不改动传入的 memories 原始顺序
  const merged = items
    .slice()
    .sort((a, b) => rank(a.type) - rank(b.type))
    .slice(0, MEMORY_SUMMARY_MAX)
    .map(item => item.content.trim().replace(/[。，,.\s]+$/, ''))
    .filter(Boolean)
    .join('，');

  return merged ? `${merged}。` : '';
}

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
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [loadingMemories, setLoadingMemories] = useState(false);
  const [memoryError, setMemoryError] = useState('');
  const [deletingMemoryKey, setDeletingMemoryKey] = useState<string | null>(
    null
  );

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
  const fetchMemories = async () => {
    setLoadingMemories(true);
    setMemoryError('');

    try {
      const response = await fetch(
        `${process.env.EXPO_PUBLIC_API_URL}/memory`,
        {
          headers: {
            Authorization: `Bearer ${API_TOKEN}`,
          },
        }
      );

      const data = await readJsonResponse(response);

      if (!response.ok) {
        throw new Error(data.error || '读取失败');
      }

      setMemories(Array.isArray(data.memories) ? data.memories : []);
    } catch (error) {
      console.error('Load memories error:', error);
      setMemoryError('读取长期记忆失败，请稍后再试。');
    } finally {
      setLoadingMemories(false);
    }
  };

  const openMemoryLibrary = () => {
    setMenuOpen(false);
    setMemoryOpen(true);
    fetchMemories();
  };

  const deleteOneMemory = (item: MemoryItem) => {
    Alert.alert('删除这条记忆？', item.content, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: async () => {
          const key = memoryKey(item);

          setDeletingMemoryKey(key);

          try {
            const response = await fetch(
              `${process.env.EXPO_PUBLIC_API_URL}/memory/delete`,
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${API_TOKEN}`,
                },
                body: JSON.stringify({
                  createdAt: item.createdAt,
                  content: item.content,
                }),
              }
            );

            const data = await readJsonResponse(response);

            if (!response.ok) {
              throw new Error(data.error || '删除失败');
            }

            // 后端确认删除成功后才更新 UI，不做乐观更新
            setMemories(prev =>
              prev.filter(entry => memoryKey(entry) !== key)
            );
          } catch (error) {
            console.error('Delete memory error:', error);
            Alert.alert('失败', '删除这条记忆失败，请稍后再试。');
          } finally {
            setDeletingMemoryKey(null);
          }
        },
      },
    ]);
  };

  const clearAllMemories = () => {
    Alert.alert(
      '清空全部记忆',
      '确定要清空所有长期记忆吗？\n这不会删除聊天记录。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '清空',
          style: 'destructive',
          onPress: async () => {
            try {
              const response = await fetch(
                `${process.env.EXPO_PUBLIC_API_URL}/memory/clear`,
                {
                  method: 'POST',
                  headers: {
                    Authorization: `Bearer ${API_TOKEN}`,
                  },
                }
              );

              const data = await readJsonResponse(response);

              if (!response.ok) {
                throw new Error(data.error || '清空失败');
              }

              setMemories([]);
              Alert.alert('完成', '长期记忆已经清空。');
            } catch (error) {
              console.error('Clear memories error:', error);
              Alert.alert('失败', '清空长期记忆失败，请稍后再试。');
            }
          },
        },
      ]
    );
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

      <Modal
        visible={memoryOpen}
        animationType="slide"
        onRequestClose={() => setMemoryOpen(false)}
      >
        <SafeAreaView style={styles.memoryContainer}>
          <View style={styles.memoryHeader}>
            <TouchableOpacity
              style={styles.memoryBack}
              onPress={() => setMemoryOpen(false)}
            >
              <Text style={[styles.memoryBackText, { color: theme.accent }]}>
                ‹ 返回
              </Text>
            </TouchableOpacity>

            <Text style={styles.memoryTitle}>记忆库</Text>

            <TouchableOpacity
              style={styles.memoryRefresh}
              onPress={fetchMemories}
              disabled={loadingMemories}
              activeOpacity={0.6}
              accessibilityLabel="刷新记忆库"
            >
              <Text
                style={[styles.memoryRefreshText, { color: theme.accent }]}
              >
                {loadingMemories ? '···' : '↻'}
              </Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.memoryCaption}>
            共 {memories.length} 条 · 这里是 Bluebird 长期保存的信息，与聊天记录相互独立
          </Text>

          {!loadingMemories && !memoryError && memories.length > 0 && (
            <View style={styles.summaryCard}>
              <Text style={styles.summaryTitle}>记忆摘要</Text>

              <Text style={styles.summaryText}>
                {buildMemorySummary(memories)}
              </Text>

              <Text style={styles.summaryNote}>
                由已有 {memories.length} 条记忆归并生成，仅作概览，原始记忆见下方
              </Text>
            </View>
          )}

          {loadingMemories ? (
            <View style={styles.memoryCenter}>
              <ActivityIndicator color={theme.accent} />
              <Text style={styles.memoryHint}>正在读取…</Text>
            </View>
          ) : memoryError ? (
            <View style={styles.memoryCenter}>
              <Text style={styles.memoryErrorText}>{memoryError}</Text>

              <TouchableOpacity
                style={styles.memoryRetry}
                onPress={fetchMemories}
              >
                <Text style={[styles.memoryRetryText, { color: theme.accent }]}>
                  重试
                </Text>
              </TouchableOpacity>
            </View>
          ) : memories.length === 0 ? (
            <View style={styles.memoryCenter}>
              <Text style={styles.memoryEmptyTitle}>目前还没有长期记忆</Text>

              <Text style={styles.memoryHint}>
                Bluebird 会在聊天过程中自动记住一些重要的信息。
              </Text>
            </View>
          ) : (
            <FlatList
              data={memories}
              keyExtractor={item => memoryKey(item)}
              contentContainerStyle={styles.memoryList}
              renderItem={({ item }) => {
                const key = memoryKey(item);
                const typeLabel = item.type
                  ? MEMORY_TYPE_LABELS[item.type]
                  : '';
                const deleting = deletingMemoryKey === key;

                return (
                  <View style={styles.memoryCard}>
                    <View style={styles.memoryCardTop}>
                      <Text style={styles.memoryContent}>{item.content}</Text>

                      {!!typeLabel && (
                        <View
                          style={[
                            styles.memoryBadge,
                            { borderColor: theme.accentBorder },
                          ]}
                        >
                          <Text
                            style={[
                              styles.memoryBadgeText,
                              { color: theme.accent },
                            ]}
                          >
                            {typeLabel}
                          </Text>
                        </View>
                      )}
                    </View>

                    {!!item.sourceQuote && (
                      <Text style={styles.memorySource}>
                        “{item.sourceQuote}”
                      </Text>
                    )}

                    <View style={styles.memoryCardBottom}>
                      <Text style={styles.memoryTime}>
                        {formatMemoryTime(item.createdAt)}
                      </Text>

                      <TouchableOpacity
                        style={styles.memoryDelete}
                        onPress={() => deleteOneMemory(item)}
                        disabled={deleting}
                      >
                        <Text style={styles.memoryDeleteText}>
                          {deleting ? '删除中…' : '删除'}
                        </Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                );
              }}
            />
          )}

          {!loadingMemories && !memoryError && memories.length > 0 && (
            <TouchableOpacity
              style={styles.memoryClearAll}
              onPress={clearAllMemories}
            >
              <Text style={styles.memoryClearAllText}>清空全部记忆</Text>
            </TouchableOpacity>
          )}
        </SafeAreaView>
      </Modal>

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
  // 记忆库右上角刷新按钮：复用同一套强调色，适配浅色/深色
  memoryRefresh: {
    minWidth: 64,
    paddingVertical: 6,
    alignItems: 'flex-end',
  },
  memoryRefreshText: {
    fontSize: 19,
    lineHeight: 23,
    fontWeight: '700',
  },
  memoryCaption: {
    color: theme.textSecondary,
    fontSize: 13,
    lineHeight: 19,
    paddingHorizontal: 20,
    paddingTop: 14,
    paddingBottom: 6,
  },
  // ---- 记忆摘要（仅展示，不替代原始记忆；随 memories 更新自动刷新） ----
  summaryCard: {
    marginHorizontal: 16,
    marginTop: 10,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    backgroundColor: theme.surface,
    borderColor: theme.borderStrong,
  },
  summaryTitle: {
    color: theme.accent,
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 8,
  },
  summaryText: {
    color: theme.textBody,
    fontSize: 15,
    lineHeight: 22,
  },
  summaryNote: {
    color: theme.textMuted,
    fontSize: 11,
    lineHeight: 16,
    marginTop: 9,
  },
  memoryCenter: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  memoryEmptyTitle: {
    color: theme.textPrimary,
    fontSize: 17,
    fontWeight: '600',
    marginBottom: 8,
  },
  memoryHint: {
    color: theme.textSecondary,
    fontSize: 14,
    lineHeight: 21,
    textAlign: 'center',
    marginTop: 8,
  },
  memoryErrorText: {
    color: theme.danger,
    fontSize: 14,
    lineHeight: 21,
    textAlign: 'center',
    marginBottom: 14,
  },
  memoryRetry: {
    borderWidth: 1,
    borderColor: theme.borderStrong,
    borderRadius: 10,
    paddingHorizontal: 18,
    paddingVertical: 9,
  },
  memoryRetryText: {
    color: theme.accent,
    fontSize: 14,
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
  memoryCardTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  memoryContent: {
    flex: 1,
    color: theme.textBody,
    fontSize: 16,
    lineHeight: 23,
    marginRight: 10,
  },
  memoryBadge: {
    backgroundColor: theme.avatarBg,
    borderWidth: 1,
    borderColor: theme.accentBorder,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  memoryBadgeText: {
    color: theme.accent,
    fontSize: 12,
  },
  memorySource: {
    color: theme.textSecondary,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 8,
  },
  memoryCardBottom: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 12,
  },
  memoryTime: {
    color: theme.textMuted,
    fontSize: 12,
    fontVariant: ['tabular-nums'],
  },
  memoryDelete: {
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  memoryDeleteText: {
    color: theme.danger,
    fontSize: 14,
  },
  memoryClearAll: {
    marginHorizontal: 16,
    marginBottom: 16,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.dangerBorder,
    alignItems: 'center',
  },
  memoryClearAllText: {
    color: theme.danger,
    fontSize: 15,
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
