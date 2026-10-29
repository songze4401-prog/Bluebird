// 应用根：只做「组合 + 页面/弹层切换」。
//
// 阶段 2 之前这里是 1400 行单体：聊天状态、六个网页面的取数、上传、主题偏好
// 全部堆在一个组件里。现在分工是：
//   - 会话列表      → hooks/useSessionList（唯一 /sessions 数据源）
//   - 会话生命周期   → hooks/useSessionActions（新建/选择/删除）
//   - 聊天状态与请求 → hooks/useChatSession
//   - 模型选择      → hooks/useModelSelection
//   - 主题 / 流式开关 → hooks/useThemePreference / useStreamingPreference
//   - 附件上传      → hooks/useAttachments
//   - 消息变换规则   → lib/chat-messages（纯函数）
// 本文件只剩页面路由、弹层开关，以及启动引导（bootstrap）的时序。

import React, { useEffect, useMemo, useState } from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  View,
  KeyboardAvoidingView,
  Keyboard,
} from 'react-native';

import { DEFAULT_SESSION_ID } from './lib/constants';
import type { Attachment } from './lib/types';
import { createAppStyles } from './app-styles';

import { ChatInput } from './components/ChatInput';
import { ChatHeader } from './components/ChatHeader';
import { MessageList } from './components/MessageList';
import { MemoryScreen } from './components/MemoryScreen';
import { ThemeScreen } from './components/ThemeScreen';
import { HomeScreen } from './components/HomeScreen';
import { HistoryScreen } from './components/HistoryScreen';
import { ControlPanelScreen } from './components/ControlPanelScreen';
import { ModelScreen } from './components/ModelScreen';
import { PlusPanel } from './components/PlusPanel';
import { SettingsDrawer } from './components/SettingsDrawer';
import { BottomTabBar, type ChatTab } from './components/BottomTabBar';
import { TasksPanel } from './components/TasksPanel';

import { usePresence } from './lib/presence';
import { useChatSession } from './hooks/useChatSession';
import { useSessionList } from './hooks/useSessionList';
import { useSessionActions } from './hooks/useSessionActions';
import { useModelSelection } from './hooks/useModelSelection';
import { useThemePreference } from './hooks/useThemePreference';
import { useStreamingPreference } from './hooks/useStreamingPreference';
import { useAttachments } from './hooks/useAttachments';

