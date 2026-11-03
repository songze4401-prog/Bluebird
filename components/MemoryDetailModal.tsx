import React, { useMemo, useState } from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { Theme } from '../theme';
import type {
  MemoryContribution,
  MemoryItem,
} from '../lib/api/types';
import type { MemoryRelation } from '../lib/memory-center';
import {
  decisionActionLabel,
  isEffectiveMemory,
  memoryConfidencePercent,
  memoryDisplayStatusLabel,
  memoryStatus,
  memoryTypeLabel,
  reasonLabel,
  sourceQuotes,
  sourceTypeLabel,
} from '../lib/memory-center';
import { formatMessageTime } from '../lib/utils';
import type { MemoryCenterStyles } from './memory-center-styles';

export type MemoryAction =
  | 'confirm'
  | 'reject'
  | 'archive'
  | 'delete'
  | 'deny'
  | 'correct';

function StatusNotice({
  item,
  styles,
}: {
  item: MemoryItem;
  styles: MemoryCenterStyles;
}) {
  const status = memoryStatus(item);
  const text =
    status === 'pending'
      ? '待确认候选，尚未进入检索'
      : status === 'contested'
        ? '冲突待裁决，暂不参与检索；请确认一方或否认'
        : status === 'archived'
          ? item.withdrawnAt
            ? '已被用户否认，归档保留审计且不参与检索'
            : '已归档，不参与记忆检索'
          : status === 'superseded'
            ? '历史版本，已被新版本取代'
            : isEffectiveMemory(item)
              ? '活跃记忆，会参与相关对话的检索'
              : '已过期，不参与记忆检索';

  return (
    <View style={styles.noticeCard}>
      <Text style={styles.noticeTitle}>
        {memoryDisplayStatusLabel(item)}
      </Text>
      <Text style={styles.noticeBody}>{text}</Text>
      {status === 'pending' && item.pendingReason ? (
        <Text style={styles.noticeBody}>
          待确认原因：{reasonLabel(item.pendingReason)}
        </Text>
      ) : null}
    </View>
  );
}

function SourceCard({
  item,
  styles,
}: {
  item: MemoryItem;
  styles: MemoryCenterStyles;
}) {
  const quotes = sourceQuotes(item);
  const contributions: MemoryContribution[] =
    item.contributions && item.contributions.length
      ? item.contributions
      : quotes.map(quote => ({ sourceQuote: quote }));

  if (!contributions.length) {
    return (
      <View style={styles.card}>
        <Text style={styles.cardBody}>服务端没有记录这条记忆的来源原话。</Text>
      </View>
    );
  }

  return (
    <View style={styles.card}>
      {contributions.map((contribution, index) => (
        <View
          key={`${contribution.sourceQuote}-${index}`}
          style={styles.quoteCard}
        >
          <Text style={styles.quoteText}>“{contribution.sourceQuote}”</Text>
          <Text style={styles.quoteMeta}>
            {sourceTypeLabel(contribution.sourceType) || '来源未标注'}
            {contribution.createdAt
              ? ` · ${formatMessageTime(contribution.createdAt, true)}`
              : ''}
          </Text>
        </View>
      ))}
    </View>
  );
}

