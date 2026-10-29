import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Modal,
  PanResponder,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { type Theme } from '../theme';
import { apiFetch } from '../lib/api/client';
import { API_PATHS } from '../lib/api/endpoints';
import { apiErrorFromPayload } from '../lib/api/errors';
import type {
  AgentPolicyResponse,
  AgentPolicySaveResponse,
  PersonaResponse,
  PersonaSaveResponse,
} from '../lib/api/types';
import {
  type AgentPolicyConfig,
  type AgentPolicyTool,
  type PersonaConfig,
} from '../lib/types';

// Blue 人格控制面板：独立弹层，不挤占主聊天界面。
// 配置读写都走后端 /persona（服务端 persona.json 是唯一数据源），
// 前端不留副本——这样保存后重启、换设备都一致，且面板不是"假调节"。

type SliderKey = 'colloquial' | 'warmth' | 'initiative' | 'length';

type SliderDef = {
  key: SliderKey;
  title: string;
  anchors: [string, string, string]; // 左 / 中 / 右 语义标签
};

const SLIDERS: SliderDef[] = [
  { key: 'colloquial', title: '口语化', anchors: ['正式', '自然', '随意'] },
  { key: 'warmth', title: '温暖程度', anchors: ['冷淡', '适中', '温暖'] },
  { key: 'initiative', title: '主动表达', anchors: ['被动回应', '适度', '主动'] },
  { key: 'length', title: '表达长度', anchors: ['简短', '适中', '详细'] },
];

const MODE_OPTIONS: { id: PersonaConfig['messageMode']; label: string }[] = [
  { id: 'single', label: '单条回复' },
  { id: 'auto', label: '自动判断分几条' },
  { id: 'frequent', label: '更频繁地连续发送' },
];

const MODE_LABEL: Record<PersonaConfig['messageMode'], string> = {
  single: '单条回复',
  auto: '自动判断',
  frequent: '频繁连续',
};

const AGENT_MODES: {
  id: AgentPolicyConfig['mode'];
  label: string;
  hint: string;
}[] = [
  { id: 'answer_only', label: '只回答', hint: '不调用任何工具' },
  {
    id: 'plan_then_act',
    label: '先计划再执行',
    hint: '先形成简短计划，再在允许范围内调用工具',
  },
  {
    id: 'bounded_autonomy',
    label: '有界自主',
    hint: '在服务端预算与授权范围内自主执行',
  },
];

const RISK_LABEL: Record<AgentPolicyTool['risk'], string> = {
  read: '只读',
  reversible_write: '可逆写入',
  high_risk: '高风险（需后端确认）',
};

