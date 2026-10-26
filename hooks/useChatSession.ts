// 聊天会话状态与编排（阶段 2 状态分层）。
//
// 这里的职责边界：
//   - 拥有 messages / loadingHistory / sending / continuing / mood 五个状态
//   - 拥有「发消息」「继续说」「读历史」「清空」「撤回」的完整编排
//   - 不拥有会话 id（由 App 的 useSessionList 决定），不拥有输入框内容
//
// 关键约束（与重构前逐条对齐，避免行为漂移）：
//   1. 请求入口快照 sessionId：await 期间切走会话，本次请求仍落在原会话
//   2. 流式期间每收到 delta 就按数据层规则重新分条，done 时用权威分条整体替换
//   3. 用户已切走会话时停止渲染（消息早已落盘，切回时历史完整恢复）
//   4. 发送失败展示错误气泡（可重试）；续写失败只弹 Alert（不产生错误气泡）

import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';

import { apiFetch } from '../lib/api/client';
import { makeLocalId, readJsonResponse } from '../lib/utils';
import { streamChatRequest } from '../lib/stream';
import {
  applyStreamingText,
  buildReplyBubbles,
  buildWelcomeMessages,
  ensureSegmentsAll,
  mapHistoryItem,
  normalizeSegments,
  reconcileStreamDone,
  removeStreamBubble,
  type StreamMode,
} from '../lib/chat-messages';
import type {
  Attachment,
  Message,
  ModelDefaults,
  PendingAttachment,
} from '../lib/types';

// /chat 与 /chat/stream 的共享超时预算（与重构前一致：60s）
const CHAT_TIMEOUT_MS = 60_000;

// 历史一次性拉取上限（服务端按需截断）
const HISTORY_LIMIT = 200;

// 进入模型上下文的最大历史条数
const HISTORY_CONTEXT_LIMIT = 20;

// 服务端明确错误（无效模型 / 无视觉模型 / 缺 Key 等）：把后端给出的原因原样
// 展示给用户，而不是统一成「连接失败」。网络类错误仍用统一文案。
type ServerError = Error & { fromServer?: true };

function serverError(message: string): ServerError {
  const error = new Error(message) as ServerError;
  error.fromServer = true;
  return error;
}

function isServerError(error: unknown): error is ServerError {
  return error instanceof Error && (error as ServerError).fromServer === true;
}

// 统一的失败文案：超时 / 服务端明确原因 / 通用连接失败
function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') {
    return '连接Bluebird超时了，再试一次。';
  }

  if (isServerError(error) && error.message) return error.message;

  return '连接Bluebird失败了，再试一次。';
}

export type ChatSendExtras = {
  attachments?: Attachment[];
  overrideText?: string;
};

export type ChatSessionConfig = {
  // 当前会话 id（由 useSessionList 拥有）。所有聊天请求都带上它，保证会话隔离。
  sessionId: string;
  // 流式开关：关闭走 /chat，开启优先 /chat/stream（无 delta 时回退）
  streamingEnabled: boolean;
  // 本次请求要携带的模型选择（服务端 defaults 的镜像）
  selectedModel: ModelDefaults | null;
  // 在线状态上报（发消息 / 续写算一次有效互动）
  reportInteraction: (sessionId: string) => void;
  // 输入框内容与待发送附件：由 App 持有，发送成功后回调清空
  draft: string;
  pendingAttachments: PendingAttachment[];
  onDraftConsumed: () => void;
  onAttachmentsConsumed: () => void;
  // 清空历史成功后关闭顶部菜单（菜单由 App 持有）
  onMenuCloseRequest: () => void;
};

export type ChatSessionApi = {
  messages: Message[];
  loadingHistory: boolean;
  sending: boolean;
  continuing: boolean;
  mood: string;
  sendMessage: (
    retryText?: string,
    retryAttachments?: Attachment[],
    extras?: ChatSendExtras
  ) => Promise<void>;
  sendContinuation: () => Promise<void>;
  loadHistory: (
    sessionId: string
  ) => Promise<{ ok: boolean; status: number }>;
  markHistoryLoaded: () => void;
  clearHistory: () => void;
  recallMessage: (message: Message) => void;
  resetMessages: () => void;
};

