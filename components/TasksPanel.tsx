import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import type { Theme } from '../theme';
import { CHAT_LAYOUT, CHAT_TYPE } from '../lib/design';
import { apiFetch } from '../lib/api/client';
import { API_PATHS } from '../lib/api/endpoints';
import type { AgentTask, AgentTasksResponse } from '../lib/api/types';

const STATUS_LABEL: Record<string, string> = {
  queued: '排队中',
  accepted: '已接收',
  running: '执行中',
  waiting_approval: '等待审批',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  timed_out: '超时',
};

/**
 * 主控任务页：只显示服务端真实任务。主控派发使用
 * POST /agent-tasks 的 parentSessionId，任务完成后结果也会写回当前会话。
 */
export function TasksPanel({
  theme,
  sessionId,
}: {
  theme: Theme;
  sessionId: string;
}) {
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    setError('');
    try {
      const response = await apiFetch(
        API_PATHS.agentTasks('memory', 30) +
          `&parentSessionId=${encodeURIComponent(sessionId)}`
      );
      if (!response.ok) throw new Error('failed');
      const data = (await response.json()) as AgentTasksResponse;
      setTasks(data.tasks || []);
    } catch {
      setError('暂时无法读取任务，请检查后端连接。');
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void load();
    }, 0);
    const interval = setInterval(() => {
      void load();
    }, 4000);
    return () => {
      clearTimeout(timer);
      clearInterval(interval);
    };
  }, [load]);

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.head}>
        <View>
          <Text style={styles.title}>任务</Text>
          <Text style={styles.subtitle}>主控派发给 Memory Bot 的真实任务</Text>
        </View>
        <TouchableOpacity
          onPress={() => void load()}
          disabled={loading}
          accessibilityLabel="刷新任务"
          style={styles.refresh}
        >
          <Text style={styles.refreshText}>{loading ? '···' : '↻'}</Text>
        </TouchableOpacity>
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {!loading && !error && tasks.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>还没有任务</Text>
          <Text style={styles.emptyText}>
            当主控把记忆任务派发给 Memory Bot 时，这里会显示排队、执行与真实结果。
          </Text>
        </View>
      ) : null}

      {tasks.map(task => (
        <View key={task.taskId} style={styles.card}>
          <View style={styles.cardHead}>
            <Text style={styles.taskType}>{task.taskType}</Text>
            <Text
              style={[
                styles.status,
                {
                  color:
                    task.status === 'completed'
                      ? theme.online
                      : task.status === 'failed' ||
                          task.status === 'timed_out' ||
                          task.status === 'cancelled'
                        ? theme.danger
                        : theme.warning,
                },
              ]}
            >
              {STATUS_LABEL[task.status] || task.status}
            </Text>
          </View>
          <Text style={styles.goal}>{task.goal}</Text>
          <Text style={styles.meta}>
            {task.taskId} · 尝试 {task.attempts}/{task.maxAttempts} ·{' '}
            {task.completedAt || task.createdAt}
            {task.deliveredToParentAt ? ' · 已回传主控' : ''}
          </Text>

          {task.result ? (
            <View style={styles.result}>
              <Text style={styles.resultLabel}>Memory Bot 结果</Text>
              <Text style={styles.resultText}>{task.result.summary}</Text>
              {task.result.toolSteps.length ? (
                <Text style={styles.resultMeta}>
                  工具：{task.result.toolSteps.map(step => step.name).join('、')}
                </Text>
              ) : null}
              {task.result.evidence.length ? (
                <Text style={styles.resultMeta}>
                  证据 ID：
                  {task.result.evidence
                    .slice(0, 6)
                    .map(item => `${item.kind}:${item.id}`)
                    .join('、')}
                </Text>
              ) : null}
              {task.result.requiresConfirmation ? (
                <Text style={styles.pending}>需要用户确认后才会执行维护操作。</Text>
              ) : null}
            </View>
          ) : task.errorCode ? (
            <Text style={styles.errorCode}>错误码：{task.errorCode}</Text>
          ) : task.deliveryErrorCode ? (
            <Text style={styles.errorCode}>回传失败：{task.deliveryErrorCode}</Text>
          ) : (
            <Text style={styles.running}>
              {task.status === 'queued' || task.status === 'accepted'
                ? '任务已排队，等待 Memory Bot 执行。'
                : '任务执行中，结果来自服务端任务存储。'}
            </Text>
          )}
        </View>
      ))}
    </ScrollView>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.chatBg },
    content: {
      paddingHorizontal: CHAT_LAYOUT.gutter,
      paddingTop: CHAT_LAYOUT.threadTopPad,
      paddingBottom: 32,
    },
    head: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
    },
    title: {
      color: theme.chatText,
      fontSize: CHAT_TYPE.title,
      fontWeight: '700',
    },
    subtitle: {
      marginTop: 4,
      color: theme.chatMuted,
      fontSize: CHAT_TYPE.meta,
    },
    refresh: { padding: 6 },
    refreshText: { color: theme.chatMuted, fontSize: 18 },
    empty: {
      marginTop: 26,
      padding: 16,
      borderRadius: 16,
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
    },
    emptyTitle: { color: theme.chatText, fontSize: 15, fontWeight: '600' },
    emptyText: { marginTop: 6, color: theme.chatMuted, fontSize: 12, lineHeight: 18 },
    error: { marginTop: 14, color: theme.danger, fontSize: 12 },
    card: {
      marginTop: 12,
      padding: 14,
      borderRadius: 16,
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
    },
    cardHead: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
    taskType: { color: theme.chatText, fontSize: 13, fontWeight: '600' },
    status: { fontSize: 11, fontWeight: '600' },
    goal: { marginTop: 6, color: theme.chatText, fontSize: 13, lineHeight: 19 },
    meta: { marginTop: 6, color: theme.chatMuted, fontSize: 9, fontFamily: 'monospace' },
    result: {
      marginTop: 10,
      paddingTop: 9,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
    },
    resultLabel: { color: theme.chatMuted, fontSize: 10, letterSpacing: 0.4 },
    resultText: { marginTop: 4, color: theme.chatText, fontSize: 12, lineHeight: 18 },
    resultMeta: { marginTop: 4, color: theme.chatMuted, fontSize: 10, lineHeight: 15 },
    pending: { marginTop: 5, color: theme.warning, fontSize: 10 },
    errorCode: { marginTop: 8, color: theme.danger, fontSize: 10 },
    running: { marginTop: 8, color: theme.chatMuted, fontSize: 11 },
  });
