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
import type { AgentPolicyResponse } from '../lib/api/types';

type AgentPolicyTool = AgentPolicyResponse['availableTools'][number];

const RISK_LABEL: Record<string, string> = {
  read: '只读',
  reversible_write: '受控写入',
};

/**
 * Agent 工具状态的只读页面。全局开关由服务端环境变量控制；
 * 这里不提供假开关，只展示 /agent-policy 返回的真实运行状态和工具注册表。
 */
export function AgentToolsScreen({
  visible,
  onClose,
  theme,
  onOpenAdvanced,
}: {
  visible: boolean;
  onClose: () => void;
  theme: Theme;
  onOpenAdvanced?: () => void;
}) {
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [data, setData] = useState<AgentPolicyResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await apiFetch(API_PATHS.agentPolicy);
      if (!response.ok) throw new Error('读取 Agent 状态失败');
      setData((await response.json()) as AgentPolicyResponse);
    } catch {
      setError('暂时无法读取 Agent 状态，请检查后端连接。');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    // 延迟到当前渲染提交后再发起请求，避免在 effect 内同步 setState。
    const timer = setTimeout(() => {
      void load();
    }, 0);
    return () => clearTimeout(timer);
  }, [visible, load]);

  const tools = data?.availableTools || [];
  const runtime = data?.runtime;
  const allowed = data?.policy?.tools?.allowedTools;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.root}>
        <View style={styles.header}>
          <TouchableOpacity
            onPress={onClose}
            hitSlop={8}
            accessibilityLabel="返回"
            style={styles.back}
          >
            <Text style={styles.backText}>‹</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Agent 工具</Text>
          <TouchableOpacity
            onPress={() => void load()}
            disabled={loading}
            hitSlop={8}
            accessibilityLabel="刷新 Agent 状态"
            style={styles.refresh}
          >
            <Text style={styles.refreshText}>{loading ? '···' : '↻'}</Text>
          </TouchableOpacity>
        </View>

        <ScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
        >
          <Text style={styles.title}>工具边界</Text>
          <Text style={styles.subtitle}>
            工具只在当前会话需要时调用。读取可以自动执行，写入必须经过你的确认。
          </Text>

          {loading && !data ? (
            <View style={styles.center}>
              <ActivityIndicator color={theme.accent} />
              <Text style={styles.hint}>正在读取服务端状态…</Text>
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
              <View style={styles.statusCard}>
                <View
                  style={[
                    styles.statusDot,
                    {
                      backgroundColor: runtime
                        ? runtime.switchOn
                          ? theme.online
                          : theme.textMuted
                        : theme.warning,
                    },
                  ]}
                />
                <View style={styles.statusMain}>
                  <Text style={styles.statusTitle}>
                    {runtime
                      ? runtime.switchOn
                        ? '工具调用已启用'
                        : '工具调用已关闭'
                      : '工具调用状态未读取'}
                  </Text>
                  <Text style={styles.statusHint}>
                    由服务端环境变量控制 · 本页只读
                  </Text>
                </View>
                <Text style={styles.statusValue}>
                  {runtime ? (runtime.switchOn ? 'ON' : 'OFF') : '—'}
                </Text>
              </View>

              <Text style={styles.sectionLabel}>已注册工具</Text>
              <View style={styles.list}>
                {tools.length === 0 ? (
                  <Text style={styles.empty}>服务端没有注册任何工具。</Text>
                ) : (
                  <>
                    {tools.map(tool => (
                      <ToolRow
                        key={tool.name}
                        tool={tool}
                        theme={theme}
                        styles={styles}
                        allowed={
                          allowed === null ||
                          allowed === undefined ||
                          allowed.includes(tool.name)
                        }
                      />
                    ))}
                    {!tools.some(tool => tool.name === 'weather') && (
                      <View style={styles.toolRow}>
                        <View style={styles.toolGlyph}>
                          <Text style={styles.toolGlyphText}>—</Text>
                        </View>
                        <View style={styles.toolMain}>
                          <Text style={styles.toolName}>weather</Text>
                          <Text style={styles.toolDesc}>
                            天气查询 · 未接入当前版本
                          </Text>
                        </View>
                        <Text style={[styles.toolState, { color: theme.textMuted }]}>未提供</Text>
                      </View>
                    )}
                  </>
                )}
              </View>

              <Text style={styles.sectionLabel}>运行边界</Text>
              <View style={styles.boundary}>
                <Boundary
                  styles={styles}
                  label="最大模型轮数"
                  value={String(runtime?.maxRounds ?? data?.runtimeLimits?.maxRounds ?? '—')}
                />
                <Boundary
                  styles={styles}
                  label="默认工具超时"
                  value={
                    runtime?.toolTimeoutDefaultMs
                      ? `${runtime.toolTimeoutDefaultMs}ms`
                      : '—'
                  }
                />
                <Boundary
                  styles={styles}
                  label="图片请求"
                  value={
                    runtime?.imageRequestsDisableTools === false
                      ? '允许工具'
                      : '不启用工具'
                  }
                />
                <Boundary
                  styles={styles}
                  label="外部网络"
                  value="未授权"
                />
              </View>

              <Text style={styles.note}>
                本页不会显示无法执行的开关，也不会把未注册的工具伪装成可用。服务端配置变更后请重新加载。
              </Text>

              {onOpenAdvanced && (
                <TouchableOpacity
                  style={styles.advanced}
                  onPress={onOpenAdvanced}
                  activeOpacity={0.7}
                >
                  <Text style={styles.advancedText}>高级 Agent 策略</Text>
                  <Text style={styles.advancedArrow}>›</Text>
                </TouchableOpacity>
              )}
            </>
          )}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