export default function App() {
  // ---- 页面与弹层（纯 UI 状态，不进任何 hook）----
  const [screen, setScreen] = useState<'home' | 'chat'>('home');
  // 底部标签栏选中的「同一屏内容」：对话 / 任务。
  // 记忆是独立的全屏弹层（它自己取数、有自己的返回），不占这个状态，
  // 否则点「对话」还得先把弹层关掉，两个来源会互相覆盖。
  const [tab, setTab] = useState<ChatTab>('chat');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [plusOpen, setPlusOpen] = useState(false);
  const [themePickerOpen, setThemePickerOpen] = useState(false);

  // ---- 当前会话 id（组合状态：聊天请求与历史列表都要用）----
  // 会话 id 不落本地存储，以服务端 /sessions 为权威。
  const [currentSessionId, setCurrentSessionId] =
    useState<string>(DEFAULT_SESSION_ID);

  // ---- 输入框内容（纯 UI，发送成功由 useChatSession 回调清空）----
  const [input, setInput] = useState('');

  const { theme, selectMode, selectTheme } = useThemePreference();
  const styles = useMemo(() => createAppStyles(theme), [theme]);

  const { streamingEnabled, setStreaming } = useStreamingPreference();
  const { selectedModel, selectedModelLabel, refreshModelSelection } =
    useModelSelection();

  // 在线状态感知：AppState 前后台 + 心跳 + 用户互动上报。
  // 仅上报状态，不改变任何聊天、记忆、情绪或会话数据。
  const { reportInteraction } = usePresence(currentSessionId);

  const attachments = useAttachments({
    onUploadStart: () => setPlusOpen(false),
  });

  const chat = useChatSession({
    sessionId: currentSessionId,
    streamingEnabled,
    selectedModel,
    reportInteraction,
    draft: input,
    pendingAttachments: attachments.pendingAttachments,
    onDraftConsumed: () => setInput(''),
    onAttachmentsConsumed: attachments.clearAttachments,
    onMenuCloseRequest: () => setDrawerOpen(false),
  });

  const sessionList = useSessionList();
  const { refresh: refreshSessions } = sessionList;

  const actions = useSessionActions({
    chat,
    sessionList,
    currentSessionId,
    setCurrentSessionId,
    onEnterChat: () => {
      setHistoryOpen(false);
      setScreen('chat');
    },
  });

  // 启动：先选「最近更新的会话」（/sessions 已按 updatedAt 倒序），
  // 再读它的历史；/sessions 不可用时退回默认会话单历史模式（与旧行为等价）。
  // 只在挂载时跑一次：这条链路决定初始会话，之后一律由用户操作驱动，
  // 不能随 sessionId 变化重跑（否则会覆盖用户正在看的会话）。
  useEffect(() => {
    let cancelled = false;

    const bootstrap = async () => {
      const sessions = await refreshSessions();

      // 明确传 sessionId：新后端命中该会话，旧后端忽略未知 query 参数
      const resumeSessionId = sessions?.[0]?.id || DEFAULT_SESSION_ID;

      await chat.loadHistory(resumeSessionId);

      if (cancelled) return;

      setCurrentSessionId(resumeSessionId);
      chat.markHistoryLoaded();
    };

    void bootstrap();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 启动时读取服务端持久化的真实情绪状态，让顶部 Emoji 与 Emotion System 保持一致。
  // 与上面的会话引导并行：情绪读取失败不影响聊天，静默保持默认值。
  useEffect(() => {
    void chat.loadEmotion();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 标签栏「记忆」：直接开全屏弹层，不写 tab —— 记忆弹层自带取数与返回，
  // 若也进 tab 状态，点「对话」时会出现「弹层还开着但选中项已变」的错位。
  const handleTabChange = (next: ChatTab) => {
    if (next === 'memory') {
      setMemoryOpen(true);
      return;
    }

    setTab(next);
  };

  // 历史聊天：打开列表弹层，并让列表刷新一次（服务端为权威）
  const openChatHistory = () => {
    if (actions.busy) return;

    setHistoryOpen(true);
    void refreshSessions();
  };

  // 点按表情包：立即作为一条无文字消息发出，不动输入框与待发送图片
  const sendSticker = (attachment: Attachment) => {
    setPlusOpen(false);
    void chat.sendMessage(undefined, undefined, {
      attachments: [attachment],
      overrideText: '',
    });
  };

  // 并发守卫留在这里：sending / loadingHistory 来自 useChatSession，
  // 放进 useAttachments 会造成两个 hook 循环依赖。
  const pickImage = (source: 'album' | 'camera') => {
    if (chat.sending || chat.loadingHistory || attachments.uploadingImage) {
      return;
    }

    void attachments.pickImage(source);
  };

  const historyProps = {
    theme,
    currentSessionId,
    sessions: sessionList.sessions,
    loadingSessions: sessionList.loading,
    sessionsError: sessionList.error,
    onRefresh: () => void refreshSessions(),
    onSelectSession: actions.selectSession,
    onDeleteSession: actions.deleteSession,
  };

  if (screen === 'home') {
    return (
      <>
        <HomeScreen
          onContinue={() => setScreen('chat')}
          onNewChat={actions.createNewChat}
          onHistory={openChatHistory}
          creatingChat={actions.creatingSession}
        />

        <HistoryScreen
          visible={historyOpen}
          onClose={() => setHistoryOpen(false)}
          {...historyProps}
        />
      </>
    );
  }

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

      <KeyboardAvoidingView style={styles.keyboardArea} behavior="padding">
        <ChatHeader
          theme={theme}
          onOpenDrawer={() => setDrawerOpen(true)}
          onNewChat={actions.createNewChat}
          onOpenHistory={openChatHistory}
          creatingChat={actions.creatingSession}
        />

        {tab === 'tasks' ? (
          // 任务页：后端没有任务接口，这里只放真实空状态，不画假卡片
          <TasksPanel theme={theme} />
        ) : (
          <MessageList
            theme={theme}
            messages={chat.messages}
            sessionId={currentSessionId}
            loadingHistory={chat.loadingHistory || chat.loadingOlder}
            loadingOlder={chat.loadingOlder}
            hasMoreHistory={chat.hasMoreHistory}
            onLoadOlder={chat.loadOlderHistory}
            sending={chat.sending}
            continuing={chat.continuing}
            liveToolSteps={chat.liveToolSteps}
            onRecall={chat.recallMessage}
            onRetry={chat.sendMessage}
            onContinue={() => void chat.sendContinuation()}
          />
        )}

        {/* 输入区随页切换：任务页不是聊天，不放发送框 */}
        {tab === 'chat' && (
          <ChatInput
            theme={theme}
            value={input}
            onChangeText={setInput}
            sending={chat.sending}
            loadingHistory={chat.loadingHistory}
            uploadingImage={attachments.uploadingImage}
            pendingAttachments={attachments.pendingAttachments}
            onRemoveAttachment={attachments.removeAttachment}
            onSend={() => void chat.sendMessage()}
            onPlus={() => {
              Keyboard.dismiss();
              setPlusOpen(true);
            }}
            modelLabel={selectedModelLabel}
            onOpenModels={() => setModelsOpen(true)}
          />
        )}
      </KeyboardAvoidingView>

      {/* 标签栏留在 KeyboardAvoidingView 之外：Android 用 adjustResize，
          窗口本身缩小，放在外面才不会被 KAV 的 padding 再顶一次 */}
      <BottomTabBar theme={theme} active={tab} onChange={handleTabChange} />

      {/* 设置抽屉：☰ / ⋮ 的目的地，历史·记忆·控制面板·模型·主题·清理都从这里进 */}
      <SettingsDrawer
        visible={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        theme={theme}
        mood={chat.mood}
        creatingChat={actions.creatingSession}
        onOpenHistory={() => {
          setDrawerOpen(false);
          openChatHistory();
        }}
        onNewChat={() => {
          setDrawerOpen(false);
          actions.createNewChat();
        }}
        onReturnHome={() => {
          setDrawerOpen(false);
          setScreen('home');
        }}
        onOpenMemory={() => {
          setDrawerOpen(false);
          setMemoryOpen(true);
        }}
        onOpenControlPanel={() => {
          setDrawerOpen(false);
          setPanelOpen(true);
        }}
        onOpenModels={() => {
          setDrawerOpen(false);
          setModelsOpen(true);
        }}
        onOpenThemePicker={() => {
          setDrawerOpen(false);
          setThemePickerOpen(true);
        }}
        onSelectMode={selectMode}
        onClearHistory={() => {
          setDrawerOpen(false);
          chat.clearHistory();
        }}
      />

      {/* 加号面板：相册 / 拍照 / 表情包（底部弹层，不新增路由） */}
      <PlusPanel
        theme={theme}
        visible={plusOpen}
        onClose={() => setPlusOpen(false)}
        onPickImage={pickImage}
        onAddSticker={attachments.pickSticker}
        onSendSticker={sendSticker}
        busy={chat.sending || attachments.uploadingImage}
      />

      <MemoryScreen
        visible={memoryOpen}
        onClose={() => setMemoryOpen(false)}
        theme={theme}
      />

      {/* 控制面板：独立弹层，配置走后端 /persona，不占用主聊天界面 */}
      <ControlPanelScreen
        visible={panelOpen}
        onClose={() => setPanelOpen(false)}
        theme={theme}
        streamingEnabled={streamingEnabled}
        onToggleStreaming={setStreaming}
      />

      {/* 模型与 API 管理：独立弹层，服务商配置走后端 /model-providers */}
      <ModelScreen
        visible={modelsOpen}
        onClose={() => setModelsOpen(false)}
        onDefaultsChanged={refreshModelSelection}
        theme={theme}
      />

      <ThemeScreen
        visible={themePickerOpen}
        onClose={() => setThemePickerOpen(false)}
        theme={theme}
        onSelect={selectTheme}
      />

      <HistoryScreen
        visible={historyOpen}
        onClose={() => setHistoryOpen(false)}
        {...historyProps}
      />
    </SafeAreaView>
  );
}
