// 蓝鸟 v7 · 全屏弹层「记忆中心」——旧壳 components/MemoryCenterScreen.tsx 的 v7 重设计。
// 旧壳是唯一权威：取数 / 动作端点 / 状态语义 / 过滤维度全部对照它移植，不发明——
//   取数：GET /memory?scope=all + GET /memory/write-attempts（失败 catch 静默降级，同旧壳）
//   总览段：buildMemoryOverview 按 status 分组统计卡 + 待确认预览（快捷确认/拒绝）
//   管理段：content 搜索 + status/type 筛选（active 走有效期口径，同旧壳 statusMatches）
//   动作：confirm/reject/archive/delete——body 形状（{id} 或 delete 回退 {createdAt,content}）
//         与「无稳定 ID 只能删除」守卫同旧壳 runAction；busyAction 防重入；动作后
//         loadData + loadProfile 双刷新；成功/失败反馈走 ui.toast（旧壳 Alert 错误分支的 v7 化）
//   详情检视：二级 SheetScaffold 展示 MemoryItem 全字段（content/type/keywords/confidence/
//         status/validFrom/supersededBy/sourceQuote/pendingReason/contributions）+ 按状态给动作
//   画像段：GET /profile（includeInactive 切 /profile?includeInactive=1）+ POST /profile/feedback
//   写入台账段：memoryWriteAttempts 列表（时间/动作与写入状态/原因/错误码/会话）
// 未保留（旧壳有、v7 精简）：记忆增长图、记忆摘要、重复/冲突检查、记忆图谱、
//   生命周期时间线（entry 事件 + 本地操作合并 + 事件筛选）、清空全部记忆。
// 本组件只负责 sh-body 内容：scrim / 把手 / 标题 / ✕ 由弹层壳 SheetScaffold 统一承担。

import React, {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { SheetScaffold } from './SheetScaffold';
import { useUi } from '../app/ui-state';
import { V7_SHADOWS, type V7Tokens } from '../app/ui-theme';
import { apiFetch } from '../lib/api/client';
import { API_PATHS } from '../lib/api/endpoints';
import { apiErrorFromPayload } from '../lib/api/errors';
import type {
  MemoryContribution,
  MemoryItem,
  MemoryListResponse,
  MemoryWriteAttempt,
  MemoryWriteAttemptsResponse,
  Profile,
  ProfileFeedbackAction,
  ProfileFeedbackResponse,
  ProfileItem,
  ProfileResponse,
} from '../lib/api/types';
import {
  buildMemoryOverview,
  isEffectiveMemory,
  MEMORY_TYPE_LABELS,
  MEMORY_TYPE_ORDER,
  memoryConfidencePercent,
  memoryDisplayStatusLabel,
  memoryStatus,
  memoryTimestamp,
  memoryTypeLabel,
  reasonLabel,
  sourceQuotes,
  sourceTypeLabel,
  type MemoryStatus,
} from '../lib/memory-center';
import {
  createFeedbackId,
  feedbackActionLabel,
  feedbackReasonLabel,
  findMemoryForProfile,
  PROFILE_SECTION_DEFAULT_LABELS,
  PROFILE_SECTION_ORDER,
  profileDigestShort,
  profileItemStatusLabel,
} from '../lib/profile';
import { formatMessageTime, readJsonResponse } from '../lib/utils';

type MemoryTab = 'overview' | 'manage' | 'writes' | 'profile';

const TABS: { id: MemoryTab; label: string }[] = [
  { id: 'overview', label: '总览' },
  { id: 'manage', label: '管理' },
  { id: 'writes', label: '写入' },
  { id: 'profile', label: '画像' },
];

type StatusFilter = MemoryStatus | 'all';

const STATUS_FILTERS: { id: StatusFilter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'active', label: '活跃' },
  { id: 'pending', label: '待确认' },
  { id: 'contested', label: '冲突' },
  { id: 'archived', label: '已归档' },
  { id: 'superseded', label: '历史版本' },
];

type MemoryActionKind = 'confirm' | 'reject' | 'archive' | 'delete';

const ACTION_PATHS: Record<MemoryActionKind, string> = {
  confirm: API_PATHS.memoryConfirm,
  reject: API_PATHS.memoryReject,
  archive: API_PATHS.memoryArchive,
  delete: API_PATHS.memoryDelete,
};

// 动作完成 toast（旧壳 Alert「完成」分支的同款文案，去句号适配 toast）
const ACTION_TOASTS: Record<MemoryActionKind, string> = {
  confirm: '已确认，这条记忆现在参与检索',
  reject: '已拒绝，这条候选不会进入记忆中心',
  archive: '已归档，不再参与记忆检索',
  delete: '已删除',
};

// 破坏性动作的二次确认（文案同旧壳 requestAction：语义来自服务端行为，不重写）
const ACTION_CONFIRM_TITLES: Record<
  Exclude<MemoryActionKind, 'confirm'>,
  string
> = {
  reject: '拒绝这条候选？',
  archive: '归档这条记忆？',
  delete: '删除这条记忆？',
};

const ACTION_CONFIRM_BODIES: Record<
  Exclude<MemoryActionKind, 'confirm'>,
  string
> = {
  reject: '拒绝后这条候选不会进入记忆中心。',
  archive: '归档后不参与检索，可在“已归档”中查看。',
  delete: '删除不可恢复；服务端也不会保留这条记忆的完整删除事件。',
};

const ACTION_CONFIRM_LABELS: Record<
  Exclude<MemoryActionKind, 'confirm'>,
  string
> = {
  reject: '拒绝',
  archive: '归档',
  delete: '删除',
};

// 画像反馈完成 toast（旧壳 runProfileFeedback「完成」分支的同款文案）
const PROFILE_FEEDBACK_TOASTS: Record<ProfileFeedbackAction, string> = {
  confirm: '已确认，画像与生命周期已更新',
  deny: '已否认，条目归档并保留审计',
  correct: '已纠正，新版本生效，旧版本保留为历史',
};

// 状态徽章 → token 文字色键（up=活跃 warn=待确认/冲突 mut=历史/归档/过期）
const TONE_TXT_KEYS = {
  up: 'toneUpTxt',
  warn: 'toneWarnTxt',
  mut: 'toneMutTxt',
} as const;

function statusTone(item: MemoryItem): keyof typeof TONE_TXT_KEYS {
  const status = memoryStatus(item);

  if (status === 'pending' || status === 'contested') return 'warn';
  if (status === 'active' && isEffectiveMemory(item)) return 'up';
  return 'mut';
}

// active 筛选走有效期口径（isEffectiveMemory），其余按 status 精确匹配——同旧壳
function statusMatches(item: MemoryItem, filter: StatusFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'active') return isEffectiveMemory(item);
  return memoryStatus(item) === filter;
}

function rowKey(item: MemoryItem): string {
  return item.id || `${item.createdAt || ''}::${item.content}`;
}

// 详情页状态说明（同旧壳 MemoryDetailModal 的 StatusNotice 文案映射）
function statusNotice(item: MemoryItem): string {
  const status = memoryStatus(item);

  if (status === 'pending') return '待确认候选，尚未进入检索';
  if (status === 'contested') {
    return '冲突待裁决，暂不参与检索；请确认一方或否认';
  }
  if (status === 'archived') {
    return item.withdrawnAt
      ? '已被用户否认，归档保留审计且不参与检索'
      : '已归档，不参与记忆检索';
  }
  if (status === 'superseded') return '历史版本，已被新版本取代';
  return isEffectiveMemory(item)
    ? '活跃记忆，会参与相关对话的检索'
    : '已过期，不参与记忆检索';
}

