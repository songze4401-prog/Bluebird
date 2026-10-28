// 当前所选模型（阶段 2）。
//
// 服务端 api-configs.json 的 defaults 是唯一数据源，前端只保留一份只读镜像，
// 用于在每个聊天请求里显式携带 providerId/modelId。
// 重构前 App 与 ModelScreen 各持一份，且靠「关闭设置页时再刷新」来同步；
// 现在镜像只在这里，设置页改完默认模型后主动通知刷新。

import { useCallback, useEffect, useState } from 'react';

import { apiFetch } from '../lib/api/client';
import { API_PATHS } from '../lib/api/endpoints';
import type { ModelProvidersResponse } from '../lib/api/types';
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
  refreshModelSelection: () => Promise<void>;
} {
  const [selectedModel, setSelectedModel] = useState<ModelDefaults | null>(
    null
  );
  const [selectedModelLabel, setSelectedModelLabel] = useState('');

  const refreshModelSelection = useCallback(async () => {
    try {
      const response = await apiFetch(API_PATHS.modelProviders);

      const data = (await readJsonResponse(response)) as ModelProvidersResponse;

      // 读取失败时保持 null：请求不带 ids，由服务端全局默认兜底
      if (!response.ok || !data || !data.defaults) return;

      const { providerId, modelId } = data.defaults;

      if (typeof providerId === 'string' && typeof modelId === 'string') {
        const defaults = { providerId, modelId };

        setSelectedModel(defaults);
        setSelectedModelLabel(
          buildLabel(Array.isArray(data.providers) ? data.providers : [], defaults)
        );
      }
    } catch (error) {
      console.error('Load model selection error:', error);
    }
  }, []);

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

  return { selectedModel, selectedModelLabel, refreshModelSelection };
}
