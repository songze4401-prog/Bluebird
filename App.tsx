import React, { useEffect, useMemo, useState } from 'react';
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
  MODE_OPTIONS,
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

function SharedTime({
  theme,
  styles,
}: {
  theme: Theme;
  styles: ReturnType<typeof createStyles>;
}) {
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

// 距底部小于该距离视为"已在底部"：
// 决定「新消息是否自动跟随」以及「返回底部按钮是否显示」，两者互补不留死区
const AT_BOTTOM_DISTANCE = 80;

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
  styles,
}: {
  size?: number;
  theme: Theme;
  styles: ReturnType<typeof createStyles>;
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
  const flatListRef = React.useRef<FlatList<Message>>(null);
  const isAtBottomRef = React.useRef(true);
  const hasInitialScrolledRef = React.useRef(false);
  const previousMessageCountRef = React.useRef(0);
  const pendingInitialScrollRef = React.useRef(false);

  // 「返回底部」悬浮按钮：仅在用户向上翻看历史时出现
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

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

  // 「返回底部」：平滑滚到底部，并立即隐藏按钮（后续 onScroll 会复核）
  const scrollToBottom = () => {
    isAtBottomRef.current = true;
    setShowScrollToBottom(false);

    flatListRef.current?.scrollToEnd({ animated: true });
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
            <View style={styles.headerTitle}>
              <Text style={styles.title} numberOfLines={1}>
                Bluebird
              </Text>
              <Text style={styles.status}>● 在线</Text>
            </View>
          </View>

          <View style={styles.headerRight}>
            <SharedTime theme={theme} styles={styles} />

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

            {MODE_OPTIONS.map(option => {
              const active = theme.mode === option.id;

              return (
                <TouchableOpacity
                  key={option.id}
                  style={styles.menuItem}
                  onPress={() => selectMode(option.id)}
                >
                  <Text
                    style={[
                      styles.menuItemText,
                      active && { color: theme.accent },
                    ]}
                  >
                    {option.emoji} {option.label}
                    {active ? '  ✓' : ''}
                  </Text>
                </TouchableOpacity>
              );
            })}

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

            <View style={styles.menuVersion}>
              <Text style={styles.version}>V0.3</Text>
            </View>
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

            const atBottom = distanceFromBottom < AT_BOTTOM_DISTANCE;

            // 自动跟随的判断依据（ref，不触发渲染）
            isAtBottomRef.current = atBottom;

            // 按钮显隐与自动跟随互补：离开底部才显示。
            // 仅状态真正变化时才 setState，避免滚动过程中频繁渲染。
            const shouldShow = !atBottom;
            setShowScrollToBottom(prev =>
              prev === shouldShow ? prev : shouldShow
            );
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

            // 只有"最新一条且是 Bluebird 正常回复"时才显示续写按钮
            const showContinue =
              index === messages.length - 1 &&
              item.role === 'assistant' &&
              !item.retryText &&
              !sending;

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
                      <Text style={[styles.messageText, styles.userMessageText]}>
                        {item.content}
                      </Text>
                    </TouchableOpacity>
                  ) : (
                    // 气泡与「继续说」包在同一列里：列宽 = 气泡宽，按钮靠右即贴住气泡右边缘
                    <View style={styles.assistantColumn}>
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

                      {showContinue && (
                        <View style={styles.continueRow}>
                          <TouchableOpacity
                            style={[
                              styles.continueButton,
                              { borderColor: theme.accentBorder },
                            ]}
                            onPress={sendContinuation}
                            disabled={continuing}
                            activeOpacity={0.6}
                          >
                            <Text
                              style={[
                                styles.continueText,
                                {
                                  color: continuing
                                    ? theme.accentBorder
                                    : theme.accent,
                                },
                              ]}
                            >
                              {continuing ? '···' : '→'}
                            </Text>
                          </TouchableOpacity>
                        </View>
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
                <BlueAvatar theme={theme} styles={styles} />
                <View style={styles.typingBubble}>
                  <Text style={styles.typingText}>Bluebird 正在输入…</Text>
                </View>
              </View>
            ) : null
          }
        />

        {showScrollToBottom && (
          <TouchableOpacity
            style={[
              styles.scrollToBottom,
              {
                backgroundColor: theme.surface,
                borderColor: theme.borderStrong,
              },
            ]}
            onPress={scrollToBottom}
            activeOpacity={0.75}
            accessibilityLabel="返回底部"
          >
            <Text style={[styles.scrollToBottomIcon, { color: theme.accent }]}>
              ↓
            </Text>
          </TouchableOpacity>
        )}

        {/* 悬浮输入栏 dock：留在正常流里，键盘弹起时仍会被 KeyboardAvoidingView 顶上去 */}
        <View style={styles.inputDock}>
          <View style={styles.inputArea}>
            {/* 整条输入栏是一个大胶囊，左头像 / 中间输入 / 右按钮全包在里面 */}
            <View style={styles.inputCapsule}>
              {/* 左侧圆形头像：直接复用聊天界面里的 BlueAvatar（同一个 B 头像） */}
              <BlueAvatar size={48} theme={theme} styles={styles} />

              <TextInput
                value={input}
                onChangeText={setInput}
                placeholder="发消息..."
                placeholderTextColor={theme.textMuted}
                cursorColor={theme.accent}
                selectionColor={theme.accentBorder}
                style={styles.input}
                multiline
              />

              {input.trim().length > 0 ? (
                // 有输入内容：右侧变为发送按钮（向上箭头，不显示文字）
                <TouchableOpacity
                  style={[
                    styles.sendButton,
                    sending && styles.sendButtonDisabled,
                    { backgroundColor: theme.sendButton },
                  ]}
                  onPress={() => sendMessage()}
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

// 样式由主题派生：所有颜色都来自 theme，组件内不再硬编码浅色/深色色值
const createStyles = (theme: Theme) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.background,
  },
  header: {
    height: 72,
    paddingHorizontal: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
  },
  title: {
    color: theme.textPrimary,
    fontSize: 24,
    fontWeight: '700',
  },
  status: {
    color: theme.online,
    fontSize: 12,
    marginTop: 3,
  },
  version: {
    color: theme.textMuted,
    fontSize: 12,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 0,
  },

  sharedTime: {
    alignItems: 'flex-end',
    marginRight: 12,
  },

  sharedTimeClock: {
    color: theme.accent,
    fontSize: 15,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },

  sharedTimeDate: {
    color: theme.textMuted,
    fontSize: 10,
    marginTop: 2,
  },

  sharedTimeCaption: {
    color: theme.textMuted,
    fontSize: 9,
    marginTop: 2,
    opacity: 0.75,
  },

  menuButton: {
    marginLeft: 14,
    padding: 6,
  },

  menuIcon: {
    color: theme.textPrimary,
    fontSize: 22,
  },

  menu: {
    position: 'absolute',
    top: 62,
    right: 16,
    zIndex: 100,
    width: 160,
    backgroundColor: theme.surface,
    borderRadius: 12,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: theme.borderStrong,
  },

  menuItem: {
    paddingHorizontal: 16,
    paddingVertical: 13,
  },

  menuItemText: {
    color: theme.textPrimary,
    fontSize: 15,
  },

  menuVersion: {
    alignItems: 'center',
    marginTop: 4,
    paddingTop: 9,
    paddingBottom: 5,
    borderTopWidth: 1,
    borderTopColor: theme.border,
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

  // ---- 「继续说」按钮 ----
  continueRow: {
    flexDirection: 'row',
    // 撑满整列（列宽 = 气泡宽），内容靠右 → 按钮右边缘贴住气泡右边缘
    alignSelf: 'stretch',
    justifyContent: 'flex-end',
    // 与气泡下方留出间距（进同一列后原来的 -2 会压住气泡）
    marginTop: 6,
    marginBottom: 10,
  },
  continueButton: {
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 9,
    borderWidth: 1,
  },
  continueText: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1,
  },
  messages: {
    padding: 16,
    // 让最后一条消息能滚出悬浮胶囊之外：胶囊高度 56 + 底部间距 8 + 余量 16
    paddingBottom: 80,
  },
  messageTime: {
    alignSelf: 'center',
    color: theme.textMuted,
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
    flexShrink: 1,
  },

  headerTitle: {
    flexShrink: 1,
  },

  headerMood: {
    fontSize: 26,
    marginRight: 10,
  },

  avatar: {
    backgroundColor: theme.avatarBg,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 8,
    borderWidth: 1,
    borderColor: theme.accentBorder,
  },
  avatarText: {
    color: theme.accent,
    fontWeight: '700',
  },
  bubble: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 18,
  },
  // 对方消息：气泡与「继续说」同一列，列宽由气泡决定
  assistantColumn: {
    // 相对 messageRow（宽度确定），限制整列不超过 85%
    maxWidth: '85%',
    // 让气泡按内容收缩，而不是被拉伸到整列宽度
    alignItems: 'flex-start',
  },
  bluebirdBubble: {
    backgroundColor: theme.bubbleIncoming,
    borderWidth: 1,
    borderColor: theme.bubbleIncomingBorder,
    borderBottomLeftRadius: 6,
  },
  userBubble: {
    // 78% 从共享的 bubble 挪到这里：用户气泡父级是 messageRow（宽度确定），百分比有效
    maxWidth: '78%',
    backgroundColor: theme.bubble,
    borderBottomRightRadius: 6,
  },
  messageText: {
    color: theme.textBody,
    fontSize: 16,
    lineHeight: 23,
  },
  // 用户气泡是饱和底色，需要铺在其上的浅色文字
  userMessageText: {
    color: theme.textOnAccent,
  },
  // ---- 输入栏：整条大胶囊 + 左头像 + 右「＋」（参考图配色，写死色值） ----
  inputDock: {
    height: 80,
    // 上移 80 叠在消息列表底部之上：列表照旧铺满，胶囊浮在消息上面
    marginTop: -80,
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
  // ---- 「返回底部」悬浮按钮 ----
  scrollToBottom: {
    position: 'absolute',
    right: 16,
    // 输入区高度约 71，这里让按钮浮在它正上方，不遮挡输入框
    bottom: 84,
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    elevation: 3,
    zIndex: 50,
  },
  scrollToBottomIcon: {
    fontSize: 20,
    lineHeight: 24,
    fontWeight: '700',
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
    backgroundColor: theme.bubbleIncoming,
    borderWidth: 1,
    borderColor: theme.bubbleIncomingBorder,
  },
  typingText: {
    color: theme.textMuted,
    fontSize: 14,
  },
  retryButton: {
    marginTop: 9,
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: theme.bubble,
  },
  retryText: {
    color: theme.textOnAccent,
    fontSize: 13,
  },
});
