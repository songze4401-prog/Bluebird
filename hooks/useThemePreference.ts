// 主题偏好（阶段 2）：模式（浅色/深色）+ 强调色，纯前端本地偏好，不经过服务器。
// 重构前这段读写逻辑与三处 setState 全部堆在 App 里，现在独立成一个 hook，
// App 只消费 theme 与两个 switcher。

import { useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  DEFAULT_THEME_ID,
  DEFAULT_THEME_MODE,
  THEME_MODE_STORAGE_KEY,
  THEME_STORAGE_KEY,
  getTheme,
  isThemeId,
  isThemeMode,
  type Theme,
  type ThemeId,
  type ThemeMode,
} from '../theme';

export type ThemePreferenceApi = {
  // 由「模式 + 强调色」合成的全局主题：组件内不再硬编码任何色值
  theme: Theme;
  themeMode: ThemeMode;
  themeId: ThemeId;
  selectMode: (next: ThemeMode) => void;
  selectTheme: (next: ThemeId) => void;
};

export function useThemePreference(): ThemePreferenceApi {
  const [themeMode, setThemeMode] = useState<ThemeMode>(DEFAULT_THEME_MODE);
  const [themeId, setThemeId] = useState<ThemeId>(DEFAULT_THEME_ID);

  // 启动时读取本地保存的主题；读不到就用默认（浅色 + 蓝色强调）
  useEffect(() => {
    let cancelled = false;

    const loadTheme = async () => {
      try {
        const [savedMode, savedAccent] = await Promise.all([
          AsyncStorage.getItem(THEME_MODE_STORAGE_KEY),
          AsyncStorage.getItem(THEME_STORAGE_KEY),
        ]);

        if (cancelled) return;

        if (isThemeMode(savedMode)) setThemeMode(savedMode);
        if (isThemeId(savedAccent)) setThemeId(savedAccent);
      } catch (error) {
        console.error('Load theme error:', error);
      }
    };

    loadTheme();

    return () => {
      cancelled = true;
    };
  }, []);

  const theme = useMemo(
    () => getTheme(themeMode, themeId),
    [themeMode, themeId]
  );

  // 切换强调色：先立即生效（UI 不等 IO），再异步落盘
  const selectTheme = (next: ThemeId) => {
    setThemeId(next);

    AsyncStorage.setItem(THEME_STORAGE_KEY, next).catch(error => {
      console.error('Save theme error:', error);
    });
  };

  // 切换浅色 / 深色模式：同样先立即生效再落盘
  const selectMode = (next: ThemeMode) => {
    setThemeMode(next);

    AsyncStorage.setItem(THEME_MODE_STORAGE_KEY, next).catch(error => {
      console.error('Save theme mode error:', error);
    });
  };

  return { theme, themeMode, themeId, selectMode, selectTheme };
}
