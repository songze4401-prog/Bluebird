import React, { useEffect, useMemo, useState } from 'react';
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
import { SafeAreaView } from 'react-native-safe-area-context';

import type { Theme } from '../theme';
import { apiFetch } from '../lib/api/client';
import { API_PATHS } from '../lib/api/endpoints';
import type {
  MonitoringAlertsResponse,
  MonitoringAuditResponse,
  MonitoringCard,
  MonitoringEvent,
  MonitoringEventsResponse,
  MonitoringHealthResponse,
  MonitoringMetricValue,
  MonitoringModelsResponse,
  MonitoringOverviewResponse,
  MonitoringTraceDetail,
  MonitoringTraceDetailResponse,
  MonitoringTraceSummary,
  MonitoringTracesResponse,
  MonitoringToolsResponse,
} from '../lib/api/types';
import { readJsonResponse } from '../lib/utils';

// 系统监控：独立只读工作区（页面第 5 节）。
// - 只用真实监控 API 的数据；空数据显示「暂无数据/尚未接入」，不显示看似正常的 0；
// - 隐私：后端只返回元数据，这里也不请求任何 prompt / 记忆正文 / 工具参数；
// - 无写接口：控制台不提供清理、改配置、执行工具或绕过权限的按钮。

type MonitoringTab =
  | 'overview'
  | 'traces'
  | 'context'
  | 'tools'
  | 'models'
  | 'errors'
  | 'security'
  | 'health';

const TABS: { id: MonitoringTab; label: string }[] = [
  { id: 'overview', label: '总览' },
  { id: 'traces', label: 'Trace' },
  { id: 'context', label: '上下文·记忆' },
  { id: 'tools', label: '工具' },
  { id: 'models', label: '模型·成本' },
  { id: 'errors', label: '错误·事件' },
  { id: 'security', label: '安全·可靠性' },
  { id: 'health', label: '健康·告警' },
];

const RANGES = [
  { hours: 1, label: '1 小时' },
  { hours: 24, label: '24 小时' },
  { hours: 168, label: '7 天' },
];

const CARD_TAB: Record<string, MonitoringTab> = {
  agent: 'traces',
  model: 'models',
  memory: 'context',
  context: 'context',
  tools: 'tools',
  http: 'errors',
  persistence: 'health',
  monitoring: 'health',
};

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

function statusTone(theme: Theme, status?: string) {
  if (status === 'success' || status === 'completed' || status === 'ok') {
    return { color: theme.online, background: withTone(theme.online) };
  }
  if (status === 'timeout' || status === 'partial_success') {
    return { color: theme.accent, background: withTone(theme.accent) };
  }
  if (status === 'denied' || status === 'failed' || status === 'degraded') {
    return { color: theme.danger, background: withTone(theme.danger) };
  }
  if (status === 'cancelled' || status === 'skipped') {
    return { color: theme.textSecondary, background: withTone(theme.textSecondary) };
  }
  return { color: theme.textMuted, background: withTone(theme.textMuted) };
}

