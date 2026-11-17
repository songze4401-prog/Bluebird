// 蓝鸟 UI 移植 · 弹层「系统监控」（v7）
// 旧壳 components/MonitoringScreen.tsx 的 v7 弹层化移植：只读 · 真实监控数据 · 无写操作。
// - 分段（简单 state + seg 按钮行，参考 app/SettingsScreen.tsx 的 .seg）：
//     总览   GET monitoringOverview(from, to) → 健康快照 notice + 统计卡 + 成本说明
//     Traces GET monitoringTraces({...}) 列表，点选 → GET monitoringTrace(id) 详情
//     Events GET monitoringEvents({...}) 错误 + 权限拒绝事件（去重合并，按时间倒序）
// - 时间范围 1 小时 / 24 小时 / 7 天（照旧壳 RANGES）；手动刷新保留；每 30 秒只读轮询
// - 隐私：后端只返回元数据，这里不请求任何 prompt / 记忆正文 / 工具参数；
//   空数据显示「暂无数据/尚未接入」，不显示看似正常的 0。
// 本组件只负责 sh-body 内容：把手 / 标题 / ✕ / 滚动由 SheetScaffold 统一承担。

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { SheetScaffold } from './SheetScaffold';
import { useUi } from '../app/ui-state';
import { V7_SHADOWS, type V7Tokens } from '../app/ui-theme';
import { apiFetch } from '../lib/api/client';
import { API_PATHS } from '../lib/api/endpoints';
import type {
  MonitoringCard,
  MonitoringEvent,
  MonitoringEventsResponse,
  MonitoringMetricValue,
  MonitoringOverviewResponse,
  MonitoringTraceDetail,
  MonitoringTraceDetailResponse,
  MonitoringTraceSummary,
  MonitoringTracesResponse,
} from '../lib/api/types';
import { readJsonResponse, withAlpha } from '../lib/utils';

type MonitorSegment = 'overview' | 'traces' | 'events';

const SEGMENTS: { id: MonitorSegment; label: string }[] = [
  { id: 'overview', label: '总览' },
  { id: 'traces', label: 'Traces' },
  { id: 'events', label: 'Events' },
];

// 时间范围选项（照旧壳 MonitoringScreen 的 RANGES）
const RANGES = [
  { hours: 1, label: '1 小时' },
  { hours: 24, label: '24 小时' },
  { hours: 168, label: '7 天' },
];

// 只读轮询节奏（照旧壳：30 秒）
const POLL_INTERVAL_MS = 30000;

async function fetchMonitoring<T>(path: string): Promise<T> {
  const response = await apiFetch(path, { timeoutMs: 20000 });
  const data = (await readJsonResponse(response)) as T & {
    error?: string;
    code?: string;
  };

  if (!response.ok) {
    throw new Error(data.error || `监控请求失败（HTTP ${response.status}）`);
  }

  return data;
}