function ToolRow({
  tool,
  theme,
  styles,
  allowed,
}: {
  tool: AgentPolicyTool;
  theme: Theme;
  styles: ReturnType<typeof createStyles>;
  allowed: boolean;
}) {
  return (
    <View style={styles.toolRow}>
      <View style={styles.toolGlyph}>
        <Text style={styles.toolGlyphText}>
          {tool.readOnly ? 'R' : 'W'}
        </Text>
      </View>
      <View style={styles.toolMain}>
        <Text style={styles.toolName}>{tool.name}</Text>
        <Text style={styles.toolDesc} numberOfLines={2}>
          {tool.description}
        </Text>
      </View>
      <Text
        style={[
          styles.toolState,
          { color: tool.readOnly ? theme.textSecondary : theme.warning },
        ]}
      >
        {allowed ? RISK_LABEL[tool.risk] || tool.risk : '策略禁用'}
      </Text>
    </View>
  );
}

function Boundary({
  styles,
  label,
  value,
}: {
  styles: ReturnType<typeof createStyles>;
  label: string;
  value: string;
}) {
  return (
    <View style={styles.boundaryRow}>
      <Text style={styles.boundaryLabel}>{label}</Text>
      <Text style={styles.boundaryValue}>{value}</Text>
    </View>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: theme.background,
    },
    header: {
      height: 52,
      paddingHorizontal: 16,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    back: {
      width: 40,
      height: 40,
      alignItems: 'flex-start',
      justifyContent: 'center',
    },
    backText: {
      color: theme.textSecondary,
      fontSize: 27,
      lineHeight: 31,
    },
    headerTitle: {
      color: theme.textPrimary,
      fontSize: 14,
      fontWeight: '600',
    },
    refresh: {
      width: 40,
      height: 40,
      alignItems: 'flex-end',
      justifyContent: 'center',
    },
    refreshText: {
      color: theme.textSecondary,
      fontSize: 18,
    },
    content: {
      paddingHorizontal: 20,
      paddingTop: 14,
      paddingBottom: 42,
    },
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
      maxWidth: 320,
    },
    statusCard: {
      marginTop: 22,
      padding: 14,
      borderRadius: 14,
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.borderStrong,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    statusDot: {
      width: 7,
      height: 7,
      borderRadius: 4,
    },
    statusMain: {
      flex: 1,
    },
    statusTitle: {
      color: theme.textBody,
      fontSize: 13,
      lineHeight: 18,
      fontWeight: '600',
    },
    statusHint: {
      color: theme.textMuted,
      fontSize: 10,
      lineHeight: 15,
      marginTop: 2,
    },
    statusValue: {
      color: theme.textMuted,
      fontSize: 10,
      letterSpacing: 0.8,
    },
    sectionLabel: {
      marginTop: 25,
      color: theme.textMuted,
      fontSize: 10,
      lineHeight: 14,
      letterSpacing: 0.6,
    },
    list: {
      marginTop: 2,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
    },
    toolRow: {
      minHeight: 56,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
    },
    toolGlyph: {
      width: 28,
      height: 28,
      borderRadius: 9,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.borderStrong,
      alignItems: 'center',
      justifyContent: 'center',
    },
    toolGlyphText: {
      color: theme.textMuted,
      fontSize: 9,
      fontFamily: 'monospace',
    },
    toolMain: {
      flex: 1,
      minWidth: 0,
    },
    toolName: {
      color: theme.textBody,
      fontSize: 12,
      lineHeight: 17,
      fontFamily: 'monospace',
    },
    toolDesc: {
      color: theme.textMuted,
      fontSize: 10,
      lineHeight: 15,
      marginTop: 2,
    },
    toolState: {
      fontSize: 9,
      lineHeight: 13,
    },
    boundary: {
      marginTop: 2,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
    },
    boundaryRow: {
      height: 38,
      flexDirection: 'row',
      alignItems: 'center',
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
    },
    boundaryLabel: {
      color: theme.textSecondary,
      fontSize: 11,
      lineHeight: 16,
    },
    boundaryValue: {
      marginLeft: 'auto',
      color: theme.textMuted,
      fontSize: 10,
      lineHeight: 15,
    },
    note: {
      marginTop: 17,
      color: theme.textMuted,
      fontSize: 10,
      lineHeight: 16,
    },
    empty: {
      color: theme.textMuted,
      fontSize: 12,
      paddingVertical: 18,
    },
    center: {
      paddingTop: 60,
      alignItems: 'center',
    },
    hint: {
      marginTop: 10,
      color: theme.textMuted,
      fontSize: 12,
    },
    error: {
      color: theme.danger,
      fontSize: 13,
      lineHeight: 20,
      textAlign: 'center',
    },
    retry: {
      marginTop: 14,
      paddingHorizontal: 18,
      paddingVertical: 8,
      borderRadius: 9,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.borderStrong,
    },
    retryText: {
      color: theme.accent,
      fontSize: 12,
    },
    advanced: {
      marginTop: 22,
      height: 46,
      borderRadius: 13,
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.borderStrong,
      paddingHorizontal: 14,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    advancedText: {
      color: theme.textSecondary,
      fontSize: 12,
    },
    advancedArrow: {
      color: theme.textMuted,
      fontSize: 16,
    },
  });
