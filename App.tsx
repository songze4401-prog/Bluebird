import React, { useEffect, useMemo, useRef, useState } from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  View,
  StyleSheet,
  KeyboardAvoidingView,
  Keyboard,
  Alert,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as ImagePicker from 'expo-image-picker';

import {
  Attachment,
  Message,
  PendingAttachment,
  ReplySegment,
  SessionMeta,
} from './lib/types';
import { API_TOKEN, DEFAULT_SESSION_ID, REPLY_PACING } from './lib/constants';
import { makeLocalId, readJsonResponse } from './lib/utils';
import { streamChatRequest } from './lib/stream';
import { addSticker, uploadImage } from './lib/uploads';

import { ChatInput } from './components/ChatInput';
import { ChatHeader } from './components/ChatHeader';
import { ChatBubble } from './components/ChatBubble';
import { MessageList } from './components/MessageList';
import { MemoryScreen } from './components/MemoryScreen';
import { ThemeScreen } from './components/ThemeScreen';
import { HomeScreen } from './components/HomeScreen';
import { HistoryScreen } from './components/HistoryScreen';
import { ControlPanelScreen } from './components/ControlPanelScreen';
import { PlusPanel } from './components/PlusPanel';
import { usePresence } from './lib/presence';

import {
  getTheme,
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

const sleep = (ms: number) =>
  new Promise<void>(resolve => setTimeout(resolve, ms));

// 逐条展示间隔：按上一条长度计算，短消息不做无意义的长等待
const pacingDelay = (content: string) =>
  Math.min(
    REPLY_PACING.maxMs,
    REPLY_PACING.baseMs + content.length * REPLY_PACING.perCharMs
  );

// /chat 响应归一化为分条数组：优先服务端 replies[]（连续消息模式），
// 字段缺失时回退为单条 reply —— 新旧服务端双向兼容
function normalizeSegments(data: {
  reply?: string;
  replies?: ReplySegment[];
  assistantMessageId?: string;
  createdAt?: string;
}): ReplySegment[] {
  if (Array.isArray(data.replies)) {
    const valid = data.replies.filter(
      seg => seg && typeof seg.content === 'string' && seg.content.length > 0
    );

    if (valid.length > 0) return valid;
  }

  return typeof data.reply === 'string' && data.reply.length > 0
    ? [
        {
          id:
            typeof data.assistantMessageId === 'string'
              ? data.assistantMessageId
              : '',
          content: data.reply,
          createdAt: data.createdAt,
        },
      ]
    : [];
}

// 流式临时气泡：delta 原地累加到同一条消息，不新建气泡
function applyStreamDelta(
  prev: Message[],
  tempId: string,
  delta: string
): Message[] {
  const index = prev.findIndex(m => m.id === tempId);
  const target = index >= 0 ? prev[index] : undefined;

  if (target) {
    const next = [...prev];
    next[index] = { ...target, content: target.content + delta };
    return next;
  }

  return [
    ...prev,
    {
      id: tempId,
      role: 'assistant',
      content: delta,
      createdAt: new Date().toISOString(),
    },
  ];
}

// 流式收尾：用一组气泡替换临时气泡（done 的权威分条，或失败时的错误气泡）。
// 临时气泡不存在（用户已切走会话等）时直接追加。
function reconcileStreamDone(
  prev: Message[],
  tempId: string,
  bubbles: Message[]
): Message[] {
  const index = prev.findIndex(m => m.id === tempId);
  if (index < 0) return [...prev, ...bubbles];
  return [...prev.slice(0, index), ...bubbles, ...prev.slice(index + 1)];
}

// 移除流式临时气泡（失败且不展示错误气泡的场景，如「继续说」失败）
function removeStreamBubble(prev: Message[], tempId: string): Message[] {
  return prev.filter(m => m.id !== tempId);
}

export default function App() {
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [mood, setMood] = useState('calm');

  // 启动落在固定欢迎主页，选择入口后才进入聊天页
  const [screen, setScreen] = useState<'home' | 'chat'>('home');

  // 当前所在会话：所有聊天类请求都带上它，保证会话隔离。
  // 会话 id 不落本地存储，以服务端 /sessions 为权威。
  const [currentSessionId, setCurrentSessionId] =
    useState<string>(DEFAULT_SESSION_ID);

  // 历史聊天弹层开关；新建会话请求进行中（防连点）
  const [historyOpen, setHistoryOpen] = useState(false);
  const [creatingSession, setCreatingSession] = useState(false);

  // 在线状态感知：AppState 前后台 + 心跳 + 用户互动上报。
  // 仅上报状态，不改变任何聊天、记忆、情绪或会话数据。
  const { reportInteraction } = usePresence(currentSessionId);

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

  // 记忆库 / 控制面板弹层开关
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);

  // 加号面板 / 待发送图片附件 / 上传进行中
  const [plusOpen, setPlusOpen] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<
    PendingAttachment[]
  >([]);
  const [uploadingImage, setUploadingImage] = useState(false);

  // 当前会话的 ref 镜像：分条逐条展示期间侦测"用户已切走会话"，
  // 切走即停止展示（消息早已落盘，切回时历史完整恢复）
  const currentSessionIdRef = useRef(currentSessionId);

  useEffect(() => {
    currentSessionIdRef.current = currentSessionId;
  }, [currentSessionId]);

  // 空会话欢迎语：纯本地展示，不落盘、不计入服务端 messageCount
  const buildWelcomeMessages = (): Message[] => [
    {
      id: 'welcome-1',
      role: 'assistant',
      content: '我在',
    },
  ];

  // 读取指定会话的消息并渲染；返回是否成功（失败时由调用方决定文案）
  const loadSessionHistory = async (
    sessionId: string
  ): Promise<{ ok: boolean; status: number }> => {
    try {
      const response = await fetch(
        `${process.env.EXPO_PUBLIC_API_URL}/history?sessionId=${encodeURIComponent(
          sessionId
        )}&limit=200`,
        {
          headers: {
            Authorization: `Bearer ${API_TOKEN}`,
          },
        }
      );

      const data = await readJsonResponse(response);

      if (!response.ok || !Array.isArray(data.history)) {
        return { ok: false, status: response.status };
      }

      setMessages(
        data.history.length === 0
          ? buildWelcomeMessages()
          : data.history.map(
              (
                item: {
                  id?: string;
                  role: 'user' | 'assistant';
                  content: string;
                  createdAt?: string;
                  attachments?: Attachment[];
                },
                index: number
              ) => ({
                id: item.id ?? `history-${index}`,
                role: item.role,
                content: item.content,
                createdAt: item.createdAt,
                // 图片/表情包附件原样透传，气泡按 id 从服务端读取渲染
                ...(Array.isArray(item.attachments) && item.attachments.length
                  ? { attachments: item.attachments }
                  : {}),
              })
            )
      );

      return { ok: true, status: response.status };
    } catch (error) {
      console.error('History load error:', error);
      return { ok: false, status: 0 };
    }
  };

  // 启动：先选「最近更新的会话」（/sessions 已按 updatedAt 倒序），
  // 再读它的历史；/sessions 不可用时退回默认会话单历史模式（与旧行为等价）。
  useEffect(() => {
    let cancelled = false;

    const loadSessions = async (): Promise<SessionMeta[] | null> => {
      try {
        const response = await fetch(
          `${process.env.EXPO_PUBLIC_API_URL}/sessions`,
          {
            headers: {
              Authorization: `Bearer ${API_TOKEN}`,
            },
          }
        );

        const data = await readJsonResponse(response);

        if (!response.ok || !Array.isArray(data.sessions)) {
          throw new Error('读取会话列表失败');
        }

        return data.sessions as SessionMeta[];
      } catch (error) {
        // 失败不抛出：退回默认会话，保证单历史模式仍完整可用
        console.error('Sessions load error:', error);
        return null;
      }
    };

    const bootstrap = async () => {
      const sessions = await loadSessions();

      // 明确传 sessionId：新后端命中该会话，旧后端忽略未知 query 参数
      const resumeSessionId = sessions?.[0]?.id || DEFAULT_SESSION_ID;

      await loadSessionHistory(resumeSessionId);

      if (cancelled) return;

      setCurrentSessionId(resumeSessionId);
      setLoadingHistory(false);
    };

    bootstrap();

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
      '清理当前会话',
      '确定要删除当前会话的全部聊天记录吗？其他会话不受影响。',
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
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${API_TOKEN}`,
                  },
                  body: JSON.stringify({ sessionId: currentSessionId }),
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
  const openMemoryLibrary = () => {
    setMenuOpen(false);
    setMemoryOpen(true);
  };

  // ---- 控制面板 ----
  const openControlPanel = () => {
    setMenuOpen(false);
    setPanelOpen(true);
  };

  const recallMessage = (message: Message) => {
    // 纯图片/表情包消息没有文字，确认框正文给占位说明
    const preview =
      message.content ||
      (message.attachments?.length ? '（图片/表情包）' : '');

    Alert.alert('撤回这条消息？', preview, [
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
                body: JSON.stringify({
                  sessionId: currentSessionId,
                  messageId: message.id,
                }),
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

  // ---- 加号面板：图片与表情包 ----
  // 与服务端 MAX_ATTACHMENTS 对齐：单条消息最多 4 张
  const MAX_PENDING_ATTACHMENTS = 4;

  // 选图 → 上传（POST /uploads/image）→ 进入待发送预览行。
  // 上传完成后才出现在预览里，失败只弹提示不留半成品。
  const pickImage = async (source: 'album' | 'camera') => {
    if (sending || loadingHistory || uploadingImage) return;

    if (pendingAttachments.length >= MAX_PENDING_ATTACHMENTS) {
      Alert.alert('最多 4 张', '单条消息最多携带 4 张图片。');
      return;
    }

    try {
      if (source === 'camera') {
        const permission =
          await ImagePicker.requestCameraPermissionsAsync();

        if (!permission.granted) {
          Alert.alert('无法拍照', '请在系统设置中允许使用相机。');
          return;
        }
      }

      const result =
        source === 'camera'
          ? await ImagePicker.launchCameraAsync({
              base64: true,
              quality: 0.85,
            })
          : await ImagePicker.launchImageLibraryAsync({
              mediaTypes: ['images'],
              base64: true,
              quality: 0.85,
            });

      if (result.canceled) return;

      const asset = result.assets?.[0];

      if (!asset?.base64) {
        Alert.alert('读取图片失败', '请换一张图片再试。');
        return;
      }

      const dataUrl = `data:${asset.mimeType || 'image/jpeg'};base64,${asset.base64}`;

      setUploadingImage(true);
      setPlusOpen(false);

      const attachment = await uploadImage(
        dataUrl,
        'image',
        asset.fileName ?? undefined
      );

      setPendingAttachments(prev => [
        ...prev,
        { attachment, previewUri: dataUrl },
      ]);
    } catch (error) {
      console.error('Pick image error:', error);
      Alert.alert(
        '图片上传失败',
        error instanceof Error ? error.message : '请稍后再试。'
      );
    } finally {
      setUploadingImage(false);
    }
  };

  // 从相册选图登记为表情包（入仓库，sha256 去重），返回新表情包供面板插入网格
  const pickSticker = async (): Promise<Attachment | null> => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        base64: true,
        quality: 0.85,
      });

      if (result.canceled) return null;

      const asset = result.assets?.[0];

      if (!asset?.base64) {
        Alert.alert('读取图片失败', '请换一张图片再试。');
        return null;
      }

      const dataUrl = `data:${asset.mimeType || 'image/jpeg'};base64,${asset.base64}`;

      return await addSticker(dataUrl, asset.fileName ?? undefined);
    } catch (error) {
      console.error('Add sticker error:', error);
      Alert.alert(
        '添加表情包失败',
        error instanceof Error ? error.message : '请稍后再试。'
      );
      return null;
    }
  };

  // 点按表情包：立即作为一条无文字消息发出，不动输入框与待发送图片
  const sendSticker = (attachment: Attachment) => {
    setPlusOpen(false);
    void sendMessage(undefined, undefined, {
      attachments: [attachment],
      overrideText: '',
    });
  };

  const sendMessage = async (
    retryText?: string,
    retryAttachments?: Attachment[],
    extras?: { attachments?: Attachment[]; overrideText?: string }
  ) => {
    const isRetry = typeof retryText === 'string';
    // 附件来源：重试带原附件 / 表情包点按带 extras / 正常发送带待发送预览
    const attachments = isRetry
      ? retryAttachments ?? []
      : extras?.attachments ??
        pendingAttachments.map(item => item.attachment);
    const text = (
      isRetry ? (retryText as string) : extras?.overrideText ?? input
    ).trim();

    // 纯发图（无文字）合法；既无文字又无附件才拦下
    if ((!text && attachments.length === 0) || sending || loadingHistory)
      return;

    // 请求入口快照：await 期间即使用户切换了会话，本次请求也保持在同一会话
    const sessionId = currentSessionId;

    // 用户发消息是一次有效互动：立即刷新活跃时间（失败静默，不影响发送）
    reportInteraction(sessionId);

    const userMessage: Message = {
      id: makeLocalId(),
      role: 'user',
      content: text,
      createdAt: new Date().toISOString(),
      ...(attachments.length ? { attachments } : {}),
    };

    setSending(true);

    // welcome 是纯本地展示消息，不进模型上下文
    const past = messages.filter(
      item => !item.retryText && !item.id.startsWith('welcome-')
    );
    const history = (isRetry ? past.slice(0, -1) : past)
      .slice(-20)
      .map(item => ({
        role: item.role,
        content: item.content,
        // 带上附件元数据：后端会把用户消息的图片转成模型可读的 content blocks
        ...(item.attachments?.length
          ? { attachments: item.attachments }
          : {}),
      }));

    if (isRetry) {
      setMessages(prev => prev.filter(m => m.retryText !== retryText));
    } else {
      setMessages(prev => [...prev, userMessage]);
      setInput('');
      // 表情包点按不动待发送预览；正常发送后清空预览行
      if (!extras?.attachments) setPendingAttachments([]);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);

    // 附件按存储位置分流：表情包引用仓库 ID（stickerIds），
    // 聊天图片引用 uploads 临时附件（attachmentIds）。重试时同样按 kind 路由。
    const stickerIds = attachments
      .filter(att => att.kind === 'sticker')
      .map(att => att.id);
    const imageIds = attachments
      .filter(att => att.kind !== 'sticker')
      .map(att => att.id);

    const payload = {
      message: text,
      history,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      sessionId,
      ...(imageIds.length ? { attachmentIds: imageIds } : {}),
      ...(stickerIds.length ? { stickerIds } : {}),
    };

    // 流式回复的临时气泡 id：delta 原地累加进同一条消息
    const streamTempId = `stream-${makeLocalId()}`;

    try {
      // 优先走流式（SSE）：文字随模型生成逐步显示。
      // 一个 delta 都没收到就失败时自动回退非流式 /chat（兼容旧服务端）。
      const outcome = await streamChatRequest(payload, {
        onDelta: delta => {
          // 用户已切走会话：停止渲染（服务端照常落盘，切回时历史完整恢复）
          if (currentSessionIdRef.current !== sessionId) return;
          setMessages(prev => applyStreamDelta(prev, streamTempId, delta));
        },
      });

      if (outcome.kind === 'done') {
        const data = outcome.data;
        const replyMood = typeof data.mood === 'string' ? data.mood : 'calm';
        const segments = normalizeSegments(data);

        // 撤回需要服务端稳定 id：用服务端返回的 id 替换本地临时 id
        const serverUserId =
          typeof data.userMessageId === 'string' ? data.userMessageId : null;

        if (serverUserId) {
          setMessages(prev => {
            // 正常发送更新刚发出的气泡；重试时更新最后一条用户消息
            const targetId = retryText
              ? [...prev].reverse().find(m => m.role === 'user')?.id
              : userMessage.id;

            return prev.map(m =>
              m.id === targetId ? { ...m, id: serverUserId } : m
            );
          });
        }

        setMood(replyMood);

        // 用服务端权威分条替换临时气泡：内容在流式期间已逐步读完，
        // 不再加逐条等待；id 换成服务端稳定 id，撤回逻辑不受影响
        if (currentSessionIdRef.current === sessionId && segments.length > 0) {
          const bubbles: Message[] = segments.map(seg => ({
            id: seg.id || `${makeLocalId()}-ai`,
            role: 'assistant',
            content: seg.content,
            mood: replyMood,
            createdAt:
              seg.createdAt ?? data.createdAt ?? new Date().toISOString(),
            // AI 回复的图片/表情包附件（服务端约定挂在最后一格气泡）
            ...(seg.attachments?.length
              ? { attachments: seg.attachments }
              : {}),
          }));

          setMessages(prev =>
            reconcileStreamDone(prev, streamTempId, bubbles)
          );
        }

        return;
      }

      if (outcome.kind === 'error') {
        // 流式中途失败：临时气泡（可能已有部分内容）替换为错误气泡
        setMessages(prev =>
          reconcileStreamDone(prev, streamTempId, [
            {
              id: `error-${makeLocalId()}`,
              role: 'assistant',
              content: outcome.message,
              retryText: text,
              // 带图消息失败后重试需原样带回附件
              ...(attachments.length ? { retryAttachments: attachments } : {}),
            },
          ])
        );
        return;
      }

      // outcome.kind === 'fallback'：非流式旧路径（一个 delta 都没收到）
      const response = await fetch(
        `${process.env.EXPO_PUBLIC_API_URL}/chat`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${API_TOKEN}`,
          },
          signal: controller.signal,
          body: JSON.stringify(payload),
        }
      );

      const data = await readJsonResponse(response);

      if (!response.ok) {
        // 会话被清理/只读保护时给出明确的下一步指引
        if (response.status === 404) {
          Alert.alert('会话已失效', '返回主页后请重新选择会话。');
        }

        throw new Error(data.error || '请求失败');
      }

      const replyMood = typeof data.mood === 'string' ? data.mood : 'calm';
      const segments = normalizeSegments(data);

      // 撤回需要服务端稳定 id：用服务端返回的 id 替换本地临时 id
      const serverUserId =
        typeof data.userMessageId === 'string' ? data.userMessageId : null;

      if (serverUserId) {
        setMessages(prev => {
          // 正常发送更新刚发出的气泡；重试时更新最后一条用户消息
          const targetId = retryText
            ? [...prev].reverse().find(m => m.role === 'user')?.id
            : userMessage.id;

          return prev.map(m =>
            m.id === targetId ? { ...m, id: serverUserId } : m
          );
        });
      }

      setMood(replyMood);

      // 分条逐条展示：第一条立即出现，后续按上一条长度等待，模拟真人
      // 连续发消息的节奏。展示期间 sending 保持 true，沿用现有防连发；
      // 空 segments（异常响应）时不追加任何气泡，由下方静默兜底
      for (let i = 0; i < segments.length; i++) {
        // 用户已切走会话：停止展示（消息已落盘，切回时历史完整恢复）
        if (currentSessionIdRef.current !== sessionId) return;

        const seg = segments[i];

        setMessages(prev => [
          ...prev,
          {
            id: seg.id || `${makeLocalId()}-ai`,
            role: 'assistant',
            content: seg.content,
            mood: replyMood,
            createdAt:
              seg.createdAt ?? data.createdAt ?? new Date().toISOString(),
            ...(seg.attachments?.length
              ? { attachments: seg.attachments }
              : {}),
          },
        ]);

        if (i < segments.length - 1) {
          await sleep(pacingDelay(seg.content));
        }
      }
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
          // 带图消息失败后重试需原样带回附件
          ...(attachments.length ? { retryAttachments: attachments } : {}),
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
    if (continuing || sending || loadingHistory) return;

    const last = messages[messages.length - 1];

    if (!last || last.role !== 'assistant' || last.retryText) return;

    // 与 sendMessage 同样的入口快照：续写期间不因切换会话串上下文
    const sessionId = currentSessionId;

    reportInteraction(sessionId);

    const history = messages
      .filter(item => !item.retryText && !item.id.startsWith('welcome-'))
      .slice(-20)
      .map(item => ({ role: item.role, content: item.content }));

    setContinuing(true);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);

    const payload = {
      mode: 'continue',
      history,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      sessionId,
    };

    const streamTempId = `stream-${makeLocalId()}`;

    try {
      // 续写同样优先走流式；回退/失败语义与 sendMessage 一致
      const outcome = await streamChatRequest(payload, {
        onDelta: delta => {
          if (currentSessionIdRef.current !== sessionId) return;
          setMessages(prev => applyStreamDelta(prev, streamTempId, delta));
        },
      });

      if (outcome.kind === 'done') {
        const data = outcome.data;
        const replyMood = typeof data.mood === 'string' ? data.mood : 'calm';
        const segments = normalizeSegments(data);

        setMood(replyMood);

        if (currentSessionIdRef.current === sessionId && segments.length > 0) {
          const bubbles: Message[] = segments.map(seg => ({
            id: seg.id || `${makeLocalId()}-ai`,
            role: 'assistant',
            content: seg.content,
            mood: replyMood,
            createdAt:
              seg.createdAt ?? data.createdAt ?? new Date().toISOString(),
            // AI 回复的图片/表情包附件（服务端约定挂在最后一格气泡）
            ...(seg.attachments?.length
              ? { attachments: seg.attachments }
              : {}),
          }));

          setMessages(prev =>
            reconcileStreamDone(prev, streamTempId, bubbles)
          );
        }

        return;
      }

      if (outcome.kind === 'error') {
        // 续写失败不展示错误气泡（沿用原有 Alert 提示），移除临时气泡
        setMessages(prev => removeStreamBubble(prev, streamTempId));
        Alert.alert('失败', '继续说失败了，请稍后再试。');
        return;
      }

      // outcome.kind === 'fallback'：非流式旧路径
      const response = await fetch(
        `${process.env.EXPO_PUBLIC_API_URL}/chat`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${API_TOKEN}`,
          },
          signal: controller.signal,
          body: JSON.stringify(payload),
        }
      );

      const data = await readJsonResponse(response);

      if (!response.ok) {
        throw new Error(data.error || '请求失败');
      }

      const replyMood = typeof data.mood === 'string' ? data.mood : 'calm';
      const segments = normalizeSegments(data);

      setMood(replyMood);

      // 与 sendMessage 相同的分条逐条展示；续写没有用户气泡要补丁
      for (let i = 0; i < segments.length; i++) {
        if (currentSessionIdRef.current !== sessionId) return;

        const seg = segments[i];

        setMessages(prev => [
          ...prev,
          {
            id: seg.id || `${makeLocalId()}-ai`,
            role: 'assistant',
            content: seg.content,
            mood: replyMood,
            createdAt:
              seg.createdAt ?? data.createdAt ?? new Date().toISOString(),
            ...(seg.attachments?.length
              ? { attachments: seg.attachments }
              : {}),
          },
        ]);

        if (i < segments.length - 1) {
          await sleep(pacingDelay(seg.content));
        }
      }
    } catch (error) {
      console.error('Continue error:', error);

      Alert.alert('失败', '继续说失败了，请稍后再试。');
    } finally {
      clearTimeout(timeout);
      setContinuing(false);
    }
  };

  // ---- 欢迎主页的三个入口 ----
  // 继续聊天：启动时已加载「最近更新的会话」，直接进聊天页即可
  const enterChatFromHome = () => setScreen('chat');

  // 新建聊天：点击即创建独立会话（POST /sessions），进入空的聊天页
  const createNewChat = async () => {
    if (creatingSession || sending || continuing || loadingHistory) return;

    setCreatingSession(true);

    try {
      const response = await fetch(
        `${process.env.EXPO_PUBLIC_API_URL}/sessions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${API_TOKEN}`,
          },
          body: JSON.stringify({}),
        }
      );

      const data = await readJsonResponse(response);

      if (!response.ok || !data.session?.id) {
        throw new Error(data.error || '新建会话失败');
      }

      setCurrentSessionId(data.session.id);
      setMessages([]);
      setScreen('chat');
    } catch (error) {
      console.error('Create session error:', error);
      Alert.alert(
        '新建聊天失败',
        error instanceof Error && error.message.includes('新建会话失败')
          ? error.message
          : '暂时无法连接会话服务，请稍后再试。'
      );
    } finally {
      setCreatingSession(false);
    }
  };

  // 历史聊天：打开会话列表弹层
  const openChatHistory = () => {
    if (creatingSession || sending || continuing || loadingHistory) return;
    setHistoryOpen(true);
  };

  // 从历史列表选择一个会话：加载它的消息并进入聊天页
  const selectSessionFromHistory = async (sessionId: string) => {
    if (sending || continuing || loadingHistory) return;

    const result = await loadSessionHistory(sessionId);

    if (!result.ok) {
      Alert.alert(
        '打开会话失败',
        result.status === 404
          ? '会话不存在，可能已被清理。'
          : '读取会话记录失败，请稍后再试。'
      );
      return;
    }

    setCurrentSessionId(sessionId);
    setHistoryOpen(false);
    setScreen('chat');
  };

  // 删除会话：DELETE /sessions/:id。删除的是当前会话时切回默认会话，
  // 服务端保证 default 被删后会立即重建为空会话，不会留下悬空 id
  const deleteSessionFromHistory = async (
    sessionId: string
  ): Promise<boolean> => {
    try {
      const response = await fetch(
        `${process.env.EXPO_PUBLIC_API_URL}/sessions/${encodeURIComponent(sessionId)}`,
        {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${API_TOKEN}`,
          },
        }
      );

      const data = await readJsonResponse(response);

      if (!response.ok) {
        throw new Error(data.error || '删除失败');
      }

      if (sessionId === currentSessionId) {
        setCurrentSessionId(DEFAULT_SESSION_ID);
        setMessages([]);
      }

      return true;
    } catch (error) {
      console.error('Delete session error:', error);
      Alert.alert('失败', '删除会话失败，请稍后再试。');
      return false;
    }
  };

  if (screen === 'home') {
    return (
      <>
        <HomeScreen
          onContinue={enterChatFromHome}
          onNewChat={createNewChat}
          onHistory={openChatHistory}
          creatingChat={creatingSession}
        />

        <HistoryScreen
          visible={historyOpen}
          onClose={() => setHistoryOpen(false)}
          theme={theme}
          currentSessionId={currentSessionId}
          onSelectSession={selectSessionFromHistory}
          onDeleteSession={deleteSessionFromHistory}
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
          onOpenControlPanel={openControlPanel}
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
          loadingHistory={loadingHistory}
          uploadingImage={uploadingImage}
          pendingAttachments={pendingAttachments}
          onRemoveAttachment={id =>
            setPendingAttachments(prev =>
              prev.filter(item => item.attachment.id !== id)
            )
          }
          onSend={() => sendMessage()}
          onPlus={() => {
            Keyboard.dismiss();
            setPlusOpen(true);
          }}
          onReturnHome={() => setScreen('home')}
        />
      </KeyboardAvoidingView>

      {/* 加号面板：相册 / 拍照 / 表情包（底部弹层，不新增路由） */}
      <PlusPanel
        theme={theme}
        visible={plusOpen}
        onClose={() => setPlusOpen(false)}
        onPickImage={pickImage}
        onAddSticker={pickSticker}
        onSendSticker={sendSticker}
        busy={sending || uploadingImage}
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
        theme={theme}
        currentSessionId={currentSessionId}
        onSelectSession={selectSessionFromHistory}
        onDeleteSession={deleteSessionFromHistory}
      />
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
});
