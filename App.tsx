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

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  View,
  KeyboardAvoidingView,
  Keyboard,
  Alert,
} from 'react-native';

import AsyncStorage from '@react-native-async-storage/async-storage';

import { DEFAULT_SESSION_ID } from './lib/constants';
import type { Attachment, Message } from './lib/types';
import { createAppStyles } from './app-styles';

import { ChatInput } from './components/ChatInput';
import { ChatHeader } from './components/ChatHeader';
import { ChatWelcome } from './components/ChatWelcome';
import { MessageList } from './components/MessageList';
import { MemoryCenterScreen } from './components/MemoryCenterScreen';
import { ThemeScreen } from './components/ThemeScreen';
import { HistoryScreen } from './components/HistoryScreen';
import { ControlPanelScreen } from './components/ControlPanelScreen';
import { SettingsScreen } from './components/SettingsScreen';
import { AgentToolsScreen } from './components/AgentToolsScreen';
import { AgentTeamScreen } from './components/AgentTeamScreen';
import { MemoryBotScreen } from './components/MemoryBotScreen';
import { MonitoringScreen } from './components/MonitoringScreen';
import { ModelScreen } from './components/ModelScreen';
import { PlusPanel } from './components/PlusPanel';
import { SettingsDrawer } from './components/SettingsDrawer';
import { TasksPanel } from './components/TasksPanel';
import { MessageActionSheet } from './components/MessageActionSheet';

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
  // 没有独立主页：进入应用即新对话，主页内容合并进聊天首屏（ChatWelcome）。
  // 底部标签栏选中的「同一屏内容」：对话 / 任务。
  // 记忆是独立的全屏弹层（它自己取数、有自己的返回），不占这个状态，
  // 否则点「对话」还得先把弹层关掉，两个来源会互相覆盖。
  const [tab, setTab] = useState<'chat' | 'tasks'>('chat');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [plusOpen, setPlusOpen] = useState(false);
  const [themePickerOpen, setThemePickerOpen] = useState(false);
  const [monitoringOpen, setMonitoringOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [agentToolsOpen, setAgentToolsOpen] = useState(false);
  const [agentTeamOpen, setAgentTeamOpen] = useState(false);
  const [memoryBotOpen, setMemoryBotOpen] = useState(false);
  const [actionMessage, setActionMessage] = useState<Message | null>(null);
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  const [hiddenMessageIds, setHiddenMessageIds] = useState<Set<string>>(
    new Set()
  );

  // ---- 当前会话 id（组合状态：聊天请求与历史列表都要用）----
  // 会话 id 不落本地存储，以服务端 /sessions 为权威。
  const [currentSessionId, setCurrentSessionId] =
    useState<string>(DEFAULT_SESSION_ID);

  // ---- 输入框内容（纯 UI，发送成功由 useChatSession 回调清空）----
  const [input, setInput] = useState('');

  const { theme, selectMode, selectTheme } = useThemePreference();
  const styles = useMemo(() => createAppStyles(theme), [theme]);

  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem('bluebird.favoriteMessages')
      .then(raw => {
        if (cancelled || !raw) return;
        const ids = JSON.parse(raw);
        if (Array.isArray(ids)) setFavoriteIds(new Set(ids.filter(Boolean)));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleFavorite = (message: Message) => {
    setFavoriteIds(prev => {
      const next = new Set(prev);
      if (next.has(message.id)) next.delete(message.id);
      else next.add(message.id);
      void AsyncStorage.setItem(
        'bluebird.favoriteMessages',
        JSON.stringify([...next])
      ).catch(() => {});
      return next;
    });
  };

  const deleteMessage = (message: Message) => {
    if (message.role === 'user') {
      chat.recallMessage(message);
      return;
    }

    const key = `${currentSessionId}:${message.id}`;
    setHiddenMessageIds(prev => new Set(prev).add(key));
    Alert.alert(
      '已从本机视图隐藏',
      '服务端尚未提供删除单条 AI 回复的接口；刷新或重新进入会话后可能恢复显示。'
    );
  };

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
      setTab('chat');
    },
  });

  // 启动：进入应用默认新开对话，不再恢复最近会话。
  // 复用最近一个空白会话作为草稿，避免每次启动都堆出一个新的空会话；
  // 没有空白会话时才调用 POST /sessions 新建。
  // 只在挂载时跑一次，之后一律由用户操作驱动。
  useEffect(() => {
    let cancelled = false;

    const bootstrap = async () => {
      const sessions = await refreshSessions();

      if (cancelled) return;

      const draftSession = sessions?.find(item => item.messageCount === 0);

      if (draftSession) {
        setCurrentSessionId(draftSession.id);
        chat.resetMessages();
        chat.markHistoryLoaded();
        return;
      }

      // force 跳过“历史加载中”闸门；silent 避免启动阶段网络问题弹阻断框。
      const created = await actions.createNewChat({
        force: true,
        silent: true,
      });

      if (cancelled) return;

      chat.markHistoryLoaded();

      if (!created) {
        // 服务不可用：保持空白新对话，不把任何旧会话的内容混进来。
        setCurrentSessionId(DEFAULT_SESSION_ID);
        chat.resetMessages();
      }
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

  const visibleMessages = useMemo(
    () =>
      chat.messages.filter(
        message => !hiddenMessageIds.has(`${currentSessionId}:${message.id}`)
      ),
    [chat.messages, currentSessionId, hiddenMessageIds]
  );

  const isFavorite = useCallback(
    (message: Message) => favoriteIds.has(message.id),
    [favoriteIds]
  );

  const currentSessionMeta = sessionList.sessions.find(
    item => item.id === currentSessionId
  );

  // 空白会话（含刚新建、尚未发消息）在顶栏统一显示「新对话」，
  // 不暴露服务端的「新会话」占位标题。
  // 以本地消息为准：服务端列表不会在每条消息后刷新 messageCount。
  const hasLocalMessages = chat.messages.some(
    item => !item.id.startsWith('welcome-')
  );
  const isBlankSession =
    !hasLocalMessages &&
    (!chat.loadingHistory ||
      !currentSessionMeta ||
      currentSessionMeta.messageCount === 0);

  const currentSessionTitle = isBlankSession
    ? '新对话'
    : currentSessionMeta?.title || '';

  const recentSession = useMemo(
    () =>
      sessionList.sessions.find(
        item => item.id !== currentSessionId && item.messageCount > 0
      ) ?? null,
    [currentSessionId, sessionList.sessions]
  );

  const resumeRecentChat = () => {
    if (!recentSession) return;

    void actions.selectSession(recentSession.id);
  };

  // 已经在空白新对话里时，「新建」只需回到对话页，不再堆一个空会话。
  // 编辑中的输入内容也原样保留。
  const startNewChat = () => {
    if (actions.busy) return;

    setHistoryOpen(false);
    setTab('chat');

    if (isBlankSession) return;

    void actions.createNewChat();
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
    onNewChat: startNewChat,
  };

  return (
    <View style={{ flex: 1 }}>
      <SafeAreaView style={styles.container}>
        <KeyboardAvoidingView style={styles.keyboardArea} behavior="padding">
          <ChatHeader
            theme={theme}
            onOpenDrawer={() => setDrawerOpen(true)}
            onNewChat={startNewChat}
            onOpenHistory={openChatHistory}
            sessionTitle={tab === 'tasks' ? '任务' : currentSessionTitle}
            creatingChat={actions.creatingSession}
          />

          {tab === 'tasks' ? (
            // 任务页：后端没有任务接口，这里只放真实空状态，不画假卡片
            <TasksPanel theme={theme} sessionId={currentSessionId} />
          ) : (
            <MessageList
              theme={theme}
              messages={visibleMessages}
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
              onOpenActions={setActionMessage}
              isFavorite={isFavorite}
              emptyState={
                <ChatWelcome
                  theme={theme}
                  recentTitle={recentSession?.title}
                  onResumeRecent={resumeRecentChat}
                  onOpenHistory={openChatHistory}
                  onOpenMemory={() => setMemoryOpen(true)}
                />
              }
            />
          )}

          {/* 输入区随页切换：任务页不是聊天，不放发送框 */}
          {tab === 'chat' && (
            <ChatInput
              theme={theme}
              value={input}
              onChangeText={setInput}
              sending={chat.sending || chat.continuing}
              onStop={chat.stopGeneration}
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
      </SafeAreaView>

      {/* 设置抽屉：☰ 的唯一目的地，最近对话与全部功能入口都在这里 */}
      <SettingsDrawer
        visible={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        theme={theme}
        mood={chat.mood}
        sessions={sessionList.sessions}
        currentSessionId={currentSessionId}
        loadingSessions={sessionList.loading}
        sessionsError={sessionList.error}
        onSelectSession={sessionId => {
          setDrawerOpen(false);
          void actions.selectSession(sessionId);
        }}
        creatingChat={actions.creatingSession}
        onOpenHistory={() => {
          setDrawerOpen(false);
          openChatHistory();
        }}
        onNewChat={() => {
          setDrawerOpen(false);
          startNewChat();
        }}
        onOpenMemory={() => {
          setDrawerOpen(false);
          setMemoryOpen(true);
        }}
        onOpenControlPanel={() => {
          setDrawerOpen(false);
          setPanelOpen(true);
        }}
        onOpenMonitoring={() => {
          setDrawerOpen(false);
          setMonitoringOpen(true);
        }}
        onOpenAgentTools={() => {
          setDrawerOpen(false);
          setAgentToolsOpen(true);
        }}
        onOpenAgentTeam={() => {
          setDrawerOpen(false);
          setAgentTeamOpen(true);
        }}
        onOpenSettings={() => {
          setDrawerOpen(false);
          setSettingsOpen(true);
        }}
        onOpenTasks={() => {
          setDrawerOpen(false);
          setTab('tasks');
        }}
        onOpenChat={() => {
          setDrawerOpen(false);
          setTab('chat');
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

      <MemoryCenterScreen
        visible={memoryOpen}
        onClose={() => setMemoryOpen(false)}
        theme={theme}
      />

      {/* 系统监控：独立只读工作区，不把监控卡片堆进聊天页 */}
      <MonitoringScreen
        visible={monitoringOpen}
        onClose={() => setMonitoringOpen(false)}
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

      <SettingsScreen
        visible={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        theme={theme}
        modelLabel={selectedModelLabel}
        streamingEnabled={streamingEnabled}
        onToggleStreaming={setStreaming}
        onOpenModels={() => {
          setSettingsOpen(false);
          setModelsOpen(true);
        }}
        onOpenMemory={() => {
          setSettingsOpen(false);
          setMemoryOpen(true);
        }}
        onOpenControlPanel={() => {
          setSettingsOpen(false);
          setPanelOpen(true);
        }}
        onOpenAgentTools={() => {
          setSettingsOpen(false);
          setAgentToolsOpen(true);
        }}
        onOpenAgentTeam={() => {
          setSettingsOpen(false);
          setAgentTeamOpen(true);
        }}
        onOpenMonitoring={() => {
          setSettingsOpen(false);
          setMonitoringOpen(true);
        }}
        onOpenTheme={() => {
          setSettingsOpen(false);
          setThemePickerOpen(true);
        }}
        onClearHistory={() => {
          setSettingsOpen(false);
          chat.clearHistory();
        }}
      />

      <AgentToolsScreen
        visible={agentToolsOpen}
        onClose={() => setAgentToolsOpen(false)}
        theme={theme}
        onOpenAdvanced={() => {
          setAgentToolsOpen(false);
          setPanelOpen(true);
        }}
      />

      <AgentTeamScreen
        visible={agentTeamOpen}
        onClose={() => setAgentTeamOpen(false)}
        theme={theme}
        onOpenBot={() => {
          setAgentTeamOpen(false);
          setMemoryBotOpen(true);
        }}
      />

      <MemoryBotScreen
        visible={memoryBotOpen}
        onClose={() => setMemoryBotOpen(false)}
        theme={theme}
        onOpenMemory={() => {
          setMemoryBotOpen(false);
          setMemoryOpen(true);
        }}
      />

      <MessageActionSheet
        visible={!!actionMessage}
        message={actionMessage}
        theme={theme}
        isFavorite={!!actionMessage && isFavorite(actionMessage)}
        onClose={() => setActionMessage(null)}
        onToggleFavorite={toggleFavorite}
        onDelete={deleteMessage}
      />

      <HistoryScreen
        visible={historyOpen}
        onClose={() => setHistoryOpen(false)}
        {...historyProps}
      />
    </View>
  );
}
