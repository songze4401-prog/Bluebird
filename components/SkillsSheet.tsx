// 蓝鸟 UI · 弹层「技能」（v7）：设置页的技能子面板（任务书 2026-11-21）。
// - 打开时 GET /skills（清单 + enabled）→ 每行 name/description + knob 开关；
// - 切开关 PUT /skills（写 persona.enabledSkills，重启后仍生效）；
// - 空目录给「暂无技能」占位，请求失败给明确错误，不显示看似正常的 0。
// 本组件只负责 sh-body 内容：把手 / 标题 / ✕ / 滚动由 SheetScaffold 统一承担
// （与 MonitoringSheet / ModelManageSheet 同一路子）。

import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { KnobToggle } from './KnobToggle';
import { SheetScaffold } from './SheetScaffold';
import { useUi } from '../app/ui-state';
import { V7_SHADOWS, type V7Tokens } from '../app/ui-theme';
import { apiFetch } from '../lib/api/client';
import { API_PATHS } from '../lib/api/endpoints';
import { readJsonResponse } from '../lib/utils';

type SkillRow = {
  slug: string;
  name: string;
  description: string;
  enabled: boolean;
};

async function fetchSkills(): Promise<SkillRow[]> {
  const response = await apiFetch(API_PATHS.skillsList, { timeoutMs: 15000 });
  const data = (await readJsonResponse(response)) as {
    ok?: boolean;
    error?: string;
    skills?: SkillRow[];
  };
  // apiFetch 不抛 4xx/5xx（oracle P2-1）：必须显式检查 response.ok，
  // 否则 401/500 会被吞成「暂无技能」空态。
  if (!response.ok) {
    throw new Error(data.error || `技能请求失败（HTTP ${response.status}）`);
  }
  return Array.isArray(data.skills) ? data.skills : [];
}

export function SkillsSheet(props: { visible: boolean; onClose: () => void }) {
  const { tokens: t } = useUi();
  const styles = createStyles(t);
  const [skills, setSkills] = useState<SkillRow[] | null>(null);
  const [error, setError] = useState('');
  const [busySlug, setBusySlug] = useState<string | null>(null);

  // 拉取清单（MonitoringSheet 同款：setTimeout(0) 延迟触发，避免 effect 内同步 setState）
  const load = useCallback(async () => {
    try {
      const rows = await fetchSkills();
      setSkills(rows);
      setError('');
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : '加载失败，请稍后再试。');
    }
  }, []);

  useEffect(() => {
    if (!props.visible) return undefined;
    const timer = setTimeout(() => {
      void load();
    }, 0);
    return () => clearTimeout(timer);
  }, [props.visible, load]);

  const toggle = async (slug: string, next: boolean) => {
    setBusySlug(slug);
    try {
      const response = await apiFetch(API_PATHS.skillsUpdate, {
        method: 'PUT',
        body: JSON.stringify({ slug, enabled: next }),
        timeoutMs: 15000,
      });
      const data = (await readJsonResponse(response)) as {
        ok?: boolean;
        error?: string;
        skills?: SkillRow[];
      };
      if (!response.ok) {
        throw new Error(data.error || `保存失败（HTTP ${response.status}）`);
      }
      setSkills(Array.isArray(data.skills) ? data.skills : skills);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : '保存失败，请稍后再试。');
    } finally {
      setBusySlug(null);
    }
  };

  return (
    <SheetScaffold visible={props.visible} onClose={props.onClose} title="技能">
      <View style={styles.body}>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {skills === null && !error ? <Text style={styles.hint}>加载中…</Text> : null}
        {skills !== null && skills.length === 0 && !error ? (
          <Text style={styles.hint}>
            暂无技能：把 SKILL.md 放进 skills/&lt;slug&gt;/ 目录即可。
          </Text>
        ) : null}
        {(skills ?? []).map(skill => (
          <View key={skill.slug} style={styles.row}>
            <View style={styles.rowText}>
              <Text numberOfLines={1} style={styles.rowTitle}>
                {skill.name}
              </Text>
              <Text numberOfLines={2} style={styles.rowDesc}>
                {skill.description}
              </Text>
            </View>
            <KnobToggle
              on={skill.enabled}
              onToggle={() => void toggle(skill.slug, !skill.enabled)}
              label={`技能 ${skill.name}`}
            />
          </View>
        ))}
        {busySlug ? <Text style={styles.hint}>保存中…</Text> : null}
      </View>
    </SheetScaffold>
  );
}

const createStyles = (t: V7Tokens) =>
  StyleSheet.create({
    body: { gap: 10, paddingHorizontal: 18, paddingBottom: 24 },
    hint: { fontSize: 12, color: t.mut, paddingVertical: 8 },
    error: { fontSize: 12, color: t.down, paddingVertical: 8 },
    // 技能行（大圆角卡片 + knob 开关；颜色全走 tokens）
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      backgroundColor: t.surface,
      borderRadius: 16,
      paddingHorizontal: 14,
      paddingVertical: 12,
      ...V7_SHADOWS.md,
    },
    rowText: { flex: 1, gap: 2 },
    rowTitle: { fontSize: 14, fontWeight: '600', color: t.ink },
    rowDesc: { fontSize: 12, color: t.sec },
  });
