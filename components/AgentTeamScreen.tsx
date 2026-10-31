import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { Theme } from '../theme';
import { apiFetch } from '../lib/api/client';
import { API_PATHS } from '../lib/api/endpoints';
import type { AgentSummary, AgentsResponse } from '../lib/api/types';

const STATUS_LABEL: Record<string, string> = {
  enabled: '已启用',
  disabled: '已停用',
  degraded: '待配置',
};

const REASON_LABEL: Record<string, string> = {
  disabled: '服务端已停用',
  model_not_configured: '未绑定独立模型',
  provider_not_found: '模型服务商不存在',
  provider_disabled: '模型服务商已停用',
  model_not_found: '模型不存在',
  model_disabled: '模型已停用',
  credential_not_configured: '未配置独立 API Key',
};

export function AgentTeamScreen({
  visible,
  onClose,
  theme,
  onOpenBot,
}: {
  visible: boolean;
  onClose: () => void;
  theme: Theme;
  onOpenBot: (bot: AgentSummary) => void;
}) {
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await apiFetch(API_PATHS.agents);
      if (!response.ok) throw new Error('failed');
      const data = (await response.json()) as AgentsResponse;
      setAgents(data.agents || []);
    } catch {
      setError('暂时无法读取 Agent 团队，请检查后端连接。');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(() => {
      void load();
    }, 0);
    return () => clearTimeout(timer);
  }, [visible, load]);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.root}>
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose} style={styles.back} accessibilityLabel="返回">
            <Text style={styles.backText}>‹</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Agent 团队</Text>
          <TouchableOpacity
            onPress={() => void load()}
            disabled={loading}
            style={styles.refresh}
            accessibilityLabel="刷新 Agent 团队"
          >
            <Text style={styles.refreshText}>{loading ? '···' : '↻'}</Text>
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          <Text style={styles.title}>专业 Agent</Text>
          <Text style={styles.subtitle}>
            这里只显示服务端真实注册的 Agent。未注册的能力保留位置，但不会伪装成在线。
          </Text>

          {loading && agents.length === 0 ? (
            <View style={styles.center}>
              <ActivityIndicator color={theme.accent} />
              <Text style={styles.hint}>正在读取团队注册表…</Text>
            </View>
          ) : error ? (
            <View style={styles.center}>
              <Text style={styles.error}>{error}</Text>
              <TouchableOpacity onPress={() => void load()} style={styles.retry}>
                <Text style={styles.retryText}>重试</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              {agents.map(agent => (
                <View key={agent.botId} style={styles.botCard}>
                  <View style={styles.botHead}>
                    <View style={styles.botIcon}>
                      <Text style={styles.botIconText}>M</Text>
                    </View>
                    <View style={styles.botMain}>
                      <Text style={styles.botName}>{agent.displayName}</Text>
                      <Text style={styles.botDesc}>{agent.description}</Text>
                    </View>
                    <View
                      style={[
                        styles.statusPill,
                        {
                          backgroundColor:
                            agent.status === 'enabled'
                              ? theme.online + '22'
                              : theme.warning + '22',
                        },
                      ]}
                    >
                      <Text
                        style={[
                          styles.statusText,
                          {
                            color:
                              agent.status === 'enabled'
                                ? theme.online
                                : theme.warning,
                          },
                        ]}
                      >
                        {STATUS_LABEL[agent.status] || agent.status}
                      </Text>
                    </View>
                  </View>

                  <View style={styles.metaGrid}>
                    <Meta label="模型" value={agent.model.modelId || '未绑定'} styles={styles} />
                    <Meta
                      label="凭证"
                      value={agent.credential ? agent.credential.keyHint : '未配置'}
                      styles={styles}
                    />
                    <Meta
                      label="会话"
                      value={`${agent.sessionsCount}`}
                      styles={styles}
                    />
                    <Meta
                      label="入口"
                      value={agent.entrypoints.length ? '独立对话 + 委派' : '—'}
                      styles={styles}
                    />
                  </View>

                  {agent.status !== 'enabled' && agent.statusReason && (
                    <Text style={styles.reason}>
                      {REASON_LABEL[agent.statusReason] || agent.statusReason}
                    </Text>
                  )}

                  <TouchableOpacity
                    style={styles.openButton}
                    onPress={() => onOpenBot(agent)}
                    accessibilityLabel={`打开 ${agent.displayName} 工作台`}
                  >
                    <Text style={styles.openButtonText}>打开工作台</Text>
                    <Text style={styles.openButtonArrow}>›</Text>
                  </TouchableOpacity>
                </View>
              ))}

              <View style={styles.reserved}>
                <View style={styles.reservedHead}>
                  <Text style={styles.reservedTitle}>更多 Agent</Text>
                  <Text style={styles.reservedState}>预留 · 未注册</Text>
                </View>
                <Text style={styles.reservedText}>
                  Research / Coding / Browser 等专业 Agent 尚未注册。注册后会按同一 Manifest
                  与 Runtime 契约出现在这里。
                </Text>
              </View>

              <Text style={styles.note}>
                状态来自服务端注册表与持久化配置；停用、缺模型或缺凭证都会明确显示，不会画假在线。
              </Text>
            </>
          )}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

