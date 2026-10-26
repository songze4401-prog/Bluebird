import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Modal,
  SafeAreaView,
  ScrollView,
  StyleSheet,
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
  ModelDefaultsResponse,
  ModelProviderResponse,
  ModelProvidersResponse,
  ModelTestResponse,
} from '../lib/api/types';
import { readJsonResponse } from '../lib/utils';
import { type ModelDefaults, type ModelProvider } from '../lib/types';

// 模型与 API 管理：独立弹层，不新增路由。
// 服务商配置与默认模型都在后端（/model-providers），前端不留副本。
// 后端永不下发完整 API Key：编辑时留空即保留原密钥，界面只展示脱敏 keyHint。

type FormState = {
  id: string | null; // null = 新增
  name: string;
  baseUrl: string;
  apiKey: string;
  modelIds: string;
};

const EMPTY_FORM: FormState = {
  id: null,
  name: '',
  baseUrl: '',
  apiKey: '',
  modelIds: '',
};

export function ModelScreen({
  theme,
  visible,
  onClose,
  onDefaultsChanged,
}: {
  theme: Theme;
  visible: boolean;
  onClose: () => void;
  // 默认模型变化后通知父级刷新镜像（唯一数据源仍是服务端 defaults）。
  // 重构前靠「关闭本页时父级再拉一次」兜底，现在改成显式通知。
  onDefaultsChanged?: () => void;
}) {
  const styles = useMemo(() => createStyles(theme), [theme]);

  const [providers, setProviders] = useState<ModelProvider[] | null>(null);
  const [defaults, setDefaults] = useState<ModelDefaults | null>(null);
  const [corrupted, setCorrupted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [form, setForm] = useState<FormState | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // 打开即拉取：服务端 api-configs.json 是唯一数据源
  useEffect(() => {
    if (!visible) return;

    let cancelled = false;

    (async () => {
      setLoading(true);
      setLoadError(null);
      setNotice(null);
      setForm(null);

      try {
        const data = await requestJson<ModelProvidersResponse>(
          API_PATHS.modelProviders
        );

        if (cancelled) return;

        setProviders(Array.isArray(data.providers) ? data.providers : []);
        setDefaults(data.defaults ?? null);
        setCorrupted(Boolean(data.configCorrupted));
      } catch {
        if (!cancelled) setLoadError('模型配置加载失败，请检查后端连接');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [visible]);

  const refresh = async () => {
    const data = await requestJson<ModelProvidersResponse>(
      API_PATHS.modelProviders
    );

    setProviders(Array.isArray(data.providers) ? data.providers : []);
    setDefaults(data.defaults ?? null);
    setCorrupted(Boolean(data.configCorrupted));
  };

  const currentProvider = providers?.find(p => p.id === defaults?.providerId);
  const currentModel = currentProvider?.models.find(
    m => m.id === defaults?.modelId
  );

  const handleSetDefault = async (providerId: string, modelId: string) => {
    if (busy || corrupted) return;

    setBusy(true);
    setNotice(null);

    try {
      await requestJson<ModelDefaultsResponse>(API_PATHS.modelDefaults, {
        method: 'PUT',
        body: { providerId, modelId },
      });
      await refresh();
      // 服务端默认模型已变：通知父级同步聊天请求携带的 providerId/modelId
      onDefaultsChanged?.();
      setNotice(`已切换到 ${modelId}，下一轮聊天生效`);
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : '切换模型失败，请稍后再试'
      );
    } finally {
      setBusy(false);
    }
  };

  const handleTest = async (provider: ModelProvider) => {
    if (busy) return;

    setBusy(true);
    setNotice(null);

    try {
      const data = await requestJson<ModelTestResponse>(
        API_PATHS.modelProviderTest(provider.id),
        { method: 'POST', body: {} }
      );

      setNotice(
        data.ok
          ? `${provider.name}：连接正常（${data.latencyMs ?? '-'}ms）`
          : `${provider.name}：${data.error || '连接失败'}`
      );
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : '连接测试失败，请稍后再试'
      );
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = (provider: ModelProvider) => {
    if (busy || corrupted) return;

    Alert.alert(
      '删除服务商',
      `确定删除「${provider.name}」吗？删除后需重新添加。`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: async () => {
            setBusy(true);
            setNotice(null);

            try {
              await requestJson<{ ok: true }>(
                API_PATHS.modelProvider(provider.id),
                { method: 'DELETE' }
              );
              await refresh();
              setNotice('已删除');
            } catch (error) {
              setNotice(
                error instanceof Error ? error.message : '删除失败，请稍后再试'
              );
            } finally {
              setBusy(false);
            }
          },
        },
      ]
    );
  };

  // 编辑：表单只预填脱敏信息，API Key 留空表示保留原密钥
  const openEdit = (provider: ModelProvider) => {
    if (provider.builtin) return;

    setNotice(null);
    setForm({
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      apiKey: '',
      modelIds: provider.models.map(m => m.id).join(', '),
    });
  };

  // 保存：新增走 POST，编辑走 PATCH
  const saveForm = async (): Promise<ModelProvider | null> => {
    if (!form) return null;

    const modelIds = form.modelIds
      .split(/[,，\s]+/)
      .map(item => item.trim())
      .filter(Boolean)
      .map(id => ({ id }));

    const body: Record<string, unknown> = {
      name: form.name.trim(),
      baseUrl: form.baseUrl.trim(),
      models: modelIds,
    };

    // 编辑时 apiKey 留空 = 保留原密钥（后端同样如此；前端不发送空串更直观）
    const apiKey = form.apiKey.trim();
    if (apiKey) body.apiKey = apiKey;

    const data = form.id
      ? await requestJson<ModelProviderResponse>(
          API_PATHS.modelProvider(form.id),
          { method: 'PATCH', body }
        )
      : await requestJson<ModelProviderResponse>(API_PATHS.modelProviders, {
          method: 'POST',
          body,
        });

    return data.provider ?? null;
  };

  const handleSave = async () => {
    if (!form || busy) return;

    setBusy(true);
    setNotice(null);

    try {
      const provider = await saveForm();

      await refresh();
      setForm(null);
      setNotice(
        provider
          ? `已保存「${provider.name}」，点上方模型即可设为当前使用`
          : '已保存'
      );
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : '保存失败，请检查后端连接'
      );
    } finally {
      setBusy(false);
    }
  };

  // 表单里的测试连接：新增需要先落盘才有可测对象，因此先保存再测试
  const handleFormTest = async () => {
    if (!form || busy) return;

    setBusy(true);
    setNotice(null);

    try {
      const provider = await saveForm();

      if (!provider) {
        setNotice('保存失败，无法测试连接');
        return;
      }

      const data = await requestJson<ModelTestResponse>(
        API_PATHS.modelProviderTest(provider.id),
        { method: 'POST', body: {} }
      );

      await refresh();

      if (data.ok) {
        setForm(null);
        setNotice(
          `保存成功，连接正常（${data.latencyMs ?? '-'}ms）。点上方模型即可设为当前使用`
        );
      } else {
        // 测试失败也保留已保存的配置，便于修改后重试
        setForm(prev => (prev ? { ...prev, id: provider.id } : prev));
        setNotice(`已保存，但连接失败：${data.error || '未知原因'}`);
      }
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : '保存或测试失败，请稍后再试'
      );
    } finally {
      setBusy(false);
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

          <Text style={styles.title}>模型与 API 管理</Text>

          <View style={styles.back} />
        </View>

        <ScrollView
          contentContainerStyle={styles.body}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.caption}>
            API Key 只保存在服务端，界面只显示脱敏片段；前端永远拿不到完整
            Key。
          </Text>

          {loading && <Text style={styles.muted}>加载中…</Text>}
          {loadError && <Text style={styles.errorText}>{loadError}</Text>}

          {corrupted && (
            <Text style={styles.warnText}>
              服务端配置文件已损坏，已原地保护为只读；修复前无法修改模型配置。
            </Text>
          )}

          {defaults && (
            <View style={styles.currentCard}>
              <Text style={styles.sectionLabel}>当前使用的模型</Text>
              <View style={styles.currentRow}>
                <View style={styles.currentInfo}>
                  <Text style={styles.currentProvider}>
                    {currentProvider?.name ?? defaults.providerId}
                  </Text>
                  <Text style={styles.currentModel}>
                    {currentModel?.id ?? defaults.modelId}
                  </Text>
                </View>
                <View style={styles.badge}>
                  <Text style={[styles.badgeText, { color: theme.online }]}>
                    当前使用
                  </Text>
                </View>
              </View>
            </View>
          )}

          {providers && (
            <View>
              <Text style={styles.sectionLabel}>API 服务商</Text>

              {providers.map(provider => (
                <View key={provider.id} style={styles.providerCard}>
                  <View style={styles.providerHead}>
                    <Text style={styles.providerName} numberOfLines={1}>
                      {provider.name}
                    </Text>
                    {provider.builtin && (
                      <Text style={styles.tag}>内置</Text>
                    )}
                    {!provider.enabled && (
                      <Text style={[styles.tag, { color: theme.textMuted }]}>
                        已禁用
                      </Text>
                    )}
                  </View>

                  <Text style={styles.providerUrl} numberOfLines={1}>
                    {provider.baseUrl}
                  </Text>

                  <Text style={styles.keyLine}>
                    {provider.keyConfigured
                      ? `API Key：${provider.keyHint ?? '已配置'}`
                      : 'API Key：未配置'}
                  </Text>

                  <View style={styles.modelRow}>
                    {provider.models.map(model => {
                      const active =
                        defaults?.providerId === provider.id &&
                        defaults?.modelId === model.id;

                      return (
                        <TouchableOpacity
                          key={model.id}
                          style={[
                            styles.modelChip,
                            active && { borderColor: theme.accentBorder },
                          ]}
                          onPress={() =>
                            handleSetDefault(provider.id, model.id)
                          }
                          disabled={busy || !provider.enabled}
                          activeOpacity={0.7}
                        >
                          <Text
                            style={[
                              styles.modelChipText,
                              active && { color: theme.accent },
                            ]}
                          >
                            {model.id}
                            {model.capabilities?.vision ? ' · 视觉' : ''}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>

                  <View style={styles.providerActions}>
                    <TouchableOpacity
                      style={busy && styles.disabled}
                      onPress={() => handleTest(provider)}
                      disabled={busy}
                    >
                      <Text style={[styles.actionText, { color: theme.accent }]}>
                        测试连接
                      </Text>
                    </TouchableOpacity>

                    {!provider.builtin && (
                      <>
                        <TouchableOpacity
                          style={busy && styles.disabled}
                          onPress={() => openEdit(provider)}
                          disabled={busy}
                        >
                          <Text style={styles.actionText}>编辑</Text>
                        </TouchableOpacity>

                        <TouchableOpacity
                          style={busy && styles.disabled}
                          onPress={() => handleDelete(provider)}
                          disabled={busy}
                        >
                          <Text
                            style={[styles.actionText, { color: theme.danger }]}
                          >
                            删除
                          </Text>
                        </TouchableOpacity>
                      </>
                    )}
                  </View>
                </View>
              ))}
            </View>
          )}

          {!form && (
            <TouchableOpacity
              style={[styles.addRow, corrupted && styles.disabled]}
              onPress={() => {
                setNotice(null);
                setForm({ ...EMPTY_FORM });
              }}
              disabled={corrupted}
              activeOpacity={0.7}
            >
              <Text style={styles.addPlus}>＋</Text>
              <Text style={styles.addText}>添加 API 服务商</Text>
              <Text style={styles.addArrow}>›</Text>
            </TouchableOpacity>
          )}

          {form && (
            <View style={styles.formCard}>
              <Text style={styles.formTitle}>
                {form.id ? '编辑服务商' : '添加 API 服务商'}
              </Text>

              <Text style={styles.fieldLabel}>服务商名称</Text>
              <TextInput
                style={styles.input}
                value={form.name}
                onChangeText={v => setForm(prev => (prev ? { ...prev, name: v } : prev))}
                placeholder="例如 DeepSeek"
                placeholderTextColor={theme.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
              />

              <Text style={styles.fieldLabel}>API Base URL</Text>
              <TextInput
                style={styles.input}
                value={form.baseUrl}
                onChangeText={v =>
                  setForm(prev => (prev ? { ...prev, baseUrl: v } : prev))
                }
                placeholder="https://api.deepseek.com"
                placeholderTextColor={theme.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
              />

              <Text style={styles.fieldLabel}>API Key</Text>
              <TextInput
                style={styles.input}
                value={form.apiKey}
                onChangeText={v =>
                  setForm(prev => (prev ? { ...prev, apiKey: v } : prev))
                }
                placeholder={form.id ? '留空表示保留原密钥' : 'sk-...'}
                placeholderTextColor={theme.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
              />

              <Text style={styles.fieldLabel}>模型名称</Text>
              <TextInput
                style={styles.input}
                value={form.modelIds}
                onChangeText={v =>
                  setForm(prev => (prev ? { ...prev, modelIds: v } : prev))
                }
                placeholder="deepseek-chat（多个用逗号分隔）"
                placeholderTextColor={theme.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
              />

              <Text style={styles.formHint}>
                新增时「测试连接」会先保存配置再测试；测试失败也保留配置，修改后可重试。
              </Text>

              <View style={styles.buttonRow}>
                <TouchableOpacity
                  style={[
                    styles.testButton,
                    { borderColor: theme.borderStrong },
                    busy && styles.disabled,
                  ]}
                  onPress={handleFormTest}
                  disabled={busy}
                  activeOpacity={0.8}
                >
                  <Text style={styles.testButtonText}>测试连接</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[
                    styles.saveButton,
                    { backgroundColor: theme.sendButton },
                    busy && styles.disabled,
                  ]}
                  onPress={handleSave}
                  disabled={busy}
                  activeOpacity={0.8}
                >
                  <Text
                    style={[
                      styles.saveButtonText,
                      { color: theme.textOnAccent },
                    ]}
                  >
                    保存配置
                  </Text>
                </TouchableOpacity>
              </View>

              <TouchableOpacity
                style={styles.cancelRow}
                onPress={() => {
                  setForm(null);
                  setNotice(null);
                }}
                disabled={busy}
              >
                <Text style={styles.cancelText}>取消</Text>
              </TouchableOpacity>
            </View>
          )}

          {notice && <Text style={styles.notice}>{notice}</Text>}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

// 统一请求封装：调用方用泛型声明期望的响应体（契约见 lib/api/types）。
// 错误统一抛 ApiError（带 status / code），非 JSON 时给出连接提示。
async function requestJson<T>(
  path: string,
  options: { method?: string; body?: unknown } = {}
): Promise<T> {
  const response = await apiFetch(path, {
    method: options.method ?? 'GET',
    ...(options.body !== undefined
      ? { body: JSON.stringify(options.body) }
      : {}),
  });

  const data = (await readJsonResponse(response)) as T;

  if (!response.ok) {
    throw apiErrorFromPayload(
      data,
      response.status,
      `请求失败（HTTP ${response.status}）`
    );
  }

  return data;
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
      marginBottom: 18,
    },
    muted: {
      color: theme.textMuted,
      fontSize: 14,
    },
    errorText: {
      color: theme.danger,
      fontSize: 14,
      marginBottom: 12,
    },
    warnText: {
      color: theme.danger,
      fontSize: 13,
      lineHeight: 19,
      marginBottom: 14,
    },
    sectionLabel: {
      color: theme.textSecondary,
      fontSize: 13,
      marginBottom: 8,
    },
    currentCard: {
      backgroundColor: theme.surface,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: theme.borderStrong,
      padding: 14,
      marginBottom: 22,
    },
    currentRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    currentInfo: {
      flexShrink: 1,
    },
    currentProvider: {
      color: theme.textPrimary,
      fontSize: 17,
      fontWeight: '600',
    },
    currentModel: {
      color: theme.textSecondary,
      fontSize: 13,
      marginTop: 3,
    },
    badge: {
      borderWidth: 1,
      borderColor: theme.borderStrong,
      borderRadius: 999,
      paddingHorizontal: 10,
      paddingVertical: 4,
      marginLeft: 10,
    },
    badgeText: {
      fontSize: 12,
      fontWeight: '600',
    },
    providerCard: {
      backgroundColor: theme.surface,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: theme.borderStrong,
      padding: 14,
      marginBottom: 12,
    },
    providerHead: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    providerName: {
      color: theme.textPrimary,
      fontSize: 16,
      fontWeight: '600',
      flexShrink: 1,
    },
    tag: {
      color: theme.textMuted,
      fontSize: 11,
      borderWidth: 1,
      borderColor: theme.borderStrong,
      borderRadius: 6,
      paddingHorizontal: 6,
      paddingVertical: 1,
    },
    providerUrl: {
      color: theme.textMuted,
      fontSize: 12,
      marginTop: 6,
    },
    keyLine: {
      color: theme.textSecondary,
      fontSize: 12,
      marginTop: 4,
    },
    modelRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 8,
      marginTop: 10,
    },
    modelChip: {
      borderWidth: 1,
      borderColor: theme.borderStrong,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 6,
    },
    modelChipText: {
      color: theme.textPrimary,
      fontSize: 12,
    },
    providerActions: {
      flexDirection: 'row',
      gap: 18,
      marginTop: 12,
      paddingTop: 10,
      borderTopWidth: 1,
      borderTopColor: theme.border,
    },
    actionText: {
      color: theme.textSecondary,
      fontSize: 13,
    },
    addRow: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.surface,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: theme.borderStrong,
      paddingHorizontal: 14,
      paddingVertical: 15,
      marginTop: 4,
      marginBottom: 12,
    },
    addPlus: {
      color: theme.textPrimary,
      fontSize: 16,
      marginRight: 10,
    },
    addText: {
      color: theme.textPrimary,
      fontSize: 15,
      flex: 1,
    },
    addArrow: {
      color: theme.textMuted,
      fontSize: 18,
    },
    formCard: {
      backgroundColor: theme.surface,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: theme.borderStrong,
      padding: 14,
      marginTop: 4,
      marginBottom: 12,
    },
    formTitle: {
      color: theme.textPrimary,
      fontSize: 16,
      fontWeight: '600',
      marginBottom: 4,
    },
    fieldLabel: {
      color: theme.textSecondary,
      fontSize: 12,
      marginTop: 12,
      marginBottom: 6,
    },
    input: {
      color: theme.textPrimary,
      fontSize: 15,
      borderWidth: 1,
      borderColor: theme.borderStrong,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 10,
      backgroundColor: theme.background,
    },
    formHint: {
      color: theme.textMuted,
      fontSize: 12,
      lineHeight: 18,
      marginTop: 12,
    },
    buttonRow: {
      flexDirection: 'row',
      gap: 12,
      marginTop: 14,
    },
    testButton: {
      flex: 1,
      borderRadius: 10,
      borderWidth: 1,
      paddingVertical: 12,
      alignItems: 'center',
    },
    testButtonText: {
      color: theme.textPrimary,
      fontSize: 15,
    },
    saveButton: {
      flex: 1,
      borderRadius: 10,
      paddingVertical: 12,
      alignItems: 'center',
    },
    saveButtonText: {
      fontSize: 15,
      fontWeight: '600',
    },
    cancelRow: {
      alignItems: 'center',
      marginTop: 12,
    },
    cancelText: {
      color: theme.textMuted,
      fontSize: 13,
    },
    notice: {
      color: theme.textSecondary,
      fontSize: 13,
      lineHeight: 19,
      marginTop: 6,
    },
    disabled: {
      opacity: 0.5,
    },
  });