function withTone(color: string) {
  const match = /^#?([0-9a-f]{6})$/i.exec(color);
  if (!match) return 'rgba(127,127,127,0.16)';
  const value = parseInt(match[1], 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, 0.16)`;
}

export function MonitoringScreen({
  visible,
  onClose,
  theme,
}: {
  visible: boolean;
  onClose: () => void;
  theme: Theme;
}) {
  const styles = useMemo(() => createStyles(theme), [theme]);

  const [tab, setTab] = useState<MonitoringTab>('overview');
  const [rangeHours, setRangeHours] = useState(1);
  const [refreshToken, setRefreshToken] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [overview, setOverview] = useState<MonitoringOverviewResponse | null>(null);
  const [traces, setTraces] = useState<MonitoringTracesResponse | null>(null);
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [traceDetail, setTraceDetail] = useState<MonitoringTraceDetail | null>(null);
  const [traceEvents, setTraceEvents] = useState<MonitoringEvent[]>([]);
  const [contextEvents, setContextEvents] = useState<MonitoringEvent[]>([]);
  const [memoryEvents, setMemoryEvents] = useState<MonitoringEvent[]>([]);
  const [tools, setTools] = useState<MonitoringToolsResponse | null>(null);
  const [models, setModels] = useState<MonitoringModelsResponse | null>(null);
  const [errorEvents, setErrorEvents] = useState<MonitoringEvent[]>([]);
  const [audit, setAudit] = useState<MonitoringAuditResponse | null>(null);
  const [health, setHealth] = useState<MonitoringHealthResponse | null>(null);
  const [alerts, setAlerts] = useState<MonitoringAlertsResponse | null>(null);

  useEffect(() => {
    if (!visible) return undefined;

    const timer = setInterval(() => {
      setRefreshToken(token => token + 1);
    }, 30000);

    return () => clearInterval(timer);
  }, [visible]);

  useEffect(() => {
    if (!visible) return;

    let cancelled = false;
    const to = new Date();
    const from = new Date(to.getTime() - rangeHours * 60 * 60 * 1000);
    const range = { from: from.toISOString(), to: to.toISOString() };

    const load = async () => {
      setLoading(true);
      setError('');

      try {
        if (tab === 'overview') {
          const data = await fetchMonitoring<MonitoringOverviewResponse>(
            API_PATHS.monitoringOverview(range.from, range.to)
          );
          if (!cancelled) setOverview(data);
        } else if (tab === 'traces') {
          const list = await fetchMonitoring<MonitoringTracesResponse>(
            API_PATHS.monitoringTraces({
              from: range.from,
              to: range.to,
              limit: 50,
            })
          );
          if (!cancelled) setTraces(list);

          if (selectedTraceId) {
            const detail = await fetchMonitoring<MonitoringTraceDetailResponse>(
              API_PATHS.monitoringTrace(selectedTraceId)
            );
            if (!cancelled) {
              setTraceDetail(detail.trace || null);
              setTraceEvents(detail.events || []);
            }
          }
        } else if (tab === 'context') {
          const [contextData, memoryData] = await Promise.all([
            fetchMonitoring<MonitoringEventsResponse>(
              API_PATHS.monitoringEvents({
                from: range.from,
                to: range.to,
                component: 'context',
                limit: 100,
              })
            ),
            fetchMonitoring<MonitoringEventsResponse>(
              API_PATHS.monitoringEvents({
                from: range.from,
                to: range.to,
                component: 'memory',
                limit: 100,
              })
            ),
          ]);
          if (!cancelled) {
            setContextEvents(contextData.items || []);
            setMemoryEvents(memoryData.items || []);
          }
        } else if (tab === 'tools') {
          const data = await fetchMonitoring<MonitoringToolsResponse>(
            API_PATHS.monitoringTools(range.from, range.to)
          );
          if (!cancelled) setTools(data);
        } else if (tab === 'models') {
          const data = await fetchMonitoring<MonitoringModelsResponse>(
            API_PATHS.monitoringModels(range.from, range.to)
          );
          if (!cancelled) setModels(data);
        } else if (tab === 'errors') {
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
          if (!cancelled) {
            const merged = new Map<string, MonitoringEvent>();
            for (const item of [...(failed.items || []), ...(denied.items || [])]) {
              merged.set(item.event_id, item);
            }
            setErrorEvents(
              [...merged.values()].sort(
                (a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at)
              )
            );
          }
        } else if (tab === 'security') {
          const [auditData, healthData] = await Promise.all([
            fetchMonitoring<MonitoringAuditResponse>(
              API_PATHS.monitoringAudit(range.from, range.to, 100)
            ),
            fetchMonitoring<MonitoringHealthResponse>(API_PATHS.monitoringHealth),
          ]);
          if (!cancelled) {
            setAudit(auditData);
            setHealth(healthData);
          }
        } else {
          const [healthData, alertData] = await Promise.all([
            fetchMonitoring<MonitoringHealthResponse>(API_PATHS.monitoringHealth),
            fetchMonitoring<MonitoringAlertsResponse>(API_PATHS.monitoringAlerts),
          ]);
          if (!cancelled) {
            setHealth(healthData);
            setAlerts(alertData);
          }
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(
            loadError instanceof Error ? loadError.message : '监控读取失败，请稍后重试'
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [visible, tab, rangeHours, selectedTraceId, refreshToken]);

  const openTrace = (traceId: string) => {
    setSelectedTraceId(traceId);
    setTraceDetail(null);
    setTraceEvents([]);
    setTab('traces');
  };

  const switchTab = (next: MonitoringTab) => {
    if (next !== 'traces') {
      setSelectedTraceId(null);
      setTraceDetail(null);
      setTraceEvents([]);
    }
    setTab(next);
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

  const renderOverviewCard = (card: MonitoringCard) => {
    const disabled = card.data_status === 'no_data' || card.data_status === 'disabled';

    return (
      <Pressable
        key={card.key}
        onPress={() => switchTab(CARD_TAB[card.key] || 'overview')}
        style={({ pressed }) => [
          styles.card,
          disabled && styles.cardMuted,
          pressed && styles.cardPressed,
        ]}
        accessibilityRole="button"
        accessibilityLabel={`${card.title}，${card.data_status === 'no_data' ? '暂无数据' : '查看详情'}`}
      >
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle}>{card.title}</Text>
          <Text style={styles.cardChevron}>›</Text>
        </View>

        <View style={styles.primaryRow}>
          <Text style={styles.primaryValue}>
            {metricText(card.primary)}
          </Text>
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
      </Pressable>
    );
  };

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
            onPress={() => {
              setSelectedTraceId(null);
              setTraceDetail(null);
              setTraceEvents([]);
            }}
            style={styles.backRow}
          >
            <Text style={styles.backText}>‹ 返回 Trace 列表</Text>
          </TouchableOpacity>

          <View style={styles.card}>
            <Text style={styles.monoSmall}>{traceDetail.trace_id}</Text>
            <View style={styles.badgeRow}>
              <Badge theme={theme} label={traceDetail.status} />
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
                    <Badge theme={theme} label={span.status} />
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
            <EmptyState text="该 Trace 没有 span 记录" />
          )}

          <Text style={styles.sectionTitle}>关联事件（仅元数据）</Text>
          {traceEvents.length ? (
            traceEvents.map(event => (
              <View key={event.event_id} style={styles.eventRow}>
                <View style={styles.rowBetween}>
                  <Text style={styles.eventName}>{event.event_name}</Text>
                  <Badge theme={theme} label={event.status} />
                </View>
                <Text style={styles.mutedText}>
                  {formatTime(event.occurred_at)} · {formatDuration(event.duration_ms)}
                  {event.error_code ? ` · ${event.error_code}` : ''}
                </Text>
              </View>
            ))
          ) : (
            <EmptyState text="暂无事件（或已超出保留期）" />
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
          <EmptyState text="暂无 Trace。发起一次对话后，这里会显示真实请求链路。" />
        )}
      </View>
    );
  };

  const renderTraceRow = (trace: MonitoringTraceSummary) => (
    <Pressable
      key={trace.trace_id}
      onPress={() => openTrace(trace.trace_id)}
      style={({ pressed }) => [styles.listRow, pressed && styles.cardPressed]}
      accessibilityRole="button"
      accessibilityLabel={`查看 Trace ${trace.trace_id}`}
    >
      <View style={styles.rowBetween}>
        <View style={styles.badgeRow}>
          <Badge theme={theme} label={trace.task.status} />
          <Text style={styles.listTitle}>{trace.name}</Text>
        </View>
        <Text style={styles.cardChevron}>›</Text>
      </View>
      <Text style={styles.mutedText}>
        {formatTime(trace.started_at)} · {formatDuration(trace.duration_ms)} · 模型{' '}
        {trace.model.calls} 次 · 工具 {trace.tools.executed} 次 · Token{' '}
        {formatNumber(trace.model.total_tokens)}
      </Text>
      <Text style={styles.monoSmall}>{trace.trace_id}</Text>
    </Pressable>
  );

  const renderContext = () => {
    const latestBuild = contextEvents.find(event =>
      event.event_name === 'context.build.completed' ||
      event.event_name === 'context.build.rejected'
    );
    // 发送发生在构建完成之后：以 context.sent 的最终计数为准，
    // 构建事件里的 stage_sent 只是构建时快照（通常为 0）。
    const latestSent = contextEvents.find(event => event.event_name === 'context.sent');
    const finalSent = latestSent
      ? latestSent.attributes.sent_count
      : latestBuild
        ? latestBuild.attributes.stage_sent
        : null;

    return (
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>最近一次上下文构建</Text>
        {latestBuild ? (
          <View style={styles.card}>
            <View style={styles.badgeRow}>
              <Badge theme={theme} label={latestBuild.status} />
              <Text style={styles.mutedText}>{formatTime(latestBuild.occurred_at)}</Text>
            </View>
            <Text style={styles.mutedText}>
              候选 {String(latestBuild.attributes.stage_candidate ?? '未采集')} → 选中{' '}
              {String(latestBuild.attributes.stage_selected ?? '未采集')} → 接受{' '}
              {String(latestBuild.attributes.stage_accepted ?? '未采集')} → 注入{' '}
              {String(latestBuild.attributes.stage_injected ?? '未采集')} → 发送{' '}
              {String(finalSent ?? '未采集')}
            </Text>
            <Text style={styles.mutedText}>
              历史 {String(latestBuild.attributes.history_total ?? '未知')} 条 · 摘要{' '}
              {String(latestBuild.attributes.summary_count ?? '未知')} 条 · 记忆候选{' '}
              {String(latestBuild.attributes.memory_candidates ?? '未知')} / 接受{' '}
              {String(latestBuild.attributes.memory_accepted ?? '未知')}
            </Text>
            <Text style={styles.mutedText}>
              输入估算 {String(latestBuild.attributes.estimated_input_tokens ?? '未知')} ·
              窗口 {String(latestBuild.attributes.window_tokens ?? '未知')}（
              {String(latestBuild.attributes.window_source ?? '未知')}）·
              {latestBuild.attributes.window_verified ? ' 已声明' : ' 未声明，使用保守护栏'}
            </Text>
            <Text style={styles.mutedText}>
              裁剪 {String(latestBuild.attributes.dropped_count ?? '0')} 条 · 错误{' '}
              {latestBuild.error_code || '无'}
            </Text>
            {renderReasonList(
              '排除/跳过原因',
              [
                ...((latestBuild.attributes.dropped_reasons as string[]) || []),
                ...((latestBuild.attributes.memory_skipped_reasons as string[]) || []),
              ]
            )}
          </View>
        ) : (
          <EmptyState text="暂无上下文构建事件。发起一次对话后会记录候选/选中/接受/注入/发送。" />
        )}

        <Text style={styles.sectionTitle}>上下文事件</Text>
        {contextEvents.length ? (
          contextEvents.map(event => renderEventRow(event))
        ) : (
          <EmptyState text="暂无上下文事件" />
        )}

        <Text style={styles.sectionTitle}>记忆检索与注入</Text>
        {memoryEvents.length ? (
          memoryEvents.map(event => renderEventRow(event))
        ) : (
          <EmptyState text="暂无记忆事件；无检索时不会伪造命中。" />
        )}
      </View>
    );
  };

  const renderEventRow = (event: MonitoringEvent) => (
    <View key={event.event_id} style={styles.eventRow}>
      <View style={styles.rowBetween}>
        <Text style={styles.eventName}>{event.event_name}</Text>
        <Badge theme={theme} label={event.status} />
      </View>
      <Text style={styles.mutedText}>
        {formatTime(event.occurred_at)} · {formatDuration(event.duration_ms)}
        {event.error_code ? ` · ${event.error_code}` : ''}
      </Text>
      {Object.keys(event.attributes || {}).length ? (
        <Text style={styles.attrText}>
          {Object.entries(event.attributes)
            .slice(0, 10)
            .map(([key, value]) => `${key}=${String(value)}`)
            .join('  ')}
        </Text>
      ) : null}
    </View>
  );

  const renderTools = () => {
    if (!tools) return null;

    return (
      <View style={styles.section}>
        <View style={styles.notice}>
          <Text style={styles.noticeTitle}>
            Agent 工具开关：{tools.agent_switch_on ? '已开启' : '未开启'}
          </Text>
          <Text style={styles.noticeText}>{tools.agent_switch_note}</Text>
          {tools.missing_capabilities && tools.missing_capabilities.length ? (
            <Text style={styles.warnText}>
              缺失能力：{tools.missing_capabilities.join('；')}
            </Text>
          ) : null}
        </View>

        {(tools.tools || []).length ? (
          tools.tools?.map(tool => (
            <View key={tool.name} style={styles.card}>
              <View style={styles.rowBetween}>
                <Text style={styles.cardTitle}>{tool.name}</Text>
                <Text style={styles.badgeText}>
                  {tool.read_only ? '只读' : '有副作用'}
                </Text>
              </View>
              <Text style={styles.mutedText}>{tool.description || '无描述'}</Text>
              <Text style={styles.mutedText}>
                调用 {tool.calls} · 成功 {tool.success} · 失败 {tool.failed} · 超时{' '}
                {tool.timeout} · 拒绝 {tool.denied} · P95 {formatDuration(tool.p95)}
              </Text>
              {tool.calls === 0 ? (
                <Text style={styles.emptyInline}>窗口内暂无调用样本</Text>
              ) : null}
            </View>
          ))
        ) : (
          <EmptyState text="未读取到已注册工具" />
        )}
      </View>
    );
  };

  const renderModels = () => {
    if (!models) return null;

    return (
      <View style={styles.section}>
        <View style={styles.notice}>
          <Text style={styles.noticeTitle}>成本与计费</Text>
          <Text style={styles.noticeText}>
            {models.cost?.note || '未配置费率，成本显示为未配置'}
          </Text>
        </View>

        {(models.models || []).length ? (
          models.models?.map(model => (
            <View key={`${model.provider_id}/${model.model_id}`} style={styles.card}>
              <Text style={styles.cardTitle}>{model.model_id}</Text>
              <Text style={styles.monoSmall}>{model.provider_id}</Text>
              <Text style={styles.mutedText}>
                请求 {model.requests} · 成功 {model.success} · 失败 {model.failed} · 超时{' '}
                {model.timeout} · 拒绝 {model.denied} · 取消 {model.cancelled}
              </Text>
              <Text style={styles.mutedText}>
                输入 Token {formatNumber(model.input_tokens)} · 输出 Token{' '}
                {formatNumber(model.output_tokens)} · 缓存命中{' '}
                {formatNumber(model.cached_tokens)} · 用量缺失请求 {model.usage_missing}
              </Text>
              <Text style={styles.mutedText}>
                耗时 avg {formatDuration(model.duration.avg)} · P50{' '}
                {formatDuration(model.duration.p50)} · P95{' '}
                {formatDuration(model.duration.p95)} · P99{' '}
                {formatDuration(model.duration.p99)}（分位数为桶近似）
              </Text>
            </View>
          ))
        ) : (
          <EmptyState text="暂无模型调用样本。没有数据时不展示 0% 成功率。" />
        )}
      </View>
    );
  };

  const renderErrors = () => (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>错误与权限拒绝事件</Text>
      {errorEvents.length ? (
        errorEvents.map(event => renderEventRow(event))
      ) : (
        <EmptyState text="窗口内没有 error / denied 事件；这不代表从未发生，超出保留期的数据不可见。" />
      )}
      <Text style={styles.mutedText}>
        错误与权限拒绝只展示元数据与错误码；根因建议与证据分开展示，不把未验证的自动分析写成事实。
      </Text>
    </View>
  );

  const renderSecurity = () => (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>敏感操作审计</Text>
      {(audit?.items || []).length ? (
        audit?.items?.map(record => (
          <View key={record.audit_id} style={styles.eventRow}>
            <View style={styles.rowBetween}>
              <Text style={styles.eventName}>{record.action}</Text>
              <Badge theme={theme} label={record.result} />
            </View>
            <Text style={styles.mutedText}>
              {formatTime(record.occurred_at)} · 对象 {record.target || '未记录'} · 操作者{' '}
              {record.actor_ref || '未记录'} · 会话 {record.session_ref || '未记录'}
            </Text>
            {record.reason ? (
              <Text style={styles.attrText}>原因 {record.reason}</Text>
            ) : null}
          </View>
        ))
      ) : (
        <EmptyState text="暂无审计记录（清空/删除/配置变更会留下审计）" />
      )}

      <Text style={styles.sectionTitle}>数据持久化与备份</Text>
      <View style={styles.card}>
        <Text style={styles.mutedText}>
          会话落盘（24 小时窗口）：写入 {health?.persistence?.writes ?? '未知'} · 失败{' '}
          {health?.persistence?.failed ?? '未知'} · 状态{' '}
          {health?.persistence?.ok === true
            ? '正常'
            : health?.persistence?.ok === false
              ? '异常'
              : '无样本'}
        </Text>
        <Text style={styles.mutedText}>{health?.persistence?.note || '未采集到持久化样本'}</Text>
        <Text style={styles.mutedText}>
          备份：{health?.backup?.exists
            ? health.backup.ok
              ? '最近备份正常'
              : `异常（${health.backup.reason || '未知原因'}）`
            : '未配置 / 无状态文件'}
        </Text>
        <Text style={styles.mutedText}>
          最近成功 {formatTime(health?.backup?.last_success_at || null)} · 定时任务{' '}
          {health?.backup?.scheduled_task_configured || '未知'} · 恢复演练{' '}
          {health?.backup?.restore_drill || '未知'}
        </Text>
        <Text style={styles.warnText}>
          控制台只读：清除、恢复、权限变更仍走原有确认链路，不在此处提供绕过入口。
        </Text>
      </View>
    </View>
  );

  const renderHealth = () => {
    if (!health) return null;

    const rules = alerts?.rules || [];
    const alertItems = alerts?.items || [];

    return (
      <View style={styles.section}>
        <View
          style={[
            styles.notice,
            health.status !== 'ok' && health.status !== 'no_data' && styles.noticeDanger,
          ]}
        >
          <Text style={styles.noticeTitle}>
            监控状态：{healthLabel(health.status)}
          </Text>
          <Text style={styles.noticeText}>
            {(health.reasons || []).length
              ? `原因：${(health.reasons || []).join('、')}`
              : '写盘、事件保留与告警评估均未报告异常。'}
          </Text>
          <Text style={styles.mutedText}>
            数据新鲜度 {formatDuration((health.data_freshness_seconds || 0) * 1000)} · 事件{' '}
            {health.storage?.retained_events ?? 0} · Trace {health.storage?.retained_traces ?? 0}{' '}
            · 审计 {health.storage?.retained_audit ?? 0} · 队列 {health.storage?.queue_depth ?? 0}
          </Text>
          <Text style={styles.mutedText}>
            写盘失败 {String(health.counters?.write_failures ?? 0)} · 丢弃{' '}
            {String(health.counters?.queue_dropped ?? 0)} · 查询{' '}
            {health.query_layer?.calls ?? 0} 次 / 错误 {health.query_layer?.errors ?? 0}
          </Text>
        </View>

        <Text style={styles.sectionTitle}>备份与恢复</Text>
        <View style={styles.card}>
          <Text style={styles.mutedText}>
            状态：{health.backup?.exists
              ? health.backup.ok
                ? '最近备份正常'
                : `异常（${health.backup.reason || '未知原因'}）`
              : '未配置 / 无状态文件'}
          </Text>
          <Text style={styles.mutedText}>
            最近成功：{formatTime(health.backup?.last_success_at || null)} · 连续失败{' '}
            {health.backup?.consecutive_failures ?? '未知'}
          </Text>
          <Text style={styles.mutedText}>
            定时任务：{health.backup?.scheduled_task_configured || '未知'}（代码存在不代表已调度）
          </Text>
          <Text style={styles.mutedText}>
            恢复演练：{health.backup?.restore_drill || '未知'}
          </Text>
          <Text style={styles.warnText}>
            同卷备份不代表灾难恢复级：{String(health.backup?.disaster_recovery_grade)}
          </Text>
        </View>

        <Text style={styles.sectionTitle}>告警中心</Text>
        <View style={styles.notice}>
          <Text style={styles.noticeTitle}>
            活跃告警：{alerts?.health?.active_alerts ?? 0} · 规则{' '}
            {alerts?.health?.enabled_rules ?? 0}/{alerts?.health?.rule_count ?? 0}
          </Text>
          <Text style={styles.noticeText}>
            外部通知：{alerts?.health?.notifications.configured ? '已配置' : '未配置'}
            {alerts?.health?.notifications.reason
              ? `（${alerts.health.notifications.reason}）`
              : ''}
          </Text>
        </View>

        {alertItems.length ? (
          alertItems.map(alert => (
            <View key={alert.alert_id} style={styles.card}>
              <View style={styles.rowBetween}>
                <Text style={styles.cardTitle}>{alert.rule_name}</Text>
                <Badge theme={theme} label={`${alert.severity} · ${alert.status}`} />
              </View>
              <Text style={styles.mutedText}>
                触发 {formatTime(alert.triggered_at)} · 最近评估{' '}
                {formatTime(alert.last_evaluated_at)} · 抑制{' '}
                {alert.suppressed_evaluations} 次
              </Text>
              <Text style={styles.attrText}>
                观测 {String(alert.evidence?.observed ?? '未知')} / 阈值{' '}
                {String(alert.evidence?.threshold ?? '未知')} · 样本{' '}
                {String(alert.evidence?.samples ?? '未知')}
              </Text>
            </View>
          ))
        ) : (
          <EmptyState text="暂无触发中的告警；规则在后台按窗口评估，低流量时保持 insufficient_data。" />
        )}

        <Text style={styles.sectionTitle}>规则清单</Text>
        {rules.map(rule => (
          <View key={rule.id} style={styles.ruleRow}>
            <View style={styles.rowBetween}>
              <Text style={styles.eventName}>{rule.name}</Text>
              <Text style={styles.badgeText}>
                {rule.enabled ? rule.severity : '未启用'}
              </Text>
            </View>
            <Text style={styles.mutedText}>
              窗口 {rule.window_minutes} 分钟 · 最小样本 {rule.min_samples} · 规则版本{' '}
              {rule.version}
            </Text>
            {rule.enabled ? null : (
              <Text style={styles.attrText}>
                停用原因：{rule.disabled_reason || '未说明'}
              </Text>
            )}
          </View>
        ))}
      </View>
    );
  };

  const renderReasonList = (title: string, reasons: string[] | null | undefined) => {
    if (!Array.isArray(reasons) || reasons.length === 0) return null;
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

  const renderTraceExclusions = (detail: MonitoringTraceDetail) => {
    const context = detail.context as
      | {
          dropped?: { kind?: string | null; stage?: string | null; reason?: string | null }[];
          memory_skipped?: { stage?: string | null; reason?: string | null }[];
        }
      | null;

    const dropped = Array.isArray(context?.dropped)
      ? context?.dropped.map(
          item => `${item.kind || 'block'} / ${item.stage || 'dropped'}：${item.reason || '未说明'}`
        )
      : [];
    const skipped = Array.isArray(context?.memory_skipped)
      ? context?.memory_skipped.map(
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

  const renderContent = () => {
    if (overview && overview.ok === false && overview.reason === 'disabled') {
      return (
        <EmptyState text="监控已关闭（BLUEBIRD_MONITORING=0）。这不等于系统健康；其他页面没有可信数据。" />
      );
    }

    if (loading && !overview && !traces && !tools && !models && !health) {
      return (
        <View style={styles.loadingBox}>
          <ActivityIndicator color={theme.accent} />
          <Text style={styles.mutedText}>正在读取真实监控数据…</Text>
        </View>
      );
    }

    if (tab === 'overview') {
      if (!overview) return <EmptyState text="暂无总览数据" />;
      if (!overview.ok) {
        return <EmptyState text="总览暂不可用" />;
      }

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
    }

    if (tab === 'traces') return renderTraces();
    if (tab === 'context') return renderContext();
    if (tab === 'tools') return renderTools();
    if (tab === 'models') return renderModels();
    if (tab === 'errors') return renderErrors();
    if (tab === 'security') return renderSecurity();
    return renderHealth();
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>系统监控</Text>
            <Text style={styles.subtitle}>只读 · 真实请求证据 · 无写操作</Text>
          </View>
          <TouchableOpacity onPress={onClose} hitSlop={10} accessibilityLabel="关闭系统监控">
            <Text style={styles.close}>✕</Text>
          </TouchableOpacity>
        </View>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.tabStrip}
          contentContainerStyle={styles.tabStripContent}
        >
          {TABS.map(item => {
            const active = item.id === tab;
            return (
              <TouchableOpacity
                key={item.id}
                onPress={() => switchTab(item.id)}
                style={[styles.tabItem, active && styles.tabItemActive]}
                accessibilityRole="tab"
                accessibilityState={{ selected: active }}
              >
                <Text style={[styles.tabText, active && styles.tabTextActive]}>
                  {item.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        <View style={styles.toolbar}>
          <View style={styles.rangeRow}>
            {RANGES.map(option => {
              const active = rangeHours === option.hours;
              return (
                <TouchableOpacity
                  key={option.hours}
                  onPress={() => setRangeHours(option.hours)}
                  style={[styles.rangeItem, active && styles.rangeItemActive]}
                >
                  <Text style={[styles.rangeText, active && styles.rangeTextActive]}>
                    {option.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <TouchableOpacity
            onPress={() => setRefreshToken(token => token + 1)}
            style={styles.refreshButton}
            accessibilityLabel="刷新监控数据"
          >
            <Text style={styles.refreshText}>{loading ? '刷新中…' : '刷新'}</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.autoRefreshNote}>每 30 秒自动刷新一次（只读轮询）</Text>

        {error ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
            <TouchableOpacity onPress={() => setRefreshToken(token => token + 1)}>
              <Text style={styles.errorRetry}>重试</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        <ScrollView
          style={styles.content}
          contentContainerStyle={styles.contentInner}
          showsVerticalScrollIndicator={false}
        >
          {renderContent()}
          <Text style={styles.footerNote}>
            隐私：只展示标识、数量、耗时、状态与原因；不展示 Prompt、记忆正文、工具参数或密钥。
          </Text>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

function Badge({ theme, label }: { theme: Theme; label: string }) {
  const styles = useMemo(() => createStyles(theme), [theme]);
  const tone = statusTone(theme, label);
  return (
    <View style={[styles.badge, { backgroundColor: tone.background }]}>
      <Text style={[styles.badgeText, { color: tone.color }]}>{label}</Text>
    </View>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <View style={emptyStyles.box}>
      <Text style={emptyStyles.text}>{text}</Text>
    </View>
  );
}

const emptyStyles = StyleSheet.create({
  box: {
    paddingVertical: 22,
    paddingHorizontal: 14,
    alignItems: 'center',
  },
  text: {
    color: '#8b93a3',
    fontSize: 13,
    lineHeight: 20,
    textAlign: 'center',
  },
});

function createStyles(theme: Theme) {
  return StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: theme.background,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 18,
      paddingTop: 10,
      paddingBottom: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
    },
    title: {
      color: theme.textPrimary,
      fontSize: 20,
      fontWeight: '600',
    },
    subtitle: {
      color: theme.textMuted,
      fontSize: 12,
      marginTop: 3,
    },
    close: {
      color: theme.textSecondary,
      fontSize: 18,
      padding: 4,
    },
    tabStrip: {
      maxHeight: 46,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
    },
    tabStripContent: {
      paddingHorizontal: 12,
      alignItems: 'center',
    },
    tabItem: {
      paddingHorizontal: 12,
      paddingVertical: 11,
      borderBottomWidth: 2,
      borderBottomColor: 'transparent',
    },
    tabItemActive: {
      borderBottomColor: theme.accent,
    },
    tabText: {
      color: theme.textSecondary,
      fontSize: 13,
    },
    tabTextActive: {
      color: theme.accent,
      fontWeight: '600',
    },
    toolbar: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 10,
    },
    rangeRow: {
      flexDirection: 'row',
      backgroundColor: theme.surfaceAlt,
      borderRadius: 9,
      padding: 2,
    },
    rangeItem: {
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: 7,
    },
    rangeItemActive: {
      backgroundColor: theme.surface,
    },
    rangeText: {
      color: theme.textSecondary,
      fontSize: 12,
    },
    rangeTextActive: {
      color: theme.textPrimary,
      fontWeight: '600',
    },
    refreshButton: {
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.borderStrong,
    },
    refreshText: {
      color: theme.textBody,
      fontSize: 12,
    },
    autoRefreshNote: {
      color: theme.textMuted,
      fontSize: 10,
      paddingHorizontal: 16,
      marginTop: -4,
      marginBottom: 4,
    },
    content: {
      flex: 1,
    },
    contentInner: {
      paddingHorizontal: 16,
      paddingBottom: 28,
    },
    section: {
      paddingTop: 6,
    },
    sectionTitle: {
      color: theme.textPrimary,
      fontSize: 14,
      fontWeight: '600',
      marginTop: 16,
      marginBottom: 8,
    },
    card: {
      backgroundColor: theme.surface,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      padding: 14,
      marginBottom: 10,
    },
    cardMuted: {
      opacity: 0.72,
    },
    cardPressed: {
      opacity: 0.7,
    },
    cardHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    cardTitle: {
      color: theme.textPrimary,
      fontSize: 14,
      fontWeight: '600',
      flexShrink: 1,
    },
    cardChevron: {
      color: theme.textMuted,
      fontSize: 18,
      marginLeft: 8,
    },
    primaryRow: {
      flexDirection: 'row',
      alignItems: 'baseline',
      marginTop: 8,
    },
    primaryValue: {
      color: theme.accent,
      fontSize: 22,
      fontWeight: '700',
    },
    primaryLabel: {
      color: theme.textMuted,
      fontSize: 12,
      marginLeft: 8,
    },
    metricGrid: {
      marginTop: 10,
    },
    metricRow: {
      paddingVertical: 3,
    },
    metricLabel: {
      color: theme.textSecondary,
      fontSize: 12,
    },
    metricValue: {
      color: theme.textBody,
      fontSize: 13,
      marginTop: 1,
    },
    metricNote: {
      color: theme.textMuted,
      fontSize: 11,
      marginTop: 2,
    },
    metricDefinition: {
      color: theme.textMuted,
      fontSize: 10,
      marginTop: 2,
      opacity: 0.8,
    },
    emptyInline: {
      color: theme.textMuted,
      fontSize: 12,
      marginTop: 8,
      lineHeight: 18,
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
    mutedText: {
      color: theme.textSecondary,
      fontSize: 12,
      lineHeight: 19,
      marginTop: 4,
    },
    warnText: {
      color: theme.accent,
      fontSize: 11,
      lineHeight: 17,
      marginTop: 5,
    },
    monoSmall: {
      color: theme.textMuted,
      fontSize: 10,
      marginTop: 3,
    },
    listRow: {
      backgroundColor: theme.surface,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      padding: 13,
      marginBottom: 9,
    },
    listTitle: {
      color: theme.textPrimary,
      fontSize: 13,
      fontWeight: '600',
    },
    backRow: {
      paddingVertical: 8,
    },
    backText: {
      color: theme.accent,
      fontSize: 13,
    },
    stageRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: 3,
    },
    stageLabel: {
      color: theme.textSecondary,
      fontSize: 12,
    },
    stageValue: {
      color: theme.textBody,
      fontSize: 13,
    },
    timelineItem: {
      flexDirection: 'row',
      paddingLeft: 4,
    },
    timelineDot: {
      width: 7,
      height: 7,
      borderRadius: 4,
      backgroundColor: theme.accent,
      marginTop: 6,
      marginRight: 10,
    },
    timelineBody: {
      flex: 1,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
      paddingBottom: 9,
      marginBottom: 9,
    },
    timelineName: {
      color: theme.textPrimary,
      fontSize: 13,
      fontWeight: '600',
    },
    reasonBox: {
      marginTop: 8,
      paddingTop: 6,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
    },
    reasonTitle: {
      color: theme.textSecondary,
      fontSize: 11,
      fontWeight: '600',
    },
    reasonText: {
      color: theme.textMuted,
      fontSize: 10,
      lineHeight: 16,
      marginTop: 2,
    },
    attrText: {
      color: theme.textMuted,
      fontSize: 10,
      lineHeight: 16,
      marginTop: 3,
    },
    eventRow: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
      paddingVertical: 8,
    },
    eventName: {
      color: theme.textBody,
      fontSize: 12,
      fontWeight: '600',
      flexShrink: 1,
    },
    notice: {
      backgroundColor: theme.surfaceAlt,
      borderRadius: 11,
      padding: 12,
      marginTop: 8,
      marginBottom: 8,
    },
    noticeDanger: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.dangerBorder,
    },
    noticeTitle: {
      color: theme.textPrimary,
      fontSize: 13,
      fontWeight: '600',
    },
    noticeText: {
      color: theme.textSecondary,
      fontSize: 12,
      lineHeight: 18,
      marginTop: 4,
    },
    ruleRow: {
      paddingVertical: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
    },
    loadingBox: {
      paddingVertical: 40,
      alignItems: 'center',
      gap: 10,
    },
    errorBox: {
      marginHorizontal: 16,
      marginBottom: 8,
      padding: 10,
      borderRadius: 9,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.dangerBorder,
      backgroundColor: withTone(theme.danger),
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 10,
    },
    errorText: {
      color: theme.danger,
      fontSize: 12,
      flex: 1,
    },
    errorRetry: {
      color: theme.danger,
      fontSize: 12,
      fontWeight: '600',
    },
    footerNote: {
      color: theme.textMuted,
      fontSize: 10,
      lineHeight: 16,
      textAlign: 'center',
      marginTop: 22,
    },
  });
}