// 自绘滑块：RN 核心没有 Slider 组件，且不引入新依赖。
// 支持拖动 thumb、点按轨道定位；值域 0-100 整数。
function Slider({
  theme,
  value,
  onChange,
}: {
  theme: Theme;
  value: number;
  onChange: (value: number) => void;
}) {
  const [trackWidth, setTrackWidth] = useState(0);
  const widthRef = useRef(0);
  const valueRef = useRef(value);

  // 最新值同步到 ref：放进 effect，避免在渲染期间写 ref（react-hooks/refs）。
  // 手势回调发生在事件阶段，读到的仍是最新值，行为与原实现在渲染期直写一致。
  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  const setFromX = (x: number) => {
    const w = widthRef.current;

    if (w <= 0) return;

    const next = Math.round(Math.min(1, Math.max(0, x / w)) * 100);

    if (next !== valueRef.current) onChange(next);
  };

  // PanResponder 只需创建一次；用 useMemo 持有实例（而非 useRef().current），
  // 渲染期不再读 ref.current。回调只在手势事件里读 ref，符合 refs 使用约束。
  // 该规则无法区分"渲染期调用"与"事件期回调"，对 PanResponder 属已知假阳性，
  // 这里定点抑制（行为与抑制前完全一致）。
  const panResponder = useMemo(
    () =>
      // eslint-disable-next-line react-hooks/refs -- 手势回调仅在事件阶段读 ref，渲染期不读
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        // 手指落在轨道 / 在轨道内滑动时，locationX 相对轨道自身
        onPanResponderGrant: evt => setFromX(evt.nativeEvent.locationX),
        onPanResponderMove: evt => setFromX(evt.nativeEvent.locationX),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const ratio = Math.min(1, Math.max(0, value / 100));
  const thumbLeft = trackWidth > 0 ? ratio * trackWidth : 0;

  return (
    <View
      style={sliderStyles.touchZone}
      onLayout={e => {
        const w = e.nativeEvent.layout.width;

        widthRef.current = w;
        setTrackWidth(w);
      }}
      {...panResponder.panHandlers}
    >
      <View
        style={[sliderStyles.track, { backgroundColor: theme.borderStrong }]}
      >
        <View
          style={[
            sliderStyles.fill,
            { backgroundColor: theme.textPrimary, width: thumbLeft },
          ]}
        />
      </View>
      <View
        style={[
          sliderStyles.thumb,
          {
            backgroundColor: theme.background,
            borderColor: theme.textPrimary,
            left: Math.max(0, thumbLeft - 11),
          },
        ]}
        pointerEvents="none"
      />
    </View>
  );
}

function Stepper({
  theme,
  label,
  hint,
  value,
  min,
  max,
  step,
  display,
  onChange,
}: {
  theme: Theme;
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (value: number) => void;
}) {
  const clamp = (next: number) => Math.min(max, Math.max(min, next));

  return (
    <View style={stepperStyles.row}>
      <View style={stepperStyles.text}>
        <Text style={[stepperStyles.label, { color: theme.textPrimary }]}>
          {label}
        </Text>
        <Text style={[stepperStyles.hint, { color: theme.textMuted }]}>
          {hint}
        </Text>
      </View>
      <View style={stepperStyles.controls}>
        <TouchableOpacity
          style={[stepperStyles.button, { borderColor: theme.borderStrong }]}
          onPress={() => onChange(clamp(value - step))}
          disabled={value <= min}
          activeOpacity={0.7}
        >
          <Text style={[stepperStyles.buttonText, { color: theme.textPrimary }]}>
            −
          </Text>
        </TouchableOpacity>
        <Text style={[stepperStyles.value, { color: theme.textPrimary }]}>
          {display}
        </Text>
        <TouchableOpacity
          style={[stepperStyles.button, { borderColor: theme.borderStrong }]}
          onPress={() => onChange(clamp(value + step))}
          disabled={value >= max}
          activeOpacity={0.7}
        >
          <Text style={[stepperStyles.buttonText, { color: theme.textPrimary }]}>
            +
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const stepperStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
  },
  text: { flex: 1, marginRight: 12 },
  label: { fontSize: 15, fontWeight: '600' },
  hint: { fontSize: 12, lineHeight: 17, marginTop: 2 },
  controls: { flexDirection: 'row', alignItems: 'center' },
  button: {
    width: 30,
    height: 30,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: { fontSize: 18, lineHeight: 20 },
  value: {
    minWidth: 54,
    textAlign: 'center',
    fontSize: 14,
    fontWeight: '600',
  },
});

const sliderStyles = StyleSheet.create({
  touchZone: {
    height: 34,
    justifyContent: 'center',
  },
  track: {
    height: 3,
    borderRadius: 2,
    overflow: 'visible',
  },
  fill: {
    height: 3,
    borderRadius: 2,
  },
  thumb: {
    position: 'absolute',
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    top: 6,
  },
});

export function ControlPanelScreen({
  theme,
  visible,
  onClose,
  streamingEnabled,
  onToggleStreaming,
}: {
  theme: Theme;
  visible: boolean;
  onClose: () => void;
  streamingEnabled: boolean;
  onToggleStreaming: (next: boolean) => void;
}) {
  const styles = useMemo(() => createStyles(theme), [theme]);

  const [config, setConfig] = useState<PersonaConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [policy, setPolicy] = useState<AgentPolicyConfig | null>(null);
  const [policyMeta, setPolicyMeta] = useState<AgentPolicyResponse['meta'] | null>(null);
  const [policyTools, setPolicyTools] = useState<AgentPolicyTool[]>([]);
  const [policyLimits, setPolicyLimits] = useState<AgentPolicyResponse['limits'] | null>(null);
  const [policyRuntimeMaxRounds, setPolicyRuntimeMaxRounds] = useState(5);
  const [policyLoading, setPolicyLoading] = useState(false);
  const [policySaving, setPolicySaving] = useState(false);
  const [policyNotice, setPolicyNotice] = useState<string | null>(null);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // 打开即拉取当前配置（含服务端默认值，恢复默认以此为准）
  useEffect(() => {
    if (!visible) return;

    let cancelled = false;

    (async () => {
      setLoading(true);
      setLoadError(null);
      setNotice(null);

      try {
        const response = await apiFetch(API_PATHS.persona);

        const data = (await response.json()) as PersonaResponse;

        if (!response.ok) {
          throw apiErrorFromPayload(data, response.status, '配置加载失败');
        }

        if (!cancelled) setConfig(data.config);
      } catch {
        if (!cancelled) setLoadError('配置加载失败，请检查后端连接');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [visible]);

  // Agent 策略是服务端配置；与上面的 Persona 一样，打开面板即读取，
  // 不在前端保存权威副本。保存/恢复默认都直接落到 agent-policy.json。
  useEffect(() => {
    if (!visible) return;

    let cancelled = false;

    (async () => {
      setPolicyLoading(true);
      setPolicyError(null);
      setPolicyNotice(null);

      try {
        const response = await apiFetch(API_PATHS.agentPolicy);
        const data = (await response.json()) as AgentPolicyResponse;

        if (!response.ok) {
          throw apiErrorFromPayload(data, response.status, 'Agent 策略加载失败');
        }

        if (!cancelled) {
          setPolicy(data.policy);
          setPolicyMeta(data.meta);
          setPolicyTools(Array.isArray(data.availableTools) ? data.availableTools : []);
          setPolicyLimits(data.limits || null);
          setPolicyRuntimeMaxRounds(
            data.runtimeLimits && Number.isInteger(data.runtimeLimits.maxRounds)
              ? data.runtimeLimits.maxRounds
              : data.limits.maxRounds.max
          );
        }
      } catch {
        if (!cancelled) setPolicyError('Agent 策略加载失败，请检查后端连接');
      } finally {
        if (!cancelled) setPolicyLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [visible]);

  const updatePolicy = (mutator: (current: AgentPolicyConfig) => AgentPolicyConfig) => {
    setPolicy(current => (current ? mutator(current) : current));
    setPolicyNotice(null);
  };

  const togglePolicyTool = (name: string) => {
    if (!policy || !policyTools.length) return;

    const allNames = policyTools.map(tool => tool.name);
    const current = new Set(policy.tools.allowedTools ?? allNames);

    if (current.has(name)) current.delete(name);
    else current.add(name);

    const next = allNames.filter(item => current.has(item));

    updatePolicy(currentPolicy => ({
      ...currentPolicy,
      tools: {
        ...currentPolicy.tools,
        allowedTools: next.length === allNames.length ? null : next,
      },
    }));
  };

  const putPolicy = async (body: object): Promise<boolean> => {
    const response = await apiFetch(API_PATHS.agentPolicy, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    const data = (await response.json()) as AgentPolicySaveResponse & {
      error?: string;
      code?: string;
      details?: string[];
    };

    if (response.status === 409) {
      setPolicyNotice('策略文件已损坏且无法安全覆盖，服务端拒绝写入');
      return false;
    }
    if (!response.ok) {
      throw apiErrorFromPayload(data, response.status, 'Agent 策略保存失败');
    }

    setPolicy(data.policy);
    setPolicyMeta(data.meta);
    return true;
  };

  const handlePolicySave = async () => {
    if (!policy || policySaving) return;

    setPolicySaving(true);
    setPolicyNotice(null);

    try {
      if (await putPolicy({ policy })) {
        setPolicyNotice('已保存，下一次 Agent 请求生效');
      }
    } catch {
      setPolicyNotice('保存失败，已保留当前编辑内容');
    } finally {
      setPolicySaving(false);
    }
  };

  const handlePolicyReset = async () => {
    if (policySaving) return;

    setPolicySaving(true);
    setPolicyNotice(null);

    try {
      if (await putPolicy({ reset: true })) setPolicyNotice('已恢复服务端默认策略');
    } catch {
      setPolicyNotice('恢复默认失败，请检查后端连接');
    } finally {
      setPolicySaving(false);
    }
  };

  const updateSlider = (key: SliderKey, value: number) => {
    setConfig(prev => (prev ? { ...prev, [key]: value } : prev));
    setNotice(null);
  };

  const updateMode = (mode: PersonaConfig['messageMode']) => {
    setConfig(prev => (prev ? { ...prev, messageMode: mode } : prev));
    setNotice(null);
  };

  const putConfig = async (body: object): Promise<boolean> => {
    const response = await apiFetch(API_PATHS.persona, {
      method: 'PUT',
      body: JSON.stringify(body),
    });

    const data = (await response.json()) as PersonaSaveResponse;

    if (response.status === 409) {
      setNotice('配置文件已损坏，服务端已原地保护，拒绝写入');
      return false;
    }

    if (!response.ok) {
      throw apiErrorFromPayload(data, response.status, '保存失败');
    }

    setConfig(data.config);
    return true;
  };

  const handleSave = async () => {
    if (!config || saving) return;

    setSaving(true);
    setNotice(null);

    try {
      if (await putConfig({ config })) setNotice('已保存，下一轮聊天生效');
    } catch {
      setNotice('保存失败，请检查后端连接');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    if (saving) return;

    setSaving(true);
    setNotice(null);

    try {
      // 恢复默认由服务端落盘其自身默认值，不依赖前端缓存
      if (await putConfig({ reset: true })) setNotice('已恢复默认');
    } catch {
      setNotice('恢复默认失败，请检查后端连接');
    } finally {
      setSaving(false);
    }
  };

  const selectedPolicyToolNames = policy
    ? new Set(policy.tools.allowedTools ?? policyTools.map(tool => tool.name))
    : new Set<string>();
  const maxRoundsMax = Math.min(
    policyLimits ? policyLimits.maxRounds.max : 5,
    policyRuntimeMaxRounds
  );
  const maxToolCallsMax = policyLimits ? policyLimits.maxToolCalls.max : 12;
  const minTotalMs = policyLimits ? policyLimits.maxTotalMs.min : 15000;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity style={styles.back} onPress={onClose}>
            <Text style={[styles.backText, { color: theme.accent }]}>
              ‹ 返回
            </Text>
          </TouchableOpacity>

          <Text style={styles.title}>控制面板</Text>

          <View style={styles.back} />
        </View>

        <ScrollView contentContainerStyle={styles.body}>
          <Text style={styles.caption}>
            调整 Blue 的说话风格，保存后从下一轮聊天开始生效。
          </Text>

          {/* 本机设置：纯前端偏好（AsyncStorage 持久化），与服务端 persona 无关 */}
          <View style={styles.localCard}>
            <Text style={styles.localTitle}>本机设置</Text>
            <View style={styles.toggleRow}>
              <View style={styles.toggleText}>
                <Text style={styles.toggleLabel}>流式输出</Text>
                <Text style={styles.toggleHint}>
                  开启后回复逐字显示；关闭则一次性显示
                </Text>
              </View>
              <Switch
                value={streamingEnabled}
                onValueChange={onToggleStreaming}
                trackColor={{ false: theme.borderStrong, true: theme.accent }}
                thumbColor={theme.background}
                ios_backgroundColor={theme.borderStrong}
              />
            </View>
          </View>

          {loading && <Text style={styles.muted}>加载中…</Text>}
          {loadError && <Text style={styles.errorText}>{loadError}</Text>}

          {config && (
            <>
              {SLIDERS.map(def => (
                <View key={def.key} style={styles.sliderBlock}>
                  <View style={styles.sliderHead}>
                    <Text style={styles.sliderTitle}>{def.title}</Text>
                    <Text style={styles.sliderValue}>{config[def.key]}</Text>
                  </View>

                  <Slider
                    theme={theme}
                    value={config[def.key]}
                    onChange={v => updateSlider(def.key, v)}
                  />

                  <View style={styles.anchors}>
                    <Text style={styles.anchorText}>{def.anchors[0]}</Text>
                    <Text style={styles.anchorText}>{def.anchors[1]}</Text>
                    <Text style={styles.anchorText}>{def.anchors[2]}</Text>
                  </View>
                </View>
              ))}

              <View style={styles.modeBlock}>
                <Text style={styles.sliderTitle}>连续消息模式</Text>

                {MODE_OPTIONS.map(option => {
                  const active = config.messageMode === option.id;

                  return (
                    <TouchableOpacity
                      key={option.id}
                      style={styles.modeRow}
                      onPress={() => updateMode(option.id)}
                      activeOpacity={0.7}
                    >
                      <View
                        style={[
                          styles.radio,
                          { borderColor: theme.textSecondary },
                        ]}
                      >
                        {active && (
                          <View
                            style={[
                              styles.radioDot,
                              { backgroundColor: theme.textPrimary },
                            ]}
                          />
                        )}
                      </View>
                      <Text style={styles.modeLabel}>{option.label}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              <View style={styles.summaryCard}>
                <Text style={styles.summaryTitle}>当前配置</Text>
                <Text style={styles.summaryText}>
                  口语化 {config.colloquial} · 温暖 {config.warmth} · 主动表达{' '}
                  {config.initiative} · 表达长度 {config.length}
                  {'\n'}消息模式：{MODE_LABEL[config.messageMode]}
                </Text>
              </View>

              {notice && <Text style={styles.notice}>{notice}</Text>}

              <View style={styles.buttonRow}>
                <TouchableOpacity
                  style={[
                    styles.saveButton,
                    { backgroundColor: theme.sendButton },
                    saving && styles.disabled,
                  ]}
                  onPress={handleSave}
                  disabled={saving}
                  activeOpacity={0.8}
                >
                  <Text
                    style={[
                      styles.saveButtonText,
                      { color: theme.textOnAccent },
                    ]}
                  >
                    {saving ? '保存中…' : '保存'}
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[
                    styles.resetButton,
                    { borderColor: theme.borderStrong },
                    saving && styles.disabled,
                  ]}
                  onPress={handleReset}
                  disabled={saving}
                  activeOpacity={0.8}
                >
                  <Text style={styles.resetButtonText}>恢复默认</Text>
                </TouchableOpacity>
              </View>
            </>
          )}

          <View style={styles.sectionDivider} />
          <Text style={styles.sectionTitle}>Agent 工作方式</Text>
          <Text style={styles.sectionHint}>
            这是服务端 Agent 策略，不是本机偏好。保存后从下一次 Agent
            请求生效，不会改变正在执行的任务。
          </Text>

          {policyLoading && <Text style={styles.muted}>策略加载中…</Text>}
          {policyError && <Text style={styles.errorText}>{policyError}</Text>}

          {policy && (
            <View style={styles.policyCard}>
              <Text style={styles.policySubhead}>自主程度</Text>
              {AGENT_MODES.map(mode => {
                const active = policy.mode === mode.id;

                return (
                  <TouchableOpacity
                    key={mode.id}
                    style={styles.modeRow}
                    onPress={() =>
                      updatePolicy(current => ({ ...current, mode: mode.id }))
                    }
                    activeOpacity={0.7}
                  >
                    <View
                      style={[
                        styles.radio,
                        { borderColor: theme.textSecondary },
                      ]}
                    >
                      {active && (
                        <View
                          style={[
                            styles.radioDot,
                            { backgroundColor: theme.textPrimary },
                          ]}
                        />
                      )}
                    </View>
                    <View style={styles.modeTextWrap}>
                      <Text style={styles.modeLabel}>{mode.label}</Text>
                      <Text style={styles.modeHint}>{mode.hint}</Text>
                    </View>
                  </TouchableOpacity>
                );
              })}

              <Text style={styles.policySubhead}>规划与执行</Text>
              {[
                {
                  key: 'generatePlan' as const,
                  label: '执行前生成计划',
                  hint: '只提供简短行动摘要，不展示完整思维链',
                },
                {
                  key: 'stagedExecution' as const,
                  label: '分阶段执行并验证',
                  hint: '阶段性检查结果，失败时报告未完成部分',
                },
                {
                  key: 'resultSummary' as const,
                  label: '完成后输出结果摘要',
                  hint: '附变更清单与验证证据，不记录敏感正文',
                },
              ].map(item => (
                <View key={item.key} style={styles.toggleRow}>
                  <View style={styles.toggleText}>
                    <Text style={styles.toggleLabel}>{item.label}</Text>
                    <Text style={styles.toggleHint}>{item.hint}</Text>
                  </View>
                  <Switch
                    value={policy.planning[item.key]}
                    onValueChange={value =>
                      updatePolicy(current => ({
                        ...current,
                        planning: { ...current.planning, [item.key]: value },
                      }))
                    }
                    trackColor={{
                      false: theme.borderStrong,
                      true: theme.accent,
                    }}
                    thumbColor={theme.background}
                    ios_backgroundColor={theme.borderStrong}
                  />
                </View>
              ))}

              <Text style={styles.policySubhead}>可用工具</Text>
              <Text style={styles.sectionHint}>
                只能缩小服务端已注册工具集合，不能注册新工具。高风险工具始终由
                后端确认门拦截。
              </Text>
              {policyTools.map(tool => {
                const checked = selectedPolicyToolNames.has(tool.name);

                return (
                  <TouchableOpacity
                    key={tool.name}
                    style={styles.toolRow}
                    onPress={() => togglePolicyTool(tool.name)}
                    activeOpacity={0.7}
                  >
                    <View
                      style={[
                        styles.toolCheckbox,
                        {
                          borderColor: theme.textSecondary,
                          backgroundColor: checked
                            ? theme.textPrimary
                            : 'transparent',
                        },
                      ]}
                    >
                      {checked && (
                        <Text
                          style={[
                            styles.toolCheckMark,
                            { color: theme.background },
                          ]}
                        >
                          ✓
                        </Text>
                      )}
                    </View>
                    <View style={styles.toolText}>
                      <Text style={styles.toolName}>{tool.name}</Text>
                      <Text style={styles.toolRisk}>
                        {RISK_LABEL[tool.risk]}
                        {tool.risk !== 'read' && tool.readOnly ? ' · 只读' : ''}
                      </Text>
                    </View>
                  </TouchableOpacity>
                );
              })}

              <TouchableOpacity
                style={styles.advancedToggle}
                onPress={() => setAdvancedOpen(open => !open)}
                activeOpacity={0.7}
              >
                <Text style={[styles.advancedText, { color: theme.textPrimary }]}>
                  {advancedOpen ? '收起高级设置' : '高级设置（预算 / 重试）'}
                </Text>
              </TouchableOpacity>

              {advancedOpen && (
                <>
                  <Stepper
                    theme={theme}
                    label="最大 Agent 轮次"
                    hint={'服务端硬上限 ' + maxRoundsMax + ' 轮'}
                    value={policy.budgets.maxRounds}
                    min={policyLimits ? policyLimits.maxRounds.min : 2}
                    max={maxRoundsMax}
                    step={1}
                    display={String(policy.budgets.maxRounds)}
                    onChange={value =>
                      updatePolicy(current => ({
                        ...current,
                        budgets: { ...current.budgets, maxRounds: value },
                      }))
                    }
                  />
                  <Stepper
                    theme={theme}
                    label="最大工具调用次数"
                    hint="达到后不再发起新工具调用，由模型收尾"
                    value={policy.tools.maxToolCalls}
                    min={policyLimits ? policyLimits.maxToolCalls.min : 1}
                    max={maxToolCallsMax}
                    step={1}
                    display={String(policy.tools.maxToolCalls)}
                    onChange={value =>
                      updatePolicy(current => ({
                        ...current,
                        tools: { ...current.tools, maxToolCalls: value },
                      }))
                    }
                  />
                  <Stepper
                    theme={theme}
                    label="总耗时预算"
                    hint="从请求开始计时，超时停止并报告"
                    value={policy.budgets.maxTotalMs}
                    min={minTotalMs}
                    max={policyLimits ? policyLimits.maxTotalMs.max : 120000}
                    step={15000}
                    display={String(Math.round(policy.budgets.maxTotalMs / 1000)) + 's'}
                    onChange={value =>
                      updatePolicy(current => ({
                        ...current,
                        budgets: { ...current.budgets, maxTotalMs: value },
                      }))
                    }
                  />
                  <View style={styles.toggleRow}>
                    <View style={styles.toggleText}>
                      <Text style={styles.toggleLabel}>只读工具失败重试</Text>
                      <Text style={styles.toggleHint}>
                        仅对只读工具的超时/内部错误重试一次；写入工具不自动重试
                      </Text>
                    </View>
                    <Switch
                      value={policy.tools.maxReadOnlyRetries > 0}
                      onValueChange={value =>
                        updatePolicy(current => ({
                          ...current,
                          tools: {
                            ...current.tools,
                            maxReadOnlyRetries: value ? 1 : 0,
                          },
                        }))
                      }
                      trackColor={{
                        false: theme.borderStrong,
                        true: theme.accent,
                      }}
                      thumbColor={theme.background}
                      ios_backgroundColor={theme.borderStrong}
                    />
                  </View>
                </>
              )}

              <Text style={styles.policyMeta}>
                策略版本 v{policyMeta ? policyMeta.revision : 0}
                {policyMeta && policyMeta.updatedAt
                  ? ' · ' + policyMeta.updatedAt.replace('T', ' ').slice(0, 16)
                  : ' · 服务端默认值'}
              </Text>
              {policyMeta && policyMeta.corrupted && (
                <Text style={styles.warningText}>
                  策略文件损坏，当前使用安全默认值；保存会生成新的策略文件。
                </Text>
              )}
              {policyNotice && <Text style={styles.notice}>{policyNotice}</Text>}

              <View style={styles.buttonRow}>
                <TouchableOpacity
                  style={[
                    styles.saveButton,
                    { backgroundColor: theme.sendButton },
                    policySaving && styles.disabled,
                  ]}
                  onPress={handlePolicySave}
                  disabled={policySaving}
                  activeOpacity={0.8}
                >
                  <Text
                    style={[
                      styles.saveButtonText,
                      { color: theme.textOnAccent },
                    ]}
                  >
                    {policySaving ? '保存中…' : '保存 Agent 策略'}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.resetButton,
                    { borderColor: theme.borderStrong },
                    policySaving && styles.disabled,
                  ]}
                  onPress={handlePolicyReset}
                  disabled={policySaving}
                  activeOpacity={0.8}
                >
                  <Text style={styles.resetButtonText}>恢复默认</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

// 样式由主题派生：只包含本组件用到的键
const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.background,
    },
    header: {
      height: 60,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      borderBottomWidth: 1,
      borderBottomColor: theme.border,
    },
    back: {
      width: 64,
    },
    backText: {
      fontSize: 16,
    },
    title: {
      color: theme.textPrimary,
      fontSize: 17,
      fontWeight: '600',
    },
    body: {
      padding: 20,
      paddingBottom: 40,
    },
    caption: {
      color: theme.textSecondary,
      fontSize: 13,
      lineHeight: 19,
      marginBottom: 20,
    },
    localCard: {
      backgroundColor: theme.surface,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: theme.borderStrong,
      padding: 14,
      marginBottom: 22,
    },
    localTitle: {
      color: theme.textSecondary,
      fontSize: 13,
      marginBottom: 10,
    },
    toggleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    toggleText: {
      flex: 1,
      marginRight: 12,
    },
    toggleLabel: {
      color: theme.textPrimary,
      fontSize: 16,
      fontWeight: '600',
    },
    toggleHint: {
      color: theme.textMuted,
      fontSize: 12,
      lineHeight: 17,
      marginTop: 2,
    },
    muted: {
      color: theme.textMuted,
      fontSize: 14,
    },
    errorText: {
      color: theme.danger,
      fontSize: 14,
    },
    sliderBlock: {
      marginBottom: 22,
    },
    sliderHead: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'baseline',
      marginBottom: 4,
    },
    sliderTitle: {
      color: theme.textPrimary,
      fontSize: 16,
      fontWeight: '600',
    },
    sliderValue: {
      color: theme.textPrimary,
      fontSize: 18,
      fontWeight: '700',
    },
    anchors: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginTop: 2,
    },
    anchorText: {
      color: theme.textMuted,
      fontSize: 12,
    },
    modeBlock: {
      marginTop: 6,
      marginBottom: 22,
    },
    modeRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 12,
    },
    radio: {
      width: 20,
      height: 20,
      borderRadius: 10,
      borderWidth: 1.5,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: 12,
    },
    radioDot: {
      width: 10,
      height: 10,
      borderRadius: 5,
    },
    modeLabel: {
      color: theme.textPrimary,
      fontSize: 15,
    },
    summaryCard: {
      backgroundColor: theme.surface,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: theme.borderStrong,
      padding: 14,
      marginBottom: 16,
    },
    summaryTitle: {
      color: theme.textSecondary,
      fontSize: 13,
      marginBottom: 6,
    },
    summaryText: {
      color: theme.textBody,
      fontSize: 14,
      lineHeight: 21,
    },
    notice: {
      color: theme.textSecondary,
      fontSize: 13,
      marginBottom: 12,
    },
    buttonRow: {
      flexDirection: 'row',
      gap: 12,
    },
    saveButton: {
      flex: 1,
      borderRadius: 10,
      paddingVertical: 13,
      alignItems: 'center',
    },
    saveButtonText: {
      fontSize: 15,
      fontWeight: '600',
    },
    resetButton: {
      borderRadius: 10,
      borderWidth: 1,
      paddingVertical: 13,
      paddingHorizontal: 18,
      alignItems: 'center',
    },
    resetButtonText: {
      color: theme.textPrimary,
      fontSize: 15,
    },
    sectionDivider: {
      borderTopWidth: 1,
      borderTopColor: theme.border,
      marginTop: 8,
      marginBottom: 18,
      paddingTop: 4,
    },
    sectionTitle: {
      color: theme.textPrimary,
      fontSize: 18,
      fontWeight: '700',
      marginBottom: 6,
    },
    sectionHint: {
      color: theme.textSecondary,
      fontSize: 12,
      lineHeight: 18,
      marginBottom: 10,
    },
    policyCard: {
      backgroundColor: theme.surface,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: theme.borderStrong,
      padding: 14,
      marginBottom: 16,
    },
    policySubhead: {
      color: theme.textPrimary,
      fontSize: 15,
      fontWeight: '600',
      marginTop: 12,
      marginBottom: 4,
    },
    modeTextWrap: {
      flex: 1,
    },
    modeHint: {
      color: theme.textMuted,
      fontSize: 12,
      lineHeight: 17,
      marginTop: 2,
    },
    toolRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 8,
    },
    toolCheckbox: {
      width: 20,
      height: 20,
      borderRadius: 5,
      borderWidth: 1.5,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: 12,
    },
    toolCheckMark: {
      fontSize: 13,
      fontWeight: '700',
    },
    toolText: {
      flex: 1,
    },
    toolName: {
      color: theme.textPrimary,
      fontSize: 14,
      fontWeight: '600',
    },
    toolRisk: {
      color: theme.textMuted,
      fontSize: 11,
      marginTop: 1,
    },
    advancedToggle: {
      borderTopWidth: 1,
      borderTopColor: theme.border,
      paddingVertical: 12,
      marginTop: 8,
    },
    advancedText: {
      fontSize: 14,
      fontWeight: '600',
    },
    policyMeta: {
      color: theme.textMuted,
      fontSize: 12,
      marginTop: 10,
    },
    warningText: {
      color: theme.danger,
      fontSize: 12,
      lineHeight: 17,
      marginTop: 6,
    },
    disabled: {
      opacity: 0.5,
    },
  });
