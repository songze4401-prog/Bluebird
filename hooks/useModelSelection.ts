// 当前所选模型（阶段 2）。
//
// 服务端 api-configs.json 的 defaults 是唯一数据源，前端只保留一份只读镜像，
// 用于在每个聊天请求里显式携带 providerId/modelId。
// 重构前 App 与 ModelScreen 各持一份，且靠「关闭设置页时再刷新」来同步；
// 现在镜像只在这里，设置页改完默认模型后主动通知刷新。

import { useCallback, useEffect, useState } from 'react';

import { apiFetch } from '../lib/api/client';
import { readJsonResponse } from '../lib/utils';
import type { ModelDefaults } from '../lib/types';

export function useModelSelection(): {
  selectedModel: ModelDefaults | null;
  refreshModelSelection: () => Promise<void>;
} {
  const [selectedModel, setSelectedModel] = useState<ModelDefaults | null>(
    null
  );

  const refreshModelSelection = useCallback(async () => {
    try {
      const response = await apiFetch('/model-providers');

      const data = await readJsonResponse(response);

      // 读取失败时保持 null：请求不带 ids，由服务端全局默认兜底
      if (!response.ok || !data || !data.defaults) return;

      const { providerId, modelId } = data.defaults;

      if (typeof providerId === 'string' && typeof modelId === 'string') {
        setSelectedModel({ providerId, modelId });
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

  return { selectedModel, refreshModelSelection };
}
