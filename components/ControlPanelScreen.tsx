import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Modal,
  PanResponder,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { type Theme } from '../theme';
import { API_TOKEN } from '../lib/constants';
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

  valueRef.current = value;

  const setFromX = (x: number) => {
    const w = widthRef.current;

    if (w <= 0) return;

    const next = Math.round(Math.min(1, Math.max(0, x / w)) * 100);

    if (next !== valueRef.current) onChange(next);
  };

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      // 手指落在轨道 / 在轨道内滑动时，locationX 相对轨道自身
      onPanResponderGrant: evt => setFromX(evt.nativeEvent.locationX),
      onPanResponderMove: evt => setFromX(evt.nativeEvent.locationX),
    })
  ).current;

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

export function ControlPanelScreen({
  theme,
  visible,
  onClose,
}: {
  theme: Theme;
  visible: boolean;
  onClose: () => void;
}) {
  const styles = useMemo(() => createStyles(theme), [theme]);

  const [config, setConfig] = useState<PersonaConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // 打开即拉取当前配置（含服务端默认值，恢复默认以此为准）
  useEffect(() => {
    if (!visible) return;

    let cancelled = false;

    (async () => {
      setLoading(true);
      setLoadError(null);
      setNotice(null);

      try {
        const response = await fetch(
          `${process.env.EXPO_PUBLIC_API_URL}/persona`,
          { headers: { Authorization: `Bearer ${API_TOKEN}` } }
        );

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const data = await response.json();

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

  const updateSlider = (key: SliderKey, value: number) => {
    setConfig(prev => (prev ? { ...prev, [key]: value } : prev));
    setNotice(null);
  };

  const updateMode = (mode: PersonaConfig['messageMode']) => {
    setConfig(prev => (prev ? { ...prev, messageMode: mode } : prev));
    setNotice(null);
  };

  const putConfig = async (body: object): Promise<boolean> => {
    const response = await fetch(`${process.env.EXPO_PUBLIC_API_URL}/persona`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_TOKEN}`,
      },
      body: JSON.stringify(body),
    });

    if (response.status === 409) {
      setNotice('配置文件已损坏，服务端已原地保护，拒绝写入');
      return false;
    }

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();

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
    disabled: {
      opacity: 0.5,
    },
  });
