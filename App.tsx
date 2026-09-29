import React, { useState } from 'react';
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
  role: 'yunxiu' | 'user';
  text: string;
};

export default function App() {
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Message[]>([
    {
      id: '1',
      role: 'yunxiu',
      text: '陛下，臣在。',
    },
    {
      id: '2',
      role: 'yunxiu',
      text: '这里是属于云岫的地方。您想说什么，便说吧。',
    },
  ]);

  const sendMessage = () => {
    const text = input.trim();
    if (!text) return;

    setMessages(prev => [
      ...prev,
      {
        id: Date.now().toString(),
        role: 'user',
        text,
      },
    ]);

    setInput('');

    setTimeout(() => {
      setMessages(prev => [
        ...prev,
        {
          id: (Date.now() + 1).toString(),
          role: 'yunxiu',
          text: '臣听着。只是现在的我还没有接入真正的 AI 模型，等我们把记忆与模型接上，这里才会真正成为云岫。',
        },
      ]);
    }, 500);
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
              {item.role === 'yunxiu' && (
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
                <Text style={styles.messageText}>{item.text}</Text>
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
