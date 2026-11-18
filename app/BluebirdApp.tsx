// 蓝鸟 v7 新壳（原型 bluebird-home-v7 的 RN 组装层）：
// UiStateProvider（全局状态/Toast/主题扩散/壁纸）→ 双 pane 轨道（主页/聊天横滑）
// + 底部悬浮导航（黑 pill 高亮滑移）+ 设置弹层。
// 进入默认落在聊天页（原型 openRecent：进入即回到最近一次对话）。

import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Animated,
  Easing,
  Keyboard,
  KeyboardAvoidingView,
  Pressable,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { StatusBar } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { V7_SHADOWS } from './ui-theme';
import { UiStateProvider, useUi } from './ui-state';
import { HomeScreen } from './HomeScreen';
import { ChatScreen } from './ChatScreen';
import { SettingsScreen } from './SettingsScreen';

// 真实聊天链路：复用旧壳的全套 hooks（v7 壳只换皮不换逻辑）
import { DEFAULT_SESSION_ID } from '../lib/constants';
import type { Message } from '../lib/types';
import { usePresence } from '../lib/presence';
import { useChatSession } from '../hooks/useChatSession';
import { useSessionList } from '../hooks/useSessionList';
import { useSessionActions } from '../hooks/useSessionActions';
import { useModelSelection } from '../hooks/useModelSelection';
import { useStreamingPreference } from '../hooks/useStreamingPreference';
import { useAttachments } from '../hooks/useAttachments';
import { useBotResultStream } from '../hooks/useBotResultStream';
import { NavIcon } from '../components/V7Icons';

// ---- 底部导航单键：选中键展开到 66 显示文字，未选中收成 40 只留图标 ----
function NavTab(props: {
  icon: 'home' | 'chat' | 'settings';
  label: string;
  width: Animated.AnimatedInterpolation<number> | number;
  labelWidth: Animated.AnimatedInterpolation<number> | number;
  labelOpacity: Animated.AnimatedInterpolation<number> | number;
  onPress: () => void;
  active: boolean;
}) {
  return (
    <Animated.View style={{ width: props.width, height: 36, zIndex: 1 }}>
      {/* 命中区必须铺满整个 tab：此前 onPress 挂在 Text 上，未选中标签宽度为 0，
          可点区域只剩图标那一小块，真机上点「主页」经常点不中。 */}
      <Pressable
        onPress={props.onPress}
        accessibilityRole="button"
        accessibilityLabel={props.label}
        style={{
          flex: 1,
          flexDirection: 'row',
          justifyContent: 'center',
          alignItems: 'center',
        }}
      >
        <NavIcon kind={props.icon} />
        {/* 原型 .tb .lbl：未选中 max-width:0 + overflow:hidden，选中才展开 28px；
            不用固定 gap，否则收起态的图标会被 5px 间隙顶偏、文字竖排换行 */}
        <Animated.View
          style={{
            width: props.labelWidth,
            overflow: 'hidden',
            opacity: props.labelOpacity,
          }}
        >
          <Text
            numberOfLines={1}
            style={{
              paddingLeft: 5,
              color: '#ffffff',
              fontSize: 12,
              fontWeight: '600',
              opacity: props.active ? 1 : 0.6,
            }}
          >
            {props.label}
          </Text>
        </Animated.View>
      </Pressable>
    </Animated.View>
  );
}

