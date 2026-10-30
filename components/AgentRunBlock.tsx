import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import type { Theme } from '../theme';
import type { ToolStepView } from '../lib/types';
import { toolLabel } from '../lib/constants';

function statusOf(steps: ToolStepView[]): 'running' | 'failed' | 'done' {
  if (steps.some(step => step.running)) return 'running';
  if (steps.some(step => !step.ok)) return 'failed';
  return 'done';
}

function statusLabel(status: 'running' | 'failed' | 'done'): string {
  if (status === 'running') return '运行中';
  if (status === 'failed') return '有步骤失败';
  return '已完成';
}

/**
 * Agent 执行块。只展示后端真实返回的 toolSteps / 流式 tool_start-tool_end；
 * 没有工具时不渲染。详细参数服务端未下发给客户端，不在前端编造。
 */
export function AgentRunBlock({
  theme,
  steps,
  compact = false,
}: {
  theme: Theme;
  steps: ToolStepView[];
  compact?: boolean;
}) {
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [open, setOpen] = useState(false);

  if (!steps.length) return null;

  const status = statusOf(steps);

  return (
    <>
      <TouchableOpacity
        activeOpacity={0.72}
        onPress={() => setOpen(true)}
        style={[styles.block, compact && styles.compactBlock]}
        accessibilityLabel="查看 Agent 执行详情"
      >
        <View style={styles.header}>
          <Text style={styles.eyebrow}>AGENT RUN</Text>
          <View style={styles.status}>
            {status === 'running' ? (
              <ActivityIndicator size="small" color={theme.accent} />
            ) : (
              <View
                style={[
                  styles.statusDot,
                  status === 'failed' ? styles.failedDot : styles.doneDot,
                ]}
              />
            )}
            <Text
              style={[
                styles.statusText,
                status === 'failed' && styles.failedText,
              ]}
            >
              {statusLabel(status)}
            </Text>
          </View>
          <Text style={styles.count}>{steps.length} 个工具</Text>
        </View>

        {!compact && (
          <View style={styles.rows}>
            {steps.map((step, index) => (
              <View key={`${step.name}-${index}`} style={styles.row}>
                {step.running ? (
                  <ActivityIndicator size="small" color={theme.accent} />
                ) : (
                  <Text
                    style={[
                      styles.rowState,
                      step.ok ? styles.ok : styles.failed,
                    ]}
                  >
                    {step.ok ? '✓' : '✕'}
                  </Text>
                )}
                <Text style={styles.rowLabel}>{toolLabel(step.name)}</Text>
                {!!step.durationMs && (
                  <Text style={styles.rowMeta}>
                    {Math.max(1, Math.round(step.durationMs))}ms
                  </Text>
                )}
                <Text style={styles.rowSummary} numberOfLines={1}>
                  {step.summary || (step.running ? '执行中' : '已结束')}
                </Text>
              </View>
            ))}
          </View>
        )}

        <View style={styles.footer}>
          <Text style={styles.footerText}>查看执行详情</Text>
          <Text style={styles.footerArrow}>↗</Text>
        </View>
      </TouchableOpacity>

      <Modal
        visible={open}
        transparent
        animationType="slide"
        onRequestClose={() => setOpen(false)}
      >
        <View style={styles.modalRoot}>
          <Pressable style={styles.scrim} onPress={() => setOpen(false)} />
          <View style={styles.sheet}>
            <View style={styles.handle} />
            <View style={styles.sheetHead}>
              <View>
                <Text style={styles.sheetTitle}>Agent 执行</Text>
                <Text style={styles.sheetSub}>
                  {statusLabel(status)} · {steps.length} 个工具
                </Text>
              </View>
              <TouchableOpacity
                onPress={() => setOpen(false)}
                style={styles.closeButton}
                accessibilityLabel="关闭执行详情"
              >
                <Text style={styles.close}>✕</Text>
              </TouchableOpacity>
            </View>

            <ScrollView
              style={styles.detailScroll}
              contentContainerStyle={styles.detailContent}
              showsVerticalScrollIndicator={false}
            >
              {steps.map((step, index) => (
                <View key={`${step.name}-detail-${index}`} style={styles.detailRow}>
                  <View style={styles.detailLine}>
                    {step.running ? (
                      <ActivityIndicator size="small" color={theme.accent} />
                    ) : (
                      <Text
                        style={[
                          styles.detailState,
                          step.ok ? styles.ok : styles.failed,
                        ]}
                      >
                        {step.ok ? '✓' : '✕'}
                      </Text>
                    )}
                    <Text style={styles.detailName}>
                      {toolLabel(step.name)}
                    </Text>
                    <Text style={styles.detailTool}>{step.name}</Text>
                    {!!step.durationMs && (
                      <Text style={styles.detailMeta}>
                        {Math.max(1, Math.round(step.durationMs))}ms
                      </Text>
                    )}
                  </View>
                  <Text style={styles.detailSummary}>
                    {step.summary || (step.running ? '执行中…' : '已结束')}
                  </Text>
                </View>
              ))}
              <Text style={styles.detailNote}>
                工具参数与原始结果不会下发到客户端；这里只展示服务端返回的执行摘要。
              </Text>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    block: {
      marginTop: 12,
      paddingHorizontal: 13,
      paddingTop: 11,
      paddingBottom: 9,
      backgroundColor: theme.surfaceAlt,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.borderStrong,
      borderRadius: 16,
    },
    compactBlock: {
      marginTop: 8,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    eyebrow: {
      color: theme.textMuted,
      fontSize: 9,
      lineHeight: 13,
      fontWeight: '700',
      letterSpacing: 1.3,
    },
    status: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
    },
    statusDot: {
      width: 5,
      height: 5,
      borderRadius: 3,
    },
    doneDot: {
      backgroundColor: theme.online,
    },
    failedDot: {
      backgroundColor: theme.danger,
    },
    statusText: {
      color: theme.textSecondary,
      fontSize: 10,
      lineHeight: 14,
    },
    failedText: {
      color: theme.danger,
    },
    count: {
      marginLeft: 'auto',
      color: theme.textMuted,
      fontSize: 9,
      lineHeight: 13,
    },
    rows: {
      marginTop: 5,
    },
    row: {
      height: 28,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 7,
    },
    rowState: {
      width: 13,
      fontSize: 11,
      lineHeight: 15,
      fontWeight: '700',
    },
    ok: {
      color: theme.online,
    },
    failed: {
      color: theme.danger,
    },
    rowLabel: {
      color: theme.textBody,
      fontSize: 11,
      lineHeight: 15,
      flexShrink: 0,
    },
    rowMeta: {
      color: theme.textMuted,
      fontSize: 9,
      lineHeight: 13,
      fontVariant: ['tabular-nums'],
    },
    rowSummary: {
      flex: 1,
      color: theme.textMuted,
      fontSize: 9,
      lineHeight: 13,
      textAlign: 'right',
    },
    footer: {
      marginTop: 4,
      paddingTop: 7,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    footerText: {
      color: theme.textMuted,
      fontSize: 9,
      lineHeight: 13,
    },
    footerArrow: {
      color: theme.textMuted,
      fontSize: 11,
    },
    modalRoot: {
      flex: 1,
      justifyContent: 'flex-end',
    },
    scrim: {
      position: 'absolute',
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      backgroundColor: theme.scrim,
    },
    sheet: {
      maxHeight: '78%',
      backgroundColor: theme.surface,
      borderTopLeftRadius: 26,
      borderTopRightRadius: 26,
      paddingHorizontal: 20,
      paddingTop: 9,
      paddingBottom: 26,
      borderWidth: 1,
      borderBottomWidth: 0,
      borderColor: theme.borderStrong,
    },
    handle: {
      width: 38,
      height: 4,
      borderRadius: 2,
      backgroundColor: theme.borderStrong,
      alignSelf: 'center',
      marginBottom: 14,
    },
    sheetHead: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
    },
    sheetTitle: {
      color: theme.textPrimary,
      fontSize: 19,
      lineHeight: 25,
      fontWeight: '600',
    },
    sheetSub: {
      marginTop: 4,
      color: theme.textMuted,
      fontSize: 11,
      lineHeight: 16,
    },
    closeButton: {
      width: 34,
      height: 34,
      alignItems: 'center',
      justifyContent: 'center',
    },
    close: {
      color: theme.textSecondary,
      fontSize: 16,
    },
    detailScroll: {
      marginTop: 12,
    },
    detailContent: {
      paddingBottom: 8,
    },
    detailRow: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
      paddingVertical: 11,
    },
    detailLine: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 7,
    },
    detailState: {
      width: 13,
      fontSize: 11,
      fontWeight: '700',
    },
    detailName: {
      color: theme.textBody,
      fontSize: 12,
      lineHeight: 17,
    },
    detailTool: {
      color: theme.textMuted,
      fontFamily: 'monospace',
      fontSize: 9,
      lineHeight: 13,
    },
    detailMeta: {
      marginLeft: 'auto',
      color: theme.textMuted,
      fontSize: 9,
      lineHeight: 13,
    },
    detailSummary: {
      marginTop: 4,
      marginLeft: 20,
      color: theme.textMuted,
      fontSize: 11,
      lineHeight: 17,
    },
    detailNote: {
      marginTop: 6,
      color: theme.textMuted,
      fontSize: 9,
      lineHeight: 14,
    },
  });
