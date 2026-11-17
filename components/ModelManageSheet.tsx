// 蓝鸟 UI 移植 · 弹层「模型与 API 管理」（旧壳 ModelScreen 的 v7 弹层重设计）
// 服务商配置与默认模型都在后端（/model-providers），前端不留副本。
// 后端永不下发完整 API Key：编辑时留空即保留原密钥，界面只展示脱敏 keyHint。
// 默认模型只展示当前值，切换走聊天页模型抽屉（useModelSelection），本弹层不重复做。
// 段内两态：服务商列表段 ⇄ 新增/编辑表单段（头部 ‹ 返回切换）；
// scrim / 把手 / 标题 / ✕ 由弹层壳 SheetScaffold 统一承担。

import React, { useEffect, useState } from 'react';
import {
  Alert,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { SheetScaffold } from './SheetScaffold';
import { useUi } from '../app/ui-state';
import { V7_SHADOWS, type V7Tokens } from '../app/ui-theme';
import { apiFetch } from '../lib/api/client';
import { API_PATHS } from '../lib/api/endpoints';
import { apiErrorFromPayload } from '../lib/api/errors';
import type {
  ModelProviderResponse,
  ModelProvidersResponse,
  ModelTestResponse,
} from '../lib/api/types';
import { readJsonResponse } from '../lib/utils';
import type { ModelDefaults, ModelProvider } from '../lib/types';

// 新增/编辑表单（id=null 为新增）。模型列表以逗号分隔字符串编辑，保存时再拆。
type FormState = {
  id: string | null;
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

export function ModelManageSheet(props: {
  visible: boolean;
  onClose: () => void;
  // 保存/删除等变更后通知父级刷新默认模型镜像（hooks/useModelSelection）：
  // 服务端 defaults 是唯一数据源，镜像只是随读随更（同旧壳 ModelScreen 约定）。
  onDefaultsChanged?: () => void;
}) {
  const ui = useUi();
  const t = ui.tokens;
  const styles = createStyles(t);

  const [providers, setProviders] = useState<ModelProvider[] | null>(null);
  const [defaults, setDefaults] = useState<ModelDefaults | null>(null);
  const [corrupted, setCorrupted] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [form, setForm] = useState<FormState | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 打开即拉取（服务端 api-configs.json 是唯一数据源）。visible 翻转用 React 官方
  // 「渲染期对比 prev props 调整 state」模式登记（effect 内同步 setState 会被禁），
  // 加载本体在下方 effect，setState 都发生在 await 之后。
  const [loadSeq, setLoadSeq] = useState(0);
  const [prevVisible, setPrevVisible] = useState(props.visible);

  if (prevVisible !== props.visible) {
    setPrevVisible(props.visible);

    if (props.visible) {
      // 重新打开：回到列表段，清上一轮反馈与数据（列表回到加载态）
      setForm(null);
      setFormError(null);
      setActionError(null);
      setLoadError(null);
      setProviders(null);
      setDefaults(null);
      setCorrupted(false);
      setLoadSeq(seq => seq + 1);
    }
  }

  useEffect(() => {
    if (loadSeq === 0) return;

    let cancelled = false;

    (async () => {
      try {
        const data = await requestJson<ModelProvidersResponse>(
          API_PATHS.modelProviders
        );

        if (cancelled) return;

        setProviders(Array.isArray(data.providers) ? data.providers : []);
        setDefaults(data.defaults ?? null);
        setCorrupted(Boolean(data.configCorrupted));
        setLoadError(null);
      } catch {
        if (!cancelled) setLoadError('模型配置加载失败，请检查后端连接');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [loadSeq]);

  // 列表加载中：打开后还没有数据且没有报错
  const loading = providers === null && loadError === null;

  // 服务商列表：停用的不展示（同 v7 其他弹层口径）；内置服务商只可测试
  const visibleProviders = (providers ?? []).filter(
    provider => provider.enabled
  );

  // 当前默认模型（管理面只展示；切换走聊天页模型抽屉）
  const currentProvider = providers?.find(
    item => item.id === defaults?.providerId
  );
  const currentModel = currentProvider?.models.find(
    item => item.id === defaults?.modelId
  );

  // 变更后的静默刷新：重读列表但不把列表打回加载态
  const refreshProviders = async () => {
    const data = await requestJson<ModelProvidersResponse>(
      API_PATHS.modelProviders
    );

    setProviders(Array.isArray(data.providers) ? data.providers : []);
    setDefaults(data.defaults ?? null);
    setCorrupted(Boolean(data.configCorrupted));
  };

  // 列表行上的测试连接
  const handleTest = async (provider: ModelProvider) => {
    if (busy) return;

    setBusy(true);
    setActionError(null);

    try {
      const data = await requestJson<ModelTestResponse>(
        API_PATHS.modelProviderTest(provider.id),
        { method: 'POST', body: {} }
      );

      if (data.ok) {
        ui.toast(`${provider.name}：连接正常（${data.latencyMs ?? '-'}ms）`);
      } else {
        setActionError(`${provider.name}：${data.error || '连接失败'}`);
      }
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : '连接测试失败，请稍后再试'
      );
    } finally {
      setBusy(false);
    }
  };

  // 删除（内置不可删，入口已隐藏；服务端同时拒绝删除当前默认服务商）
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
            setActionError(null);

            try {
              await requestJson<{ ok: true }>(
                API_PATHS.modelProvider(provider.id),
                { method: 'DELETE' }
              );
              await refreshProviders();
              props.onDefaultsChanged?.();
              ui.toast('已删除');
            } catch (error) {
              setActionError(
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
    if (provider.builtin || busy) return;

    setActionError(null);
    setFormError(null);
    setForm({
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      apiKey: '',
      modelIds: provider.models.map(m => m.id).join(', '),
    });
  };

  const openAdd = () => {
    if (busy || corrupted) return;

    setActionError(null);
    setFormError(null);
    setForm({ ...EMPTY_FORM });
  };

  // 回到列表段（表单头部 ‹ 返回；保存中不响应）
  const closeForm = () => {
    if (busy) return;
    setForm(null);
    setFormError(null);
  };

  // 保存：新增走 POST，编辑走 PATCH。models 里已存在的 id 保留服务端的
  // 名称/启用/能力声明，新 id 只提交 id（与旧壳 ModelScreen 一致）。
  const saveForm = async (): Promise<ModelProvider | null> => {
    if (!form) return null;

    const previousProvider = providers?.find(item => item.id === form.id);
    const models = form.modelIds
      .split(/[,，\s]+/)
      .map(item => item.trim())
      .filter(Boolean)
      .map(id => {
        const previous = previousProvider?.models.find(
          model => model.id === id
        );
        return previous
          ? {
              id,
              name: previous.name,
              enabled: previous.enabled,
              capabilities: previous.capabilities,
            }
          : { id };
      });

    const body: Record<string, unknown> = {
      name: form.name.trim(),
      baseUrl: form.baseUrl.trim(),
      models,
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
    setFormError(null);

    try {
      const provider = await saveForm();

      await refreshProviders();
      setForm(null);
      // 服务端配置已变：通知父级同步默认模型镜像
      props.onDefaultsChanged?.();
      ui.toast(provider ? `已保存「${provider.name}」` : '已保存');
    } catch (error) {
      // 表单错误如实展示（baseUrl 内网拦截、config_corrupted、字段校验等）
      setFormError(
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
    setFormError(null);

    try {
      const provider = await saveForm();

      if (!provider) {
        setFormError('保存失败，无法测试连接');
        return;
      }

      const data = await requestJson<ModelTestResponse>(
        API_PATHS.modelProviderTest(provider.id),
        { method: 'POST', body: {} }
      );

      await refreshProviders();

      if (data.ok) {
        setForm(null);
        props.onDefaultsChanged?.();
        ui.toast(`已保存，连接正常（${data.latencyMs ?? '-'}ms）`);
      } else {
        // 测试失败也保留已保存的配置，便于修改后重试
        setForm(prev => (prev ? { ...prev, id: provider.id } : prev));
        setFormError(`已保存，但连接失败：${data.error || '未知原因'}`);
      }
    } catch (error) {
      setFormError(
        error instanceof Error ? error.message : '保存或测试失败，请稍后再试'
      );
    } finally {
      setBusy(false);
    }
  };

  // 弹层标题随段切换；form 非空 = 表单段，头部出现 ‹ 返回
  const sheetTitle = form
    ? form.id
      ? '编辑服务商'
      : '添加 API 服务商'
    : '模型与 API 管理';

  return (
    <SheetScaffold
      visible={props.visible}
      onClose={props.onClose}
      title={sheetTitle}
      onBack={form ? closeForm : undefined}
    >
      {form ? (
        /* ---- 新增/编辑表单段 ---- */
        <View style={styles.body}>
          <View>
            <Text style={styles.label}>服务商名称</Text>
            <View style={styles.inputWrap}>
              <TextInput
                style={styles.input}
                value={form.name}
                onChangeText={v =>
                  setForm(prev => (prev ? { ...prev, name: v } : prev))
                }
                placeholder="例如 DeepSeek"
                placeholderTextColor={t.mut}
                autoCapitalize="none"
                autoCorrect={false}
                underlineColorAndroid="transparent"
              />
            </View>
          </View>

          <View>
            <Text style={styles.label}>API Base URL</Text>
            <View style={styles.inputWrap}>
              <TextInput
                style={styles.input}
                value={form.baseUrl}
                onChangeText={v =>
                  setForm(prev => (prev ? { ...prev, baseUrl: v } : prev))
                }
                placeholder="https://api.deepseek.com"
                placeholderTextColor={t.mut}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                underlineColorAndroid="transparent"
              />
            </View>
          </View>

          <View>
            <Text style={styles.label}>API Key</Text>
            <View style={styles.inputWrap}>
              <TextInput
                style={styles.input}
                value={form.apiKey}
                onChangeText={v =>
                  setForm(prev => (prev ? { ...prev, apiKey: v } : prev))
                }
                placeholder={form.id ? '留空表示保留原密钥' : 'sk-...'}
                placeholderTextColor={t.mut}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
                underlineColorAndroid="transparent"
              />
            </View>
          </View>

          <View>
            <Text style={styles.label}>模型名称</Text>
            <View style={styles.inputWrap}>
              <TextInput
                style={styles.input}
                value={form.modelIds}
                onChangeText={v =>
                  setForm(prev => (prev ? { ...prev, modelIds: v } : prev))
                }
                placeholder="deepseek-chat（多个用逗号分隔）"
                placeholderTextColor={t.mut}
                autoCapitalize="none"
                autoCorrect={false}
                underlineColorAndroid="transparent"
              />
            </View>
          </View>

          <Text style={styles.hint}>
            新增时「测试连接」会先保存配置再测试；测试失败也保留配置，修改后可重试。
          </Text>

          {formError && <Text style={styles.errorText}>{formError}</Text>}

          <View style={styles.buttonRow}>
            <Pressable
              style={({ pressed }) => [
                styles.testButton,
                busy && styles.disabled,
                pressed && styles.pressed,
              ]}
              onPress={() => void handleFormTest()}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel="测试连接"
            >
              <Text style={styles.testButtonText}>测试连接</Text>
            </Pressable>

            <Pressable
              style={({ pressed }) => [
                styles.saveButton,
                busy && styles.disabled,
                pressed && styles.pressed,
              ]}
              onPress={() => void handleSave()}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel="保存配置"
            >
              <Text style={styles.saveButtonText}>保存配置</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        /* ---- 服务商列表段 ---- */
        <View style={styles.body}>
          <Text style={styles.caption}>
            API Key 只保存在服务端，界面只显示脱敏片段；前端永远拿不到完整
            Key。
          </Text>

          {loading && <Text style={styles.muted}>加载中…</Text>}
          {loadError && <Text style={styles.errorText}>{loadError}</Text>}

          {corrupted && (
            <Text style={styles.errorText}>
              服务端配置文件已损坏，已原地保护为只读；修复前无法修改模型配置。
            </Text>
          )}

          {defaults && (
            <View style={styles.card}>
              <Text style={styles.cardLabel}>当前使用的模型</Text>
              <Text style={styles.currentName} numberOfLines={1}>
                {currentProvider?.name ?? defaults.providerId}
              </Text>
              <Text style={styles.currentModel} numberOfLines={1}>
                {currentModel?.id ?? defaults.modelId}
              </Text>
              <Text style={styles.cardHint}>切换默认模型：聊天页模型抽屉</Text>
            </View>
          )}

          {visibleProviders.map(provider => (
            <View key={provider.id} style={styles.card}>
              <View style={styles.cardHead}>
                <Text style={styles.providerName} numberOfLines={1}>
                  {provider.name}
                </Text>
                {provider.builtin && <Text style={styles.tag}>内置</Text>}
                <Text style={styles.modelCount}>
                  {provider.models.length} 个模型
                </Text>
              </View>

              <Text style={styles.providerUrl} numberOfLines={1}>
                {provider.baseUrl}
              </Text>

              <Text style={styles.keyLine}>
                {provider.keyConfigured
                  ? `API Key：${provider.keyHint ?? '已配置'}`
                  : 'API Key：未配置'}
              </Text>

              <View style={styles.models}>
                {provider.models.map(model => (
                  <View key={model.id} style={styles.chip}>
                    <Text style={styles.chipText}>
                      {model.id}
                      {model.capabilities.vision ? ' · 视觉' : ''}
                      {model.capabilities.tools ? ' · 工具' : ''}
                    </Text>
                  </View>
                ))}
              </View>

              <View style={styles.cardActions}>
                <Pressable
                  style={({ pressed }) => [
                    styles.actionButton,
                    busy && styles.disabled,
                    pressed && styles.pressed,
                  ]}
                  onPress={() => void handleTest(provider)}
                  disabled={busy}
                  accessibilityRole="button"
                  accessibilityLabel={`测试连接：${provider.name}`}
                >
                  <Text style={[styles.actionText, { color: t.card }]}>
                    测试连接
                  </Text>
                </Pressable>

                {!provider.builtin && (
                  <>
                    <Pressable
                      style={({ pressed }) => [
                        styles.actionButton,
                        busy && styles.disabled,
                        pressed && styles.pressed,
                      ]}
                      onPress={() => openEdit(provider)}
                      disabled={busy}
                      accessibilityRole="button"
                      accessibilityLabel={`编辑：${provider.name}`}
                    >
                      <Text style={styles.actionText}>编辑</Text>
                    </Pressable>

                    <Pressable
                      style={({ pressed }) => [
                        styles.actionButton,
                        (busy || corrupted) && styles.disabled,
                        pressed && styles.pressed,
                      ]}
                      onPress={() => handleDelete(provider)}
                      disabled={busy || corrupted}
                      accessibilityRole="button"
                      accessibilityLabel={`删除：${provider.name}`}
                    >
                      <Text style={[styles.actionText, { color: t.down }]}>
                        删除
                      </Text>
                    </Pressable>
                  </>
                )}
              </View>
            </View>
          ))}

          {actionError && <Text style={styles.errorText}>{actionError}</Text>}

          <Pressable
            style={({ pressed }) => [
              styles.addRow,
              corrupted && styles.disabled,
              pressed && styles.pressed,
            ]}
            onPress={openAdd}
            disabled={corrupted}
            accessibilityRole="button"
            accessibilityLabel="添加 API 服务商"
          >
            <Text style={styles.addPlus}>＋</Text>
            <Text style={styles.addText}>添加 API 服务商</Text>
            <Text style={styles.addArrow}>›</Text>
          </Pressable>
        </View>
      )}
    </SheetScaffold>
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

// v7 样式：颜色全部来自 tokens；卡片 soft 底 r14（原型 moncard），
// 输入 soft 底 r12（同 TaskAddSheet 输入容器），主按钮 card 底 r999。
const createStyles = (t: V7Tokens) =>
  StyleSheet.create({
    // sh-body 内边距由各弹层自理（同 SettingsScreen：4/20/24）
    body: {
      paddingTop: 4,
      paddingHorizontal: 20,
      paddingBottom: 24,
      gap: 12,
    },
    caption: { fontSize: 12, lineHeight: 18, color: t.mut },
    muted: { fontSize: 13, color: t.mut },
    errorText: { fontSize: 12, lineHeight: 18, color: t.down },
    // 服务商卡 / 默认模型卡（原型 moncard：soft r14 p12）
    card: { backgroundColor: t.soft, borderRadius: 14, padding: 12, gap: 6 },
    cardLabel: {
      fontSize: 10,
      fontWeight: '700',
      color: t.mut,
      letterSpacing: 1,
    },
    cardHint: { fontSize: 10, color: t.mut },
    currentName: { fontSize: 15, fontWeight: '800', color: t.ink },
    currentModel: { fontSize: 12, color: t.sec },
    cardHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    providerName: { flex: 1, fontSize: 14, fontWeight: '700', color: t.ink },
    // 内置标记：bg 底圆角小片（soft 卡内用 bg 反衬）
    tag: {
      backgroundColor: t.bg,
      borderRadius: 999,
      paddingVertical: 3,
      paddingHorizontal: 8,
      fontSize: 10,
      fontWeight: '700',
      color: t.sec,
      overflow: 'hidden',
    },
    modelCount: { fontSize: 11, color: t.mut },
    providerUrl: { fontSize: 11, color: t.mut },
    keyLine: { fontSize: 11, color: t.sec },
    // 模型清单 chip（model id + 能力标记，只展示不可点）
    models: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 6,
      marginTop: 2,
    },
    chip: {
      backgroundColor: t.surface,
      borderRadius: 8,
      paddingVertical: 4,
      paddingHorizontal: 8,
    },
    chipText: { fontSize: 11, color: t.ink },
    cardActions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 16,
      marginTop: 4,
      paddingTop: 8,
      borderTopWidth: 1,
      borderTopColor: t.surface,
    },
    actionButton: { paddingVertical: 2 },
    actionText: { fontSize: 12, fontWeight: '600', color: t.sec },
    pressed: { opacity: 0.5 },
    disabled: { opacity: 0.45 },
    // 添加入口行
    addRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      backgroundColor: t.soft,
      borderRadius: 12,
      paddingVertical: 12,
      paddingHorizontal: 14,
    },
    addPlus: { fontSize: 15, fontWeight: '600', color: t.ink },
    addText: { flex: 1, fontSize: 13, fontWeight: '600', color: t.ink },
    addArrow: { fontSize: 14, color: t.mut },
    // 表单（原型 .f label 12 w600 sec + 输入容器 soft r12，同 TaskAddSheet）
    label: { fontSize: 12, fontWeight: '600', color: t.sec, marginBottom: 7 },
    inputWrap: {
      backgroundColor: t.soft,
      borderRadius: 12,
      paddingVertical: 10,
      paddingHorizontal: 12,
      ...V7_SHADOWS.md,
    },
    input: { fontSize: 14, color: t.ink, padding: 0 },
    hint: { fontSize: 11, lineHeight: 16, color: t.mut },
    buttonRow: { flexDirection: 'row', gap: 10, marginTop: 4 },
    testButton: {
      flex: 1,
      alignItems: 'center',
      backgroundColor: t.soft,
      borderRadius: 999,
      paddingVertical: 12,
    },
    testButtonText: { fontSize: 14, fontWeight: '600', color: t.ink },
    saveButton: {
      flex: 1,
      alignItems: 'center',
      backgroundColor: t.card,
      borderRadius: 999,
      paddingVertical: 12,
      ...V7_SHADOWS.card,
    },
    saveButtonText: { fontSize: 14, fontWeight: '600', color: t.on },
  });
