import React, { useMemo } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import type { Theme } from '../theme';
import type {
  Profile,
  ProfileFeedbackAction,
  ProfileItem,
} from '../lib/api/types';
import {
  PROFILE_SECTION_DEFAULT_LABELS,
  PROFILE_SECTION_ORDER,
  feedbackActionLabel,
  feedbackReasonLabel,
  profileDigestShort,
  profileItemStatusLabel,
} from '../lib/profile';
import { formatMessageTime } from '../lib/utils';
import type { MemoryCenterStyles } from './memory-center-styles';

function itemTone(item: ProfileItem, theme: Theme) {
  if (item.status === 'pending' || item.status === 'contested') {
    return { color: theme.accent, background: `${theme.accent}18` };
  }
  if (
    item.status === 'archived' ||
    item.status === 'superseded' ||
    (item.status === 'active' && !item.effective)
  ) {
    return { color: theme.textMuted, background: `${theme.textMuted}16` };
  }
  return { color: theme.online, background: `${theme.online}18` };
}

function ProfileCard({
  item,
  theme,
  styles,
  busy,
  onOpen,
  onFeedback,
}: {
  item: ProfileItem;
  theme: Theme;
  styles: MemoryCenterStyles;
  busy: boolean;
  onOpen: () => void;
  onFeedback: (action: ProfileFeedbackAction) => void;
}) {
  const local = useMemo(() => createStyles(theme), [theme]);
  const tone = itemTone(item, theme);
  const status = profileItemStatusLabel(item);
  const quote = item.sourceQuote || item.sources[0]?.sourceQuote || '';

  return (
    <View style={local.profileCard}>
      <TouchableOpacity
        onPress={onOpen}
        activeOpacity={0.72}
        accessibilityLabel={`查看画像条目 ${item.content}`}
      >
        <View style={local.profileCardTop}>
          <Text style={styles.memoryRowContent} numberOfLines={3}>
            {item.content}
          </Text>
          <Text style={styles.memoryRowChevron}>›</Text>
        </View>

        <View style={styles.badges}>
          <View style={[styles.badge, { backgroundColor: tone.background }]}>
            <Text style={[styles.badgeText, { color: tone.color }]}>
              {status}
            </Text>
          </View>
          <View style={styles.badge}>
            <Text style={styles.badgeText}>
              来源 {item.sourceCount} 条
            </Text>
          </View>
          {item.feedback.confirmationCount > 0 ? (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>
                已确认 {item.feedback.confirmationCount} 次
              </Text>
            </View>
          ) : null}
        </View>

        {!!quote && (
          <Text style={styles.pendingQuote} numberOfLines={1}>
            “{quote}”
          </Text>
        )}
        <Text style={styles.memoryRowTime}>
          {formatMessageTime(item.updatedAt || item.validFrom || '')}
        </Text>
      </TouchableOpacity>

      <View style={local.actionRow}>
        {item.status === 'pending' || item.status === 'contested' ? (
          <>
            <TouchableOpacity
              style={[
                styles.miniButton,
                styles.miniButtonPrimary,
                busy && styles.miniButtonDisabled,
              ]}
              disabled={busy}
              onPress={() => onFeedback('confirm')}
              accessibilityLabel={`确认画像条目 ${item.content}`}
            >
              <Text
                style={[
                  styles.miniButtonText,
                  styles.miniButtonTextPrimary,
                  busy && styles.miniButtonDisabled,
                ]}
              >
                确认
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.miniButton,
                busy && styles.miniButtonDisabled,
              ]}
              disabled={busy}
              onPress={() => onFeedback('deny')}
              accessibilityLabel={`否认画像条目 ${item.content}`}
            >
              <Text
                style={[
                  styles.miniButtonText,
                  styles.miniButtonDanger,
                  busy && styles.miniButtonDisabled,
                ]}
              >
                否认
              </Text>
            </TouchableOpacity>
          </>
        ) : item.status === 'active' ? (
          <>
            <TouchableOpacity
              style={[
                styles.miniButton,
                busy && styles.miniButtonDisabled,
              ]}
              disabled={busy}
              onPress={() => onFeedback('correct')}
              accessibilityLabel={`纠正画像条目 ${item.content}`}
            >
              <Text
                style={[
                  styles.miniButtonText,
                  styles.miniButtonTextPrimary,
                  busy && styles.miniButtonDisabled,
                ]}
              >
                纠正
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.miniButton,
                busy && styles.miniButtonDisabled,
              ]}
              disabled={busy}
              onPress={() => onFeedback('deny')}
              accessibilityLabel={`否认画像条目 ${item.content}`}
            >
              <Text
                style={[
                  styles.miniButtonText,
                  styles.miniButtonDanger,
                  busy && styles.miniButtonDisabled,
                ]}
              >
                否认
              </Text>
            </TouchableOpacity>
          </>
        ) : null}
        <TouchableOpacity
          style={[styles.miniButton, local.openButton]}
          onPress={onOpen}
          accessibilityLabel={`打开画像条目 ${item.content}`}
        >
          <Text style={styles.miniButtonText}>详情</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

