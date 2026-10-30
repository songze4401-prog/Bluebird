import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { Theme } from '../theme';
import { apiFetch } from '../lib/api/client';
import { API_PATHS } from '../lib/api/endpoints';
import type {
  AgentConfig,
  AgentConfigResponse,
  AgentChatMessage,
  AgentChatResponse,
  AgentEvent,
  AgentApproval,
  AgentApprovalsResponse,
  AgentEventsResponse,
  AgentResponse,
  AgentSession,
  AgentSessionDetailResponse,
  AgentSessionsResponse,
  AgentSummary,
  AgentTask,
  AgentTasksResponse,
  AgentVerifyResponse,
} from '../lib/api/types';
import type { ModelProvider } from '../lib/types';
import { MarkdownMessage } from './MarkdownMessage';
import { emptyAgentMessage, sendAgentChatStream } from '../lib/agent-stream';

type Tab = 'chat' | 'config' | 'activity';

const STATUS_LABEL: Record<string, string> = {
  enabled: '已启用',
  disabled: '已停用',
  degraded: '待配置',
};

const TASK_LABEL: Record<string, string> = {
  queued: '排队中',
  accepted: '已接收',
  running: '执行中',
  waiting_approval: '等待确认',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  timed_out: '超时',
};

export function MemoryBotScreen({
  visible,
  onClose,
  theme,
  onOpenMemory,
}: {
  visible: boolean;
  onClose: () => void;
  theme: Theme;
  onOpenMemory?: () => void;
}) {
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [tab, setTab] = useState<Tab>('chat');
  const [agent, setAgent] = useState<AgentSummary | null>(null);
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AgentChatMessage[]>([]);
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [approvals, setApprovals] = useState<AgentApproval[]>([]);
  const [taskGoal, setTaskGoal] = useState('');
  const [taskType, setTaskType] = useState('memory.search');
  const [taskBusy, setTaskBusy] = useState(false);
  const [approvalBusy, setApprovalBusy] = useState('');
  const [input, setInput] = useState('');
  const [keyInput, setKeyInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const scrollRef = useRef<React.ElementRef<typeof ScrollView>>(null);

  const loadSession = useCallback(async (id: string) => {
    const response = await apiFetch(API_PATHS.agentSession('memory', id));
    if (!response.ok) throw new Error('session');
    const data = (await response.json()) as AgentSessionDetailResponse;
    setSessionId(id);
    setMessages(data.messages || []);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [agentRes, configRes, sessionsRes, tasksRes, eventsRes, approvalsRes, providersRes] =
        await Promise.all([
          apiFetch(API_PATHS.agent('memory')),
          apiFetch(API_PATHS.agentConfig('memory')),
          apiFetch(API_PATHS.agentSessions('memory')),
          apiFetch(API_PATHS.agentTasks('memory', 20)),
          apiFetch(API_PATHS.agentEvents('memory', 30)),
          apiFetch(API_PATHS.agentApprovals('memory', 50)),
          apiFetch(API_PATHS.modelProviders),
        ]);
      if (!agentRes.ok || !configRes.ok) throw new Error('agent');
      const agentData = (await agentRes.json()) as AgentResponse;
      const configData = (await configRes.json()) as AgentConfigResponse;
      const sessionsData = sessionsRes.ok
        ? ((await sessionsRes.json()) as AgentSessionsResponse)
        : { sessions: [] };
      const tasksData = tasksRes.ok
        ? ((await tasksRes.json()) as AgentTasksResponse)
        : { tasks: [] };
      const eventsData = eventsRes.ok
        ? ((await eventsRes.json()) as AgentEventsResponse)
        : { events: [] };
      const approvalsData = approvalsRes.ok
        ? ((await approvalsRes.json()) as AgentApprovalsResponse)
        : { approvals: [] };
      const providerData = providersRes.ok
        ? ((await providersRes.json()) as { providers?: ModelProvider[] })
        : {};

      setAgent(agentData.agent);
      setConfig(configData.config);
      setProviders(providerData.providers || []);
      setSessions(sessionsData.sessions || []);
      setTasks(tasksData.tasks || []);
      setEvents(eventsData.events || []);
      setApprovals(approvalsData.approvals || []);

      const preferred =
        sessionId && sessionsData.sessions.some(item => item.id === sessionId)
          ? sessionId
          : sessionsData.sessions[0]?.id;
      if (preferred) {
        await loadSession(preferred);
      } else {
        setSessionId(null);
        setMessages([]);
      }
    } catch {
      setError('暂时无法读取 Memory Bot，请检查后端连接与配置。');
    } finally {
      setLoading(false);
    }
  }, [loadSession, sessionId]);

  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(() => {
      void load();
    }, 0);
    return () => clearTimeout(timer);
  }, [visible, load]);

  const refreshActivity = useCallback(async () => {
    const [tasksRes, eventsRes, sessionsRes, approvalsRes] = await Promise.all([
      apiFetch(API_PATHS.agentTasks('memory', 20)),
      apiFetch(API_PATHS.agentEvents('memory', 30)),
      apiFetch(API_PATHS.agentSessions('memory')),
      apiFetch(API_PATHS.agentApprovals('memory', 50)),
    ]);
    if (tasksRes.ok) setTasks(((await tasksRes.json()) as AgentTasksResponse).tasks || []);
    if (eventsRes.ok) setEvents(((await eventsRes.json()) as AgentEventsResponse).events || []);
    if (sessionsRes.ok) setSessions(((await sessionsRes.json()) as AgentSessionsResponse).sessions || []);
    if (approvalsRes.ok) setApprovals(((await approvalsRes.json()) as AgentApprovalsResponse).approvals || []);
  }, []);

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    setError('');
    setNotice('');
    const localUserId = `local-${Date.now()}`;
    const streamId = `stream-${Date.now()}`;
    setMessages(prev => [
      ...prev,
      {
        id: localUserId,
        role: 'user',
        content: text,
        createdAt: new Date().toISOString(),
      },
      emptyAgentMessage(streamId),
    ]);
    setInput('');

    const fallback = async () => {
      setMessages(prev => prev.filter(message => message.id !== streamId));
      const response = await apiFetch(API_PATHS.agentChat('memory'), {
        method: 'POST',
        body: JSON.stringify({ sessionId, message: text }),
      });
      const data = (await response.json()) as AgentChatResponse & { error?: string };
      if (!response.ok) throw new Error(data.error || '发送失败');
      setSessionId(data.sessionId);
      setMessages(prev => [...prev, data.message]);
      await refreshActivity();
    };

    try {
      const outcome = await sendAgentChatStream('memory', { sessionId, message: text }, {
        onDelta: delta => {
          setMessages(prev =>
            prev.map(message =>
              message.id === streamId
                ? { ...message, content: `${message.content}${delta}` }
                : message
            )
          );
          setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 20);
        },
        onToolEvent: event => {
          if (event.type !== 'tool_end') return;
          setMessages(prev =>
            prev.map(message => {
              if (message.id !== streamId) return message;
              const steps = Array.isArray(message.toolSteps) ? message.toolSteps : [];
              const nextStep = {
                name: event.name,
                ok: event.ok === true,
                summary: event.summary || (event.ok ? '执行成功' : '执行失败'),
                durationMs: 0,
              };
              return {
                ...message,
                toolSteps: [...steps.filter(step => step.name !== event.name), nextStep],
              };
            })
          );
        },
      });

      if (outcome.kind === 'done') {
        setSessionId(outcome.data.sessionId);
        setMessages(prev =>
          prev.map(message => (message.id === streamId ? outcome.data.message : message))
        );
        await refreshActivity();
      } else if (outcome.kind === 'fallback') {
        await fallback();
      } else if (outcome.kind === 'aborted') {
        setError('流式请求已取消');
      } else {
        setError(outcome.message);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '发送失败');
    } finally {
      setSending(false);
    }
  };


  const createSession = async () => {
    setSaving(true);
    setError('');
    try {
      const response = await apiFetch(API_PATHS.agentSessions('memory'), {
        method: 'POST',
        body: JSON.stringify({ title: '新对话' }),
      });
      if (!response.ok) throw new Error('创建会话失败');
      const data = (await response.json()) as { session: AgentSession };
      setSessions(prev => [data.session, ...prev]);
      setSessionId(data.session.id);
      setMessages([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建会话失败');
    } finally {
      setSaving(false);
    }
  };

  const saveConfig = async () => {
    if (!config) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const response = await apiFetch(API_PATHS.agentConfig('memory'), {
        method: 'PUT',
        body: JSON.stringify({
          enabled: config.enabled,
          modelProfile: {
            providerId: config.modelProfile.providerId,
            modelId: config.modelProfile.modelId,
            temperature: config.modelProfile.temperature,
            maxTokens: config.modelProfile.maxTokens,
            timeoutMs: config.modelProfile.timeoutMs,
          },
          prompt: { systemPrompt: config.prompt.systemPrompt, version: config.prompt.version },
          toolAllowlist: config.toolAllowlist,
        }),
      });
      const data = (await response.json()) as AgentConfigResponse & { error?: string };
      if (!response.ok) throw new Error(data.error || '保存失败');
      setConfig(data.config);
      setAgent(data.agent);
      setNotice('配置已保存。');
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const saveKey = async () => {
    if (!config?.modelProfile.providerId) {
      setError('请先选择模型服务商，再保存 API Key。');
      return;
    }
    if (!keyInput.trim()) {
      setError('请输入 API Key。');
      return;
    }
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const response = await apiFetch(API_PATHS.agentCredentials('memory'), {
        method: 'POST',
        body: JSON.stringify({
          providerId: config.modelProfile.providerId,
          apiKey: keyInput.trim(),
        }),
      });
      const data = (await response.json()) as { error?: string; agent?: AgentSummary; credential?: { keyHint: string } };
      if (!response.ok) throw new Error(data.error || '保存失败');
      setKeyInput('');
      if (data.agent) setAgent(data.agent);
      const refreshed = await apiFetch(API_PATHS.agentConfig('memory'));
      if (refreshed.ok) {
        setConfig(((await refreshed.json()) as AgentConfigResponse).config);
      }
      setNotice(`API Key 已加密保存（${data.credential?.keyHint || '已配置'}）。`);
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const verifyKey = async () => {
    if (!agent?.credential) {
      setError('当前没有可验证的 API Key。');
      return;
    }
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const response = await apiFetch(API_PATHS.agentCredentialVerify('memory'), {
        method: 'POST',
        body: JSON.stringify({ credentialId: agent.credential.credentialId }),
      });
      const data = (await response.json()) as AgentVerifyResponse;
      if (!response.ok) throw new Error(data.error || '验证失败');
      if (data.agent) setAgent(data.agent);
      setNotice(
        data.ok
          ? `Key 验证通过（${data.latencyMs}ms）。`
          : `Key 验证失败：${data.error || data.code}`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : '验证失败');
    } finally {
      setSaving(false);
    }
  };

  const deleteKey = async () => {
    if (!agent?.credential) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const response = await apiFetch(
        API_PATHS.agentCredential('memory', agent.credential.credentialId),
        { method: 'DELETE' }
      );
      const data = (await response.json()) as { error?: string; agent?: AgentSummary };
      if (!response.ok) throw new Error(data.error || '删除失败');
      if (data.agent) setAgent(data.agent);
      setNotice('API Key 已删除。');
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败');
    } finally {
      setSaving(false);
    }
  };

  const toggleTool = (name: string) => {
    if (!config) return;
    const selected = config.toolAllowlist.includes(name);
    setConfig({
      ...config,
      toolAllowlist: selected
        ? config.toolAllowlist.filter(item => item !== name)
        : [...config.toolAllowlist, name],
    });
  };

  const createTask = async () => {
    const goal = taskGoal.trim();
    if (!goal || taskBusy) return;
    setTaskBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await apiFetch(API_PATHS.agentTaskCreate, {
        method: 'POST',
        body: JSON.stringify({
          botId: 'memory',
          taskType,
          goal,
          allowedTools: config?.toolAllowlist,
          deadlineMs: 60000,
        }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error || '创建任务失败');
      setTaskGoal('');
      await refreshActivity();
      setNotice('任务已提交，进度来自服务端任务状态。');
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建任务失败');
    } finally {
      setTaskBusy(false);
    }
  };

  const actOnApproval = async (
    approval: AgentApproval,
    action: 'approve' | 'reject' | 'execute'
  ) => {
    if (approvalBusy) return;
    setApprovalBusy(approval.approvalId);
    setError('');
    setNotice('');
    try {
      const path =
        action === 'approve'
          ? API_PATHS.agentApprovalApprove(approval.approvalId)
          : action === 'reject'
            ? API_PATHS.agentApprovalReject(approval.approvalId)
            : API_PATHS.agentApprovalExecute(approval.approvalId);
      const response = await apiFetch(path, {
        method: 'POST',
        body: JSON.stringify(
          action === 'reject' ? { reason: '用户拒绝' } : {}
        ),
      });
      const data = (await response.json()) as { error?: string; approval?: AgentApproval };
      if (!response.ok) throw new Error(data.error || '审批操作失败');
      await refreshActivity();
      setNotice(
        action === 'execute'
          ? '审批操作已执行，结果来自记忆服务。'
          : action === 'approve'
            ? '审批已批准，尚未执行。'
            : '审批已拒绝。'
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : '审批操作失败');
    } finally {
      setApprovalBusy('');
    }
  };

  const selectedProvider =
    providers.find(item => item.id === config?.modelProfile.providerId) || null;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.root}>
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose} style={styles.back} accessibilityLabel="返回">
            <Text style={styles.backText}>‹</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Memory Bot</Text>
          <TouchableOpacity
            onPress={() => void load()}
            disabled={loading}
            style={styles.refresh}
            accessibilityLabel="刷新 Memory Bot"
          >
            <Text style={styles.refreshText}>{loading ? '···' : '↻'}</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.tabs}>
          {(['chat', 'config', 'activity'] as Tab[]).map(item => (
            <TouchableOpacity
              key={item}
              style={[styles.tab, tab === item && styles.tabActive]}
              onPress={() => setTab(item)}
              accessibilityRole="button"
              accessibilityLabel={
                item === 'chat'
                  ? '独立对话页签'
                  : item === 'config'
                    ? '模型与 Key页签'
                    : '任务与事件页签'
              }
            >
              <Text style={[styles.tabText, tab === item && styles.tabTextActive]}>
                {item === 'chat' ? '独立对话' : item === 'config' ? '模型与 Key' : '任务与事件'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {agent && (
          <View style={styles.statusLine}>
            <View
              style={[
                styles.statusDot,
                {
                  backgroundColor:
                    agent.status === 'enabled' ? theme.online : theme.warning,
                },
              ]}
            />
            <Text style={styles.statusLabel}>
              {STATUS_LABEL[agent.status] || agent.status}
              {agent.model.modelId ? ` · ${agent.model.modelId}` : ''}
            </Text>
            {agent.credential && (
              <Text style={styles.statusKey}>{agent.credential.keyHint}</Text>
            )}
          </View>
        )}

        {error ? <Text style={styles.error}>{error}</Text> : null}
        {notice ? <Text style={styles.notice}>{notice}</Text> : null}

        {tab === 'chat' ? (
          <View style={styles.flex}>
            <ScrollView
              ref={scrollRef}
              style={styles.flex}
              contentContainerStyle={styles.chatContent}
              onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
            >
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.sessionBar}>
                <TouchableOpacity style={styles.newSession} onPress={() => void createSession()}>
                  <Text style={styles.newSessionText}>＋ 新对话</Text>
                </TouchableOpacity>
                {sessions.map(session => (
                  <TouchableOpacity
                    key={session.id}
                    style={[styles.sessionChip, sessionId === session.id && styles.sessionChipActive]}
                    onPress={() => {
                      setError('');
                      void loadSession(session.id).catch(() => setError('读取会话失败'));
                    }}
                  >
                    <Text
                      style={[
                        styles.sessionChipText,
                        sessionId === session.id && styles.sessionChipTextActive,
                      ]}
                      numberOfLines={1}
                    >
                      {session.title}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>

              {messages.length === 0 ? (
                <View style={styles.chatEmpty}>
                  <Text style={styles.chatEmptyTitle}>和 Memory Bot 聊聊记忆</Text>
                  <Text style={styles.chatEmptyText}>
                    它会检索你的长期记忆，说明来源与不确定性；写入只提交候选，不绕过生命周期。
                  </Text>
                </View>
              ) : (
                messages.map(message => (
                  <View
                    key={message.id}
                    style={[
                      styles.messageRow,
                      message.role === 'user' && styles.messageRowUser,
                    ]}
                  >
                    <View
                      style={[
                        styles.messageBubble,
                        message.role === 'user' && styles.userBubble,
                      ]}
                    >
                      {message.role === 'assistant' ? (
                        <MarkdownMessage content={message.content} theme={theme} />
                      ) : (
                        <Text style={styles.userText}>{message.content}</Text>
                      )}
                    </View>
                    {message.role === 'assistant' && message.toolSteps && message.toolSteps.length > 0 && (
                      <View style={styles.toolLine}>
                        {message.toolSteps.map((step, index) => (
                          <Text key={`${message.id}-${index}`} style={styles.toolText}>
                            {step.ok ? '✓' : '!'} {step.name} · {step.summary}
                          </Text>
                        ))}
                      </View>
                    )}
                  </View>
                ))
              )}
              {sending && (
                <View style={styles.typing}>
                  <ActivityIndicator size="small" color={theme.accent} />
                  <Text style={styles.typingText}>Memory Bot 正在检索…</Text>
                </View>
              )}
            </ScrollView>

            <View style={styles.composer}>
              <TextInput
                style={styles.input}
                value={input}
                onChangeText={setInput}
                placeholder="问问你的记忆，或让我整理一条候选…"
                placeholderTextColor={theme.textMuted}
                multiline
                maxLength={4000}
                editable={!sending}
              />
              <TouchableOpacity
                style={[styles.sendButton, (!input.trim() || sending) && styles.sendDisabled]}
                onPress={() => void send()}
                disabled={!input.trim() || sending}
                accessibilityLabel="发送给 Memory Bot"
              >
                <Text style={styles.sendText}>{sending ? '···' : '↑'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : tab === 'config' ? (
          <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
            <Text style={styles.sectionTitle}>独立模型</Text>
            <Text style={styles.sectionHint}>
              Memory Bot 使用自己的 Provider、模型和加密 Key，不会继承主控默认 Key。
            </Text>

            {config ? (
              <>
                <TouchableOpacity
                  style={styles.enableRow}
                  onPress={() => setConfig({ ...config, enabled: !config.enabled })}
                >
                  <View>
                    <Text style={styles.enableLabel}>启用 Memory Bot</Text>
                    <Text style={styles.enableHint}>停用后独立对话与委派任务都会被拒绝</Text>
                  </View>
                  <Text style={[styles.enableState, { color: config.enabled ? theme.online : theme.textMuted }]}>
                    {config.enabled ? '已启用' : '已停用'}
                  </Text>
                </TouchableOpacity>

                <Text style={styles.fieldLabel}>服务商</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.choiceRow}>
                  {providers.map(provider => {
                    const selected = config.modelProfile.providerId === provider.id;
                    return (
                      <TouchableOpacity
                        key={provider.id}
                        style={[styles.choice, selected && styles.choiceSelected]}
                        onPress={() =>
                          setConfig({
                            ...config,
                            modelProfile: {
                              ...config.modelProfile,
                              providerId: provider.id,
                              modelId: provider.models[0]?.id || '',
                            },
                          })
                        }
                      >
                        <Text style={[styles.choiceText, selected && styles.choiceTextSelected]}>
                          {provider.name}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>

                <Text style={styles.fieldLabel}>模型</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.choiceRow}>
                  {(selectedProvider?.models || []).map(model => {
                    const selected = config.modelProfile.modelId === model.id;
                    return (
                      <TouchableOpacity
                        key={model.id}
                        style={[styles.choice, selected && styles.choiceSelected]}
                        onPress={() =>
                          setConfig({
                            ...config,
                            modelProfile: { ...config.modelProfile, modelId: model.id },
                          })
                        }
                      >
                        <Text style={[styles.choiceText, selected && styles.choiceTextSelected]}>
                          {model.id}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>

                <View style={styles.inlineFields}>
                  <LabeledInput
                    label="温度"
                    value={String(config.modelProfile.temperature)}
                    onChangeText={value =>
                      setConfig({
                        ...config,
                        modelProfile: {
                          ...config.modelProfile,
                          temperature: Number(value) || 0,
                        },
                      })
                    }
                    styles={styles}
                  />
                  <LabeledInput
                    label="最大 tokens"
                    value={String(config.modelProfile.maxTokens)}
                    onChangeText={value =>
                      setConfig({
                        ...config,
                        modelProfile: {
                          ...config.modelProfile,
                          maxTokens: Number(value) || 0,
                        },
                      })
                    }
                    styles={styles}
                  />
                </View>

                <Text style={styles.sectionTitle}>Prompt</Text>
                <Text style={styles.sectionHint}>
                  只影响 Memory Bot 的系统指令；不会写入会话消息或运行事件。
                </Text>
                <TextInput
                  style={styles.promptInput}
                  value={config.prompt.systemPrompt}
                  onChangeText={value =>
                    setConfig({ ...config, prompt: { ...config.prompt, systemPrompt: value } })
                  }
                  multiline
                  maxLength={8000}
                  textAlignVertical="top"
                  placeholder="Memory Bot 的系统 Prompt"
                  placeholderTextColor={theme.textMuted}
                />

                <Text style={styles.fieldLabel}>工具白名单</Text>
                <View style={styles.toolGrid}>
                  {(agent?.availableTools || []).map(name => {
                    const selected = config.toolAllowlist.includes(name);
                    return (
                      <TouchableOpacity
                        key={name}
                        style={[styles.toolChip, selected && styles.toolChipSelected]}
                        onPress={() => toggleTool(name)}
                      >
                        <Text
                          style={[
                            styles.toolChipText,
                            selected && styles.toolChipTextSelected,
                          ]}
                        >
                          {selected ? '✓ ' : ''}
                          {name}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
                <Text style={styles.toolHint}>
                  只能缩小 Manifest 声明的工具集合；维护类操作不在这里，需走人工审批。
                </Text>

                <TouchableOpacity
                  style={styles.primaryButton}
                  onPress={() => void saveConfig()}
                  disabled={saving}
                >
                  <Text style={styles.primaryButtonText}>{saving ? '保存中…' : '保存配置'}</Text>
                </TouchableOpacity>

                <Text style={styles.sectionTitle}>独立 API Key</Text>
                <Text style={styles.sectionHint}>
                  只通过服务端加密保存；读取接口只返回脱敏提示，不提供查看完整 Key。
                </Text>
                <View style={styles.credentialCard}>
                  <View style={styles.credentialHead}>
                    <Text style={styles.credentialLabel}>当前凭证</Text>
                    <Text style={styles.credentialValue}>
                      {agent?.credential ? agent.credential.keyHint : '未配置'}
                    </Text>
                  </View>
                  {agent?.credential?.lastVerifiedAt && (
                    <Text style={styles.credentialMeta}>
                      最近验证：{agent.credential.lastVerifiedAt}
                      {agent.credential.lastVerifyOk ? ' · 通过' : ' · 失败'}
                    </Text>
                  )}
                  <TextInput
                    style={styles.keyInput}
                    value={keyInput}
                    onChangeText={setKeyInput}
                    placeholder="粘贴该 Bot 专用 API Key"
                    placeholderTextColor={theme.textMuted}
                    secureTextEntry
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                  <View style={styles.keyActions}>
                    <TouchableOpacity style={styles.secondaryButton} onPress={() => void saveKey()}>
                      <Text style={styles.secondaryButtonText}>加密保存</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.secondaryButton} onPress={() => void verifyKey()}>
                      <Text style={styles.secondaryButtonText}>验证</Text>
                    </TouchableOpacity>
                    {agent?.credential && (
                      <TouchableOpacity style={styles.dangerButton} onPress={() => void deleteKey()}>
                        <Text style={styles.dangerButtonText}>删除</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                </View>

                <Text style={styles.note}>
                  Key 不会进入 Prompt、工具参数、事件或普通日志；修改 Memory Bot 的配置不会改变主控默认模型。
                </Text>
              </>
            ) : (
              <Text style={styles.hint}>正在读取配置…</Text>
            )}
          </ScrollView>
        ) : (
          <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
            <Text style={styles.sectionTitle}>创建委派任务</Text>
            <Text style={styles.sectionHint}>
              任务由主控提交、Memory Bot 执行；状态和结果只来自服务端任务存储。
            </Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.choiceRow}>
              {(agent?.acceptedTaskTypes || ['memory.search']).map(type => (
                <TouchableOpacity
                  key={type}
                  style={[styles.choice, taskType === type && styles.choiceSelected]}
                  onPress={() => setTaskType(type)}
                >
                  <Text
                    style={[
                      styles.choiceText,
                      taskType === type && styles.choiceTextSelected,
                    ]}
                  >
                    {type}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            <TextInput
              style={styles.taskInput}
              value={taskGoal}
              onChangeText={setTaskGoal}
              placeholder="任务目标，例如：整理我关于咖啡的长期记忆"
              placeholderTextColor={theme.textMuted}
              maxLength={2000}
              editable={!taskBusy}
            />
            <TouchableOpacity
              style={[styles.secondaryButton, styles.taskSubmit]}
              onPress={() => void createTask()}
              disabled={taskBusy || !taskGoal.trim()}
            >
              <Text style={styles.secondaryButtonText}>
                {taskBusy ? '提交中…' : '提交任务'}
              </Text>
            </TouchableOpacity>

            <View style={styles.activityHead}>
              <Text style={styles.sectionTitle}>任务</Text>
              <TouchableOpacity onPress={() => void refreshActivity()}>
                <Text style={styles.refreshLink}>刷新</Text>
              </TouchableOpacity>
            </View>
            {tasks.length === 0 ? (
              <Text style={styles.hint}>还没有主控委派任务。</Text>
            ) : (
              tasks.map(task => (
                <View key={task.taskId} style={styles.taskCard}>
                  <View style={styles.taskHead}>
                    <Text style={styles.taskType}>{task.taskType}</Text>
                    <Text style={styles.taskStatus}>{TASK_LABEL[task.status] || task.status}</Text>
                  </View>
                  <Text style={styles.taskGoal}>{task.goal}</Text>
                  {task.result?.summary ? (
                    <Text style={styles.taskSummary} numberOfLines={4}>
                      {task.result.summary}
                    </Text>
                  ) : null}
                  <Text style={styles.taskMeta}>
                    {task.taskId} · {task.completedAt || task.createdAt}
                  </Text>
                </View>
              ))
            )}

            <Text style={styles.sectionTitle}>人工审批</Text>
            <Text style={styles.sectionHint}>
              高风险记忆维护必须先申请；未批准不能执行，执行结果来自记忆服务。
            </Text>
            {approvals.length === 0 ? (
              <Text style={styles.hint}>暂无审批申请。</Text>
            ) : (
              approvals.map(approval => (
                <View key={approval.approvalId} style={styles.approvalCard}>
                  <View style={styles.taskHead}>
                    <Text style={styles.taskType}>
                      {approval.operation} · {approval.risk}
                    </Text>
                    <Text style={styles.taskStatus}>{approval.status}</Text>
                  </View>
                  <Text style={styles.taskMeta}>
                    {String(
                      approval.payload.id ||
                        approval.payload.targetId ||
                        approval.approvalId
                    )}
                  </Text>
                  {approvalPreview(approval) ? (
                    <Text style={styles.taskSummary} numberOfLines={3}>
                      {approvalPreview(approval)}
                    </Text>
                  ) : null}
                  {approval.result ? (
                    <Text style={styles.taskSummary} numberOfLines={2}>
                      {JSON.stringify(approval.result)}
                    </Text>
                  ) : null}
                  <View style={styles.approvalActions}>
                    {approval.status === 'pending' && (
                      <>
                        <TouchableOpacity
                          style={styles.secondaryButton}
                          onPress={() => void actOnApproval(approval, 'approve')}
                          disabled={!!approvalBusy}
                        >
                          <Text style={styles.secondaryButtonText}>批准</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={styles.dangerButton}
                          onPress={() => void actOnApproval(approval, 'reject')}
                          disabled={!!approvalBusy}
                        >
                          <Text style={styles.dangerButtonText}>拒绝</Text>
                        </TouchableOpacity>
                      </>
                    )}
                    {approval.status === 'approved' && (
                      <TouchableOpacity
                        style={styles.primaryButtonSmall}
                        onPress={() => void actOnApproval(approval, 'execute')}
                        disabled={!!approvalBusy}
                      >
                        <Text style={styles.primaryButtonText}>执行</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                </View>
              ))
            )}

            <Text style={styles.sectionTitle}>运行事件</Text>
            {events.length === 0 ? (
              <Text style={styles.hint}>还没有运行事件。</Text>
            ) : (
              events.map(event => (
                <View key={event.eventId} style={styles.eventRow}>
                  <Text style={styles.eventType}>{event.eventType}</Text>
                  <Text style={styles.eventTime}>{event.timestamp}</Text>
                </View>
              ))
            )}
            <Text style={styles.note}>
              事件只包含安全字段：状态、工具名、耗时与错误码；不包含 Prompt、Key、记忆正文或模型推理。
            </Text>
            {onOpenMemory && (
              <TouchableOpacity style={styles.memoryLink} onPress={onOpenMemory}>
                <Text style={styles.memoryLinkText}>打开 Memory Center 记忆工作区</Text>
                <Text style={styles.memoryLinkArrow}>›</Text>
              </TouchableOpacity>
            )}
          </ScrollView>
        )}
      </SafeAreaView>
    </Modal>
  );
}

function approvalPreview(approval: AgentApproval): string {
  const payload = approval.payload || {};
  const replacement = payload.replacement as Record<string, unknown> | undefined;
  const content =
    (replacement && typeof replacement.content === 'string' ? replacement.content : '') ||
    (typeof payload.content === 'string' ? payload.content : '');
  if (content) return content.slice(0, 180);
  const target = typeof payload.targetId === 'string' ? payload.targetId : '';
  const sources = Array.isArray(payload.sourceIds) ? payload.sourceIds.join(', ') : '';
  if (target || sources) return `目标：${target || '—'}${sources ? `；来源：${sources}` : ''}`;
  return typeof payload.id === 'string' ? `目标：${payload.id}` : '';
}

function LabeledInput({
  label,
  value,
  onChangeText,
  styles,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  styles: ReturnType<typeof createStyles>;
}) {
  return (
    <View style={styles.labeledInput}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={styles.smallInput}
        value={value}
        onChangeText={onChangeText}
        keyboardType="numeric"
      />
    </View>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: theme.background },
    flex: { flex: 1 },
    header: {
      height: 52,
      paddingHorizontal: 16,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    back: { width: 40, height: 40, justifyContent: 'center' },
    backText: { color: theme.textSecondary, fontSize: 27, lineHeight: 31 },
    headerTitle: { color: theme.textPrimary, fontSize: 14, fontWeight: '600' },
    refresh: { width: 40, height: 40, alignItems: 'flex-end', justifyContent: 'center' },
    refreshText: { color: theme.textSecondary, fontSize: 18 },
    tabs: {
      flexDirection: 'row',
      marginHorizontal: 20,
      padding: 3,
      borderRadius: 12,
      backgroundColor: theme.surfaceAlt,
      gap: 3,
    },
    tab: { flex: 1, borderRadius: 9, paddingVertical: 8, alignItems: 'center' },
    tabActive: { backgroundColor: theme.surface },
    tabText: { color: theme.textMuted, fontSize: 12, fontWeight: '500' },
    tabTextActive: { color: theme.textPrimary, fontWeight: '600' },
    statusLine: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 7,
      paddingHorizontal: 20,
      paddingTop: 10,
    },
    statusDot: { width: 7, height: 7, borderRadius: 4 },
    statusLabel: { color: theme.textSecondary, fontSize: 11, flex: 1 },
    statusKey: { color: theme.textMuted, fontSize: 10, fontFamily: 'monospace' },
    error: { paddingHorizontal: 20, paddingTop: 8, color: theme.warning, fontSize: 11 },
    notice: { paddingHorizontal: 20, paddingTop: 8, color: theme.online, fontSize: 11 },
    chatContent: { paddingHorizontal: 20, paddingTop: 14, paddingBottom: 20 },
    sessionBar: { maxHeight: 36, marginBottom: 10 },
    newSession: {
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 999,
      backgroundColor: theme.accent,
      marginRight: 8,
    },
    newSessionText: { color: '#fff', fontSize: 11, fontWeight: '600' },
    sessionChip: {
      maxWidth: 150,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 999,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.borderStrong,
      marginRight: 8,
    },
    sessionChipActive: { backgroundColor: theme.surface, borderColor: theme.accent },
    sessionChipText: { color: theme.textMuted, fontSize: 11 },
    sessionChipTextActive: { color: theme.textPrimary, fontWeight: '600' },
    chatEmpty: {
      marginTop: 30,
      padding: 18,
      borderRadius: 18,
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
    },
    chatEmptyTitle: { color: theme.textPrimary, fontSize: 16, fontWeight: '600' },
    chatEmptyText: { marginTop: 7, color: theme.textSecondary, fontSize: 12, lineHeight: 19 },
    messageRow: { marginTop: 14, alignItems: 'flex-start' },
    messageRowUser: { alignItems: 'flex-end' },
    messageBubble: { maxWidth: '88%' },
    userBubble: {
      backgroundColor: theme.surface,
      borderRadius: 16,
      paddingHorizontal: 13,
      paddingVertical: 10,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
    },
    userText: { color: theme.textBody, fontSize: 14, lineHeight: 21 },
    toolLine: { marginTop: 5, maxWidth: '88%' },
    toolText: { color: theme.textMuted, fontSize: 10, lineHeight: 16 },
    typing: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 14 },
    typingText: { color: theme.textMuted, fontSize: 11 },
    composer: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      gap: 8,
      paddingHorizontal: 16,
      paddingTop: 8,
      paddingBottom: 10,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
    },
    input: {
      flex: 1,
      maxHeight: 110,
      minHeight: 42,
      borderRadius: 18,
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      paddingHorizontal: 14,
      paddingVertical: 10,
      color: theme.textBody,
      fontSize: 14,
    },
    sendButton: {
      width: 42,
      height: 42,
      borderRadius: 16,
      backgroundColor: theme.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    sendDisabled: { opacity: 0.4 },
    sendText: { color: '#fff', fontSize: 18, fontWeight: '600' },
    content: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 40 },
    sectionTitle: {
      marginTop: 18,
      color: theme.textPrimary,
      fontSize: 16,
      fontWeight: '600',
    },
    sectionHint: {
      marginTop: 6,
      color: theme.textSecondary,
      fontSize: 11,
      lineHeight: 17,
    },
    fieldLabel: {
      marginTop: 14,
      color: theme.textMuted,
      fontSize: 10,
      letterSpacing: 0.4,
    },
    enableRow: {
      marginTop: 14,
      padding: 13,
      borderRadius: 14,
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    enableLabel: { color: theme.textBody, fontSize: 13, fontWeight: '600' },
    enableHint: { marginTop: 3, color: theme.textMuted, fontSize: 10 },
    enableState: { fontSize: 11, fontWeight: '600' },
    choiceRow: { marginTop: 7, maxHeight: 36 },
    choice: {
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 999,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.borderStrong,
      marginRight: 8,
    },
    choiceSelected: { backgroundColor: theme.accent, borderColor: theme.accent },
    choiceText: { color: theme.textMuted, fontSize: 11 },
    choiceTextSelected: { color: '#fff', fontWeight: '600' },
    inlineFields: { flexDirection: 'row', gap: 12 },
    labeledInput: { flex: 1 },
    smallInput: {
      marginTop: 6,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      backgroundColor: theme.surface,
      paddingHorizontal: 12,
      paddingVertical: 9,
      color: theme.textBody,
      fontSize: 13,
    },
    promptInput: {
      marginTop: 8,
      minHeight: 128,
      borderRadius: 14,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.borderStrong,
      backgroundColor: theme.surface,
      paddingHorizontal: 12,
      paddingVertical: 10,
      color: theme.textBody,
      fontSize: 12,
      lineHeight: 19,
    },
    toolGrid: {
      marginTop: 8,
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 8,
    },
    toolChip: {
      paddingHorizontal: 11,
      paddingVertical: 8,
      borderRadius: 999,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.borderStrong,
    },
    toolChipSelected: {
      backgroundColor: theme.accent,
      borderColor: theme.accent,
    },
    toolChipText: { color: theme.textMuted, fontSize: 10, fontFamily: 'monospace' },
    toolChipTextSelected: { color: '#fff' },
    toolHint: { marginTop: 7, color: theme.textMuted, fontSize: 10, lineHeight: 15 },
    primaryButton: {
      marginTop: 20,
      height: 44,
      borderRadius: 14,
      backgroundColor: theme.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    primaryButtonText: { color: '#fff', fontSize: 13, fontWeight: '600' },
    credentialCard: {
      marginTop: 10,
      padding: 14,
      borderRadius: 16,
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
    },
    credentialHead: { flexDirection: 'row', justifyContent: 'space-between' },
    credentialLabel: { color: theme.textSecondary, fontSize: 12 },
    credentialValue: { color: theme.textBody, fontSize: 12, fontFamily: 'monospace' },
    credentialMeta: { marginTop: 5, color: theme.textMuted, fontSize: 10 },
    keyInput: {
      marginTop: 12,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.borderStrong,
      backgroundColor: theme.background,
      paddingHorizontal: 12,
      paddingVertical: 10,
      color: theme.textBody,
      fontSize: 13,
    },
    keyActions: { flexDirection: 'row', gap: 8, marginTop: 10 },
    secondaryButton: {
      flex: 1,
      height: 36,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.borderStrong,
      alignItems: 'center',
      justifyContent: 'center',
    },
    secondaryButtonText: { color: theme.textBody, fontSize: 11, fontWeight: '500' },
    dangerButton: {
      flex: 1,
      height: 36,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.warning,
      alignItems: 'center',
      justifyContent: 'center',
    },
    dangerButtonText: { color: theme.warning, fontSize: 11, fontWeight: '500' },
    note: { marginTop: 18, color: theme.textMuted, fontSize: 10, lineHeight: 16 },
    memoryLink: {
      marginTop: 16,
      height: 42,
      borderRadius: 13,
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.borderStrong,
      paddingHorizontal: 14,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    memoryLinkText: { color: theme.textBody, fontSize: 12, fontWeight: '500' },
    memoryLinkArrow: { color: theme.textMuted, fontSize: 18 },
    hint: { marginTop: 12, color: theme.textMuted, fontSize: 11 },
    activityHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' },
    refreshLink: { color: theme.accent, fontSize: 11 },
    taskInput: {
      marginTop: 10,
      borderRadius: 14,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.borderStrong,
      backgroundColor: theme.surface,
      paddingHorizontal: 12,
      paddingVertical: 10,
      color: theme.textBody,
      fontSize: 12,
    },
    taskSubmit: { marginTop: 8, flex: 0 },
    approvalCard: {
      marginTop: 10,
      padding: 13,
      borderRadius: 14,
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
    },
    approvalActions: { flexDirection: 'row', gap: 8, marginTop: 10 },
    primaryButtonSmall: {
      flex: 1,
      height: 36,
      borderRadius: 12,
      backgroundColor: theme.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    taskCard: {
      marginTop: 10,
      padding: 13,
      borderRadius: 14,
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
    },
    taskHead: { flexDirection: 'row', justifyContent: 'space-between' },
    taskType: { color: theme.textBody, fontSize: 12, fontWeight: '600' },
    taskStatus: { color: theme.textMuted, fontSize: 11 },
    taskGoal: { marginTop: 6, color: theme.textSecondary, fontSize: 12, lineHeight: 18 },
    taskSummary: { marginTop: 6, color: theme.textMuted, fontSize: 11, lineHeight: 17 },
    taskMeta: { marginTop: 7, color: theme.textMuted, fontSize: 9, fontFamily: 'monospace' },
    eventRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingVertical: 9,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
    },
    eventType: { color: theme.textBody, fontSize: 11, fontFamily: 'monospace' },
    eventTime: { color: theme.textMuted, fontSize: 9 },
  });
