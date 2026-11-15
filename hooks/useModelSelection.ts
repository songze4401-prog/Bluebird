// 当前所选模型（阶段 2）。
//
// 服务端 api-configs.json 的 defaults 是唯一数据源，前端只保留一份只读镜像，
// 用于在每个聊天请求里显式携带 providerId/modelId。
// 重构前 App 与 ModelScreen 各持一份，且靠「关闭设置页时再刷新」来同步；
// 现在镜像只在这里，设置页改完默认模型后主动通知刷新。

import { useCallback, useEffect, useState } from 'react';

import { apiFetch } from '../lib/api/client';
import { API_PATHS } from '../lib/api/endpoints';
import { apiErrorFromPayload } from '../lib/api/errors';
import type {
  ModelDefaultsResponse,
  ModelProvidersResponse,
} from '../lib/api/types';
import { readJsonResponse } from '../lib/utils';

import type { ModelDefaults, ModelProvider } from '../lib/types';

// 由 defaults + providers 拼出展示名（设计图的模型 pill：「DeepSeek V4.1 Flash」）。
// 服务商名与模型名都来自 /model-providers 的真实数据；对不上时退回 modelId，
// 拿不到选择时返回空串（模型 pill 此时不渲染）。
function buildLabel(
  providers: ModelProvider[],
  defaults: ModelDefaults | null
): string {
  if (!defaults) return '';

  const provider = providers.find(item => item.id === defaults.providerId);
  const model = provider?.models.find(item => item.id === defaults.modelId);

  const name = model?.name || model?.id || defaults.modelId;

  if (!name) return '';

  return provider?.name ? `${provider.name} ${name}` : name;
}

export function useModelSelection(): {
  selectedModel: ModelDefaults | null;
  // 当前所选模型的展示名（供输入区上方的模型 pill 显示）
  selectedModelLabel: string;
  // 真实服务商/模型列表（默认模型抽屉只从这里取，不再读 mock）
  providers: ModelProvider[];
  loading: boolean;
  error: string;
  // 读取成功返回 true；失败返回 false（error 里是给用户看的文案）
  refreshModelSelection: () => Promise<boolean>;
  // 切换全局默认模型；成功返回 true 并刷新镜像，失败返回 false（错误留在 error）
  setDefaultModel: (providerId: string, modelId: string) => Promise<boolean>;
} {
  const [selectedModel, setSelectedModel] = useState<ModelDefaults | null>(
    null
  );
  const [selectedModelLabel, setSelectedModelLabel] = useState('');
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const refreshModelSelection = useCallback(async (): Promise<boolean> => {
    setLoading(true);
    setError('');

    try {
      const response = await apiFetch(API_PATHS.modelProviders);

      const data = (await readJsonResponse(response)) as ModelProvidersResponse;

      // 读取失败时保持 null：请求不带 ids，由服务端全局默认兜底
      if (!response.ok || !data || !data.defaults) {
        setError('读取模型列表失败，请稍后再试。');
        return false;
      }

      const { providerId, modelId } = data.defaults;

      if (typeof providerId === 'string' && typeof modelId === 'string') {
        const defaults = { providerId, modelId };

        setSelectedModel(defaults);
        setSelectedModelLabel(
          buildLabel(Array.isArray(data.providers) ? data.providers : [], defaults)
        );
      }

      setProviders(Array.isArray(data.providers) ? data.providers : []);
      return true;
    } catch (err) {
      console.error('Load model selection error:', err);
      setError('读取模型列表失败，请稍后再试。');
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  // 切换全局默认模型（PUT /model-providers/default）。
  // 服务端是唯一数据源：先用 PUT 返回的 defaults 同步镜像（重读失败也不会继续用旧模型），
  // 再重读一次拿完整 providers/标签。
  const setDefaultModel = useCallback(
    async (providerId: string, modelId: string): Promise<boolean> => {
      try {
        const response = await apiFetch(API_PATHS.modelDefaults, {
          method: 'PUT',
          body: JSON.stringify({ providerId, modelId }),
        });

        const data = (await readJsonResponse(response)) as ModelDefaultsResponse;

        if (!response.ok) {
          throw apiErrorFromPayload(data, response.status, '切换模型失败');
        }

        const next = data?.defaults;
        const applied =
          !!next &&
          typeof next.providerId === 'string' &&
          typeof next.modelId === 'string';

        if (applied) {
          setSelectedModel(next);
          setSelectedModelLabel(buildLabel(providers, next));
        }

        // PUT 已明确成功时，即使随后的重读失败也算成功（镜像已用返回值更新）
        const refreshed = await refreshModelSelection();

        return refreshed || applied;
      } catch (err) {
        console.error('Set default model error:', err);
        setError('切换模型失败，请稍后再试。');
        return false;
      }
    },
    [providers, refreshModelSelection]
  );

  // 启动时读取一次当前所选模型（服务端 defaults 为准）。
  // 用内部 async 函数包一层：setState 发生在 await 之后，
  // 不在 effect 同步体内触发级联渲染（react-hooks/set-state-in-effect）。
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      await refreshModelSelection();

      if (cancelled) return;
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [refreshModelSelection]);

  return {
    selectedModel,
    selectedModelLabel,
    providers,
    loading,
    error,
    refreshModelSelection,
    setDefaultModel,
  };
}