function formatTime(iso?: string | null): string {
  if (!iso) return '未知';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '未知';

  const pad = (value: number) => String(value).padStart(2, '0');

  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

function formatDuration(ms?: number | null): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '未知';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)} s`;
  return `${(ms / 60000).toFixed(2)} min`;
}

function formatNumber(value?: number | null): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '未知';
  return String(Math.round(value * 1000) / 1000);
}

function metricText(metric: MonitoringMetricValue): string {
  const { value, unit } = metric;

  if (value === null || value === undefined) return '未知';

  if (Array.isArray(value)) return value.join(' / ');

  if (unit === 'ratio' && typeof value === 'number') {
    return `${(value * 100).toFixed(1)}%`;
  }
  if (unit === 'ms') {
    return typeof value === 'number' ? formatDuration(value) : String(value);
  }
  if (unit === 'timestamp') return formatTime(String(value));
  if (unit === 'state') return String(value);
  if (unit === 'items_per_search' && typeof value === 'number') {
    return `${value.toFixed(2)} 条/次`;
  }
  if (unit === 'bytes' && typeof value === 'number') {
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }

  if (typeof value === 'number') {
    return `${formatNumber(value)} ${unit === 'counts' ? '' : unit}`.trim();
  }
  return `${value} ${unit === 'counts' ? '' : unit}`.trim();
}

function healthLabel(status?: string): string {
  const labels: Record<string, string> = {
    ok: '正常',
    no_data: '暂无数据',
    degraded: '降级',
    disabled: '已关闭',
    unknown: '未知',
  };
  return labels[status || ''] || status || '未知';
}

// 状态 → 语义色（旧壳 statusTone 的 token 版：成功/超时/失败/取消各归一个语义 token）
function statusTone(t: V7Tokens, status?: string): { color: string } {
  if (status === 'success' || status === 'completed' || status === 'ok') {
    return { color: t.up };
  }
  if (status === 'timeout' || status === 'partial_success' || status === 'needs_confirmation') {
    return { color: t.warn };
  }
  if (status === 'denied' || status === 'failed' || status === 'degraded') {
    return { color: t.down };
  }
  if (status === 'cancelled' || status === 'skipped') {
    return { color: t.sec };
  }
  return { color: t.mut };
}

export function MonitoringSheet(props: { visible: boolean; onClose: () => void }) {
  const { visible, onClose } = props;
  const ui = useUi();
  const t = ui.tokens;
  const styles = createStyles(t);

  const [segment, setSegment] = useState<MonitorSegment>('overview');
  const [rangeHours, setRangeHours] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [overview, setOverview] = useState<MonitoringOverviewResponse | null>(null);
  const [traces, setTraces] = useState<MonitoringTracesResponse | null>(null);
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [traceDetail, setTraceDetail] = useState<MonitoringTraceDetail | null>(null);
  const [traceEvents, setTraceEvents] = useState<MonitoringEvent[]>([]);
  const [events, setEvents] = useState<MonitoringEvent[] | null>(null);

  // 请求票据：丢弃过期响应（切段/切范围/换 Trace 后旧请求不再写状态），模式同 MemoryCenterScreen
  const requestRef = useRef(0);

  // 按当前段拉数据（端点与参数照旧壳 MonitoringScreen 的取数分支）
  const load = useCallback(async () => {
    const ticket = requestRef.current + 1;
    requestRef.current = ticket;

    setLoading(true);
    setError('');

    try {
      const to = new Date();
      const from = new Date(to.getTime() - rangeHours * 60 * 60 * 1000);
      const range = { from: from.toISOString(), to: to.toISOString() };

      if (segment === 'overview') {
        const data = await fetchMonitoring<MonitoringOverviewResponse>(
          API_PATHS.monitoringOverview(range.from, range.to)
        );
        if (ticket !== requestRef.current) return;
        setOverview(data);
      } else if (segment === 'traces') {
        const list = await fetchMonitoring<MonitoringTracesResponse>(
          API_PATHS.monitoringTraces({
            from: range.from,
            to: range.to,
            limit: 50,
          })
        );
        if (ticket !== requestRef.current) return;
        setTraces(list);

        // 列表刷新后同步刷新选中的 Trace 详情（照旧壳）
        if (selectedTraceId) {
          const detail = await fetchMonitoring<MonitoringTraceDetailResponse>(
            API_PATHS.monitoringTrace(selectedTraceId)
          );
          if (ticket !== requestRef.current) return;
          setTraceDetail(detail.trace || null);
          setTraceEvents(detail.events || []);
        }
      } else {
        // Events 段：error 级 + 权限拒绝事件去重合并，按发生时间倒序（照旧壳「错误·事件」）
        const [failed, denied] = await Promise.all([
          fetchMonitoring<MonitoringEventsResponse>(
            API_PATHS.monitoringEvents({
              from: range.from,
              to: range.to,
              level: 'error',
              limit: 100,
            })
          ),
          fetchMonitoring<MonitoringEventsResponse>(
            API_PATHS.monitoringEvents({
              from: range.from,
              to: range.to,
              status: 'denied',
              limit: 100,
            })
          ),
        ]);
        if (ticket !== requestRef.current) return;

        const merged = new Map<string, MonitoringEvent>();
        for (const item of [...(failed.items || []), ...(denied.items || [])]) {
          merged.set(item.event_id, item);
        }
        setEvents(
          [...merged.values()].sort(
            (a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at)
          )
        );
      }
    } catch (loadError) {
      if (ticket !== requestRef.current) return;
      setError(
        loadError instanceof Error ? loadError.message : '监控读取失败，请稍后重试'
      );
    } finally {
      if (ticket === requestRef.current) setLoading(false);
    }
  }, [segment, rangeHours, selectedTraceId]);

  // 打开 / 切段 / 切范围 / 换选中 Trace → 重新拉取。
  // 延迟到当前渲染提交后再发起请求，避免在 effect 内同步 setState（同 AgentToolsScreen）。
  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(() => {
      void load();
    }, 0);
    return () => clearTimeout(timer);
  }, [visible, load]);

  // 只读轮询：每 30 秒自动刷新一次（照旧壳节奏）
  useEffect(() => {
    if (!visible) return undefined;
    const timer = setInterval(() => {
      void load();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [visible, load]);

  // 段切换：离开 Traces 时清掉选中 Trace（照旧壳 switchTab）
  const switchSegment = (next: MonitorSegment) => {
    if (next !== 'traces') {
      setSelectedTraceId(null);
      setTraceDetail(null);
      setTraceEvents([]);
    }
    setSegment(next);
  };

  // 点选 Trace：清旧详情，effect 依赖变化触发重新拉取（照旧壳 openTrace）
  const openTrace = (traceId: string) => {
    setSelectedTraceId(traceId);
    setTraceDetail(null);
    setTraceEvents([]);
  };

  const closeTrace = () => {
    setSelectedTraceId(null);
    setTraceDetail(null);
    setTraceEvents([]);
  };

  const renderMetric = (metric: MonitoringMetricValue) => (
    <View key={`${metric.label}-${metric.unit}`} style={styles.metricRow}>
      <Text style={styles.metricLabel}>{metric.label}</Text>
      <Text style={styles.metricValue}>{metricText(metric)}</Text>
      {metric.note ? <Text style={styles.metricNote}>{metric.note}</Text> : null}
      {metric.definition ? (
        <Text style={styles.metricDefinition}>{metric.definition}</Text>
      ) : null}
    </View>
  );

  // 统计卡：旧壳卡片可跳段，v7 弹层纯展示，去掉按压与箭头，字段照旧
  const renderOverviewCard = (card: MonitoringCard) => {
    const disabled = card.data_status === 'no_data' || card.data_status === 'disabled';

    return (
      <View key={card.key} style={[styles.card, disabled ? styles.cardMuted : null]}>
        <Text style={styles.cardTitle}>{card.title}</Text>

        <View style={styles.primaryRow}>
          <Text style={styles.primaryValue}>{metricText(card.primary)}</Text>
          <Text style={styles.primaryLabel}>{card.primary.label}</Text>
        </View>

        {disabled ? (
          <Text style={styles.emptyInline}>
            {card.data_status === 'disabled'
              ? '监控已关闭，无法读取该指标'
              : '暂无数据 / 尚未接入，不能用 0 代表正常'}
          </Text>
        ) : (
          <View style={styles.metricGrid}>{card.metrics.map(renderMetric)}</View>
        )}
      </View>
    );
  };

  const renderReasonList = (title: string, reasons: string[]) => {
    if (!reasons.length) return null;
    return (
      <View style={styles.reasonBox}>
        <Text style={styles.reasonTitle}>{title}</Text>
        {reasons.slice(0, 10).map((reason, index) => (
          <Text key={`${reason}-${index}`} style={styles.reasonText}>
            · {reason}
          </Text>
        ))}
      </View>
    );
  };

  // Trace 详情的上下文排除/跳过原因（照旧壳 renderTraceExclusions）
  const renderTraceExclusions = (detail: MonitoringTraceDetail) => {
    const context = detail.context as
      | {
          dropped?: { kind?: string | null; stage?: string | null; reason?: string | null }[];
          memory_skipped?: { stage?: string | null; reason?: string | null }[];
        }
      | null;

    const dropped = Array.isArray(context?.dropped)
      ? context.dropped.map(
          item => `${item.kind || 'block'} / ${item.stage || 'dropped'}：${item.reason || '未说明'}`
        )
      : [];
    const skipped = Array.isArray(context?.memory_skipped)
      ? context.memory_skipped.map(
          item => `memory / ${item.stage || 'skipped'}：${item.reason || '未说明'}`
        )
      : [];

    if (!dropped.length && !skipped.length) return null;

    return (
      <View style={styles.card}>
        <Text style={styles.cardTitle}>排除原因</Text>
        {renderReasonList('上下文裁剪', dropped)}
        {renderReasonList('记忆跳过', skipped)}
      </View>
    );
  };

  const renderTraceRow = (trace: MonitoringTraceSummary) => (
    <Pressable
      key={trace.trace_id}
      onPress={() => openTrace(trace.trace_id)}
      style={({ pressed }) => [styles.listRow, pressed ? styles.listPressed : null]}
      accessibilityRole="button"
      accessibilityLabel={`查看 Trace ${trace.trace_id}`}
    >
      <View style={styles.rowBetween}>
        <View style={styles.badgeRow}>
          <Badge t={t} label={trace.task.status} />
          <Text style={styles.listTitle}>{trace.name}</Text>
        </View>
        <Text style={styles.chev}>›</Text>
      </View>
      <Text style={styles.mutedText}>
        {formatTime(trace.started_at)} · {formatDuration(trace.duration_ms)} · 模型{' '}
        {trace.model.calls} 次 · 工具 {trace.tools.executed} 次 · Token{' '}
        {formatNumber(trace.model.total_tokens)}
      </Text>
      <Text style={styles.monoSmall}>{trace.trace_id}</Text>
    </Pressable>
  );

  const renderTraces = () => {
    if (!traces) return null;

    if (traceDetail) {
      const stageItems = [
        ['候选 candidate', traceDetail.stages.candidate],
        ['选中 selected', traceDetail.stages.selected],
        ['接受 accepted', traceDetail.stages.accepted],
        ['注入 injected', traceDetail.stages.injected],
        ['发送 sent', traceDetail.stages.sent],
      ] as [string, number | null][];

      return (
        <View style={styles.section}>
          <TouchableOpacity
            onPress={closeTrace}
            style={styles.backRow}
            accessibilityRole="button"
            accessibilityLabel="返回 Trace 列表"
          >
            <Text style={styles.backText}>‹ 返回 Trace 列表</Text>
          </TouchableOpacity>

          <View style={styles.card}>
            <Text style={styles.monoSmall}>{traceDetail.trace_id}</Text>
            <View style={styles.badgeRow}>
              <Badge t={t} label={traceDetail.status} />
              <Text style={styles.mutedText}>
                {formatTime(traceDetail.started_at)} · {formatDuration(traceDetail.duration_ms)}
              </Text>
            </View>
            <Text style={styles.mutedText}>
              会话引用 {traceDetail.session_ref || '未知'} · 模型请求{' '}
              {traceDetail.model.calls} 次 / {traceDetail.model.rounds} 轮 · Token{' '}
              {formatNumber(traceDetail.model.total_tokens)}（
              {traceDetail.model.usage_source === 'provider' ? '供应商 usage' : '未提供'}
              {traceDetail.model.cached_tokens
                ? ` · 缓存命中 ${formatNumber(traceDetail.model.cached_tokens)}`
                : ''}
              ）
            </Text>
            <Text style={styles.mutedText}>
              工具 请求 {traceDetail.tools.requested} · 执行 {traceDetail.tools.executed} · 成功{' '}
              {traceDetail.tools.succeeded} · 失败 {traceDetail.tools.failed} · 去重{' '}
              {traceDetail.tools.deduped}
            </Text>
            {traceDetail.spans_dropped ? (
              <Text style={styles.warnText}>
                由于单 Trace 上限，另有 {traceDetail.spans_dropped} 个 span 未存储
              </Text>
            ) : null}
          </View>

          <Text style={styles.sectionTitle}>上下文阶段</Text>
          <View style={styles.card}>
            {stageItems.map(([label, value]) => (
              <View key={label} style={styles.stageRow}>
                <Text style={styles.stageLabel}>{label}</Text>
                <Text style={styles.stageValue}>
                  {value === null ? '未采集' : value}
                </Text>
              </View>
            ))}
            <Text style={styles.mutedText}>
              模型实际消费（consumed）：未采集。HTTP 成功不等于模型使用了每条内容。
            </Text>
          </View>

          {renderTraceExclusions(traceDetail)}

          <Text style={styles.sectionTitle}>时间线</Text>
          {traceDetail.spans.length ? (
            traceDetail.spans.map(span => (
              <View key={span.span_id} style={styles.timelineItem}>
                <View style={styles.timelineDot} />
                <View style={styles.timelineBody}>
                  <View style={styles.rowBetween}>
                    <Text style={styles.timelineName}>{span.name}</Text>
                    <Badge t={t} label={span.status} />
                  </View>
                  <Text style={styles.mutedText}>
                    {formatTime(span.started_at)} · {formatDuration(span.duration_ms)}
                    {span.error_code ? ` · ${span.error_code}` : ''}
                  </Text>
                  {Object.keys(span.attributes || {}).length ? (
                    <Text style={styles.attrText}>
                      {Object.entries(span.attributes)
                        .slice(0, 8)
                        .map(([key, value]) => `${key}=${String(value)}`)
                        .join('  ')}
                    </Text>
                  ) : null}
                </View>
              </View>
            ))
          ) : (
            <EmptyState t={t} text="该 Trace 没有 span 记录" />
          )}

          <Text style={styles.sectionTitle}>关联事件（仅元数据）</Text>
          {traceEvents.length ? (
            traceEvents.map(event => <EventRow key={event.event_id} t={t} event={event} />)
          ) : (
            <EmptyState t={t} text="暂无事件（或已超出保留期）" />
          )}
        </View>
      );
    }

    const items = traces.items || [];

    return (
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>
          Trace 列表（{traces.total ?? 0} 条，按开始时间倒序）
        </Text>
        {items.length ? (
          items.map(trace => renderTraceRow(trace))
        ) : (
          <EmptyState t={t} text="暂无 Trace。发起一次对话后，这里会显示真实请求链路。" />
        )}
      </View>
    );
  };

  const renderEvents = () => {
    const items = events || [];

    return (
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>错误与权限拒绝事件</Text>
        {items.length ? (
          items.map(event => <EventRow key={event.event_id} t={t} event={event} />)
        ) : (
          <EmptyState t={t} text="窗口内没有 error / denied 事件；这不代表从未发生，超出保留期的数据不可见。" />
        )}
        <Text style={styles.mutedText}>
          错误与权限拒绝只展示元数据与错误码；根因建议与证据分开展示，不把未验证的自动分析写成事实。
        </Text>
      </View>
    );
  };

  const renderOverview = () => {
    if (!overview) return <EmptyState t={t} text="暂无总览数据" />;
    if (!overview.ok) return <EmptyState t={t} text="总览暂不可用" />;

    return (
      <View style={styles.section}>
        <View style={styles.notice}>
          <Text style={styles.noticeTitle}>
            数据范围 {overview.range?.duration_minutes ?? 0} 分钟 · 状态{' '}
            {overview.data_status === 'no_data' ? '暂无数据' : '已采集'}
          </Text>
          <Text style={styles.noticeText}>
            监控自身：{healthLabel(overview.monitoring_health?.status)}
            {overview.monitoring_health?.reasons.length
              ? `（${overview.monitoring_health.reasons.join('、')}）`
              : ''}
          </Text>
          <Text style={styles.mutedText}>
            保留事件 {overview.coverage?.retained_events ?? 0} · 保留 Trace{' '}
            {overview.coverage?.retained_traces ?? 0} · 分位数为桶近似
          </Text>
        </View>

        {(overview.cards || []).map(renderOverviewCard)}

        <View style={styles.notice}>
          <Text style={styles.noticeTitle}>成本</Text>
          <Text style={styles.noticeText}>
            {overview.cost?.note || '未配置费率，成本未知'}
          </Text>
        </View>
      </View>
    );
  };

  const renderContent = () => {
    // 监控被关闭：所有段都如实说明（照旧壳 renderContent 的全局守卫）
    if (overview && overview.ok === false && overview.reason === 'disabled') {
      return (
        <EmptyState t={t} text="监控已关闭（BLUEBIRD_MONITORING=0）。这不等于系统健康；其他页面没有可信数据。" />
      );
    }
    if (loading && !overview && !traces && !events) {
      return (
        <View style={styles.loadingBox}>
          <ActivityIndicator color={t.card} />
          <Text style={styles.loadingTxt}>正在读取真实监控数据…</Text>
        </View>
      );
    }
    if (segment === 'overview') return renderOverview();
    if (segment === 'traces') return renderTraces();
    return renderEvents();
  };

  return (
    <SheetScaffold visible={visible} onClose={onClose} title="系统监控">
      <View style={styles.body}>
        <Text style={styles.subtitle}>只读 · 真实请求证据 · 无写操作</Text>

        {/* 分段：总览 / Traces / Events（原型 .seg） */}
        <View style={styles.seg}>
          {SEGMENTS.map(item => {
            const on = item.id === segment;
            return (
              <Pressable
                key={item.id}
                onPress={() => switchSegment(item.id)}
                style={[styles.segOpt, on ? styles.segOn : null]}
                accessibilityRole="button"
                accessibilityLabel={'监控分段：' + item.label}
              >
                <Text style={on ? styles.segOnTxt : styles.segOffTxt}>{item.label}</Text>
              </Pressable>
            );
          })}
        </View>

        {/* 时间范围 + 手动刷新（照旧壳工具行） */}
        <View style={styles.toolbar}>
          <View style={styles.rangeRow}>
            {RANGES.map(option => {
              const on = rangeHours === option.hours;
              return (
                <Pressable
                  key={option.hours}
                  onPress={() => setRangeHours(option.hours)}
                  style={[styles.rangeOpt, on ? styles.rangeOn : null]}
                  accessibilityLabel={'时间范围：' + option.label}
                >
                  <Text style={on ? styles.rangeOnTxt : styles.rangeOffTxt}>
                    {option.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <TouchableOpacity
            onPress={() => void load()}
            style={styles.refresh}
            accessibilityLabel="刷新监控数据"
          >
            <Text style={styles.refreshTxt}>{loading ? '刷新中…' : '刷新'}</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.pollNote}>每 30 秒自动刷新一次（只读轮询）</Text>

        {/* 错误如实提示 + 重试（不静默吞掉） */}
        {!!error && (
          <View style={styles.errorBox}>
            <Text style={styles.errorTxt}>{error}</Text>
            <TouchableOpacity
              onPress={() => void load()}
              accessibilityLabel="重试监控请求"
            >
              <Text style={styles.errorRetry}>重试</Text>
            </TouchableOpacity>
          </View>
        )}

        {renderContent()}

        <Text style={styles.footerNote}>
          隐私：只展示标识、数量、耗时、状态与原因；不展示 Prompt、记忆正文、工具参数或密钥。
        </Text>
      </View>
    </SheetScaffold>
  );
}

// 状态徽标（旧壳 Badge 的 token 版：语义色 + 同色低透明底）
function Badge(props: { t: V7Tokens; label: string }) {
  const { t, label } = props;
  const styles = createStyles(t);
  const tone = statusTone(t, label);
  return (
    <View style={[styles.badge, { backgroundColor: withAlpha(tone.color, 0.16) }]}>
      <Text style={[styles.badgeText, { color: tone.color }]}>{label}</Text>
    </View>
  );
}

// 空态（旧壳 EmptyState：占位居中、弱化色说明）
function EmptyState(props: { t: V7Tokens; text: string }) {
  const { t, text } = props;
  const styles = createStyles(t);
  return (
    <View style={styles.emptyBox}>
      <Text style={styles.emptyTxt}>{text}</Text>
    </View>
  );
}

// 事件行（名称 + 状态徽标 + 时间/耗时/错误码 + 属性元数据，照旧壳 renderEventRow）
function EventRow(props: { t: V7Tokens; event: MonitoringEvent }) {
  const { t, event } = props;
  const styles = createStyles(t);
  const attributes = Object.entries(event.attributes || {}).slice(0, 10);

  return (
    <View style={styles.eventRow}>
      <View style={styles.rowBetween}>
        <Text style={styles.eventName}>{event.event_name}</Text>
        <Badge t={t} label={event.status} />
      </View>
      <Text style={styles.mutedText}>
        {formatTime(event.occurred_at)} · {formatDuration(event.duration_ms)}
        {event.error_code ? ` · ${event.error_code}` : ''}
      </Text>
      {attributes.length ? (
        <Text style={styles.attrText}>
          {attributes.map(([key, value]) => `${key}=${String(value)}`).join('  ')}
        </Text>
      ) : null}
    </View>
  );
}

// v7 版式（旧壳 createStyles 的 token 移植；颜色全部取自 tokens，无硬编码色值）
const createStyles = (t: V7Tokens) =>
  StyleSheet.create({
    body: {
      paddingHorizontal: 16,
      paddingBottom: 24,
    },
    subtitle: {
      fontSize: 11,
      color: t.mut,
      marginTop: 2,
    },

    // 分段（原型 .seg{background:surface;r999;p3;sh-md}；弹层内落在 surface 上改用 soft 底）
    seg: {
      flexDirection: 'row',
      backgroundColor: t.soft,
      borderRadius: 999,
      padding: 3,
      marginTop: 10,
      ...V7_SHADOWS.md,
    },
    segOpt: { flex: 1, alignItems: 'center', paddingVertical: 7, borderRadius: 999 },
    segOn: { backgroundColor: t.card },
    segOnTxt: { fontSize: 12, color: t.on, fontWeight: '600' },
    segOffTxt: { fontSize: 12, color: t.sec },

    // 工具行：范围选项 + 刷新
    toolbar: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 10,
      marginTop: 12,
    },
    rangeRow: {
      flexDirection: 'row',
      backgroundColor: t.soft,
      borderRadius: 999,
      padding: 3,
    },
    rangeOpt: {
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: 999,
      alignItems: 'center',
    },
    rangeOn: { backgroundColor: t.card },
    rangeOnTxt: { fontSize: 11, color: t.on, fontWeight: '600' },
    rangeOffTxt: { fontSize: 11, color: t.sec },
    refresh: {
      backgroundColor: t.soft,
      borderRadius: 999,
      paddingVertical: 7,
      paddingHorizontal: 14,
      alignItems: 'center',
      ...V7_SHADOWS.md,
    },
    refreshTxt: { fontSize: 12, fontWeight: '600', color: t.sec },
    pollNote: {
      fontSize: 10,
      color: t.mut,
      marginTop: 6,
    },

    errorBox: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 10,
      marginTop: 10,
      padding: 10,
      borderRadius: 12,
      backgroundColor: withAlpha(t.down, 0.14),
    },
    errorTxt: {
      flex: 1,
      fontSize: 12,
      color: t.down,
    },
    errorRetry: {
      fontSize: 12,
      fontWeight: '700',
      color: t.down,
    },

    loadingBox: {
      paddingVertical: 36,
      alignItems: 'center',
      gap: 10,
    },
    loadingTxt: {
      fontSize: 12,
      color: t.sec,
    },

    section: {
      paddingTop: 10,
    },
    sectionTitle: {
      fontSize: 13,
      fontWeight: '700',
      color: t.ink,
      marginTop: 14,
      marginBottom: 8,
    },

    // 卡片（原型 .pcard：soft 底 r16 p12/14 mb8；阴影走 V7_SHADOWS.md）
    card: {
      backgroundColor: t.soft,
      borderRadius: 16,
      paddingVertical: 12,
      paddingHorizontal: 14,
      marginBottom: 8,
      gap: 8,
      ...V7_SHADOWS.md,
    },
    cardMuted: { opacity: 0.72 },
    cardTitle: {
      fontSize: 13,
      fontWeight: '700',
      color: t.ink,
    },
    primaryRow: {
      flexDirection: 'row',
      alignItems: 'baseline',
      gap: 8,
    },
    primaryValue: {
      fontSize: 22,
      fontWeight: '700',
      color: t.card,
    },
    primaryLabel: { fontSize: 12, color: t.mut },
    metricGrid: { gap: 4 },
    metricRow: { paddingVertical: 3 },
    metricLabel: { fontSize: 12, color: t.sec },
    metricValue: { fontSize: 13, color: t.ink, marginTop: 1 },
    metricNote: { fontSize: 11, color: t.mut, marginTop: 2 },
    metricDefinition: { fontSize: 10, color: t.mut, marginTop: 2 },
    emptyInline: {
      fontSize: 12,
      lineHeight: 18,
      color: t.mut,
    },

    mutedText: {
      fontSize: 12,
      lineHeight: 19,
      color: t.sec,
      marginTop: 4,
    },
    warnText: {
      fontSize: 11,
      lineHeight: 17,
      color: t.warn,
      marginTop: 5,
    },
    monoSmall: {
      fontSize: 10,
      color: t.mut,
      marginTop: 3,
      fontFamily: 'monospace',
    },

    // Trace 行（可按压列表卡片）
    listRow: {
      backgroundColor: t.soft,
      borderRadius: 16,
      paddingVertical: 11,
      paddingHorizontal: 14,
      marginBottom: 8,
      gap: 6,
    },
    listPressed: { opacity: 0.7 },
    listTitle: {
      fontSize: 13,
      fontWeight: '700',
      color: t.ink,
      flexShrink: 1,
    },
    chev: { fontSize: 16, color: t.mut },

    backRow: { paddingVertical: 8, alignSelf: 'flex-start' },
    backText: { fontSize: 13, fontWeight: '600', color: t.card },

    stageRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: 3,
    },
    stageLabel: { fontSize: 12, color: t.sec },
    stageValue: { fontSize: 13, color: t.ink },

    timelineItem: {
      flexDirection: 'row',
      paddingLeft: 4,
    },
    timelineDot: {
      width: 7,
      height: 7,
      borderRadius: 4,
      backgroundColor: t.card,
      marginTop: 6,
      marginRight: 10,
    },
    timelineBody: {
      flex: 1,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: withAlpha(t.mut, 0.4),
      paddingBottom: 9,
      marginBottom: 9,
    },
    timelineName: {
      fontSize: 13,
      fontWeight: '700',
      color: t.ink,
    },

    reasonBox: {
      marginTop: 8,
      paddingTop: 6,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: withAlpha(t.mut, 0.4),
    },
    reasonTitle: {
      fontSize: 11,
      fontWeight: '700',
      color: t.sec,
    },
    reasonText: {
      fontSize: 10,
      lineHeight: 16,
      color: t.mut,
      marginTop: 2,
    },

    attrText: {
      fontSize: 10,
      lineHeight: 16,
      color: t.mut,
      marginTop: 3,
    },
    eventRow: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: withAlpha(t.mut, 0.4),
      paddingVertical: 8,
    },
    eventName: {
      fontSize: 12,
      fontWeight: '600',
      color: t.ink,
      flexShrink: 1,
    },

    rowBetween: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8,
    },
    badgeRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      flexWrap: 'wrap',
    },
    badge: {
      borderRadius: 999,
      paddingHorizontal: 8,
      paddingVertical: 2,
    },
    badgeText: {
      fontSize: 11,
      fontWeight: '600',
    },

    notice: {
      backgroundColor: t.soft,
      borderRadius: 12,
      padding: 12,
      marginTop: 8,
      marginBottom: 8,
    },
    noticeTitle: {
      fontSize: 13,
      fontWeight: '700',
      color: t.ink,
    },
    noticeText: {
      fontSize: 12,
      lineHeight: 18,
      color: t.sec,
      marginTop: 4,
    },

    emptyBox: {
      paddingVertical: 22,
      paddingHorizontal: 14,
      alignItems: 'center',
    },
    emptyTxt: {
      fontSize: 13,
      lineHeight: 20,
      color: t.mut,
      textAlign: 'center',
    },

    footerNote: {
      fontSize: 10,
      lineHeight: 16,
      color: t.mut,
      textAlign: 'center',
      marginTop: 22,
    },
  });
