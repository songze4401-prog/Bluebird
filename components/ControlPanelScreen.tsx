import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Modal,
  PanResponder,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { type Theme } from '../theme';
import { apiFetch } from '../lib/api/client';
import { API_PATHS } from '../lib/api/endpoints';
import { apiErrorFromPayload } from '../lib/api/errors';
import type {
  PersonaResponse,
  PersonaSaveResponse,
} from '../lib/api/types';
import { type PersonaConfig } from '../lib/types';

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

type Notice = { text: string; error: boolean };

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
  const [notice, setNotice] = useState<Notice | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // 字数上限由服务端 GET /persona 下发（persona.js 是唯一来源，前端不写死）；
  // 拿到之前只做纯计数展示，不做拦截——超限由服务端拒绝并回显原因。
  const [customPromptMax, setCustomPromptMax] = useState<number | null>(null);

  // 打开即拉取当前配置（含服务端默认值与字段上限，恢复默认以此为准）
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

        if (!cancelled) {
          setConfig(data.config);
          setCustomPromptMax(data.limits?.customPromptMaxChars ?? null);
        }
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

  const updateSlider = (key: SliderKey, value: number) => {
    setConfig(prev => (prev ? { ...prev, [key]: value } : prev));
    setNotice(null);
  };

  const updateMode = (mode: PersonaConfig['messageMode']) => {
    setConfig(prev => (prev ? { ...prev, messageMode: mode } : prev));
    setNotice(null);
  };

  const updateCustomPrompt = (text: string) => {
    setConfig(prev => (prev ? { ...prev, customPrompt: text } : prev));
    setNotice(null);
  };

  const notify = (text: string, error = false) => setNotice({ text, error });

  // 返回 null 表示保存成功；返回字符串表示失败原因（本地编辑内容一律保留）。
  const applyConfig = async (body: object): Promise<string | null> => {
    const response = await apiFetch(API_PATHS.persona, {
      method: 'PUT',
      body: JSON.stringify(body),
    });

    const data = (await response.json()) as PersonaSaveResponse & {
      error?: string;
    };

    if (response.status === 409) {
      return '配置文件已损坏，服务端已原地保护，拒绝写入';
    }

    if (!response.ok) {
      // 400 等：服务端已给出可执行的中文原因，直接回显，用户改了再存
      return data.error || '保存失败，请检查后端连接';
    }

    // 以服务端归一化结果为准（换行统一、越界夹取），避免面板与实际注入不一致
    setConfig(data.config);
    return null;
  };

  const handleSave = async () => {
    if (!config || saving) return;

    setSaving(true);
    setNotice(null);

    try {
      const failure = await applyConfig({ config });

      // 失败原因（400/409/500）一律按错误样式显示，不能和成功提示同色
      if (failure) notify(failure, true);
      else notify('已保存，下一轮聊天生效');
    } catch {
      // 网络层异常：config state 未被覆盖，用户写的文字仍在编辑框里
      notify('保存失败，请检查后端连接', true);
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
      const failure = await applyConfig({ reset: true });

      if (failure) notify(failure, true);
      else notify('已恢复默认');
    } catch {
      notify('恢复默认失败，请检查后端连接', true);
    } finally {
      setSaving(false);
    }
  };

  const customPromptText = config?.customPrompt ?? '';
  const customPromptChars = Array.from(customPromptText).length;
  const customPromptOver =
    customPromptMax !== null && customPromptChars > customPromptMax;

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

              <View style={styles.customBlock}>
                <View style={styles.sliderHead}>
                  <Text style={styles.sliderTitle}>自定义人格提示词</Text>
                  <Text
                    style={
                      customPromptOver
                        ? styles.counterOver
                        : styles.counterNormal
                    }
                  >
                    {customPromptMax === null
                      ? `${customPromptChars} 字`
                      : `${customPromptChars} / ${customPromptMax} 字`}
                  </Text>
                </View>

                {/* 整句写在一条字符串里：JSX 会把换行折成空格，中文里就多出断词空格 */}
                <Text style={styles.customHint} testID="custom-prompt-hint">
                  {'用你自己的话描述希望她怎么陪你：性格、称呼、语气、想聊和不想聊的话题都可以。只影响表达方式，不会因此获得任何工具权限或绕过确认；清空即回到只用上面的滑块。'}
                </Text>

                <TextInput
                  testID="custom-prompt-input"
                  style={styles.customInput}
                  value={customPromptText}
                  onChangeText={updateCustomPrompt}
                  multiline
                  textAlignVertical="top"
                  placeholder="例如：别叫我主人，说话直接一点，我难过的时候先陪我待一会儿再讲道理。"
                  placeholderTextColor={theme.textMuted}
                  accessibilityLabel="自定义人格提示词"
                />
              </View>

              <View style={styles.summaryCard}>
                <Text style={styles.summaryTitle}>当前配置</Text>
                <Text style={styles.summaryText}>
                  口语化 {config.colloquial} · 温暖 {config.warmth} · 主动表达{' '}
                  {config.initiative} · 表达长度 {config.length}
                  {'\n'}消息模式：{MODE_LABEL[config.messageMode]}
                  {'\n'}自定义提示词：
                  {customPromptChars === 0
                    ? '未填写'
                    : `已填写 ${customPromptChars} 字`}
                </Text>
              </View>

              {notice && (
                <Text
                  style={notice.error ? styles.noticeError : styles.notice}
                  testID="persona-notice"
                >
                  {notice.text}
                </Text>
              )}

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
    customBlock: {
      marginTop: 6,
      marginBottom: 22,
    },
    customHint: {
      color: theme.textMuted,
      fontSize: 12,
      lineHeight: 18,
      marginBottom: 10,
    },
    customInput: {
      borderWidth: 1,
      borderRadius: 10,
      padding: 12,
      minHeight: 120,
      fontSize: 15,
      lineHeight: 22,
      color: theme.textBody,
      backgroundColor: theme.surface,
      borderColor: theme.borderStrong,
    },
    counterNormal: {
      color: theme.textMuted,
      fontSize: 12,
    },
    counterOver: {
      color: theme.danger,
      fontSize: 12,
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
    noticeError: {
      color: theme.danger,
      fontSize: 13,
      lineHeight: 19,
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
    disabled: {
      opacity: 0.5,
    },
  });
