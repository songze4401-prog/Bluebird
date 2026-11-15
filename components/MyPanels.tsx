// 蓝鸟 UI 移植 · 我的面板区（原型 .myPanels/.mypanel）
// 横滑卡片：按面板类型渲染 stock / weather / news 内文（原型 renderPanels 的内联样式移植）。
// panels 为空时由父级负责不渲染本组件。

import React, { Fragment } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { useUi } from '../app/ui-state';
import { V7_SHADOWS, type V7Tokens } from '../app/ui-theme';

export function MyPanels() {
  const ui = useUi();
  const t = ui.tokens;
  const styles = createStyles(t);

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
    >
      {ui.panels.map((p, i) => (
        <View key={i} style={styles.panel}>
          {/* 面板名：12 w700 on 一行省略（原型 .mpn） */}
          <Text numberOfLines={1} style={styles.pn}>
            {p.n}
          </Text>
          {p.t === 'stock' ? (
            <Fragment>
              {/* 价格 18 w800 on + 24 根迷你柱（原型 renderPanels stock 分支） */}
              <Text style={styles.price}>{ui.stock.price.toFixed(1)}</Text>
              <View style={styles.bars}>
                {barHeights(ui.stock.pts).map((h, bi) => (
                  <View key={bi} style={[styles.bar, { height: h }]} />
                ))}
              </View>
            </Fragment>
          ) : p.t === 'weather' ? (
            <Fragment>
              {/* 温度 24 w800 on + 天况 10 onDim */}
              <Text style={styles.temp}>{ui.weather.temp}°</Text>
              <Text style={styles.cond}>{ui.weather.cond}</Text>
            </Fragment>
          ) : (
            <Fragment>
              {/* 新闻前 2 条：· 标题，一行省略 */}
              {ui.news.slice(0, 2).map((n, ni) => (
                <Text key={ni} numberOfLines={1} style={styles.newsLine}>
                  · {n.t}
                </Text>
              ))}
            </Fragment>
          )}
        </View>
      ))}
    </ScrollView>
  );
}

// 股价走势归一化成迷你柱高（8~36，最多 24 根；原型 spark 的 RN 近似）
function barHeights(pts: number[]): number[] {
  const last = pts.slice(-24);
  if (last.length === 0) return [];
  const min = Math.min(...last);
  const max = Math.max(...last);
  return last.map(v => 8 + ((v - min) / (max - min || 1)) * 28);
}

// 原型 .myPanels/.mypanel/.mpn + renderPanels 内联样式的 RN 移植
const createStyles = (t: V7Tokens) =>
  StyleSheet.create({
    // 原型 .myPanels：横滑 gap12，底部留 6
    row: {
      flexDirection: 'row',
      gap: 12,
      paddingBottom: 6,
    },
    // 原型 .mypanel：168 宽 minH 112 card 底 r18 card 阴影 p12 列 gap8
    panel: {
      width: 168,
      minHeight: 112,
      backgroundColor: t.card,
      borderRadius: 18,
      padding: 12,
      gap: 8,
      ...V7_SHADOWS.card,
    },
    // 原型 .mpn：12 w700 on 一行省略
    pn: {
      fontSize: 12,
      fontWeight: '700',
      color: t.on,
    },
    // 价格：18 w800 on
    price: {
      fontSize: 18,
      fontWeight: '800',
      color: t.on,
    },
    // 迷你柱容器：底对齐、高 36
    bars: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      gap: 2,
      height: 36,
    },
    // 单根柱：宽 3、up 色（高度由调用处给）
    bar: {
      width: 3,
      backgroundColor: t.up,
    },
    // 温度：24 w800 on
    temp: {
      fontSize: 24,
      fontWeight: '800',
      color: t.on,
    },
    // 天况：10 onDim
    cond: {
      fontSize: 10,
      color: t.onDim,
    },
    // 新闻行：10 on 一行省略
    newsLine: {
      fontSize: 10,
      color: t.on,
    },
  });