// 写入台账的动作标签：与 lib/memory-center 的 attemptType + LIFECYCLE_TITLES 同口径
// （该映射未导出，这里是展示层的等价移植，不发明新语义）
function attemptStatusLabel(attempt: MemoryWriteAttempt): string {
  if (attempt.errorCode || attempt.reason === 'write_failed') return '写入失败';

  switch (attempt.action) {
    case 'inserted':
      return '创建';
    case 'merged':
      return '合并';
    case 'updated':
      return '更新';
    case 'superseded':
      return '取代';
    case 'pending':
      return '待确认';
    default:
      return '拒绝';
  }
}

// ---- 管理段记忆行（content + type/状态/置信度徽章 + keywords + 元信息）----
function MemoryRowCard(props: {
  item: MemoryItem;
  styles: MemoryCenterSheetStyles;
  onPress: () => void;
}) {
  const { item, styles, onPress } = props;

  return (
    <TouchableOpacity
      style={styles.row}
      onPress={onPress}
      activeOpacity={0.72}
      accessibilityLabel={`打开记忆 ${item.content}`}
    >
      <View style={styles.rowTop}>
        <Text style={styles.rowContent} numberOfLines={3}>
          {item.content}
        </Text>
        <Text style={styles.rowChev}>›</Text>
      </View>

      <View style={styles.badgeRow}>
        <View style={styles.badge}>
          <Text style={styles.badgeTxt}>{memoryTypeLabel(item.type)}</Text>
        </View>
        <View style={styles.badge}>
          <Text style={[styles.badgeTxt, styles[TONE_TXT_KEYS[statusTone(item)]]]}>
            {memoryDisplayStatusLabel(item)}
          </Text>
        </View>
        <View style={styles.badge}>
          <Text style={styles.badgeTxt}>
            置信度 {memoryConfidencePercent(item)}
          </Text>
        </View>
      </View>

      {!!item.keywords?.length && (
        <Text style={styles.rowKwd} numberOfLines={1}>
          {item.keywords.join(' · ')}
        </Text>
      )}

      <Text style={styles.rowMeta}>
        {formatMessageTime(item.updatedAt || item.createdAt || '')} · 来源{' '}
        {sourceQuotes(item).length} 条
      </Text>
    </TouchableOpacity>
  );
}