function Meta({
  label,
  value,
  styles,
}: {
  label: string;
  value: string;
  styles: ReturnType<typeof createStyles>;
}) {
  return (
    <View style={styles.metaItem}>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text style={styles.metaValue} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: theme.background },
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
    content: { paddingHorizontal: 20, paddingTop: 14, paddingBottom: 42 },
    title: {
      color: theme.textPrimary,
      fontSize: 30,
      lineHeight: 38,
      fontWeight: '600',
      letterSpacing: -0.5,
    },
    subtitle: {
      marginTop: 8,
      color: theme.textSecondary,
      fontSize: 14,
      lineHeight: 22,
      maxWidth: 330,
    },
    center: { paddingVertical: 48, alignItems: 'center', gap: 10 },
    hint: { color: theme.textMuted, fontSize: 12 },
    error: { color: theme.warning, fontSize: 13, textAlign: 'center' },
    retry: {
      paddingHorizontal: 16,
      paddingVertical: 8,
      borderRadius: 12,
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.borderStrong,
    },
    retryText: { color: theme.textBody, fontSize: 12 },
    botCard: {
      marginTop: 24,
      padding: 16,
      borderRadius: 20,
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.borderStrong,
      shadowColor: '#000',
      shadowOpacity: 0.06,
      shadowRadius: 18,
      shadowOffset: { width: 0, height: 8 },
      elevation: 2,
    },
    botHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
    botIcon: {
      width: 42,
      height: 42,
      borderRadius: 14,
      backgroundColor: theme.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    botIconText: { color: '#fff', fontSize: 17, fontWeight: '700' },
    botMain: { flex: 1 },
    botName: { color: theme.textPrimary, fontSize: 18, fontWeight: '600' },
    botDesc: { marginTop: 4, color: theme.textSecondary, fontSize: 12, lineHeight: 18 },
    statusPill: {
      paddingHorizontal: 9,
      paddingVertical: 5,
      borderRadius: 999,
    },
    statusText: { fontSize: 10, fontWeight: '600' },
    metaGrid: {
      marginTop: 18,
      flexDirection: 'row',
      flexWrap: 'wrap',
      rowGap: 12,
    },
    metaItem: { width: '50%', paddingRight: 8 },
    metaLabel: { color: theme.textMuted, fontSize: 10, letterSpacing: 0.5 },
    metaValue: { marginTop: 3, color: theme.textBody, fontSize: 13, fontWeight: '500' },
    reason: { marginTop: 14, color: theme.warning, fontSize: 11, lineHeight: 17 },
    openButton: {
      marginTop: 18,
      height: 42,
      borderRadius: 14,
      backgroundColor: theme.accent,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
    },
    openButtonText: { color: '#fff', fontSize: 13, fontWeight: '600' },
    openButtonArrow: { color: '#fff', fontSize: 18, marginTop: -1 },
    reserved: {
      marginTop: 16,
      padding: 16,
      borderRadius: 18,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      borderStyle: 'dashed',
    },
    reservedHead: { flexDirection: 'row', justifyContent: 'space-between' },
    reservedTitle: { color: theme.textBody, fontSize: 13, fontWeight: '600' },
    reservedState: { color: theme.textMuted, fontSize: 10 },
    reservedText: { marginTop: 8, color: theme.textMuted, fontSize: 11, lineHeight: 18 },
    note: { marginTop: 22, color: theme.textMuted, fontSize: 10, lineHeight: 16 },
  });
