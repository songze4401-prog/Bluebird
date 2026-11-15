// 蓝鸟 v7 新壳（原型 bluebird-home-v7 的 RN 组装层）：
// UiStateProvider（全局状态/Toast/主题扩散/壁纸）→ 双 pane 轨道（主页/聊天横滑）
// + 底部悬浮导航（黑 pill 高亮滑移）+ 设置弹层。
// 进入默认落在聊天页（原型 openRecent：进入即回到最近一次对话）。

import React, { useEffect, useState } from 'react';
import {
  Animated,
  Easing,
  KeyboardAvoidingView,
  Platform,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { V7_SHADOWS } from './ui-theme';
import { UiStateProvider, useUi } from './ui-state';
import { HomeScreen } from './HomeScreen';
import { ChatScreen } from './ChatScreen';
import { SettingsScreen } from './SettingsScreen';

// 真实聊天链路：复用旧壳的全套 hooks（v7 壳只换皮不换逻辑）
import { DEFAULT_SESSION_ID } from '../lib/constants';
import { usePresence } from '../lib/presence';
import { useChatSession } from '../hooks/useChatSession';
import { useSessionList } from '../hooks/useSessionList';
import { useSessionActions } from '../hooks/useSessionActions';
import { useModelSelection } from '../hooks/useModelSelection';
import { useStreamingPreference } from '../hooks/useStreamingPreference';
import { useAttachments } from '../hooks/useAttachments';

// ---- 底部导航单键：选中键展开到 66 显示文字，未选中收成 40 只留图标 ----
function NavTab(props: {
  icon: string;
  label: string;
  width: Animated.AnimatedInterpolation<number> | number;
  labelOpacity: Animated.AnimatedInterpolation<number> | number;
  onPress: () => void;
  active: boolean;
}) {
  return (
    <Animated.View
      style={{
        width: props.width,
        height: 36,
        justifyContent: 'center',
        alignItems: 'center',
        zIndex: 1,
      }}
    >
      <Text
        onPress={props.onPress}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 5,
          color: '#ffffff',
          fontSize: 12,
          fontWeight: '600',
          opacity: props.active ? 1 : 0.6,
        }}
      >
        <Text style={{ fontSize: 15 }}>{props.icon}</Text>
        <Animated.Text
          style={{
            color: '#ffffff',
            fontSize: 12,
            fontWeight: '600',
            opacity: props.labelOpacity,
          }}
        >
          {props.label}
        </Animated.Text>
      </Text>
    </Animated.View>
  );
}

function InnerShell() {
  const ui = useUi();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [settingsOpen, setSettingsOpen] = useState(false);

  // ---- 真实聊天链路（与旧壳 App.tsx 同款组合）----
  const [currentSessionId, setCurrentSessionId] = useState<string>(DEFAULT_SESSION_ID);
  const { streamingEnabled } = useStreamingPreference();
  const { selectedModel, selectedModelLabel } = useModelSelection();
  const { reportInteraction } = usePresence(currentSessionId);
  const sessionList = useSessionList();
  // 附件通道先接通（暂无选择入口，加号面板图片/文件仍是演示占位；R2 接相册/拍照）
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
    onEnterChat: () => {},
  });

  // 启动引导（与旧壳同款）：复用空白会话当草稿 → 否则新建 → 失败回退默认会话
  useEffect(() => {
    let cancelled = false;
    const bootstrap = async () => {
      const sessions = await sessionList.refresh();
      if (cancelled) return;
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

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
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
            <HomeScreen />
          </View>
          <View style={{ width }}>
            <ChatScreen chat={chat} modelLabel={selectedModelLabel} />
          </View>
        </Animated.View>
      </View>

      {/* 底部悬浮导航：空白处点击穿透（pointerEvents box-none），pill 本体可按 */}
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
          <NavTab icon="⌂" label="主页" width={homeWidth} labelOpacity={homeLabel} active={ui.view === 'home'} onPress={() => ui.setView('home')} />
          <NavTab icon="💬" label="聊天" width={chatWidth} labelOpacity={chatLabel} active={ui.view === 'chat'} onPress={() => ui.setView('chat')} />
          <NavTab icon="⚙" label="设置" width={40} labelOpacity={0} active={false} onPress={() => setSettingsOpen(true)} />
        </View>
      </View>

      <SettingsScreen visible={settingsOpen} onClose={() => setSettingsOpen(false)} />
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