export function MemoryProfileTab({
  theme,
  styles,
  profile,
  loading,
  error,
  includeInactive,
  busyAction,
  onRefresh,
  onToggleInactive,
  onOpenProfileItem,
  onOpenMemoryById,
  onFeedback,
}: {
  theme: Theme;
  styles: MemoryCenterStyles;
  profile: Profile | null;
  loading: boolean;
  error: string;
  includeInactive: boolean;
  busyAction: string | null;
  onRefresh: () => void;
  onToggleInactive: () => void;
  onOpenProfileItem: (item: ProfileItem) => void;
  onOpenMemoryById: (memoryId: string) => void;
  onFeedback: (action: ProfileFeedbackAction, item: ProfileItem) => void;
}) {
  const local = useMemo(() => createStyles(theme), [theme]);
  const labels = profile?.sectionLabels || PROFILE_SECTION_DEFAULT_LABELS;

  if (loading && !profile) {
    return (
      <View style={local.center}>
        <ActivityIndicator color={theme.accent} />
        <Text style={styles.emptyHint}>正在派生画像…</Text>
      </View>
    );
  }

  if (error && !profile) {
    return (
      <View style={local.center}>
        <Text style={styles.errorText}>{error}</Text>
        <TouchableOpacity style={styles.retryButton} onPress={onRefresh}>
          <Text style={styles.retryText}>重试</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!profile) {
    return (
      <View style={local.center}>
        <Text style={styles.emptyTitle}>暂无画像</Text>
        <Text style={styles.emptyHint}>
          画像从长期记忆派生；写入记忆后这里会显示可追溯的来源。
        </Text>
      </View>
    );
  }

  const sectionItems = PROFILE_SECTION_ORDER.map(key => ({
    key,
    label: labels[key] || PROFILE_SECTION_DEFAULT_LABELS[key] || key,
    items: profile.sections[key] || [],
  })).filter(section => section.items.length > 0);
  const hasCurrent =
    sectionItems.length > 0 ||
    profile.pending.length > 0 ||
    profile.contested.length > 0;

  return (
    <ScrollView
      style={local.fill}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.heroCard}>
        <View style={styles.heroTop}>
          <Text style={styles.heroLabel}>可追溯画像</Text>
          <View style={styles.heroBadge}>
            <Text style={styles.heroBadgeText}>
              {profile.rebuildable ? '可重建' : '只读'}
            </Text>
          </View>
        </View>
        <View style={styles.heroNumberLine}>
          <Text style={styles.heroNumber}>{profile.counts.active}</Text>
          <Text style={styles.heroNumberSuffix}>条当前事实</Text>
        </View>
        <View style={styles.heroStats}>
          <View style={styles.heroStat}>
            <Text style={styles.heroStatLabel}>待确认</Text>
            <Text style={[styles.heroStatValue, styles.heroStatPending]}>
              {profile.counts.pending}
            </Text>
          </View>
          <View style={styles.heroStat}>
            <Text style={styles.heroStatLabel}>冲突</Text>
            <Text style={[styles.heroStatValue, styles.heroStatPending]}>
              {profile.counts.contested}
            </Text>
          </View>
          <View style={styles.heroStat}>
            <Text style={styles.heroStatLabel}>已否认</Text>
            <Text style={[styles.heroStatValue, styles.heroStatMuted]}>
              {profile.counts.denied}
            </Text>
          </View>
        </View>
        <Text style={styles.heroFooter}>
          digest {profileDigestShort(profile.digest)} · 来源 memory.json · 每次读取重新派生
        </Text>
      </View>

      <View style={local.toolbar}>
        <TouchableOpacity
          style={[styles.chip, includeInactive && styles.chipActive]}
          onPress={onToggleInactive}
          accessibilityLabel={
            includeInactive ? '隐藏画像历史版本' : '显示画像历史版本'
          }
        >
          <Text
            style={[
              styles.chipText,
              includeInactive && styles.chipTextActive,
            ]}
          >
            {includeInactive ? '隐藏历史版本' : '显示历史版本'}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.chip, loading && styles.miniButtonDisabled]}
          onPress={onRefresh}
          disabled={loading}
          accessibilityLabel="刷新画像"
        >
          <Text style={styles.chipText}>{loading ? '刷新中…' : '刷新画像'}</Text>
        </TouchableOpacity>
      </View>

      {!!error && (
        <View style={styles.noticeCard}>
          <Text style={styles.noticeBody}>画像刷新失败：{error}</Text>
        </View>
      )}

      {!hasCurrent && (
        <View style={styles.emptyState}>
          <Text style={styles.emptyTitle}>暂无当前画像</Text>
          <Text style={styles.emptyHint}>
            没有活跃、待确认或冲突条目；历史版本和已否认条目仍可在下方审计视图查看。
          </Text>
        </View>
      )}

      {sectionItems.map(section => (
        <View key={section.key}>
          <View style={styles.sectionHead}>
            <Text style={styles.sectionLabel}>{section.label}</Text>
            <Text style={styles.sectionHint}>{section.items.length} 条</Text>
          </View>
          {section.items.map(item => (
            <ProfileCard
              key={item.memoryId}
              item={item}
              theme={theme}
              styles={styles}
              busy={!!busyAction}
              onOpen={() => onOpenProfileItem(item)}
              onFeedback={action => onFeedback(action, item)}
            />
          ))}
        </View>
      ))}

      {profile.pending.length > 0 && (
        <>
          <View style={styles.sectionHead}>
            <Text style={styles.sectionLabel}>待确认</Text>
            <Text style={styles.sectionHint}>{profile.pending.length} 条</Text>
          </View>
          {profile.pending.map(item => (
            <ProfileCard
              key={item.memoryId}
              item={item}
              theme={theme}
              styles={styles}
              busy={!!busyAction}
              onOpen={() => onOpenProfileItem(item)}
              onFeedback={action => onFeedback(action, item)}
            />
          ))}
        </>
      )}

      {profile.contested.length > 0 && (
        <>
          <View style={styles.sectionHead}>
            <Text style={styles.sectionLabel}>冲突待裁决</Text>
            <Text style={styles.sectionHint}>{profile.contested.length} 条</Text>
          </View>
          {profile.contested.map(item => (
            <ProfileCard
              key={item.memoryId}
              item={item}
              theme={theme}
              styles={styles}
              busy={!!busyAction}
              onOpen={() => onOpenProfileItem(item)}
              onFeedback={action => onFeedback(action, item)}
            />
          ))}
        </>
      )}

      {profile.feedback.recent.length > 0 && (
        <>
          <View style={styles.sectionHead}>
            <Text style={styles.sectionLabel}>反馈历史</Text>
            <Text style={styles.sectionHint}>
              {profile.feedback.counts.confirm} 确认 · {profile.feedback.counts.deny} 否认 ·{' '}
              {profile.feedback.counts.correct} 纠正
            </Text>
          </View>
          <View style={styles.card}>
            {profile.feedback.recent.map((event, index) => (
              <TouchableOpacity
                key={`${event.feedbackId || event.memoryId}:${event.action}:${index}`}
                style={local.feedbackRow}
                onPress={() => onOpenMemoryById(event.memoryId)}
                accessibilityLabel={`打开反馈关联记忆 ${event.memoryId}`}
              >
                <View style={local.feedbackHead}>
                  <Text style={styles.cardTitle}>
                    {feedbackActionLabel(event.action)}
                  </Text>
                  <Text style={styles.memoryRowTime}>
                    {formatMessageTime(event.at || '')}
                  </Text>
                </View>
                <Text style={styles.cardBody} numberOfLines={2}>
                  {feedbackReasonLabel(event.reason) || '服务端未给出原因'}
                  {event.feedbackId ? ` · ${event.feedbackId}` : ''}
                </Text>
              </TouchableOpacity>
            ))}
            <Text style={styles.summaryNote}>
              反馈历史来自条目 feedbackHistory；只含动作、原因短码与时间，不含正文。
            </Text>
          </View>
        </>
      )}

      {includeInactive && profile.inactive.length > 0 && (
        <>
          <View style={styles.sectionHead}>
            <Text style={styles.sectionLabel}>历史与审计</Text>
            <Text style={styles.sectionHint}>{profile.inactive.length} 条</Text>
          </View>
          {profile.inactive.map(item => (
            <ProfileCard
              key={`inactive:${item.memoryId}`}
              item={item}
              theme={theme}
              styles={styles}
              busy={!!busyAction}
              onOpen={() => onOpenProfileItem(item)}
              onFeedback={action => onFeedback(action, item)}
            />
          ))}
        </>
      )}

      <Text style={styles.trendNote}>
        画像是 memory.json 的派生视图，不是第二份存储；确认/否认/纠正会更新
        条目、墓碑与审计。来源原话只展示给当前已认证用户。
      </Text>
    </ScrollView>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    fill: {
      flex: 1,
    },
    center: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 32,
    },
    toolbar: {
      marginTop: 14,
      flexDirection: 'row',
      gap: 8,
    },
    profileCard: {
      marginBottom: 8,
      padding: 14,
      borderRadius: 18,
      backgroundColor: theme.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.borderStrong,
    },
    profileCardTop: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 8,
    },
    actionRow: {
      marginTop: 10,
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 6,
    },
    openButton: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
    },
    feedbackRow: {
      paddingVertical: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
    },
    feedbackHead: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8,
    },
  });
