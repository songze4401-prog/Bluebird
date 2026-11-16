// 蓝鸟 UI 移植 · 弹层「记忆」（原型 memBody：待确认候选 + 已记住）
// R5 起接真实 /memory：GET /memory?scope=all 拉 MemoryItem 列表，
//   status='pending' → 「等你确认」（记住=POST /memory/confirm、不用了=POST /memory/reject）；
//   其余非归档态 → 「Blue 记住的」（✕ = POST /memory/delete）。
// 本组件只负责 sh-body 内容：scrim / 把手 / 标题 / ✕ 由弹层壳 SheetScaffold 统一承担。

import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { SheetScaffold } from './SheetScaffold';
import { useUi } from '../app/ui-state';
import { apiFetch } from '../lib/api/client';
import { API_PATHS } from '../lib/api/endpoints';
import type { MemoryItem } from '../lib/api/types';
import type { V7Tokens } from '../app/ui-theme';

export function MemoryPanelSheet(props: { visible: boolean; onClose: () => void }) {
  const ui = useUi();
  const t = ui.tokens;
  const styles = createStyles(t);

  // 真实记忆列表（status='pending' → 等你确认；active 等 → 已记住）
  const [memories, setMemories] = useState<MemoryItem[] | null>(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => {
    apiFetch(API_PATHS.memoryAll)
      .then(async response => {
        if (!response.ok) throw new Error('failed');
        const data = (await response.json()) as { memories?: MemoryItem[] };
        setMemories(data.memories || []);
        setError('');
      })
      .catch(() => {
        setError('暂时无法读取记忆，请检查后端连接。');
        setMemories([]);
      });
  }, []);

  // 打开即拉取（可见性翻转触发一次）
  useEffect(() => {
    if (props.visible) load();
  }, [props.visible, load]);

  // confirm / reject / delete 三动作（POST { id }，完成后刷新列表）
  const runAction = async (
    action: 'confirm' | 'reject' | 'delete',
    item: MemoryItem
  ) => {
    const busyKey = action + ':' + (item.id ?? item.content);
    if (busyId) return;
    if (action !== 'delete' && !item.id) {
      ui.toast('这条记忆缺少稳定 ID，暂时无法操作');
      return;
    }
    setBusyId(busyKey);
    try {
      const body =
        action === 'delete' && !item.id
          ? { createdAt: item.validFrom, content: item.content }
          : { id: item.id };
      const response = await apiFetch(
        action === 'confirm'
          ? API_PATHS.memoryConfirm
          : action === 'reject'
            ? API_PATHS.memoryReject
            : API_PATHS.memoryDelete,
        { method: 'POST', body: JSON.stringify(body) }
      );
      if (!response.ok) {
        ui.toast('操作失败，请稍后再试');
        return;
      }
      ui.toast(
        action === 'confirm' ? '已记住' : action === 'reject' ? '好的，忽略了' : '已删除'
      );
      load();
    } catch {
      ui.toast('操作失败，请稍后再试');
    } finally {
      setBusyId(null);
    }
  };

  const all = memories ?? [];
  const pending = all.filter(m => m.status === 'pending');
  const kept = all.filter(m => m.status !== 'pending' && m.status !== 'archived');

  return (
    <SheetScaffold visible={props.visible} onClose={props.onClose} title="记忆">
      <View>
        {/* 拉取失败：如实提示 + 重试（不静默吞掉） */}
        {!!error && (
          <View style={styles.pcard}>
            <Text style={styles.pxTxt}>{error}</Text>
            <TouchableOpacity style={styles.pbtYes} onPress={load}>
              <Text style={styles.pbtYesTxt}>重试</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* 待确认候选（真实 pending 记忆；原型 .pcard：soft 底 r16 p12/14 mb8 列 gap8） */}
        {pending.length > 0 && (
          <View>
            <Text style={styles.mlab}>等你确认（{pending.length}）</Text>
            {pending.map(m => (
              <View key={m.id ?? m.content} style={styles.pcard}>
                <View style={styles.px}>
                  <Text style={styles.pxTxt}>{m.content}</Text>
                </View>
                <View style={styles.pbt}>
                  <TouchableOpacity
                    style={styles.pbtYes}
                    disabled={busyId !== null}
                    onPress={() => void runAction('confirm', m)}
                  >
                    <Text style={styles.pbtYesTxt}>记住</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.pbtNo}
                    disabled={busyId !== null}
                    onPress={() => void runAction('reject', m)}
                  >
                    <Text style={styles.pbtNoTxt}>不用了</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ))}
          </View>
        )}

        {/* 已记住（真实 active 记忆；原型 .prow：soft 底 r12 p9/12 mb6）；空则给虚线圆空态 */}
        <Text style={styles.mlab}>Blue 记住的（{kept.length}）</Text>
        {kept.length > 0
          ? kept.map(m => (
              <View key={m.id ?? m.content} style={styles.prow}>
                <Text style={styles.pl}>{m.content}</Text>
                <TouchableOpacity
                  style={styles.mx}
                  disabled={busyId !== null}
                  onPress={() => void runAction('delete', m)}
                >
                  <Text style={styles.mxTxt}>✕</Text>
                </TouchableOpacity>
              </View>
            ))
          : memories !== null && !error
            ? (
                <View style={styles.empty}>
                  <View style={styles.emptyDot} />
                  <Text style={styles.emptyTxt}>还没有记住任何事</Text>
                </View>
              )
            : null}
      </View>
    </SheetScaffold>
  );
}