export function MemoryDetailModal({
  visible,
  theme,
  styles,
  item,
  relations,
  busyAction,
  initialAction = null,
  onClose,
  onAction,
  onOpenRelated,
}: {
  visible: boolean;
  theme: Theme;
  styles: MemoryCenterStyles;
  item: MemoryItem | null;
  relations: MemoryRelation[];
  busyAction?: string | null;
  initialAction?: 'correct' | null;
  onClose: () => void;
  onAction: (
    action: MemoryAction,
    payload?: { content?: string }
  ) => void;
  onOpenRelated: (item: MemoryItem) => void;
}) {
  const [technicalOpen, setTechnicalOpen] = useState(false);
  const [correcting, setCorrecting] = useState(initialAction === 'correct');
  const [draft, setDraft] = useState(item?.content || '');
  const [correctError, setCorrectError] = useState('');
  const localStyles = useMemo(() => createStyles(theme), [theme]);

  if (!visible || !item) return null;

  const status = memoryStatus(item);
  const hasId = !!item.id;
  const busy = !!busyAction;
  const canConfirm = status === 'pending';
  const canArchive = status === 'active' || status === 'superseded';

  const actionLabel = (action: MemoryAction) => {
    if (busyAction === action) return '处理中…';
    if (action === 'confirm') return '确认';
    if (action === 'reject') return '拒绝';
    if (action === 'archive') return '归档';
    if (action === 'deny') return '否认';
    if (action === 'correct') return '纠正';
    return '删除';
  };

  return (
    <View style={styles.overlayRoot}>
      <SafeAreaView style={localStyles.root} edges={['top', 'bottom']}>
        <View style={styles.header}>
          <TouchableOpacity
            style={styles.headerButton}
            onPress={onClose}
            accessibilityLabel="返回记忆列表"
            activeOpacity={0.6}
          >
            <Text style={styles.headerGlyph}>‹</Text>
          </TouchableOpacity>

          <View style={styles.headerCenter}>
            <Text style={styles.headerTitle}>记忆详情</Text>
            <Text style={styles.headerSubtitle}>
              {memoryTypeLabel(item.type)} · {memoryDisplayStatusLabel(item)}
            </Text>
          </View>

          <View style={{ width: 38 }} />
        </View>

        <ScrollView
          style={localStyles.scroll}
          contentContainerStyle={styles.overlayContent}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.card}>
            <Text style={styles.detailContent}>{item.content}</Text>
            <View style={styles.badges}>
              <View style={[styles.badge, styles.badgeAccent]}>
                <Text style={[styles.badgeText, styles.badgeAccentText]}>
                  {memoryTypeLabel(item.type)}
                </Text>
              </View>
              <View
                style={[
                  styles.badge,
                  status === 'pending'
                    ? styles.badgeWarning
                    : styles.badgeMuted,
                ]}
              >
                <Text
                  style={[
                    styles.badgeText,
                    status === 'pending'
                      ? styles.badgeWarningText
                      : undefined,
                  ]}
                >
                  {memoryDisplayStatusLabel(item)}
                </Text>
              </View>
              <View style={styles.badge}>
                <Text style={styles.badgeText}>
                  置信度 {memoryConfidencePercent(item)}
                </Text>
              </View>
            </View>
          </View>

          <View style={styles.detailSection}>
            <StatusNotice item={item} styles={styles} />
          </View>

          <View style={styles.detailSection}>
            <Text style={styles.detailLabel}>基本信息</Text>
            <View style={styles.card}>
              <View style={styles.detailRow}>
                <Text style={styles.detailRowLabel}>创建</Text>
                <Text style={styles.detailRowValue}>
                  {item.createdAt
                    ? formatMessageTime(item.createdAt, true)
                    : '—'}
                </Text>
              </View>
              <View style={styles.detailRow}>
                <Text style={styles.detailRowLabel}>更新</Text>
                <Text style={styles.detailRowValue}>
                  {item.updatedAt
                    ? formatMessageTime(item.updatedAt, true)
                    : '—'}
                </Text>
              </View>
              <View style={styles.detailRow}>
                <Text style={styles.detailRowLabel}>有效期</Text>
                <Text style={styles.detailRowValue}>
                  {item.validFrom
                    ? formatMessageTime(item.validFrom, true)
                    : '未标注'}{' '}
                  →{' '}
                  {item.validTo
                    ? formatMessageTime(item.validTo, true)
                    : '持续有效'}
                </Text>
              </View>
              <View style={styles.detailRow}>
                <Text style={styles.detailRowLabel}>稳定 ID</Text>
                <Text style={styles.detailRowValue}>
                  {item.id || '服务端未返回'}
                </Text>
              </View>
            </View>
          </View>

          <View style={styles.detailSection}>
            <Text style={styles.detailLabel}>来源</Text>
            <SourceCard item={item} styles={styles} />
          </View>

          {!!item.keywords?.length && (
            <View style={styles.detailSection}>
              <Text style={styles.detailLabel}>关键词</Text>
              <View style={styles.badges}>
                {item.keywords.map(keyword => (
                  <View key={keyword} style={styles.badge}>
                    <Text style={styles.badgeText}>{keyword}</Text>
                  </View>
                ))}
              </View>
            </View>
          )}

          {!!item.lastDecision?.at && (
            <View style={styles.detailSection}>
              <Text style={styles.detailLabel}>最近决策</Text>
              <View style={styles.card}>
                <Text style={styles.cardTitle}>
                  {decisionActionLabel(item.lastDecision.action) || '状态变更'}
                </Text>
                <Text style={styles.cardBody}>
                  {reasonLabel(item.lastDecision.reason) || '服务端未给出原因'}
                </Text>
                <Text style={styles.summaryNote}>
                  {formatMessageTime(item.lastDecision.at, true)}
                  {item.lastDecision.actor
                    ? ` · ${item.lastDecision.actor === 'user' ? '用户' : '系统'}`
                    : ''}
                </Text>
              </View>
            </View>
          )}

          {!!relations.length && (
            <View style={styles.detailSection}>
              <Text style={styles.detailLabel}>关联记忆</Text>
              {relations.map((relation, index) => (
                <TouchableOpacity
                  key={`${relation.item.id || relation.item.content}:${index}`}
                  style={styles.relationRow}
                  activeOpacity={0.7}
                  onPress={() => onOpenRelated(relation.item)}
                  accessibilityLabel={`打开关联记忆 ${relation.item.content}`}
                >
                  <Text style={styles.relationLabel}>{relation.label}</Text>
                  <Text style={styles.relationText} numberOfLines={2}>
                    {relation.item.content}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          )}

          {!!item.feedbackHistory?.length && (
            <View style={styles.detailSection}>
              <Text style={styles.detailLabel}>反馈历史</Text>
              <View style={styles.card}>
                {item.feedbackHistory.map((feedback, index) => (
                  <View
                    key={`${feedback.feedbackId || feedback.at || index}:${feedback.action}`}
                    style={styles.detailRow}
                  >
                    <Text style={styles.detailRowLabel}>
                      {decisionActionLabel(feedback.action) || '反馈'}
                    </Text>
                    <Text style={styles.detailRowValue}>
                      {reasonLabel(feedback.reason) || '未给出原因'}
                      {feedback.at
                        ? ` · ${formatMessageTime(feedback.at, true)}`
                        : ''}
                      {feedback.feedbackId ? ` · ${feedback.feedbackId}` : ''}
                    </Text>
                  </View>
                ))}
                <Text style={styles.summaryNote}>
                  反馈历史最多保留 20 条；只含动作、原因短码与时间，不含正文。
                </Text>
              </View>
            </View>
          )}

          {status !== 'superseded' && status !== 'archived' && (
            <View style={styles.detailSection}>
              <Text style={styles.detailLabel}>画像治理</Text>
              <View style={styles.card}>
                {correcting ? (
                  <>
                    <TextInput
                      value={draft}
                      onChangeText={value => {
                        setDraft(value);
                        setCorrectError('');
                      }}
                      multiline
                      maxLength={100}
                      placeholder="输入纠正后的内容"
                      placeholderTextColor={theme.textMuted}
                      selectionColor={theme.accent}
                      style={localStyles.correctInput}
                      accessibilityLabel="纠正后的记忆内容"
                    />
                    <Text style={styles.summaryNote}>
                      {draft.trim().length}/100 · 保存后旧版本保留为历史，旧来源写墓碑
                    </Text>
                    {!!correctError && (
                      <Text style={styles.errorText}>{correctError}</Text>
                    )}
                    <View style={styles.pendingActions}>
                      <TouchableOpacity
                        style={[styles.miniButton, busy && styles.miniButtonDisabled]}
                        disabled={busy}
                        onPress={() => {
                          setCorrecting(false);
                          setCorrectError('');
                          setDraft(item.content);
                        }}
                        accessibilityLabel="取消纠正"
                      >
                        <Text style={styles.miniButtonText}>取消</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[
                          styles.miniButton,
                          styles.miniButtonPrimary,
                          busy && styles.miniButtonDisabled,
                        ]}
                        disabled={busy}
                        onPress={() => {
                          const value = draft.trim();
                          if (!value) {
                            setCorrectError('纠正内容不能为空。');
                            return;
                          }
                          if (value === item.content) {
                            setCorrectError('纠正内容与当前记忆相同。');
                            return;
                          }
                          onAction('correct', { content: value });
                        }}
                        accessibilityLabel="保存纠正"
                      >
                        <Text
                          style={[
                            styles.miniButtonText,
                            styles.miniButtonTextPrimary,
                            busy && styles.miniButtonDisabled,
                          ]}
                        >
                          {actionLabel('correct')}
                        </Text>
                      </TouchableOpacity>
                    </View>
                  </>
                ) : (
                  <>
                    <Text style={styles.cardBody}>
                      纠正会新建 active 版本并保留旧版本；否认会归档并写墓碑。
                      两者都会写入审计与反馈历史，不物理删除正文。
                    </Text>
                    <View style={styles.pendingActions}>
                      <TouchableOpacity
                        style={[styles.miniButton, busy && styles.miniButtonDisabled]}
                        disabled={busy || !hasId}
                        onPress={() => {
                          setCorrecting(true);
                          setDraft(item.content);
                          setCorrectError('');
                        }}
                        accessibilityLabel="纠正这条记忆"
                      >
                        <Text
                          style={[
                            styles.miniButtonText,
                            styles.miniButtonTextPrimary,
                            (busy || !hasId) && styles.miniButtonDisabled,
                          ]}
                        >
                          纠正
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[styles.miniButton, busy && styles.miniButtonDisabled]}
                        disabled={busy || !hasId}
                        onPress={() => onAction('deny')}
                        accessibilityLabel="否认这条记忆"
                      >
                        <Text
                          style={[
                            styles.miniButtonText,
                            styles.miniButtonDanger,
                            (busy || !hasId) && styles.miniButtonDisabled,
                          ]}
                        >
                          否认
                        </Text>
                      </TouchableOpacity>
                    </View>
                  </>
                )}
              </View>
            </View>
          )}

          <View style={styles.detailSection}>
            <TouchableOpacity
              style={styles.technicalToggle}
              onPress={() => setTechnicalOpen(open => !open)}
              activeOpacity={0.7}
              accessibilityLabel={technicalOpen ? '折叠技术信息' : '展开技术信息'}
            >
              <Text style={styles.technicalToggleText}>技术信息</Text>
              <Text style={styles.technicalMeta}>
                {technicalOpen ? '收起' : '展开'}
              </Text>
            </TouchableOpacity>

            {technicalOpen && (
              <View style={[styles.card, localStyles.technicalCard]}>
                {[
                  ['ID', item.id || '—'],
                  ['createdAt', item.createdAt || '—'],
                  ['updatedAt', item.updatedAt || '—'],
                  ['validFrom', item.validFrom || '—'],
                  ['validTo', item.validTo || '—'],
                  ['supersedes', item.supersedes || '—'],
                  ['supersededBy', item.supersededBy || '—'],
                  ['pendingTargetId', item.pendingTargetId || '—'],
                  ['confirmationCount', String(item.confirmationCount || 0)],
                  ['lastConfirmedAt', item.lastConfirmedAt || '—'],
                  ['withdrawnAt', item.withdrawnAt || '—'],
                  ['withdrawnReason', item.withdrawnReason || '—'],
                  ['archivedReason', item.archivedReason || '—'],
                  ['contestedBy', item.contestedBy || '—'],
                ].map(([label, value]) => (
                  <View key={label} style={styles.detailRow}>
                    <Text style={styles.detailRowLabel}>{label}</Text>
                    <Text style={styles.detailRowValue}>{value}</Text>
                  </View>
                ))}
                {(item.contributions || []).map((contribution, index) => (
                  <View key={`${contribution.sourceQuote}-${index}`}>
                    <View style={styles.detailRow}>
                      <Text style={styles.detailRowLabel}>
                        贡献 {index + 1}
                      </Text>
                      <Text style={styles.detailRowValue}>
                        {contribution.sessionId || '无会话'} ·{' '}
                        {contribution.messageId || '无 messageId'}
                      </Text>
                    </View>
                  </View>
                ))}
              </View>
            )}
          </View>

          {!hasId && (
            <Text style={[styles.errorText, localStyles.noIdNote]}>
              这条记忆缺少稳定 ID，确认/归档/删除暂时不可用。
            </Text>
          )}
        </ScrollView>

        <View style={styles.footerBar}>
          {canConfirm && (
            <TouchableOpacity
              style={[styles.footerButton, styles.footerButtonDanger]}
              onPress={() => onAction('reject')}
              disabled={busy || !hasId}
              activeOpacity={0.7}
              accessibilityLabel="拒绝待确认记忆"
            >
              <Text
                style={[
                  styles.footerButtonText,
                  styles.footerButtonTextDanger,
                  (busy || !hasId) && styles.miniButtonDisabled,
                ]}
              >
                {actionLabel('reject')}
              </Text>
            </TouchableOpacity>
          )}

          {canConfirm ? (
            <TouchableOpacity
              style={[styles.footerButton, styles.footerButtonPrimary]}
              onPress={() => onAction('confirm')}
              disabled={busy || !hasId}
              activeOpacity={0.7}
              accessibilityLabel="确认这条记忆"
            >
              <Text
                style={[
                  styles.footerButtonText,
                  styles.footerButtonTextPrimary,
                  (busy || !hasId) && styles.miniButtonDisabled,
                ]}
              >
                {actionLabel('confirm')}
              </Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={styles.footerButton}
              onPress={() => onAction('archive')}
              disabled={!canArchive || busy || !hasId}
              activeOpacity={0.7}
              accessibilityLabel="归档这条记忆"
            >
              <Text
                style={[
                  styles.footerButtonText,
                  (!canArchive || busy || !hasId) &&
                    styles.miniButtonDisabled,
                ]}
              >
                {canArchive ? actionLabel('archive') : '已归档'}
              </Text>
            </TouchableOpacity>
          )}

          <TouchableOpacity
            style={[
              styles.footerButton,
              styles.footerButtonDanger,
              !canArchive && !canConfirm ? styles.footerButtonPrimary : null,
            ]}
            onPress={() => onAction('delete')}
            disabled={busy || !hasId}
            activeOpacity={0.7}
            accessibilityLabel="删除这条记忆"
          >
            <Text
              style={[
                styles.footerButtonText,
                !canArchive && !canConfirm
                  ? styles.footerButtonTextPrimary
                  : styles.footerButtonTextDanger,
                (busy || !hasId) && styles.miniButtonDisabled,
              ]}
            >
              {actionLabel('delete')}
            </Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    </View>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: theme.background,
    },
    scroll: {
      flex: 1,
    },
    technicalCard: {
      marginTop: 8,
    },
    correctInput: {
      minHeight: 84,
      padding: 10,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      backgroundColor: theme.surfaceAlt,
      color: theme.textPrimary,
      fontSize: 13,
      lineHeight: 19,
      textAlignVertical: 'top',
    },
    noIdNote: {
      marginTop: 16,
      textAlign: 'left',
    },
  });