export function useChatSession({
  sessionId,
  streamingEnabled,
  selectedModel,
  reportInteraction,
  draft,
  pendingAttachments,
  onDraftConsumed,
  onAttachmentsConsumed,
  onMenuCloseRequest,
}: ChatSessionConfig): ChatSessionApi {
  const [messagesState, setMessagesState] = useState<Message[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [sending, setSending] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [mood, setMood] = useState('calm');

  // 所有消息统一从数据层入口过一遍：assistant 正文在进入 state 前就切好片段，
  // 渲染层（ChatBubble）只消费 segments，不再解析原始标记。
  const setMessages: React.Dispatch<React.SetStateAction<Message[]>> =
    useCallback(updater => {
      setMessagesState(prev => {
        const next =
          typeof updater === 'function'
            ? (updater as (current: Message[]) => Message[])(prev)
            : updater;

        return ensureSegmentsAll(next);
      });
    }, []);

  // 当前会话的 ref 镜像：分条逐条展示期间侦测"用户已切走会话"，
  // 切走即停止展示（消息早已落盘，切回时历史完整恢复）
  const sessionIdRef = useRef(sessionId);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  const markHistoryLoaded = useCallback(() => setLoadingHistory(false), []);
  const resetMessages = useCallback(() => setMessages([]), [setMessages]);

  // 读取指定会话的消息并渲染；返回是否成功（失败时由调用方决定文案）
  const loadHistory = async (
    targetSessionId: string
  ): Promise<{ ok: boolean; status: number }> => {
    try {
      const response = await apiFetch(
        `/history?sessionId=${encodeURIComponent(
          targetSessionId
        )}&limit=${HISTORY_LIMIT}`
      );

      const data = await readJsonResponse(response);

      if (!response.ok || !Array.isArray(data.history)) {
        return { ok: false, status: response.status };
      }

      setMessages(
        data.history.length === 0
          ? buildWelcomeMessages()
          : data.history.map(mapHistoryItem)
      );

      return { ok: true, status: response.status };
    } catch (error) {
      console.error('History load error:', error);
      return { ok: false, status: 0 };
    }
  };

  // ---- 聊天请求的公共执行器 ----
  // 发送与续写共用这一条链路：流式 →（无 delta）回退非流式 → 统一分条。
  // 差异只通过回调表达：发送失败要错误气泡、续写失败只弹 Alert。
  const runChat = async (options: {
    requestSessionId: string;
    payload: Record<string, unknown>;
    // 拿到服务端稳定 id 后要就地改 id 的那条用户气泡
    retry: boolean;
    localUserId?: string;
    onStreamError: (message: string, streamTempId: string) => void;
    onError: (message: string) => void;
  }): Promise<void> => {
    const { requestSessionId, payload, retry, localUserId } = options;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);

    // 服务端 id 落地：撤回需要稳定 id，用服务端返回的 id 替换本地临时 id
    const applyServerUserId = (serverUserId: string) => {
      setMessages(prev => {
        // 正常发送更新刚发出的气泡；重试时更新最后一条用户消息
        const targetId = retry
          ? [...prev].reverse().find(m => m.role === 'user')?.id
          : localUserId;

        return prev.map(m =>
          m.id === targetId ? { ...m, id: serverUserId } : m
        );
      });
    };

    try {
      // 流式开关关闭时跳过 SSE，直接走 /chat（一次性显示）；
      // 开启时优先 SSE，一个 delta 都没收到才回退 /chat（兼容旧服务端）。
      // 两条路径最终都用 buildReplyBubbles 同源切分，done 与回退零跳变。
      if (streamingEnabled) {
        // 流式回复的临时气泡前缀：流式期按分段规则切成 tempId#0..#n
        const streamTempId = `stream-${makeLocalId()}`;
        const streamCreatedAt = new Date().toISOString();
        // 累计正文与分段模式：模式由服务端 meta 事件下发（默认 auto）
        let streamedText = '';
        let streamMode: StreamMode = 'auto';

        const outcome = await streamChatRequest(payload, {
          onMeta: meta => {
            if (
              meta.messageMode === 'single' ||
              meta.messageMode === 'auto' ||
              meta.messageMode === 'frequent'
            ) {
              streamMode = meta.messageMode;
            }
          },
          onDelta: delta => {
            // 用户已切走会话：停止渲染（服务端照常落盘，切回时历史完整恢复）
            if (sessionIdRef.current !== requestSessionId) return;
            streamedText += delta;
            setMessages(prev =>
              applyStreamingText(
                prev,
                streamTempId,
                streamedText,
                streamMode,
                streamCreatedAt
              )
            );
          },
        });

        if (outcome.kind === 'done') {
          const data = outcome.data;
          const segments = normalizeSegments(data);

          const serverUserId =
            typeof data.userMessageId === 'string'
              ? data.userMessageId
              : null;

          if (serverUserId) applyServerUserId(serverUserId);

          const { bubbles, replyMood } = buildReplyBubbles(data, segments);

          setMood(replyMood);

          // 用服务端权威分条替换临时气泡：内容在流式期间已逐步读完，
          // 不再加逐条等待；id 换成服务端稳定 id，撤回逻辑不受影响
          if (
            sessionIdRef.current === requestSessionId &&
            bubbles.length > 0
          ) {
            setMessages(prev =>
              reconcileStreamDone(prev, streamTempId, bubbles)
            );
          }

          return;
        }

        if (outcome.kind === 'error') {
          options.onStreamError(outcome.message, streamTempId);
          return;
        }

        // outcome.kind === 'fallback'：一个 delta 都没收到，落到下面 /chat
      }

      // ---- 非流式 /chat 路径（开关关闭，或流式回退）----
      // 一次性写入全部气泡（不做假分条动画），与流式 done 同源切分；
      // 用户已切走会话则不追加（消息已落盘，切回时历史完整恢复）
      const response = await apiFetch('/chat', {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify(payload),
      });

      const data = await readJsonResponse(response);

      if (!response.ok) {
        // 会话被清理/只读保护时给出明确的下一步指引
        if (response.status === 404) {
          Alert.alert('会话已失效', '返回主页后请重新选择会话。');
        }

        throw serverError(data.error || '请求失败');
      }

      const segments = normalizeSegments(data);

      const serverUserId =
        typeof data.userMessageId === 'string' ? data.userMessageId : null;

      if (serverUserId) applyServerUserId(serverUserId);

      const { bubbles, replyMood } = buildReplyBubbles(data, segments);

      setMood(replyMood);

      if (sessionIdRef.current === requestSessionId && bubbles.length > 0) {
        setMessages(prev => [...prev, ...bubbles]);
      }
    } catch (error) {
      console.error(error);
      options.onError(toErrorMessage(error));
    } finally {
      clearTimeout(timeout);
    }
  };

  const sendMessage = async (
    retryText?: string,
    retryAttachments?: Attachment[],
    extras?: ChatSendExtras
  ) => {
    const isRetry = typeof retryText === 'string';
    // 附件来源：重试带原附件 / 表情包点按带 extras / 正常发送带待发送预览
    const attachments = isRetry
      ? retryAttachments ?? []
      : extras?.attachments ??
        pendingAttachments.map(item => item.attachment);
    const text = (
      isRetry ? (retryText as string) : extras?.overrideText ?? draft
    ).trim();

    // 纯发图（无文字）合法；既无文字又无附件才拦下。
    // 并发互斥：发送 / 续写 / 首次加载任一进行中都不接受新发送。
    if (
      (!text && attachments.length === 0) ||
      sending ||
      continuing ||
      loadingHistory
    ) {
      return;
    }

    // 请求入口快照：await 期间即使用户切换了会话，本次请求也保持在同一会话
    const requestSessionId = sessionId;

    // 用户发消息是一次有效互动：立即刷新活跃时间（失败静默，不影响发送）
    reportInteraction(requestSessionId);

    const userMessage: Message = {
      id: makeLocalId(),
      role: 'user',
      content: text,
      createdAt: new Date().toISOString(),
      ...(attachments.length ? { attachments } : {}),
    };

    setSending(true);

    // welcome 是纯本地展示消息，不进模型上下文
    const past = messagesState.filter(
      item => !item.retryText && !item.id.startsWith('welcome-')
    );
    const history = (isRetry ? past.slice(0, -1) : past)
      .slice(-HISTORY_CONTEXT_LIMIT)
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
      onDraftConsumed();
      // 表情包点按不动待发送预览；正常发送后清空预览行
      if (!extras?.attachments) onAttachmentsConsumed();
    }

    // 附件按存储位置分流：表情包引用仓库 ID（stickerIds），
    // 聊天图片引用 uploads 临时附件（attachmentIds）。重试时同样按 kind 路由。
    const stickerIds = attachments
      .filter(att => att.kind === 'sticker')
      .map(att => att.id);
    const imageIds = attachments
      .filter(att => att.kind !== 'sticker')
      .map(att => att.id);

    // 本次请求的模型选择快照（在请求发出前取值）：即使用户随后切换模型，
    // 这条已在途的请求仍按发出时的模型执行。未读到选择时省略，服务端用全局默认。
    const modelSelection = selectedModel
      ? {
          providerId: selectedModel.providerId,
          modelId: selectedModel.modelId,
        }
      : {};

    const payload = {
      message: text,
      history,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      sessionId: requestSessionId,
      ...modelSelection,
      ...(imageIds.length ? { attachmentIds: imageIds } : {}),
      ...(stickerIds.length ? { stickerIds } : {}),
    };

    try {
      await runChat({
        requestSessionId,
        payload,
        retry: isRetry,
        localUserId: userMessage.id,
        onStreamError: (message, streamTempId) => {
          // 流式中途失败：临时气泡（可能已有部分内容）替换为错误气泡
          setMessages(prev =>
            reconcileStreamDone(prev, streamTempId, [
              {
                id: `error-${makeLocalId()}`,
                role: 'assistant',
                content: message,
                retryText: text,
                // 带图消息失败后重试需原样带回附件
                ...(attachments.length
                  ? { retryAttachments: attachments }
                  : {}),
              },
            ])
          );
        },
        onError: message => {
          setMessages(prev => [
            ...prev,
            {
              id: `error-${makeLocalId()}`,
              role: 'assistant',
              content: message,
              retryText: text,
              // 带图消息失败后重试需原样带回附件
              ...(attachments.length
                ? { retryAttachments: attachments }
                : {}),
            },
          ]);
        },
      });
    } finally {
      setSending(false);
    }
  };

  // 「继续说」：让 Bluebird 接着自己上一条回复往下说。
  // 走同一个 /chat，用 mode:'continue' 标记为内部续写请求；
  // 后端不会保存任何"继续说"用户消息，只追加 assistant 消息。
  const sendContinuation = async () => {
    if (continuing || sending || loadingHistory) return;

    const last = messagesState[messagesState.length - 1];

    if (!last || last.role !== 'assistant' || last.retryText) return;

    // 与 sendMessage 同样的入口快照：续写期间不因切换会话串上下文
    const requestSessionId = sessionId;

    reportInteraction(requestSessionId);

    const history = messagesState
      .filter(item => !item.retryText && !item.id.startsWith('welcome-'))
      .slice(-HISTORY_CONTEXT_LIMIT)
      .map(item => ({ role: item.role, content: item.content }));

    setContinuing(true);

    const payload = {
      mode: 'continue',
      history,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      sessionId: requestSessionId,
      // 续写同样是聊天请求：沿用发出时的模型选择
      ...(selectedModel
        ? {
            providerId: selectedModel.providerId,
            modelId: selectedModel.modelId,
          }
        : {}),
    };

    try {
      await runChat({
        requestSessionId,
        payload,
        retry: false,
        onStreamError: (message, streamTempId) => {
          // 续写失败不展示错误气泡（沿用原有 Alert 提示），移除临时气泡
          setMessages(prev => removeStreamBubble(prev, streamTempId));
          Alert.alert('失败', message || '继续说失败了，请稍后再试。');
        },
        onError: message => {
          Alert.alert('失败', message || '继续说失败了，请稍后再试。');
        },
      });
    } finally {
      setContinuing(false);
    }
  };

  const clearHistory = () => {
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
              const response = await apiFetch('/history/clear', {
                method: 'POST',
                body: JSON.stringify({
                  sessionId,
                  // 真实数据目录下服务端要求二次确认；此处已在 Alert 里确认过
                  confirm: true,
                }),
              });

              const data = await readJsonResponse(response);

              if (!response.ok) {
                throw new Error(data.error || '清理失败');
              }

              setMessages([]);
              onMenuCloseRequest();
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
            const response = await apiFetch('/history/recall', {
              method: 'POST',
              body: JSON.stringify({
                sessionId,
                messageId: message.id,
              }),
            });

            const data = await readJsonResponse(response);

            if (!response.ok) {
              throw new Error(data.error || '撤回失败');
            }

            // 服务端返回真实删除的 id 列表（含配对的 AI 回复），按它移除
            const removedIds: string[] = Array.isArray(data.removedIds)
              ? data.removedIds
              : [message.id];

            setMessages(prev => prev.filter(m => !removedIds.includes(m.id)));
          } catch (error) {
            console.error('Recall error:', error);
            Alert.alert('撤回失败', '请稍后再试。');
          }
        },
      },
    ]);
  };

  return {
    messages: messagesState,
    loadingHistory,
    sending,
    continuing,
    mood,
    sendMessage,
    sendContinuation,
    loadHistory,
    markHistoryLoaded,
    clearHistory,
    recallMessage,
    resetMessages,
  };
}
