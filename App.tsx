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
  Platform,
  Alert,
} from 'react-native';

type Message = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  retryText?: string;
};

async function readJsonResponse(response: Response) {
  const contentType = response.headers.get('content-type') || '';

  if (!contentType.toLowerCase().includes('application/json')) {
    throw new Error('服务器连接失败');
  }

  return response.json();
}

const API_TOKEN = process.env.EXPO_PUBLIC_BLUEBIRD_API_TOKEN;

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

function SharedTime() {
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
      <Text style={styles.sharedTimeClock}>{timeText}</Text>
      <Text style={styles.sharedTimeDate}>{dateText}</Text>
      <Text style={styles.sharedTimeCaption}>我们现在都在这里</Text>
    </View>
  );
}

function BlueAvatar({ size = 38 }: { size?: number }) {
  return (
    <View
      style={[
        styles.avatar,
        { width: size, height: size, borderRadius: size / 2 },
      ]}
    >
      <Text style={[styles.avatarText, { fontSize: size * 0.45 }]}>B</Text>
    </View>
  );
}

export default function App() {
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [sending, setSending] = useState(false);
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
                role: 'user' | 'assistant';
                content: string;
                createdAt?: string;
              },
              index: number
            ) => ({
              id: `${item.createdAt || 'history'}-${index}`,
              role: item.role,
              content: item.content,
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

  const clearMemory = async () => {
    Alert.alert(
      '清理长期记忆',
      '确定要清空 Bluebird 对你的长期记忆吗？',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '清理',
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
                throw new Error(data.error || '清理失败');
              }

              setMenuOpen(false);
              Alert.alert('完成', 'Bluebird 的长期记忆已经清空。');
            } catch (error) {
              console.error('Clear memory error:', error);
              Alert.alert('失败', '清理长期记忆失败，请稍后再试。');
            }
          },
        },
      ]
    );
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

  const sendMessage = async (retryText?: string) => {
    const text = (retryText ?? input).trim();

    if (!text || sending) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: text,
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

      setMessages(prev => [
        ...prev,
        {
          id: `${Date.now()}-ai`,
          role: 'assistant',
          content: data.reply,
        },
      ]);
    } catch (error) {
      console.error(error);

      const errorMessage =
        error instanceof Error && error.name === 'AbortError'
          ? '连接Bluebird超时了，再试一次。'
          : '连接Bluebird失败了，再试一次。';

      setMessages(prev => [
        ...prev,
        {
          id: `error-${Date.now()}`,
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
            <BlueAvatar size={30} />
            <View>
              <Text style={styles.title}>Bluebird</Text>
              <Text style={styles.status}>● 在线</Text>
            </View>
          </View>

          <View style={styles.headerRight}>
            <SharedTime />
            <Text style={styles.version}>V0.2</Text>

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
              onPress={clearMemory}
            >
              <Text style={styles.menuItemText}>清理长期记忆</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.menuItem}
              onPress={clearChatHistory}
            >
              <Text style={styles.menuItemText}>清理聊天记录</Text>
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
          renderItem={({ item }) => (
            <View
              style={[
                styles.messageRow,
                item.role === 'user' && styles.userRow,
              ]}
            >
              {item.role === 'assistant' && <BlueAvatar />}

              <View
                style={[
                  styles.bubble,
                  item.role === 'user'
                    ? styles.userBubble
                    : styles.bluebirdBubble,
                ]}
              >
                <Text style={styles.messageText}>{item.content}</Text>

                {item.role === 'assistant' && !!item.retryText && (
                  <TouchableOpacity
                    style={styles.retryButton}
                    onPress={() => sendMessage(item.retryText)}
                    disabled={sending}
                  >
                    <Text style={styles.retryText}>重新发送</Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>
          )}
          ListFooterComponent={
            sending ? (
              <View style={styles.typingRow}>
                <BlueAvatar />
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
            style={[styles.sendButton, sending && styles.sendButtonDisabled]}
            onPress={() => sendMessage()}
            disabled={sending}
          >
            <Text style={styles.sendText}>{sending ? '发送中' : '发送'}</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
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
  messages: {
    padding: 16,
    paddingBottom: 24,
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