// 原型 .mlab/.pcard/.px/.pi/.pbt/.prow/.mx/.empty 的 RN 移植
const createStyles = (t: V7Tokens) =>
  StyleSheet.create({
    // 原型 .mlab：12 w700 sec
    mlab: { fontSize: 12, fontWeight: '700', color: t.sec, marginBottom: 8 },
    // 待确认卡片：soft 底 r16 p12/14 mb8 列 gap8
    pcard: {
      backgroundColor: t.soft,
      borderRadius: 16,
      paddingVertical: 12,
      paddingHorizontal: 14,
      marginBottom: 8,
      gap: 8,
    },
    // 原型 .px：行 gap8（icon 方块 + 文本）
    px: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    pi: {
      width: 28,
      height: 28,
      borderRadius: 9,
      backgroundColor: t.soft,
      alignItems: 'center',
      justifyContent: 'center',
      padding: 4,
    },
    piTxt: { fontSize: 14 },
    pxTxt: { flex: 1, fontSize: 13, color: t.ink },
    // 原型 .pbt：按钮行 gap8
    pbt: { flexDirection: 'row', gap: 8 },
    // 原型 .pbt button：flex1 r999 p8/0 12 w700（记住=card 底 on；不用了=soft 底 sec）
    pbtYes: {
      flex: 1,
      backgroundColor: t.card,
      borderRadius: 999,
      paddingVertical: 8,
      alignItems: 'center',
    },
    pbtYesTxt: { fontSize: 12, fontWeight: '700', color: t.on },
    pbtNo: {
      flex: 1,
      backgroundColor: t.soft,
      borderRadius: 999,
      paddingVertical: 8,
      alignItems: 'center',
    },
    pbtNoTxt: { fontSize: 12, fontWeight: '700', color: t.sec },
    // 已记住行：文本 13 w500 flex1 + ✕
    prow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      backgroundColor: t.soft,
      borderRadius: 12,
      paddingVertical: 9,
      paddingHorizontal: 12,
      marginBottom: 6,
    },
    prowPi: {
      width: 32,
      height: 32,
      borderRadius: 10,
      backgroundColor: t.card,
      alignItems: 'center',
      justifyContent: 'center',
    },
    pl: { flex: 1, minWidth: 0, fontSize: 13, fontWeight: '500', color: t.ink },
    // 原型 .mx：✕ 12 mut p4
    mx: { padding: 4 },
    mxTxt: { fontSize: 12, color: t.mut },
    // 原型 .empty：minH 140 居中列 mut 12 lh1.7
    empty: {
      minHeight: 140,
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: 20,
      paddingHorizontal: 16,
    },
    // 原型 .empty::before：40 虚线圆
    emptyDot: {
      width: 40,
      height: 40,
      borderRadius: 20,
      borderWidth: 1.5,
      borderColor: 'rgba(128,128,128,0.32)',
      borderStyle: 'dashed',
      marginBottom: 12,
    },
    emptyTxt: { fontSize: 12, lineHeight: 20, color: t.mut, textAlign: 'center' },
  });