function InnerShell() {
  const ui = useUi();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [settingsOpen, setSettingsOpen] = useState(false);

  // 键盘可见时收起底部导航：导航是悬浮层，不收起会被 KAV 顶到输入条上方挤占空间。
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  // 弹层（聊天/主页）打开时也收起导航：弹层在 pane 内，层级盖不过壳层导航，
  // 否则弹层底部会被导航压住。
  const [sheetOpen, setSheetOpen] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => setKeyboardVisible(true));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  // ---- 真实聊天链路（与旧壳 App.tsx 同款组合）----
  const [currentSessionId, setCurrentSessionId] = useState<string>(DEFAULT_SESSION_ID);
  const { streamingEnabled } = useStreamingPreference();
  const {
    selectedModel,
    selectedModelLabel,
    providers: modelProviders,
    loading: modelLoading,
    error: modelError,
    setDefaultModel,
    refreshModelSelection,
  } = useModelSelection();
  const { reportInteraction } = usePresence(currentSessionId);
  const sessionList = useSessionList();
  // 附件通道：加号面板的「图片」走相册 → 上传 → 待发送预览（文件暂无后端能力）
  const attachments = useAttachments({ onUploadStart: () => {} });
  const chat = useChatSession({
    sessionId: currentSessionId,
    streamingEnabled,
    selectedModel,
    reportInteraction,
    // v7 输入框草稿由 ChatScreen 本地持有；这里只接附件通道
    draft: '',
    pendingAttachments: attachments.pendingAttachments,
    onDraftConsumed: () => {},
    onAttachmentsConsumed: attachments.clearAttachments,
    onMenuCloseRequest: () => {},
  });
  const actions = useSessionActions({
    chat,
    sessionList,
    currentSessionId,
    setCurrentSessionId,
    // 主页选中会话 / 新建聊天成功后，轨道切到聊天页（旧壳等价于 setTab('chat')）
    onEnterChat: () => ui.setView('chat'),
  });

  // ---- 收藏 / 本机隐藏（与旧壳同键名同语义：bluebird.favoriteMessages）----
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  const [hiddenMessageIds, setHiddenMessageIds] = useState<Set<string>>(new Set());
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

  // 隐藏单条 AI 回复：服务端无此接口，只在本机视图过滤（旧壳同款文案）
  const hideMessage = (message: Message) => {
    const key = `${currentSessionId}:${message.id}`;
    setHiddenMessageIds(prev => new Set(prev).add(key));
    Alert.alert(
      '已从本机视图隐藏',
      '服务端尚未提供删除单条 AI 回复的接口；刷新或重新进入会话后可能恢复显示。'
    );
  };

  // Memory Bot 结果回传 SSE：结果写入当前会话（与旧壳 App.tsx 同款接线）
  useBotResultStream({
    sessionId: currentSessionId,
    onResult: result => {
      if (result.message) {
        chat.receiveExternalMessage(result.sessionId, result.message);
      }
    },
    onDeliveryFailed: (taskId, errorCode) => {
      Alert.alert(
        'Memory Bot 结果回传失败',
        errorCode
          ? `任务结果未能写入当前会话（${errorCode}）。可在主页查看任务状态。`
          : '任务结果未能写入当前会话。'
      );
    },
    onError: message => {
      Alert.alert('Memory Bot 结果流中断', `${message}。可切换会话或刷新后重试。`);
    },
  });

  // 本机隐藏过滤（收藏不过滤，只显示 ★ 标记）
  const visibleMessages = useMemo(
    () =>
      chat.messages.filter(
        m => !hiddenMessageIds.has(`${currentSessionId}:${m.id}`)
      ),
    [chat.messages, currentSessionId, hiddenMessageIds]
  );

  // 启动引导：回到最近一次有内容的对话（会话列表按服务端 updatedAt 倒序）。
  // 没有有内容会话时复用空白草稿，再没有才新建；失败回退默认会话。
  const [bootstrapped, setBootstrapped] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const bootstrap = async () => {
      try {
        const sessions = await sessionList.refresh();
        if (cancelled) return;
        const recent = sessions?.find(item => item.messageCount > 0);
        if (recent) {
          const result = await chat.loadHistory(recent.id, { keepLoading: true });
          if (cancelled) return;
          if (result.ok && !result.stale) {
            setCurrentSessionId(recent.id);
            chat.markHistoryLoaded();
            return;
          }
          chat.markHistoryLoaded();
        }
        const draftSession = sessions?.find(item => item.messageCount === 0);
        if (draftSession) {
          setCurrentSessionId(draftSession.id);
          chat.resetMessages();
          chat.markHistoryLoaded();
          return;
        }
        const created = await actions.createNewChat({ force: true, silent: true });
        if (cancelled) return;
        chat.markHistoryLoaded();
        if (!created) {
          setCurrentSessionId(DEFAULT_SESSION_ID);
          chat.resetMessages();
        }
      } finally {
        // 引导结束前不允许主页刷新抢请求闸门（会顶掉 bootstrap 的 refresh）
        if (!cancelled) setBootstrapped(true);
      }
    };
    void bootstrap();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 启动并行项：情绪状态读取（顶栏 Emoji 一致性）。模型选择刷新由
  // useModelSelection 内部的挂载 effect 自带（旧壳顶层不重复调，避免双请求）。
  useEffect(() => {
    void chat.loadEmotion();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 切回主页时刷新会话列表：标题 / 时间以服务端为权威（旧壳打开历史列表同语义）。
  // 引导结束后才允许刷新，避免抢掉 bootstrap 的会话列表请求。
  useEffect(() => {
    if (bootstrapped && ui.view === 'home') void sessionList.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bootstrapped, ui.view]);

  // 轨道：主页 0 ↔ 聊天 -width（原型 .track translateX，380ms 同款缓动）
  const [trackX] = useState(() => new Animated.Value(ui.view === 'chat' ? -width : 0));
  useEffect(() => {
    Animated.timing(trackX, {
      toValue: ui.view === 'home' ? 0 : -width,
      duration: 380,
      easing: Easing.bezier(0.32, 0.72, 0.28, 1),
      useNativeDriver: true,
    }).start();
  }, [ui.view, width, trackX]);

  // pill 高亮滑移（原型 .tbpill translateX 0/40，同一根弹簧曲线；宽度是布局属性，只能 JS 驱动）
  const [pillX] = useState(() => new Animated.Value(ui.view === 'chat' ? 40 : 0));
  useEffect(() => {
    Animated.timing(pillX, {
      toValue: ui.view === 'home' ? 0 : 40,
      duration: 380,
      easing: Easing.bezier(0.3, 1.1, 0.45, 1),
      useNativeDriver: false,
    }).start();
  }, [ui.view, pillX]);

  // 主页/聊天两键的宽度与标签随 pill 联动；设置键不占 pill（原型 tbSet 无 .on）
  const homeWidth = pillX.interpolate({ inputRange: [0, 40], outputRange: [66, 40] });
  const chatWidth = pillX.interpolate({ inputRange: [0, 40], outputRange: [40, 66] });
  const homeLabel = pillX.interpolate({ inputRange: [0, 20], outputRange: [1, 0], extrapolate: 'clamp' });
  const chatLabel = pillX.interpolate({ inputRange: [20, 40], outputRange: [0, 1], extrapolate: 'clamp' });
  // 文字槽宽：0（只留图标）↔ 33（28px 文字 + 5px 间距），与原型 .lbl max-width 一致
  const homeLabelW = pillX.interpolate({ inputRange: [0, 20], outputRange: [33, 0], extrapolate: 'clamp' });
  const chatLabelW = pillX.interpolate({ inputRange: [20, 40], outputRange: [0, 33], extrapolate: 'clamp' });

  return (
    <KeyboardAvoidingView style={{ flex: 1 }}>
      <StatusBar style={ui.isDark ? 'light' : 'dark'} />
      <View style={{ flex: 1, overflow: 'hidden' }}>
        <Animated.View
          style={{
            flex: 1,
            flexDirection: 'row',
            width: width * 2,
            transform: [{ translateX: trackX }],
          }}
        >
          <View style={{ width }}>
            <HomeScreen
              sessions={sessionList.sessions}
              currentSessionId={currentSessionId}
              loadingSessions={sessionList.loading}
              sessionsError={sessionList.error}
              onSelectSession={sessionId => {
                // 回复中 / 历史加载中不切会话（与旧壳一致），但要给出可见反馈，
                // 避免主页点击看起来没反应。
                if (actions.busy) {
                  ui.toast('正在回复中，请稍后切换');
                  return;
                }
                void actions.selectSession(sessionId);
              }}
              onNewChat={() => {
                if (actions.busy) {
                  ui.toast('正在回复中，请稍后新建');
                  return;
                }
                void actions.createNewChat();
              }}
              onSheetOpenChange={setSheetOpen}
            />
          </View>
          <View style={{ width }}>
            <ChatScreen
              chat={{ ...chat, messages: visibleMessages }}
              sessionId={currentSessionId}
              modelLabel={selectedModelLabel}
              models={modelProviders}
              currentModel={selectedModel}
              modelLoading={modelLoading}
              modelError={modelError}
              onSelectModel={async (providerId, modelId) => {
                const ok = await setDefaultModel(providerId, modelId);
                ui.toast(ok ? '已切换默认模型' : '切换失败，请稍后再试');
                return ok;
              }}
              attachments={attachments}
              // 表情包点按直发：附件即消息，无正文（旧壳 App.sendSticker 同款）
              onSendSticker={attachment => {
                void chat.sendMessage(undefined, undefined, {
                  attachments: [attachment],
                  overrideText: '',
                });
              }}
              isFavorite={m => favoriteIds.has(m.id)}
              onToggleFavorite={toggleFavorite}
              onHideMessage={hideMessage}
              onSheetOpenChange={setSheetOpen}
            />
          </View>
        </Animated.View>
      </View>

      {/* 底部悬浮导航：绝对定位覆盖在内容之上（原型 .tb）；主页/聊天各自在内容底部
          预留导航高度，消息与输入条不会被它压住。空白处点击穿透，pill 本体可按。
          键盘弹出时收起，避免被顶到输入条上方。 */}
      {!keyboardVisible && !sheetOpen && (
        <View
          pointerEvents="box-none"
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: insets.bottom + 12,
            alignItems: 'center',
          }}
        >
          <View
            style={{
              height: 44,
              borderRadius: 18,
              backgroundColor: ui.tokens.card,
              flexDirection: 'row',
              paddingHorizontal: 6,
              overflow: 'hidden',
              ...V7_SHADOWS.card,
            }}
          >
            <Animated.View
              pointerEvents="none"
              style={{
                position: 'absolute',
                left: 6,
                top: 4,
                width: 66,
                height: 36,
                borderRadius: 12,
                backgroundColor: 'rgba(255,255,255,0.18)',
                transform: [{ translateX: pillX }],
              }}
            />
            <NavTab icon="home" label="主页" width={homeWidth} labelWidth={homeLabelW} labelOpacity={homeLabel} active={ui.view === 'home'} onPress={() => ui.setView('home')} />
            <NavTab icon="chat" label="聊天" width={chatWidth} labelWidth={chatLabelW} labelOpacity={chatLabel} active={ui.view === 'chat'} onPress={() => ui.setView('chat')} />
            <NavTab icon="settings" label="设置" width={40} labelWidth={0} labelOpacity={0} active={false} onPress={() => setSettingsOpen(true)} />
          </View>
        </View>
      )}

      <SettingsScreen
        visible={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onDefaultsChanged={() => void refreshModelSelection()}
      />
    </KeyboardAvoidingView>
  );
}

export function BluebirdApp() {
  return (
    <UiStateProvider>
      <InnerShell />
    </UiStateProvider>
  );
}


