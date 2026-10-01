import React, { useEffect, useState } from 'react';
import {
  SafeAreaView,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';

type Message = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
};

export default function App() {
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);

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
        content: '这里是属于云岫的地方。想说什么就说吧。',
      },
    ];

    const loadHistory = async () => {
      try {
        const response = await fetch(
          `${process.env.EXPO_PUBLIC_API_URL}/history?limit=200`
        );

        const data = await response.json();

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

  const sendMessage = async () => {
    const text = input.trim();

    if (!text) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: text,
    };

    setMessages(prev => [...prev, userMessage]);
    setInput('');

    try {
      const response = await fetch(
        `${process.env.EXPO_PUBLIC_API_URL}/chat`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            message: text,
            history: messages.slice(-20).map(item => ({
              role: item.role,
              content: item.content,
            })),
          }),
        }
      );

      const data = await response.json();

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

      setMessages(prev => [
        ...prev,
        {
          id: `${Date.now()}-error`,
          role: 'assistant',
          content: '连接云岫失败了，再试一次。',
        },
      ]);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>云岫</Text>
            <Text style={styles.status}>● 在线</Text>
          </View>
          <Text style={styles.version}>V0.1</Text>
        </View>

        <FlatList
          data={messages}
          keyExtractor={item => item.id}
          contentContainerStyle={styles.messages}
          renderItem={({ item }) => (
            <View
              style={[
                styles.messageRow,
                item.role === 'user' && styles.userRow,
              ]}
            >
              {item.role === 'assistant' && (
                <View style={styles.avatar}>
                  <Text style={styles.avatarText}>岫</Text>
                </View>
              )}

              <View
                style={[
                  styles.bubble,
                  item.role === 'user'
                    ? styles.userBubble
                    : styles.yunxiuBubble,
                ]}
              >
                <Text style={styles.messageText}>{item.content}</Text>
              </View>
            </View>
          )}
        />

        <View style={styles.inputArea}>
          <TextInput
            value={input}
            onChangeText={setInput}
            placeholder="与云岫说些什么……"
            placeholderTextColor="#777"
            style={styles.input}
            multiline
          />

          <TouchableOpacity style={styles.sendButton} onPress={sendMessage}>
            <Text style={styles.sendText}>发送</Text>
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
  messages: {
    padding: 16,
    paddingBottom: 24,
  },
  messageRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    marginBottom: 16,
  },
  userRow: {
    justifyContent: 'flex-end',
  },
  avatar: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: '#202735',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 9,
  },
  avatarText: {
    color: '#d9c7a1',
    fontSize: 17,
    fontWeight: '700',
  },
  bubble: {
    maxWidth: '78%',
    paddingHorizontal: 15,
    paddingVertical: 11,
    borderRadius: 16,
  },
  yunxiuBubble: {
    backgroundColor: '#171b24',
    borderBottomLeftRadius: 4,
  },
  userBubble: {
    backgroundColor: '#303846',
    borderBottomRightRadius: 4,
  },
  messageText: {
    color: '#eeeeee',
    fontSize: 16,
    lineHeight: 24,
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
});
