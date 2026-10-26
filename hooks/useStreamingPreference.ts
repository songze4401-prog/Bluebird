// 「流式输出」开关（阶段 2）：纯前端本地偏好（AsyncStorage 持久化），默认开启。
// 开启走 /chat/stream（逐字显示），关闭走 /chat（一次性显示）。
// 与服务端 persona 配置无关，不进 /persona。

import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

// 键名保持与重构前完全一致，老用户已保存的偏好不会丢
export const STREAMING_STORAGE_KEY = 'BLUEBIRD_STREAMING_ENABLED';

export function useStreamingPreference(): {
  streamingEnabled: boolean;
  setStreaming: (next: boolean) => void;
} {
  const [streamingEnabled, setStreamingEnabled] = useState(true);

  // 启动时读取本地保存的开关；未保存过 → 默认开启
  useEffect(() => {
    let cancelled = false;

    const loadStreaming = async () => {
      try {
        const saved = await AsyncStorage.getItem(STREAMING_STORAGE_KEY);

        if (cancelled) return;

        // 只有显式存过 'false' 才关
        if (saved !== null) setStreamingEnabled(saved === 'true');
      } catch (error) {
        console.error('Load streaming setting error:', error);
      }
    };

    loadStreaming();

    return () => {
      cancelled = true;
    };
  }, []);

  const setStreaming = (next: boolean) => {
    setStreamingEnabled(next);

    AsyncStorage.setItem(STREAMING_STORAGE_KEY, String(next)).catch(error => {
      console.error('Save streaming setting error:', error);
    });
  };

  return { streamingEnabled, setStreaming };
}
