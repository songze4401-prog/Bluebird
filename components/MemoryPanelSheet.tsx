// 蓝鸟 UI 移植 · 弹层「记忆」（原型 memBody：待确认候选 + 已记住）
// p=true 待确认（记住 / 不用了），p=false 已记住（✕ 删除）。
// 本组件只负责 sh-body 内容：scrim / 把手 / 标题 / ✕ 由弹层壳 SheetScaffold 统一承担。

import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { SheetScaffold } from './SheetScaffold';
import { useUi } from '../app/ui-state';
import type { V7Tokens } from '../app/ui-theme';
import type { Mem } from '../data/mock';

// 带原下标的条目：confirmMem/rejectMem/deleteMem 都按 mems 全量下标寻址
type IndexedMem = { m: Mem; i: number };

export function MemoryPanelSheet(props: { visible: boolean; onClose: () => void }) {
  const ui = useUi();
  const styles = createStyles(ui.tokens);

  const pending: IndexedMem[] = ui.mems.map((m, i) => ({ m, i })).filter(x => x.m.p);
  const kept: IndexedMem[] = ui.mems.map((m, i) => ({ m, i })).filter(x => !x.m.p);

  return (
    <SheetScaffold visible={props.visible} onClose={props.onClose} title="记忆">
      <View>
        {/* 待确认候选（原型 .pcard：soft 底 r16 p12/14 mb8 列 gap8） */}
        {pending.length > 0 && (
          <View>
            <Text style={styles.mlab}>等你确认（{pending.length}）</Text>
            {pending.map(x => (
              <View key={x.i} style={styles.pcard}>
                <View style={styles.px}>
                  <View style={styles.pi}>
                    <Text style={styles.piTxt}>{x.m.i}</Text>
                  </View>
                  <Text style={styles.pxTxt}>{x.m.x}</Text>
                </View>
                <View style={styles.pbt}>
                  <TouchableOpacity style={styles.pbtYes} onPress={() => ui.confirmMem(x.i)}>
                    <Text style={styles.pbtYesTxt}>记住</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.pbtNo} onPress={() => ui.rejectMem(x.i)}>
                    <Text style={styles.pbtNoTxt}>不用了</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ))}
          </View>
        )}

        {/* 已记住（原型 .prow：soft 底 r12 p9/12 mb6）；空则给虚线圆空态（原型 .empty） */}
        <Text style={styles.mlab}>Blue 记住的（{kept.length}）</Text>
        {kept.length > 0
          ? kept.map(x => (
              <View key={x.i} style={styles.prow}>
                <View style={styles.prowPi}>
                  <Text style={styles.piTxt}>{x.m.i}</Text>
                </View>
                <Text style={styles.pl}>{x.m.x}</Text>
                <TouchableOpacity style={styles.mx} onPress={() => ui.deleteMem(x.i)}>
                  <Text style={styles.mxTxt}>✕</Text>
                </TouchableOpacity>
              </View>
            ))
          : (
            <View style={styles.empty}>
              <View style={styles.emptyDot} />
              <Text style={styles.emptyTxt}>还没有记住任何事</Text>
            </View>
          )}
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
    // 原型 .pi：28 r9 内边距 4 居中
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
    // 已记住行：icon 32 r10 card 底 + 文本 13 w500 flex1 + ✕
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
    pl: { flex: 1, fontSize: 13, fontWeight: '500', color: t.ink },
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