// ---- 画像段条目卡（状态/来源/确认次数 + 快捷反馈动作）----
function ProfileRowCard(props: {
  item: ProfileItem;
  styles: MemoryCenterSheetStyles;
  busy: boolean;
  onOpen: () => void;
  onFeedback: (action: ProfileFeedbackAction) => void;
}) {
  const { item, styles, busy, onOpen, onFeedback } = props;
  const pendingOrContested =
    item.status === 'pending' || item.status === 'contested';
  const toneKey = pendingOrContested
    ? TONE_TXT_KEYS.warn
    : item.status === 'active' && item.effective
      ? TONE_TXT_KEYS.up
      : TONE_TXT_KEYS.mut;
  const quote = item.sourceQuote || item.sources[0]?.sourceQuote || '';

  return (
    <View style={styles.row}>
      <TouchableOpacity
        onPress={onOpen}
        activeOpacity={0.72}
        accessibilityLabel={`查看画像条目 ${item.content}`}
      >
        <View style={styles.rowTop}>
          <Text style={styles.rowContent} numberOfLines={3}>
            {item.content}
          </Text>
          <Text style={styles.rowChev}>›</Text>
        </View>

        <View style={styles.badgeRow}>
          <View style={styles.badge}>
            <Text style={[styles.badgeTxt, styles[toneKey]]}>
              {profileItemStatusLabel(item)}
            </Text>
          </View>
          <View style={styles.badge}>
            <Text style={styles.badgeTxt}>来源 {item.sourceCount} 条</Text>
          </View>
          {item.feedback.confirmationCount > 0 ? (
            <View style={styles.badge}>
              <Text style={styles.badgeTxt}>
                已确认 {item.feedback.confirmationCount} 次
              </Text>
            </View>
          ) : null}
        </View>

        {!!quote && (
          <Text style={styles.rowQuote} numberOfLines={1}>
            “{quote}”
          </Text>
        )}
        <Text style={styles.rowMeta}>
          {formatMessageTime(item.updatedAt || item.validFrom || '')}
        </Text>
      </TouchableOpacity>

      {(pendingOrContested || item.status === 'active') && (
        <View style={styles.actionRow}>
          {pendingOrContested ? (
            <TouchableOpacity
              style={[styles.actBtn, styles.actBtnPrimary, busy && styles.actBtnDisabled]}
              disabled={busy}
              onPress={() => onFeedback('confirm')}
              accessibilityLabel={`确认画像条目 ${item.content}`}
            >
              <Text style={[styles.actBtnTxt, styles.actBtnTxtPrimary]}>确认</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={[styles.actBtn, styles.actBtnPrimary, busy && styles.actBtnDisabled]}
              disabled={busy}
              onPress={() => onFeedback('correct')}
              accessibilityLabel={`纠正画像条目 ${item.content}`}
            >
              <Text style={[styles.actBtnTxt, styles.actBtnTxtPrimary]}>纠正</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={[styles.actBtn, busy && styles.actBtnDisabled]}
            disabled={busy}
            onPress={() => onFeedback('deny')}
            accessibilityLabel={`否认画像条目 ${item.content}`}
          >
            <Text style={[styles.actBtnTxt, styles.actBtnTxtDanger]}>否认</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

export function MemoryCenterSheet(props: {
  visible: boolean;
  onClose: () => void;
}) {
  const { visible, onClose } = props;
  const ui = useUi();
  const t = ui.tokens;
  const styles = createStyles(t);

  const [tab, setTab] = useState<MemoryTab>('overview');
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [attempts, setAttempts] = useState<MemoryWriteAttempt[]>([]);
  const [attemptsError, setAttemptsError] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  // 详情检视（二级弹层）：selected 留住条目让退出动画期间内容不闪空（SettingsScreen 同款）
  const [selected, setSelected] = useState<MemoryItem | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [correcting, setCorrecting] = useState(false);
  const [draft, setDraft] = useState('');
  const [correctError, setCorrectError] = useState('');
  const requestRef = useRef(0);
  const profileRequestRef = useRef(0);

  // ---- 取数：/memory?scope=all + /memory/write-attempts（失败静默降级，同旧壳 loadData）----
  const loadData = useCallback(async () => {
    const ticket = requestRef.current + 1;
    requestRef.current = ticket;

    setLoading(true);
    setError('');

    try {
      const [memoriesResponse, attemptsResponse] = await Promise.all([
        apiFetch(API_PATHS.memoryAll),
        apiFetch(API_PATHS.memoryWriteAttempts).catch(() => null),
      ]);

      if (ticket !== requestRef.current) return;

      const data = (await readJsonResponse(
        memoriesResponse
      )) as MemoryListResponse;

      if (ticket !== requestRef.current) return;

      if (!memoriesResponse.ok) {
        throw apiErrorFromPayload(
          data,
          memoriesResponse.status,
          '读取记忆失败'
        );
      }

      setItems(Array.isArray(data.memories) ? data.memories : []);

      if (!attemptsResponse) {
        setAttempts([]);
        setAttemptsError('写入尝试记录暂不可用。');
      } else {
        try {
          const attemptData = (await readJsonResponse(
            attemptsResponse
          )) as MemoryWriteAttemptsResponse;

          if (ticket !== requestRef.current) return;

          if (attemptsResponse.ok && Array.isArray(attemptData.attempts)) {
            setAttempts(attemptData.attempts);
            setAttemptsError('');
          } else {
            setAttempts([]);
            setAttemptsError('写入尝试记录暂不可用。');
          }
        } catch {
          setAttempts([]);
          setAttemptsError('写入尝试记录暂不可用。');
        }
      }
    } catch (loadError) {
      if (ticket !== requestRef.current) return;

      console.error('Load memory center error:', loadError);
      setError(
        loadError instanceof Error && loadError.message
          ? loadError.message
          : '读取记忆失败，请稍后再试。'
      );
    } finally {
      if (ticket === requestRef.current) setLoading(false);
    }
  }, []);

  // ---- 取数：/profile（includeInactive 切 profileWithInactive，同旧壳 loadProfile）----
  const loadProfile = useCallback(async (withInactive: boolean) => {
    const ticket = profileRequestRef.current + 1;
    profileRequestRef.current = ticket;

    setProfileLoading(true);
    setProfileError('');

    try {
      const response = await apiFetch(
        withInactive ? API_PATHS.profileWithInactive : API_PATHS.profile
      );
      const data = (await readJsonResponse(response)) as ProfileResponse & {
        error?: string;
      };

      if (ticket !== profileRequestRef.current) return;

      if (!response.ok) {
        throw apiErrorFromPayload(data, response.status, '读取画像失败');
      }

      setProfile(data.profile || null);
    } catch (loadError) {
      if (ticket !== profileRequestRef.current) return;

      console.error('Load profile error:', loadError);
      setProfileError(
        loadError instanceof Error && loadError.message
          ? loadError.message
          : '读取画像失败，请稍后再试。'
      );
    } finally {
      if (ticket === profileRequestRef.current) setProfileLoading(false);
    }
  }, []);

  // 打开即拉取（旧壳 useLayoutEffect 的微任务延后写法：effect 内不做同步 setState）
  useLayoutEffect(() => {
    if (!visible) return;

    let cancelled = false;

    void Promise.resolve().then(() => {
      if (!cancelled) {
        void loadData();
        void loadProfile(includeInactive);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [visible, loadData, loadProfile, includeInactive]);

  const overview = useMemo(() => buildMemoryOverview(items), [items]);

  // 待确认预览：按 pendingAt/updatedAt 倒序（同旧壳 pendingItems）
  const pendingItems = useMemo(
    () =>
      items
        .filter(item => memoryStatus(item) === 'pending')
        .sort(
          (a, b) =>
            (Date.parse(b.pendingAt || b.updatedAt || '') || 0) -
            (Date.parse(a.pendingAt || a.updatedAt || '') || 0)
        ),
    [items]
  );

  // 管理段过滤：status + type + content 搜索，按 updatedAt 倒序（同旧壳 manage 过滤）
  const filteredItems = useMemo(() => {
    const needle = query.trim().toLowerCase();

    return items
      .filter(item => {
        if (!statusMatches(item, statusFilter)) return false;
        if (typeFilter !== 'all' && (item.type || '') !== typeFilter) {
          return false;
        }
        if (!needle) return true;
        return item.content.toLowerCase().includes(needle);
      })
      .sort((a, b) => memoryTimestamp(b) - memoryTimestamp(a));
  }, [items, query, statusFilter, typeFilter]);

  // 写入台账：只保留时间可解析的尝试并倒序（同旧壳 collectWriteAttemptEvents 的入口过滤）
  const writeAttempts = useMemo(
    () =>
      attempts
        .filter(attempt => Number.isFinite(Date.parse(attempt.at)))
        .slice()
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at)),
    [attempts]
  );

  const openDetail = (item: MemoryItem, initialAction: 'correct' | null = null) => {
    setSelected(item);
    setCorrecting(initialAction === 'correct');
    setDraft(item.content);
    setCorrectError('');
    setDetailOpen(true);
  };

  const closeDetail = () => {
    setDetailOpen(false);
    setCorrecting(false);
    setCorrectError('');
  };

  const closeSheet = () => {
    requestRef.current += 1;
    profileRequestRef.current += 1;
    setDetailOpen(false);
    setSelected(null);
    setCorrecting(false);
    setCorrectError('');
    onClose();
  };

  // ---- 动作：body 形状与无稳定 ID 守卫同旧壳 runAction；Alert 反馈换成 toast ----
  const runAction = async (action: MemoryActionKind, item: MemoryItem) => {
    if (busyAction) return;

    if (!item.id && action !== 'delete') {
      Alert.alert('无法操作', '这条记忆缺少稳定 ID，当前只能删除。');
      return;
    }

    setBusyAction(action);

    try {
      const body =
        action === 'delete'
          ? item.id
            ? { id: item.id }
            : { createdAt: item.createdAt, content: item.content }
          : { id: item.id };
      const response = await apiFetch(ACTION_PATHS[action], {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const data = (await readJsonResponse(response)) as {
        ok?: boolean;
        error?: string;
        id?: string;
        status?: string;
      };

      if (!response.ok) {
        throw apiErrorFromPayload(data, response.status, '操作失败');
      }

      // confirm 可能合并到原记忆：toast 需要区分「合并」与「独立生效」（同旧壳语义）
      const targetId =
        action === 'confirm'
          ? item.pendingTargetId ||
            (data.id && data.id !== item.id ? data.id : null)
          : item.supersededBy || null;

      setDetailOpen(false);
      setSelected(null);
      setCorrecting(false);
      setCorrectError('');

      await Promise.all([loadData(), loadProfile(includeInactive)]);

      ui.toast(
        action === 'confirm' && targetId && targetId !== item.id
          ? '已确认，并合并到原记忆'
          : ACTION_TOASTS[action]
      );
    } catch (actionError) {
      console.error(`Memory ${action} error:`, actionError);
      ui.toast(
        actionError instanceof Error && actionError.message
          ? actionError.message
          : '操作失败，请稍后再试'
      );
    } finally {
      setBusyAction(null);
    }
  };

  // confirm 直接执行；reject/archive/delete 先确认（文案同旧壳）
  const requestAction = (action: MemoryActionKind, item: MemoryItem) => {
    if (busyAction) return;

    if (action === 'confirm') {
      void runAction('confirm', item);
      return;
    }

    Alert.alert(
      ACTION_CONFIRM_TITLES[action],
      `${ACTION_CONFIRM_BODIES[action]}\n\n${item.content}`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: ACTION_CONFIRM_LABELS[action],
          style: 'destructive',
          onPress: () => void runAction(action, item),
        },
      ]
    );
  };

  // 总览待确认预览的快捷动作（同旧壳 requestQuickAction：确认直接、拒绝先确认）
  const requestQuickAction = (item: MemoryItem, action: 'confirm' | 'reject') => {
    if (busyAction) return;

    if (action === 'confirm') {
      void runAction('confirm', item);
      return;
    }

    Alert.alert('拒绝这条候选？', item.content, [
      { text: '取消', style: 'cancel' },
      {
        text: '拒绝',
        style: 'destructive',
        onPress: () => void runAction('reject', item),
      },
    ]);
  };

  // ---- 画像反馈：body 形状（action/id/feedbackId/correct 补 content）与守卫同旧壳 ----
  const runProfileFeedback = async (
    action: ProfileFeedbackAction,
    item: MemoryItem,
    payload?: { content?: string }
  ) => {
    if (busyAction) return;

    if (!item.id) {
      Alert.alert('无法操作', '这条记忆缺少稳定 ID，不能提交画像反馈。');
      return;
    }

    const corrected = payload?.content?.trim() || '';

    if (action === 'correct' && !corrected) {
      Alert.alert('无法纠正', '纠正内容不能为空。');
      return;
    }

    setBusyAction(action);

    try {
      const body: Record<string, string> = {
        action,
        id: item.id,
        feedbackId: createFeedbackId(action),
      };
      if (action === 'correct') body.content = corrected;

      const response = await apiFetch(API_PATHS.profileFeedback, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const data = (await readJsonResponse(response)) as ProfileFeedbackResponse & {
        error?: string;
      };

      if (!response.ok) {
        throw apiErrorFromPayload(data, response.status, '反馈失败');
      }

      setDetailOpen(false);
      setSelected(null);
      setCorrecting(false);
      setCorrectError('');

      await Promise.all([loadData(), loadProfile(includeInactive)]);

      ui.toast(PROFILE_FEEDBACK_TOASTS[action]);
    } catch (feedbackError) {
      console.error(`Profile ${action} error:`, feedbackError);
      ui.toast(
        feedbackError instanceof Error && feedbackError.message
          ? feedbackError.message
          : '反馈失败，请稍后再试'
      );
    } finally {
      setBusyAction(null);
    }
  };

  // 否认走确认弹层（文案同旧壳：条目会归档并保留审计）
  const requestDeny = (item: MemoryItem) => {
    if (busyAction) return;

    Alert.alert(
      '否认这条记忆？',
      `${item.content}\n\n条目会归档并保留审计；同源异步抽取不能再复活它。`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '否认',
          style: 'destructive',
          onPress: () => void runProfileFeedback('deny', item),
        },
      ]
    );
  };

  // 画像条目反馈入口（同旧壳 requestProfileFeedback：correct 转详情纠正编辑器）
  const requestProfileFeedback = (
    action: ProfileFeedbackAction,
    profileItem: ProfileItem
  ) => {
    const memory = findMemoryForProfile(profileItem, items);

    if (action === 'correct') {
      openDetail(memory, 'correct');
      return;
    }

    if (action === 'confirm') {
      void runProfileFeedback('confirm', memory);
      return;
    }

    requestDeny(memory);
  };

  // 纠正保存（旧壳纠正编辑器的校验：非空、不与当前内容相同）
  const saveCorrect = () => {
    if (!selected) return;

    const value = draft.trim();

    if (!value) {
      setCorrectError('纠正内容不能为空。');
      return;
    }
    if (value === selected.content) {
      setCorrectError('纠正内容与当前记忆相同。');
      return;
    }

    void runProfileFeedback('correct', selected, { content: value });
  };

  // ---- 总览段 ----
  const overviewBody = (
    <View>
      <View style={styles.hero}>
        <View style={styles.heroTop}>
          <Text style={styles.heroLab}>记忆总量</Text>
          <View style={styles.heroBadge}>
            <Text style={styles.heroBadgeTxt}>本机记忆</Text>
          </View>
        </View>

        <View style={styles.heroNumLine}>
          <Text style={styles.heroNum}>{overview.total}</Text>
          <Text style={styles.heroNumSuffix}> 条</Text>
        </View>

        <View style={styles.statRow}>
          <View style={styles.statBox}>
            <Text style={styles.statLab}>活跃</Text>
            <Text style={[styles.statNum, styles.toneUpTxt]}>
              {overview.active}
            </Text>
          </View>
          <View style={styles.statBox}>
            <Text style={styles.statLab}>待确认</Text>
            <Text style={[styles.statNum, styles.toneWarnTxt]}>
              {overview.pending}
            </Text>
          </View>
          <View style={styles.statBox}>
            <Text style={styles.statLab}>冲突</Text>
            <Text style={[styles.statNum, styles.toneWarnTxt]}>
              {overview.contested}
            </Text>
          </View>
          <View style={styles.statBox}>
            <Text style={styles.statLab}>归档</Text>
            <Text style={[styles.statNum, styles.toneMutTxt]}>
              {overview.archived}
            </Text>
          </View>
        </View>

        <Text style={styles.heroFoot}>
          含 {overview.history} 条历史版本
          {overview.expired > 0 ? ` · ${overview.expired} 条已过期` : ''}
        </Text>
      </View>

      {pendingItems.length > 0 && (
        <View>
          <View style={styles.secHead}>
            <Text style={styles.secTitle}>待确认</Text>
            <TouchableOpacity
              hitSlop={6}
              onPress={() => {
                setStatusFilter('pending');
                setTab('manage');
              }}
              accessibilityLabel="查看全部待确认记忆"
            >
              <Text style={styles.secAction}>查看全部</Text>
            </TouchableOpacity>
          </View>

          {pendingItems.slice(0, 2).map(item => {
            const quote = sourceQuotes(item)[0];

            return (
              <View key={item.id || item.content} style={styles.row}>
                <TouchableOpacity
                  onPress={() => openDetail(item)}
                  activeOpacity={0.72}
                  accessibilityLabel={`查看待确认记忆 ${item.content}`}
                >
                  <Text style={styles.rowContent} numberOfLines={2}>
                    {item.content}
                  </Text>
                  {!!quote && (
                    <Text style={styles.rowQuote} numberOfLines={1}>
                      “{quote}”
                    </Text>
                  )}
                </TouchableOpacity>
                <View style={styles.actionRow}>
                  <TouchableOpacity
                    style={[
                      styles.actBtn,
                      (!!busyAction || !item.id) && styles.actBtnDisabled,
                    ]}
                    disabled={!!busyAction || !item.id}
                    onPress={() => requestQuickAction(item, 'reject')}
                    accessibilityLabel={`拒绝待确认记忆 ${item.content}`}
                  >
                    <Text style={[styles.actBtnTxt, styles.actBtnTxtDanger]}>
                      拒绝
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[
                      styles.actBtn,
                      styles.actBtnPrimary,
                      (!!busyAction || !item.id) && styles.actBtnDisabled,
                    ]}
                    disabled={!!busyAction || !item.id}
                    onPress={() => requestQuickAction(item, 'confirm')}
                    accessibilityLabel={`确认待确认记忆 ${item.content}`}
                  >
                    <Text style={[styles.actBtnTxt, styles.actBtnTxtPrimary]}>
                      确认
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            );
          })}
        </View>
      )}
    </View>
  );

  // ---- 管理段 ----
  const manageBody = (
    <View>
      <View style={styles.searchBar}>
        <Text style={styles.searchGlyph}>⌕</Text>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="搜索记忆内容"
          placeholderTextColor={t.mut}
          selectionColor={t.card}
          style={styles.searchInput}
          returnKeyType="search"
          accessibilityLabel="搜索记忆"
        />
        {!!query && (
          <TouchableOpacity
            hitSlop={8}
            onPress={() => setQuery('')}
            accessibilityLabel="清除搜索"
          >
            <Text style={styles.searchClear}>✕</Text>
          </TouchableOpacity>
        )}
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.chipScroll}
        contentContainerStyle={styles.chipContent}
      >
        {STATUS_FILTERS.map(filter => {
          const active = statusFilter === filter.id;

          return (
            <TouchableOpacity
              key={filter.id}
              style={[styles.chip, active && styles.chipOn]}
              onPress={() => setStatusFilter(filter.id)}
              activeOpacity={0.7}
              accessibilityLabel={`状态筛选 ${filter.label}`}
            >
              <Text style={[styles.chipTxt, active && styles.chipTxtOn]}>
                {filter.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.chipScroll}
        contentContainerStyle={styles.chipContent}
      >
        <TouchableOpacity
          style={[styles.chip, typeFilter === 'all' && styles.chipOn]}
          onPress={() => setTypeFilter('all')}
          activeOpacity={0.7}
          accessibilityLabel="类型筛选 全部类型"
        >
          <Text style={[styles.chipTxt, typeFilter === 'all' && styles.chipTxtOn]}>
            全部类型
          </Text>
        </TouchableOpacity>
        {MEMORY_TYPE_ORDER.map(type => {
          const active = typeFilter === type;

          return (
            <TouchableOpacity
              key={type}
              style={[styles.chip, active && styles.chipOn]}
              onPress={() => setTypeFilter(type)}
              activeOpacity={0.7}
              accessibilityLabel={`类型筛选 ${MEMORY_TYPE_LABELS[type]}`}
            >
              <Text style={[styles.chipTxt, active && styles.chipTxtOn]}>
                {MEMORY_TYPE_LABELS[type]}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      <View style={styles.secHead}>
        <Text style={styles.secTitle}>记忆列表</Text>
        <Text style={styles.secCount}>{filteredItems.length} 条</Text>
      </View>

      {filteredItems.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>没有匹配的记忆</Text>
          <Text style={styles.emptyTxt}>调整搜索词或筛选条件后再试。</Text>
          <TouchableOpacity
            style={styles.retryBtn}
            onPress={() => {
              setQuery('');
              setStatusFilter('all');
              setTypeFilter('all');
            }}
            activeOpacity={0.7}
          >
            <Text style={styles.retryTxt}>清除筛选</Text>
          </TouchableOpacity>
        </View>
      ) : (
        filteredItems.map(item => (
          <MemoryRowCard
            key={rowKey(item)}
            item={item}
            styles={styles}
            onPress={() => openDetail(item)}
          />
        ))
      )}
    </View>
  );

  // ---- 写入台账段 ----
  const writesBody = (
    <View>
      {!!attemptsError && (
        <View style={styles.errorCard}>
          <Text style={styles.errorTxt}>{attemptsError}</Text>
        </View>
      )}

      <View style={styles.secHead}>
        <Text style={styles.secTitle}>写入台账</Text>
        <Text style={styles.secCount}>{writeAttempts.length} 条</Text>
      </View>

      {writeAttempts.length === 0 && !attemptsError ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTxt}>暂无写入尝试记录。</Text>
        </View>
      ) : (
        writeAttempts.map((attempt, index) => {
          const failed =
            !!attempt.errorCode || attempt.reason === 'write_failed';

          return (
            <View
              key={`write:${attempt.at}:${attempt.id || index}`}
              style={styles.row}
            >
              <View style={styles.rowTop}>
                <Text style={[styles.rowTitle, failed && styles.toneDownTxt]}>
                  {attemptStatusLabel(attempt)} ·{' '}
                  {attempt.written ? '已写入' : '未写入'}
                </Text>
                <Text style={styles.rowMeta}>
                  {formatMessageTime(attempt.at, true)}
                </Text>
              </View>
              <Text style={styles.cardTxt}>
                {reasonLabel(attempt.reason) ||
                  (attempt.written ? '记忆引擎写入尝试' : '未写入')}
              </Text>
              {!!attempt.errorCode && (
                <Text style={[styles.cardTxt, styles.toneDownTxt]}>
                  错误码 {attempt.errorCode}
                </Text>
              )}
              {!!attempt.sessionId && (
                <Text style={styles.rowMeta}>
                  会话 {attempt.sessionId.slice(0, 8)}
                </Text>
              )}
            </View>
          );
        })
      )}

      <Text style={styles.note}>
        仅当前服务进程最近 20 次写入尝试，不含正文；用于排查“为什么没记住”，
        不能替代完整审计。
      </Text>
    </View>
  );

  // ---- 画像段 ----
  let profileBody: React.ReactNode;

  if (profileLoading && !profile) {
    profileBody = (
      <View style={styles.center}>
        <ActivityIndicator color={t.card} />
        <Text style={styles.emptyTxt}>正在派生画像…</Text>
      </View>
    );
  } else if (profileError && !profile) {
    profileBody = (
      <View style={styles.center}>
        <Text style={styles.errorTxt}>{profileError}</Text>
        <TouchableOpacity
          style={styles.retryBtn}
          onPress={() => void loadProfile(includeInactive)}
          activeOpacity={0.7}
        >
          <Text style={styles.retryTxt}>重试</Text>
        </TouchableOpacity>
      </View>
    );
  } else if (!profile) {
    profileBody = (
      <View style={styles.center}>
        <Text style={styles.emptyTitle}>暂无画像</Text>
        <Text style={styles.emptyTxt}>
          画像从长期记忆派生；写入记忆后这里会显示可追溯的来源。
        </Text>
      </View>
    );
  } else {
    const current = profile;
    const labels =
      current.sectionLabels || PROFILE_SECTION_DEFAULT_LABELS;
    const sectionItems = PROFILE_SECTION_ORDER.map(key => ({
      key,
      label: labels[key] || PROFILE_SECTION_DEFAULT_LABELS[key] || key,
      items: current.sections[key] || [],
    })).filter(section => section.items.length > 0);
    const hasCurrent =
      sectionItems.length > 0 ||
      current.pending.length > 0 ||
      current.contested.length > 0;

    const renderProfileCard = (item: ProfileItem) => (
      <ProfileRowCard
        key={item.memoryId}
        item={item}
        styles={styles}
        busy={busyAction !== null}
        onOpen={() => openDetail(findMemoryForProfile(item, items))}
        onFeedback={action => requestProfileFeedback(action, item)}
      />
    );

    profileBody = (
      <View>
        <View style={styles.hero}>
          <View style={styles.heroTop}>
            <Text style={styles.heroLab}>可追溯画像</Text>
            <View style={styles.heroBadge}>
              <Text style={styles.heroBadgeTxt}>
                {current.rebuildable ? '可重建' : '只读'}
              </Text>
            </View>
          </View>

          <View style={styles.heroNumLine}>
            <Text style={styles.heroNum}>{current.counts.active}</Text>
            <Text style={styles.heroNumSuffix}> 条当前事实</Text>
          </View>

          <View style={styles.statRow}>
            <View style={styles.statBox}>
              <Text style={styles.statLab}>待确认</Text>
              <Text style={[styles.statNum, styles.toneWarnTxt]}>
                {current.counts.pending}
              </Text>
            </View>
            <View style={styles.statBox}>
              <Text style={styles.statLab}>冲突</Text>
              <Text style={[styles.statNum, styles.toneWarnTxt]}>
                {current.counts.contested}
              </Text>
            </View>
            <View style={styles.statBox}>
              <Text style={styles.statLab}>已否认</Text>
              <Text style={[styles.statNum, styles.toneMutTxt]}>
                {current.counts.denied}
              </Text>
            </View>
          </View>

          <Text style={styles.heroFoot}>
            digest {profileDigestShort(current.digest)} · 来源 memory.json ·
            每次读取重新派生
          </Text>
        </View>

        <View style={styles.toolbar}>
          <TouchableOpacity
            style={[styles.chip, includeInactive && styles.chipOn]}
            onPress={() => setIncludeInactive(value => !value)}
            accessibilityLabel={
              includeInactive ? '隐藏画像历史版本' : '显示画像历史版本'
            }
          >
            <Text
              style={[styles.chipTxt, includeInactive && styles.chipTxtOn]}
            >
              {includeInactive ? '隐藏历史版本' : '显示历史版本'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.chip, profileLoading && styles.chipDisabled]}
            onPress={() => void loadProfile(includeInactive)}
            disabled={profileLoading}
            accessibilityLabel="刷新画像"
          >
            <Text style={styles.chipTxt}>
              {profileLoading ? '刷新中…' : '刷新画像'}
            </Text>
          </TouchableOpacity>
        </View>

        {!!profileError && (
          <View style={styles.errorCard}>
            <Text style={styles.errorTxt}>画像刷新失败：{profileError}</Text>
          </View>
        )}

        {!hasCurrent && (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>暂无当前画像</Text>
            <Text style={styles.emptyTxt}>
              没有活跃、待确认或冲突条目；历史版本和已否认条目可在显示历史版本后查看。
            </Text>
          </View>
        )}

        {sectionItems.map(section => (
          <View key={section.key}>
            <View style={styles.secHead}>
              <Text style={styles.secTitle}>{section.label}</Text>
              <Text style={styles.secCount}>{section.items.length} 条</Text>
            </View>
            {section.items.map(renderProfileCard)}
          </View>
        ))}

        {current.pending.length > 0 && (
          <View>
            <View style={styles.secHead}>
              <Text style={styles.secTitle}>待确认</Text>
              <Text style={styles.secCount}>
                {current.pending.length} 条
              </Text>
            </View>
            {current.pending.map(renderProfileCard)}
          </View>
        )}

        {current.contested.length > 0 && (
          <View>
            <View style={styles.secHead}>
              <Text style={styles.secTitle}>冲突待裁决</Text>
              <Text style={styles.secCount}>
                {current.contested.length} 条
              </Text>
            </View>
            {current.contested.map(renderProfileCard)}
          </View>
        )}

        {current.feedback.recent.length > 0 && (
          <View>
            <View style={styles.secHead}>
              <Text style={styles.secTitle}>反馈历史</Text>
              <Text style={styles.secCount}>
                {current.feedback.counts.confirm} 确认 ·{' '}
                {current.feedback.counts.deny} 否认 ·{' '}
                {current.feedback.counts.correct} 纠正
              </Text>
            </View>
            <View style={styles.card}>
              {current.feedback.recent.map((event, index) => (
                <TouchableOpacity
                  key={`${event.feedbackId || event.memoryId}:${event.action}:${index}`}
                  style={styles.fbRow}
                  onPress={() => {
                    const memory = items.find(
                      entry => entry.id === event.memoryId
                    );
                    if (memory) openDetail(memory);
                  }}
                  accessibilityLabel={`打开反馈关联记忆 ${event.memoryId}`}
                >
                  <View style={styles.rowTop}>
                    <Text style={styles.fbAction}>
                      {feedbackActionLabel(event.action)}
                    </Text>
                    <Text style={styles.rowMeta}>
                      {formatMessageTime(event.at || '')}
                    </Text>
                  </View>
                  <Text style={styles.cardTxt} numberOfLines={2}>
                    {feedbackReasonLabel(event.reason) || '服务端未给出原因'}
                    {event.feedbackId ? ` · ${event.feedbackId}` : ''}
                  </Text>
                </TouchableOpacity>
              ))}
              <Text style={styles.note}>
                反馈历史来自条目 feedbackHistory；只含动作、原因短码与时间，不含正文。
              </Text>
            </View>
          </View>
        )}

        {includeInactive && current.inactive.length > 0 && (
          <View>
            <View style={styles.secHead}>
              <Text style={styles.secTitle}>历史与审计</Text>
              <Text style={styles.secCount}>
                {current.inactive.length} 条
              </Text>
            </View>
            {current.inactive.map(renderProfileCard)}
          </View>
        )}
      </View>
    );
  }

  // ---- 详情检视（二级弹层内容；全字段 + 按状态给动作）----
  const detailItem = selected;
  const detailStatus = detailItem ? memoryStatus(detailItem) : 'active';
  const detailHasId = !!detailItem?.id;
  const canConfirm = detailStatus === 'pending';
  const canArchive = detailStatus === 'active' || detailStatus === 'superseded';
  const detailToneKey = detailItem ? TONE_TXT_KEYS[statusTone(detailItem)] : 'toneMutTxt';
  const detailQuotes = detailItem ? sourceQuotes(detailItem) : [];
  const detailContributions: MemoryContribution[] = detailItem
    ? detailItem.contributions?.length
      ? detailItem.contributions
      : detailQuotes.map(quote => ({ sourceQuote: quote }))
    : [];

  const detailBody: React.ReactNode = detailItem ? (
    <View>
      <View style={styles.row}>
        <Text style={styles.detailContent}>{detailItem.content}</Text>
        <View style={styles.badgeRow}>
          <View style={styles.badge}>
            <Text style={styles.badgeTxt}>
              {memoryTypeLabel(detailItem.type)}
            </Text>
          </View>
          <View style={styles.badge}>
            <Text style={[styles.badgeTxt, styles[detailToneKey]]}>
              {memoryDisplayStatusLabel(detailItem)}
            </Text>
          </View>
          <View style={styles.badge}>
            <Text style={styles.badgeTxt}>
              置信度 {memoryConfidencePercent(detailItem)}
            </Text>
          </View>
        </View>
      </View>

      <View style={styles.noticeCard}>
        <Text style={styles.noticeTitle}>
          {memoryDisplayStatusLabel(detailItem)}
        </Text>
        <Text style={styles.cardTxt}>{statusNotice(detailItem)}</Text>
        {detailStatus === 'pending' && !!detailItem.pendingReason ? (
          <Text style={styles.cardTxt}>
            待确认原因：{reasonLabel(detailItem.pendingReason)}
          </Text>
        ) : null}
      </View>

      {!!detailItem.keywords?.length && (
        <View style={styles.card}>
          <Text style={styles.noticeTitle}>关键词</Text>
          <View style={styles.badgeRow}>
            {detailItem.keywords.map(keyword => (
              <View key={keyword} style={styles.badge}>
                <Text style={styles.badgeTxt}>{keyword}</Text>
              </View>
            ))}
          </View>
        </View>
      )}

      <View style={styles.card}>
        <Text style={styles.noticeTitle}>基本信息</Text>
        <View style={styles.detailRow}>
          <Text style={styles.detailRowLab}>创建</Text>
          <Text style={styles.detailRowVal}>
            {detailItem.createdAt
              ? formatMessageTime(detailItem.createdAt, true)
              : '—'}
          </Text>
        </View>
        <View style={styles.detailRow}>
          <Text style={styles.detailRowLab}>更新</Text>
          <Text style={styles.detailRowVal}>
            {detailItem.updatedAt
              ? formatMessageTime(detailItem.updatedAt, true)
              : '—'}
          </Text>
        </View>
        <View style={styles.detailRow}>
          <Text style={styles.detailRowLab}>有效期</Text>
          <Text style={styles.detailRowVal}>
            {detailItem.validFrom
              ? formatMessageTime(detailItem.validFrom, true)
              : '未标注'}{' '}
            →{' '}
            {detailItem.validTo
              ? formatMessageTime(detailItem.validTo, true)
              : '持续有效'}
          </Text>
        </View>
        <View style={styles.detailRow}>
          <Text style={styles.detailRowLab}>被新版本取代</Text>
          <Text style={styles.detailRowVal}>
            {detailItem.supersededBy || '—'}
          </Text>
        </View>
        <View style={styles.detailRow}>
          <Text style={styles.detailRowLab}>稳定 ID</Text>
          <Text style={styles.detailRowVal}>
            {detailItem.id || '服务端未返回'}
          </Text>
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.noticeTitle}>来源</Text>
        {detailContributions.length === 0 ? (
          <Text style={styles.cardTxt}>
            服务端没有记录这条记忆的来源原话。
          </Text>
        ) : (
          detailContributions.map((contribution, index) => (
            <View
              key={`${contribution.sourceQuote}-${index}`}
              style={styles.quoteCard}
            >
              <Text style={styles.rowQuote}>“{contribution.sourceQuote}”</Text>
              <Text style={styles.rowMeta}>
                {sourceTypeLabel(contribution.sourceType) || '来源未标注'}
                {contribution.createdAt
                  ? ` · ${formatMessageTime(contribution.createdAt, true)}`
                  : ''}
              </Text>
            </View>
          ))
        )}
      </View>

      {detailStatus !== 'superseded' && detailStatus !== 'archived' && (
        <View style={styles.card}>
          <Text style={styles.noticeTitle}>画像治理</Text>
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
                placeholderTextColor={t.mut}
                selectionColor={t.card}
                style={styles.correctInput}
                accessibilityLabel="纠正后的记忆内容"
              />
              <Text style={styles.note}>
                {draft.trim().length}/100 · 保存后旧版本保留为历史，旧来源写墓碑
              </Text>
              {!!correctError && (
                <Text style={styles.errorTxt}>{correctError}</Text>
              )}
              <View style={styles.actionRow}>
                <TouchableOpacity
                  style={[styles.actBtn, busyAction && styles.actBtnDisabled]}
                  disabled={busyAction !== null}
                  onPress={() => {
                    setCorrecting(false);
                    setCorrectError('');
                  }}
                  accessibilityLabel="取消纠正"
                >
                  <Text style={styles.actBtnTxt}>取消</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.actBtn,
                    styles.actBtnPrimary,
                    busyAction && styles.actBtnDisabled,
                  ]}
                  disabled={busyAction !== null}
                  onPress={saveCorrect}
                  accessibilityLabel="保存纠正"
                >
                  <Text style={[styles.actBtnTxt, styles.actBtnTxtPrimary]}>
                    {busyAction === 'correct' ? '处理中…' : '保存纠正'}
                  </Text>
                </TouchableOpacity>
              </View>
            </>
          ) : (
            <>
              <Text style={styles.cardTxt}>
                纠正会新建 active 版本并保留旧版本；否认会归档并写墓碑。
                两者都会写入审计与反馈历史，不物理删除正文。
              </Text>
              <View style={styles.actionRow}>
                <TouchableOpacity
                  style={[
                    styles.actBtn,
                    styles.actBtnPrimary,
                    (busyAction || !detailHasId) && styles.actBtnDisabled,
                  ]}
                  disabled={busyAction !== null || !detailHasId}
                  onPress={() => {
                    setCorrecting(true);
                    setDraft(detailItem.content);
                    setCorrectError('');
                  }}
                  accessibilityLabel="纠正这条记忆"
                >
                  <Text style={[styles.actBtnTxt, styles.actBtnTxtPrimary]}>
                    纠正
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.actBtn,
                    (busyAction || !detailHasId) && styles.actBtnDisabled,
                  ]}
                  disabled={busyAction !== null || !detailHasId}
                  onPress={() => requestDeny(detailItem)}
                  accessibilityLabel="否认这条记忆"
                >
                  <Text style={[styles.actBtnTxt, styles.actBtnTxtDanger]}>
                    {busyAction === 'deny' ? '处理中…' : '否认'}
                  </Text>
                </TouchableOpacity>
              </View>
            </>
          )}
        </View>
      )}

      {!detailHasId && (
        <Text style={styles.errorTxt}>
          这条记忆缺少稳定 ID，确认/拒绝/归档暂时不可用；仅可删除。
        </Text>
      )}

      <View style={styles.actionRow}>
        {canConfirm ? (
          <>
            <TouchableOpacity
              style={[
                styles.actBtn,
                (busyAction || !detailHasId) && styles.actBtnDisabled,
              ]}
              disabled={busyAction !== null || !detailHasId}
              onPress={() => requestAction('reject', detailItem)}
              accessibilityLabel="拒绝待确认记忆"
            >
              <Text style={[styles.actBtnTxt, styles.actBtnTxtDanger]}>
                {busyAction === 'reject' ? '处理中…' : '拒绝'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.actBtn,
                styles.actBtnPrimary,
                (busyAction || !detailHasId) && styles.actBtnDisabled,
              ]}
              disabled={busyAction !== null || !detailHasId}
              onPress={() => void runAction('confirm', detailItem)}
              accessibilityLabel="确认这条记忆"
            >
              <Text style={[styles.actBtnTxt, styles.actBtnTxtPrimary]}>
                {busyAction === 'confirm' ? '处理中…' : '确认'}
              </Text>
            </TouchableOpacity>
          </>
        ) : (
          <TouchableOpacity
            style={[
              styles.actBtn,
              (!canArchive || busyAction || !detailHasId) &&
                styles.actBtnDisabled,
            ]}
            disabled={!canArchive || busyAction !== null || !detailHasId}
            onPress={() => requestAction('archive', detailItem)}
            accessibilityLabel="归档这条记忆"
          >
            <Text style={styles.actBtnTxt}>
              {canArchive
                ? busyAction === 'archive'
                  ? '处理中…'
                  : '归档'
                : '已归档'}
            </Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity
          style={[
            styles.actBtn,
            busyAction && styles.actBtnDisabled,
            !canConfirm && !canArchive ? styles.actBtnPrimary : null,
          ]}
          disabled={busyAction !== null}
          onPress={() => requestAction('delete', detailItem)}
          accessibilityLabel="删除这条记忆"
        >
          <Text
            style={[
              styles.actBtnTxt,
              !canConfirm && !canArchive
                ? styles.actBtnTxtPrimary
                : styles.actBtnTxtDanger,
            ]}
          >
            {busyAction === 'delete' ? '处理中…' : '删除'}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  ) : null;

  const showInitialLoading = loading && items.length === 0;

  return (
    <>
      <SheetScaffold visible={visible} onClose={closeSheet} title="记忆中心">
        <View style={styles.body}>
          {/* 段切换（app/SettingsScreen.tsx 的 .seg：r999 p3，选中 card 底 on 字） */}
          <View style={styles.seg}>
            {TABS.map(item => {
              const active = tab === item.id;

              return (
                <TouchableOpacity
                  key={item.id}
                  style={[styles.segOpt, active && styles.segOptOn]}
                  onPress={() => setTab(item.id)}
                  activeOpacity={0.75}
                  accessibilityRole="button"
                  accessibilityLabel={`记忆中心 ${item.label}`}
                >
                  <Text style={active ? styles.segOnTxt : styles.segOffTxt}>
                    {item.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* 列表错误态如实显示：有数据时挂横幅可重试，无数据时整页错误态（同旧壳） */}
          {!!error && items.length > 0 && (
            <View style={styles.errorCard}>
              <Text style={styles.errorTxt}>{error}</Text>
              <TouchableOpacity
                hitSlop={6}
                onPress={() => void loadData()}
                accessibilityLabel="重试读取记忆"
              >
                <Text style={styles.errorRetry}>重试</Text>
              </TouchableOpacity>
            </View>
          )}

          {showInitialLoading ? (
            <View style={styles.center}>
              <ActivityIndicator color={t.card} />
              <Text style={styles.emptyTxt}>正在读取记忆…</Text>
            </View>
          ) : !!error && items.length === 0 ? (
            <View style={styles.center}>
              <Text style={styles.errorTxt}>{error}</Text>
              <TouchableOpacity
                style={styles.retryBtn}
                onPress={() => void loadData()}
                activeOpacity={0.7}
              >
                <Text style={styles.retryTxt}>重试</Text>
              </TouchableOpacity>
            </View>
          ) : tab === 'overview' ? (
            overviewBody
          ) : tab === 'manage' ? (
            manageBody
          ) : tab === 'writes' ? (
            writesBody
          ) : (
            profileBody
          )}
        </View>
      </SheetScaffold>

      {/* 详情检视：二级弹层与主弹层并存（app/SettingsScreen.tsx 的二级面板同款，
          后渲染者自然在上层），onBack 返回记忆列表 */}
      <SheetScaffold
        visible={detailOpen && !!selected}
        onClose={closeDetail}
        onBack={closeDetail}
        title="记忆详情"
      >
        {detailBody}
      </SheetScaffold>
    </>
  );
}

type MemoryCenterSheetStyles = ReturnType<typeof createStyles>;

// 原型 v7 的 token 化样式：颜色全部取 V7Tokens，阴影走 V7_SHADOWS，零硬编码色值
const createStyles = (t: V7Tokens) =>
  StyleSheet.create({
    // sh-body 布局：横向内边距由本组件自理（SheetScaffold 只给滚动）
    body: { paddingHorizontal: 16, paddingBottom: 24 },

    // 段切换（app/SettingsScreen.tsx 的 .seg：r999 p3 + sh-md；容器改 soft 以在 sheet 上显形）
    seg: {
      flexDirection: 'row',
      backgroundColor: t.soft,
      borderRadius: 999,
      padding: 3,
      marginBottom: 12,
      ...V7_SHADOWS.md,
    },
    segOpt: { flex: 1, alignItems: 'center', paddingVertical: 7, borderRadius: 999 },
    segOptOn: { backgroundColor: t.card },
    segOnTxt: { fontSize: 12, color: t.on, fontWeight: '600' },
    segOffTxt: { fontSize: 12, color: t.sec },

    // 段标题行
    secHead: {
      flexDirection: 'row',
      alignItems: 'baseline',
      justifyContent: 'space-between',
      marginTop: 14,
      marginBottom: 8,
    },
    secTitle: { fontSize: 10, fontWeight: '700', color: t.mut, letterSpacing: 1 },
    secCount: { fontSize: 10, color: t.mut },
    secAction: { fontSize: 12, fontWeight: '700', color: t.card },

    // 统计卡（旧壳 heroCard 的 v7 精简：soft 底 + surface 内格）
    hero: { backgroundColor: t.soft, borderRadius: 16, padding: 14, gap: 8 },
    heroTop: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    heroLab: { fontSize: 12, fontWeight: '700', color: t.sec },
    heroBadge: {
      backgroundColor: t.surface,
      borderRadius: 999,
      paddingVertical: 3,
      paddingHorizontal: 9,
    },
    heroBadgeTxt: { fontSize: 10, fontWeight: '700', color: t.mut },
    heroNumLine: { flexDirection: 'row', alignItems: 'baseline' },
    heroNum: { fontSize: 28, fontWeight: '800', color: t.ink },
    heroNumSuffix: { fontSize: 12, color: t.mut },
    heroFoot: { fontSize: 10, lineHeight: 16, color: t.mut },
    statRow: { flexDirection: 'row', gap: 8 },
    statBox: {
      flex: 1,
      backgroundColor: t.surface,
      borderRadius: 12,
      paddingVertical: 10,
      alignItems: 'center',
    },
    statLab: { fontSize: 10, color: t.mut, marginBottom: 2 },
    statNum: { fontSize: 16, fontWeight: '800' },

    // 通用卡片 / 文本
    card: {
      backgroundColor: t.soft,
      borderRadius: 14,
      padding: 12,
      marginBottom: 8,
      gap: 4,
    },
    cardTxt: { fontSize: 12, lineHeight: 19, color: t.ink },
    note: { fontSize: 10, lineHeight: 16, color: t.mut, marginTop: 6 },
    noticeCard: {
      backgroundColor: t.soft,
      borderRadius: 14,
      padding: 12,
      marginBottom: 8,
      gap: 4,
    },
    noticeTitle: { fontSize: 12, fontWeight: '700', color: t.ink },

    // 记忆行（content + 徽章 + 关键词 + 元信息）
    row: {
      backgroundColor: t.soft,
      borderRadius: 14,
      padding: 12,
      marginBottom: 8,
      gap: 6,
    },
    rowTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
    rowContent: {
      flex: 1,
      minWidth: 0,
      fontSize: 13,
      lineHeight: 19,
      fontWeight: '500',
      color: t.ink,
    },
    rowChev: { fontSize: 14, color: t.mut },
    rowTitle: { flex: 1, fontSize: 12, fontWeight: '700', color: t.ink },
    rowQuote: { fontSize: 11, lineHeight: 17, color: t.sec },
    rowKwd: { fontSize: 10, color: t.mut },
    rowMeta: { fontSize: 10, color: t.mut },

    badgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
    badge: {
      backgroundColor: t.surface,
      borderRadius: 999,
      paddingVertical: 3,
      paddingHorizontal: 9,
      alignSelf: 'flex-start',
    },
    badgeTxt: { fontSize: 10, fontWeight: '700', color: t.mut },

    // 状态色调（token 唯一出口：up=活跃 warn=待确认/冲突 mut=历史/归档 down=失败/危险）
    toneUpTxt: { color: t.up },
    toneWarnTxt: { color: t.warn },
    toneMutTxt: { color: t.mut },
    toneDownTxt: { color: t.down },

    // 筛选 chips + 搜索框
    chipScroll: { marginBottom: 8 },
    chipContent: { gap: 8, paddingRight: 8 },
    chip: {
      backgroundColor: t.soft,
      borderRadius: 999,
      paddingVertical: 6,
      paddingHorizontal: 12,
    },
    chipOn: { backgroundColor: t.card },
    chipTxt: { fontSize: 11, fontWeight: '600', color: t.sec },
    chipTxtOn: { color: t.on },
    searchBar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      backgroundColor: t.soft,
      borderRadius: 12,
      paddingVertical: 9,
      paddingHorizontal: 12,
      marginBottom: 10,
    },
    searchGlyph: { fontSize: 14, color: t.mut },
    searchInput: { flex: 1, minWidth: 0, fontSize: 13, color: t.ink, padding: 0 },
    searchClear: { fontSize: 12, color: t.mut, padding: 4 },

    // 动作按钮（TaskDetailSheet 的 .wact：soft 底 r12；主操作 card 底）
    actionRow: { flexDirection: 'row', gap: 8, marginTop: 2 },
    actBtn: {
      flex: 1,
      backgroundColor: t.surface,
      borderRadius: 12,
      paddingVertical: 10,
      alignItems: 'center',
    },
    actBtnPrimary: { backgroundColor: t.card },
    actBtnDisabled: { opacity: 0.5 },
    actBtnTxt: { fontSize: 12, fontWeight: '700', color: t.ink },
    actBtnTxtPrimary: { color: t.on },
    actBtnTxtDanger: { color: t.down },

    toolbar: { flexDirection: 'row', gap: 8, marginBottom: 8 },
    chipDisabled: { opacity: 0.5 },

    // 详情检视
    detailContent: { fontSize: 14, lineHeight: 22, fontWeight: '600', color: t.ink },
    detailRow: {
      flexDirection: 'row',
      alignItems: 'baseline',
      justifyContent: 'space-between',
      gap: 12,
      paddingVertical: 6,
    },
    detailRowLab: { fontSize: 11, color: t.mut },
    detailRowVal: { flex: 1, fontSize: 12, color: t.ink, textAlign: 'right' },
    quoteCard: {
      backgroundColor: t.surface,
      borderRadius: 10,
      paddingVertical: 9,
      paddingHorizontal: 12,
      gap: 3,
    },
    correctInput: {
      minHeight: 72,
      borderRadius: 10,
      backgroundColor: t.surface,
      padding: 10,
      fontSize: 13,
      lineHeight: 19,
      color: t.ink,
      textAlignVertical: 'top',
    },

    // 反馈历史行
    fbRow: { paddingVertical: 8, gap: 4 },
    fbAction: { flex: 1, fontSize: 12, fontWeight: '700', color: t.ink },

    // 加载 / 空 / 错误
    center: {
      minHeight: 220,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 10,
      padding: 20,
    },
    empty: {
      minHeight: 140,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      paddingVertical: 20,
    },
    emptyTitle: { fontSize: 13, fontWeight: '700', color: t.ink },
    emptyTxt: { fontSize: 12, lineHeight: 20, color: t.mut, textAlign: 'center' },
    errorCard: {
      backgroundColor: t.soft,
      borderRadius: 12,
      padding: 10,
      marginBottom: 8,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 10,
    },
    errorTxt: { flexShrink: 1, fontSize: 12, lineHeight: 18, color: t.down },
    errorRetry: { fontSize: 12, fontWeight: '700', color: t.down },
    retryBtn: {
      backgroundColor: t.soft,
      borderRadius: 999,
      paddingVertical: 8,
      paddingHorizontal: 18,
      marginTop: 6,
    },
    retryTxt: { fontSize: 12, fontWeight: '700', color: t.ink },
  });
