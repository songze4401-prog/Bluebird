import React, { useEffect, useState } from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  KeyboardAvoidingView,
  Alert,
  Modal,
  ActivityIndicator,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  THEMES,
  getTheme,
  isThemeId,
  DEFAULT_THEME_ID,
  THEME_STORAGE_KEY,
  type Theme,
  type ThemeId,
} from './theme';

// 本地临时消息的 id（服务端返回稳定 id 后会被替换）
function makeLocalId(): string {
  return Date.now().toString();
}

type Message = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt?: string; // ISO 时间，后端返回；前端发送时自己打
  retryText?: string;
  mood?: string;
};

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

async function readJsonResponse(response: Response) {
  const contentType = response.headers.get('content-type') || '';

  if (!contentType.toLowerCase().includes('application/json')) {
    throw new Error('服务器连接失败');
  }

  return response.json();
}

const API_TOKEN = process.env.EXPO_PUBLIC_BLUEBIRD_API_TOKEN;

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

// 记忆类型 -> 中文徽章（仅展示，不参与任何逻辑）
const MEMORY_TYPE_LABELS: Record<string, string> = {
  identity: '身份',
  preference: '偏好',
  fact: '事实',
  goal: '目标',
  relationship: '关系',
};

function SharedTime({ theme }: { theme: Theme }) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined;

    // 对齐到下一分钟边界，之后每分钟刷新
    const timeout = setTimeout(
      () => {
        setNow(new Date());
        interval = setInterval(() => setNow(new Date()), 60000);
      },
      (60 - new Date().getSeconds()) * 1000
    );

    return () => {
      clearTimeout(timeout);
      if (interval) clearInterval(interval);
    };
  }, []);

  const timeText = `${String(now.getHours()).padStart(2, '0')}:${String(
    now.getMinutes()
  ).padStart(2, '0')}`;
  const dateText = `${now.getMonth() + 1}月${now.getDate()}日 周${
    WEEKDAYS[now.getDay()]
  }`;

  return (
    <View style={styles.sharedTime}>
      <Text style={[styles.sharedTimeClock, { color: theme.accent }]}>
        {timeText}
      </Text>
      <Text style={styles.sharedTimeDate}>{dateText}</Text>
      <Text style={styles.sharedTimeCaption}>我们现在都在这里</Text>
    </View>
  );
}

// 与 Emotion System V1 的 8 种情绪一一对应（全项目只有这一套情绪值域）
const MOOD_EMOJI: Record<string, string> = {
  calm: '😌',
  happy: '😊',
  playful: '😏',
  excited: '🤩',
  tired: '😴',
  sad: '😔',
  annoyed: '😒',
  hurt: '🥺',
};

function moodEmoji(mood?: string) {
  return MOOD_EMOJI[mood ?? 'calm'] ?? MOOD_EMOJI.calm;
}

// 微信式时间显示：间隔超过 5 分钟或跨天才显示一次时间标签
const MESSAGE_TIME_GAP_MS = 5 * 60 * 1000;

function formatMessageTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';

  const now = new Date();
  const hm = `${String(date.getHours()).padStart(2, '0')}:${String(
    date.getMinutes()
  ).padStart(2, '0')}`;

  const startOfDay = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = Math.round(
    (startOfDay(now) - startOfDay(date)) / 86400000
  );

  if (dayDiff <= 0) return hm; // 今天：只显示时间
  if (dayDiff === 1) return `昨天 ${hm}`;
  if (dayDiff < 7) return `周${WEEKDAYS[date.getDay()]} ${hm}`;
  if (date.getFullYear() === now.getFullYear()) {
    return `${date.getMonth() + 1}月${date.getDate()}日 ${hm}`;
  }
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${hm}`;
}

function shouldShowMessageTime(
  current: Message,
  previous?: Message
): boolean {
  if (!current.createdAt) return false;
  if (!previous) return true;
  if (!previous.createdAt) return true;

  const curr = new Date(current.createdAt).getTime();
  const prev = new Date(previous.createdAt).getTime();
  if (Number.isNaN(curr) || Number.isNaN(prev)) return false;

  if (curr - prev >= MESSAGE_TIME_GAP_MS) return true;

  // 间隔短但跨天：新的一天第一条仍显示
  const a = new Date(curr);
  const b = new Date(prev);
  return (
    a.getFullYear() !== b.getFullYear() ||
    a.getMonth() !== b.getMonth() ||
    a.getDate() !== b.getDate()
  );
}

function BlueAvatar({
  size = 38,
  theme,
}: {
  size?: number;
  theme: Theme;
}) {
  return (
    <View
      style={[
        styles.avatar,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          borderColor: theme.accentBorder,
        },
      ]}
    >
      <Text
        style={[
          styles.avatarText,
          { fontSize: size * 0.45, color: theme.accent },
        ]}
      >
        B
      </Text>
    </View>
  );
}

export default function App() {
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [mood, setMood] = useState('calm');

  // 主题色：纯前端本地偏好，不经过服务器、不写入 Memory
  const [themeId, setThemeId] = useState<ThemeId>(DEFAULT_THEME_ID);
  const [themePickerOpen, setThemePickerOpen] = useState(false);
  const theme = getTheme(themeId);

  // 记忆库
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [loadingMemories, setLoadingMemories] = useState(false);
  const [memoryError, setMemoryError] = useState('');
  const [deletingMemoryKey, setDeletingMemoryKey] = useState<string | null>(
    null
  );
  const flatListRef = React.useRef<FlatList<Message>>(null);
  const isAtBottomRef = React.useRef(true);
  const hasInitialScrolledRef = React.useRef(false);
  const previousMessageCountRef = React.useRef(0);
  const pendingInitialScrollRef = React.useRef(false);

  useEffect(() => {
    if (messages.length === 0) {
      previousMessageCountRef.current = 0;
      hasInitialScrolledRef.current = false;
      pendingInitialScrollRef.current = false;
      return;
    }

    if (!hasInitialScrolledRef.current) {
      pendingInitialScrollRef.current = true;
      previousMessageCountRef.current = messages.length;
      return;
    }

    if (
      messages.length > previousMessageCountRef.current &&
      isAtBottomRef.current
    ) {
      previousMessageCountRef.current = messages.length;

      requestAnimationFrame(() => {
        flatListRef.current?.scrollToEnd({ animated: true });
      });

      return;
    }

    previousMessageCountRef.current = messages.length;
  }, [messages.length, loadingHistory]);

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

  // 启动时读取本地保存的主题色；读不到就用默认（黑色）
  useEffect(() => {
    let cancelled = false;

    const loadTheme = async () => {
      try {
        const saved = await AsyncStorage.getItem(THEME_STORAGE_KEY);

        if (cancelled || !isThemeId(saved)) return;

        setThemeId(saved);
      } catch (error) {
        console.error('Load theme error:', error);
      }
    };

    loadTheme();

    return () => {
      cancelled = true;
    };
  }, []);

  // 切换主题：先立即生效（UI 不等 IO），再异步落盘
  const selectTheme = (next: ThemeId) => {
    setThemeId(next);

    AsyncStorage.setItem(THEME_STORAGE_KEY, next).catch(error => {
      console.error('Save theme error:', error);
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

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView
        style={styles.container}
        behavior="padding"
      >
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <Text style={styles.headerMood}>{moodEmoji(mood)}</Text>
            <View>
              <Text style={styles.title}>Bluebird</Text>
              <Text style={styles.status}>● 在线</Text>
            </View>
          </View>

          <View style={styles.headerRight}>
            <SharedTime theme={theme} />
            <Text style={styles.version}>V0.3</Text>

            <TouchableOpacity
              style={styles.menuButton}
              onPress={() => setMenuOpen(prev => !prev)}
            >
              <Text style={styles.menuIcon}>☰</Text>
            </TouchableOpacity>
          </View>
        </View>

        {menuOpen && (
          <View style={styles.menu}>
            <TouchableOpacity
              style={styles.menuItem}
              onPress={openMemoryLibrary}
            >
              <Text style={styles.menuItemText}>🧠 记忆库</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.menuItem}
              onPress={openThemePicker}
            >
              <Text style={styles.menuItemText}>🎨 主题色</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.menuItem}
              onPress={clearChatHistory}
            >
              <Text style={styles.menuItemText}>🗑️ 清理聊天记录</Text>
            </TouchableOpacity>
          </View>
        )}

        <FlatList
          ref={flatListRef}
          data={messages}
          keyExtractor={item => item.id}
          onScroll={event => {
            const { contentOffset, contentSize, layoutMeasurement } =
              event.nativeEvent;

            const distanceFromBottom =
              contentSize.height -
              (contentOffset.y + layoutMeasurement.height);

            isAtBottomRef.current = distanceFromBottom < 80;
          }}
          scrollEventThrottle={100}
          onContentSizeChange={() => {
            if (pendingInitialScrollRef.current && messages.length > 0) {
              pendingInitialScrollRef.current = false;
              hasInitialScrolledRef.current = true;

              requestAnimationFrame(() => {
                flatListRef.current?.scrollToEnd({ animated: false });
              });
            }
          }}
          contentContainerStyle={styles.messages}
          renderItem={({ item, index }) => {
            const previous = messages[index - 1];
            const showTime = shouldShowMessageTime(item, previous);

            return (
              <View>
                {showTime && item.createdAt && (
                  <Text style={styles.messageTime}>
                    {formatMessageTime(item.createdAt)}
                  </Text>
                )}

                <View
                  style={[
                    styles.messageRow,
                    item.role === 'user' && styles.userRow,
                  ]}
                >
                  {item.role === 'assistant' && <BlueAvatar theme={theme} />}

                  {item.role === 'user' ? (
                    <TouchableOpacity
                      style={[
                        styles.bubble,
                        styles.userBubble,
                        { backgroundColor: theme.bubble },
                      ]}
                      activeOpacity={0.75}
                      onLongPress={() => recallMessage(item)}
                    >
                      <Text style={styles.messageText}>{item.content}</Text>
                    </TouchableOpacity>
                  ) : (
                    <View style={[styles.bubble, styles.bluebirdBubble]}>
                      <Text style={styles.messageText}>{item.content}</Text>

                      {!!item.retryText && (
                        <TouchableOpacity
                          style={[
                            styles.retryButton,
                            { backgroundColor: theme.bubble },
                          ]}
                          onPress={() => sendMessage(item.retryText)}
                          disabled={sending}
                        >
                          <Text style={styles.retryText}>重新发送</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  )}
                </View>
              </View>
            );
          }}
          ListFooterComponent={
            sending ? (
              <View style={styles.typingRow}>
                <BlueAvatar theme={theme} />
                <View style={styles.typingBubble}>
                  <Text style={styles.typingText}>Bluebird 正在输入…</Text>
                </View>
              </View>
            ) : null
          }
        />

        <View style={styles.inputArea}>
          <TextInput
            value={input}
            onChangeText={setInput}
            placeholder="与Bluebird说些什么……"
            placeholderTextColor="#777"
            style={styles.input}
            multiline
          />

          <TouchableOpacity
            style={[
              styles.sendButton,
              sending && styles.sendButtonDisabled,
              { backgroundColor: theme.sendButton },
            ]}
            onPress={() => sendMessage()}
            disabled={sending}
          >
            <Text style={styles.sendText}>{sending ? '发送中' : '发送'}</Text>
          </TouchableOpacity>
        </View>
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

            <View style={styles.memoryHeaderSpacer} />
          </View>

          <Text style={styles.memoryCaption}>
            共 {memories.length} 条 · 这里是 Bluebird 长期保存的信息，与聊天记录相互独立
          </Text>

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
              const selected = item.id === theme.id;

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
                        { backgroundColor: item.sendButton },
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

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0b0d12',
  },
  header: {
    height: 72,
    paddingHorizontal: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: '#20242d',
  },
  title: {
    color: '#f0f0f0',
    fontSize: 24,
    fontWeight: '700',
  },
  status: {
    color: '#7fd18b',
    fontSize: 12,
    marginTop: 3,
  },
  version: {
    color: '#777',
    fontSize: 12,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
  },

  sharedTime: {
    alignItems: 'flex-end',
    marginRight: 12,
    paddingLeft: 12,
    borderLeftWidth: 1,
    borderLeftColor: '#20242d',
  },

  sharedTimeClock: {
    color: '#d9c7a1',
    fontSize: 15,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },

  sharedTimeDate: {
    color: '#777',
    fontSize: 10,
    marginTop: 2,
  },

  sharedTimeCaption: {
    color: '#777',
    fontSize: 9,
    marginTop: 2,
    opacity: 0.75,
  },

  menuButton: {
    marginLeft: 14,
    padding: 6,
  },

  menuIcon: {
    color: '#ffffff',
    fontSize: 22,
  },

  menu: {
    position: 'absolute',
    top: 62,
    right: 16,
    zIndex: 100,
    width: 160,
    backgroundColor: '#181c25',
    borderRadius: 12,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: '#303642',
  },

  menuItem: {
    paddingHorizontal: 16,
    paddingVertical: 13,
  },

  menuItemText: {
    color: '#ffffff',
    fontSize: 15,
  },

  // ---- 记忆库 ----
  memoryContainer: {
    flex: 1,
    backgroundColor: '#0b0d12',
  },
  memoryHeader: {
    height: 72,
    paddingHorizontal: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: '#20242d',
  },
  memoryBack: {
    minWidth: 64,
    paddingVertical: 6,
  },
  memoryBackText: {
    color: '#d9c7a1',
    fontSize: 16,
  },
  memoryTitle: {
    color: '#f0f0f0',
    fontSize: 20,
    fontWeight: '700',
  },
  memoryHeaderSpacer: {
    minWidth: 64,
  },
  memoryCaption: {
    color: '#8b93a3',
    fontSize: 13,
    lineHeight: 19,
    paddingHorizontal: 20,
    paddingTop: 14,
    paddingBottom: 6,
  },
  memoryCenter: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  memoryEmptyTitle: {
    color: '#f0f0f0',
    fontSize: 17,
    fontWeight: '600',
    marginBottom: 8,
  },
  memoryHint: {
    color: '#8b93a3',
    fontSize: 14,
    lineHeight: 21,
    textAlign: 'center',
    marginTop: 8,
  },
  memoryErrorText: {
    color: '#e08a8a',
    fontSize: 14,
    lineHeight: 21,
    textAlign: 'center',
    marginBottom: 14,
  },
  memoryRetry: {
    borderWidth: 1,
    borderColor: '#303642',
    borderRadius: 10,
    paddingHorizontal: 18,
    paddingVertical: 9,
  },
  memoryRetryText: {
    color: '#d9c7a1',
    fontSize: 14,
  },
  memoryList: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 24,
  },
  memoryCard: {
    backgroundColor: '#181c25',
    borderWidth: 1,
    borderColor: '#303642',
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
    color: '#eeeeee',
    fontSize: 16,
    lineHeight: 23,
    marginRight: 10,
  },
  memoryBadge: {
    backgroundColor: '#202735',
    borderWidth: 1,
    borderColor: 'rgba(217,199,161,0.45)',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  memoryBadgeText: {
    color: '#d9c7a1',
    fontSize: 12,
  },
  memorySource: {
    color: '#8b93a3',
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
    color: '#777',
    fontSize: 12,
    fontVariant: ['tabular-nums'],
  },
  memoryDelete: {
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  memoryDeleteText: {
    color: '#e08a8a',
    fontSize: 14,
  },
  memoryClearAll: {
    marginHorizontal: 16,
    marginBottom: 16,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(224,138,138,0.5)',
    alignItems: 'center',
  },
  memoryClearAllText: {
    color: '#e08a8a',
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
    borderColor: '#303642',
  },
  themeLabel: {
    flex: 1,
    color: '#eeeeee',
    fontSize: 16,
  },
  themeCheck: {
    fontSize: 18,
    fontWeight: '700',
  },
  messages: {
    padding: 16,
    paddingBottom: 24,
  },
  messageTime: {
    alignSelf: 'center',
    color: '#777',
    fontSize: 12,
    marginBottom: 12,
    marginTop: 4,
    fontVariant: ['tabular-nums'],
  },
  messageRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    marginBottom: 12,
  },
  userRow: {
    justifyContent: 'flex-end',
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },

  headerMood: {
    fontSize: 26,
    marginRight: 10,
  },

  avatar: {
    backgroundColor: '#202735',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 8,
    borderWidth: 1,
    borderColor: 'rgba(217,199,161,0.45)',
  },
  avatarText: {
    color: '#d9c7a1',
    fontWeight: '700',
  },
  bubble: {
    maxWidth: '78%',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 18,
  },
  bluebirdBubble: {
    backgroundColor: '#161c28',
    borderWidth: 1,
    borderColor: '#232b3a',
    borderBottomLeftRadius: 6,
  },
  userBubble: {
    backgroundColor: '#2f3d55',
    borderBottomRightRadius: 6,
  },
  messageText: {
    color: '#eeeeee',
    fontSize: 16,
    lineHeight: 23,
  },
  inputArea: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: '#20242d',
    backgroundColor: '#0e1016',
  },
  input: {
    flex: 1,
    maxHeight: 110,
    minHeight: 46,
    backgroundColor: '#181c25',
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 11,
    color: '#ffffff',
    fontSize: 16,
    textAlignVertical: 'top',
  },
  sendButton: {
    height: 46,
    paddingHorizontal: 16,
    marginLeft: 8,
    borderRadius: 14,
    backgroundColor: '#303846',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '600',
  },
  sendButtonDisabled: {
    opacity: 0.55,
  },
  typingRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    marginBottom: 12,
  },
  typingBubble: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 18,
    borderBottomLeftRadius: 6,
    backgroundColor: '#161c28',
    borderWidth: 1,
    borderColor: '#232b3a',
  },
  typingText: {
    color: '#999999',
    fontSize: 14,
  },
  retryButton: {
    marginTop: 9,
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: '#2f3d55',
  },
  retryText: {
    color: '#ffffff',
    fontSize: 13,
  },
});
