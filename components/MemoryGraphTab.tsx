import React, { useMemo, useRef, useState } from 'react';
import {
  PanResponder,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';

import type { MemoryItem } from '../lib/api/types';
import type { MemoryRelation } from '../lib/memory-center';
import type { MemoryGraph, MemoryGraphEdgeKind } from '../lib/memory-graph';
import type { MemoryCenterStyles } from './memory-center-styles';

const GRAPH_BG = '#101216';
const GRAPH_TEXT = '#f5f3ee';
const GRAPH_MUTED = 'rgba(245,243,238,0.52)';
const ACTIVE = '#9db8ff';
const PENDING = '#e2c489';
const ARCHIVED = '#9aa0aa';
const SUPERSEDED = '#6f7681';

function nodeColors(status: string) {
  switch (status) {
    case 'pending':
      return { border: PENDING, fill: 'rgba(226,196,137,0.16)' };
    case 'archived':
      return { border: ARCHIVED, fill: 'rgba(154,160,170,0.12)' };
    case 'superseded':
      return { border: SUPERSEDED, fill: 'rgba(111,118,129,0.12)' };
    default:
      return { border: ACTIVE, fill: 'rgba(157,184,255,0.15)' };
  }
}

function edgeColor(kind: MemoryGraphEdgeKind): string {
  return kind === 'supersede'
    ? 'rgba(226,196,137,0.6)'
    : 'rgba(157,184,255,0.2)';
}

function relationsForNode(
  graph: MemoryGraph,
  nodeId: string
): MemoryRelation[] {
  const byId = new Map(graph.nodes.map(node => [node.id, node]));

  const seen = new Set<string>();

  return graph.edges
    .filter(edge => edge.a === nodeId || edge.b === nodeId)
    .map(edge => {
      const otherId = edge.a === nodeId ? edge.b : edge.a;
      const other = byId.get(otherId);

      if (!other || seen.has(otherId)) return null;

      seen.add(otherId);

      return { item: other.item, label: edge.label };
    })
    .filter((item): item is MemoryRelation => item !== null);
}

export function MemoryGraphTab({
  styles,
  graph,
  onSelectMemory,
}: {
  styles: MemoryCenterStyles;
  graph: MemoryGraph;
  onSelectMemory: (item: MemoryItem, relations: MemoryRelation[]) => void;
}) {
  const { width } = useWindowDimensions();
  const canvasSize = Math.min(360, Math.max(280, width - 40));
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [scale, setScale] = useState(1);
  const panRef = useRef(pan);
  const startRef = useRef({ x: 0, y: 0 });
  const graphStyles = useMemo(() => createGraphStyles(canvasSize), [canvasSize]);

  const updatePan = (next: { x: number; y: number }) => {
    panRef.current = next;
    setPan(next);
  };

  const responder = useMemo(
    () =>
      // eslint-disable-next-line react-hooks/refs -- 手势回调只在事件阶段读 ref，渲染期不读
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_, gesture) =>
          Math.abs(gesture.dx) > 4 || Math.abs(gesture.dy) > 4,
        onPanResponderGrant: () => {
          startRef.current = panRef.current;
        },
        onPanResponderMove: (_, gesture) => {
          updatePan({
            x: startRef.current.x + gesture.dx,
            y: startRef.current.y + gesture.dy,
          });
        },
      }),
    []
  );

  const zoom = (delta: number) => {
    setScale(current =>
      Math.min(2, Math.max(0.6, Number((current + delta).toFixed(2))))
    );
  };

  const reset = () => {
    updatePan({ x: 0, y: 0 });
    setScale(1);
  };

  const pad = 38;
  const inner = canvasSize - pad * 2;
  const centers = new Map(
    graph.nodes.map(node => [
      node.id,
      {
        x: pad + node.x * inner,
        y: pad + node.y * inner,
      },
    ])
  );

  return (
    <View>
      <View style={styles.sectionHead}>
        <Text style={styles.sectionLabel}>神经图谱</Text>
        <Text style={styles.sectionHint}>
          {graph.truncated
            ? `展示 ${graph.nodes.length}/${graph.totalNodes} 个高关联节点`
            : `${graph.nodes.length} 个节点 · ${graph.edges.length} 条关联`}
        </Text>
      </View>

      <View
        style={graphStyles.viewport}
        {...responder.panHandlers}
        accessibilityLabel="记忆关联图谱，可拖动平移"
      >
        {graph.nodes.length === 0 ? (
          <View style={graphStyles.empty}>
            <Text style={graphStyles.emptyTitle}>暂无可关联的记忆</Text>
            <Text style={graphStyles.emptyHint}>
              有记忆后，关键词共现与版本关系会在这里连接成网。
            </Text>
          </View>
        ) : (
          <View
            style={[
              graphStyles.canvas,
              {
                transform: [
                  { translateX: pan.x },
                  { translateY: pan.y },
                  { scale },
                ],
              },
            ]}
          >
            {graph.edges.map(edge => {
              const a = centers.get(edge.a);
              const b = centers.get(edge.b);

              if (!a || !b) return null;

              const dx = b.x - a.x;
              const dy = b.y - a.y;
              const length = Math.hypot(dx, dy);
              const angle = (Math.atan2(dy, dx) * 180) / Math.PI;

              return (
                <View
                  key={edge.id}
                  pointerEvents="none"
                  style={[
                    graphStyles.edge,
                    {
                      width: length,
                      left: (a.x + b.x) / 2 - length / 2,
                      top: (a.y + b.y) / 2,
                      backgroundColor: edgeColor(edge.kind),
                      transform: [{ rotate: `${angle}deg` }],
                    },
                  ]}
                />
              );
            })}

            {graph.nodes.map(node => {
              const center = centers.get(node.id);
              const colors = nodeColors(node.status);

              if (!center) return null;

              return (
                <TouchableOpacity
                  key={node.id}
                  style={[
                    graphStyles.node,
                    {
                      width: node.radius * 2,
                      height: node.radius * 2,
                      borderRadius: node.radius,
                      left: center.x - node.radius,
                      top: center.y - node.radius,
                      backgroundColor: colors.fill,
                      borderColor: colors.border,
                    },
                  ]}
                  activeOpacity={0.75}
                  onPress={() =>
                    onSelectMemory(node.item, relationsForNode(graph, node.id))
                  }
                  accessibilityRole="button"
                  accessibilityLabel={`打开记忆 ${node.label}`}
                >
                  <Text style={graphStyles.nodeGlyph}>
                    {node.typeLabel.slice(0, 1)}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        )}

        <View style={graphStyles.zoomBar}>
          <TouchableOpacity
            style={graphStyles.zoomButton}
            onPress={() => zoom(-0.2)}
            accessibilityLabel="缩小图谱"
          >
            <Text style={graphStyles.zoomText}>−</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={graphStyles.zoomButton}
            onPress={reset}
            accessibilityLabel="重置图谱视图"
          >
            <Text style={graphStyles.zoomReset}>{scale.toFixed(1)}×</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={graphStyles.zoomButton}
            onPress={() => zoom(0.2)}
            accessibilityLabel="放大图谱"
          >
            <Text style={graphStyles.zoomText}>＋</Text>
          </TouchableOpacity>
        </View>
      </View>

      <View style={graphStyles.legend}>
        <View style={graphStyles.legendItem}>
          <View style={[graphStyles.legendDot, { backgroundColor: ACTIVE }]} />
          <Text style={graphStyles.legendText}>活跃</Text>
        </View>
        <View style={graphStyles.legendItem}>
          <View
            style={[graphStyles.legendDot, { backgroundColor: PENDING }]}
          />
          <Text style={graphStyles.legendText}>待确认</Text>
        </View>
        <View style={graphStyles.legendItem}>
          <View
            style={[graphStyles.legendDot, { backgroundColor: ARCHIVED }]}
          />
          <Text style={graphStyles.legendText}>已归档</Text>
        </View>
        <View style={graphStyles.legendItem}>
          <View
            style={[graphStyles.legendLine, { backgroundColor: PENDING }]}
          />
          <Text style={graphStyles.legendText}>版本取代</Text>
        </View>
      </View>

      <Text style={styles.trendNote}>
        节点由真实记忆生成；边来自关键词共现和 supersededBy（版本取代）。
        布局在本地确定性计算，拖动平移，+/− 缩放。神经嵌入与向量模型尚未接入，
        因此这里不声称存在机器学习关联。
      </Text>
    </View>
  );
}

const createGraphStyles = (canvasSize: number) =>
  StyleSheet.create({
    viewport: {
      width: '100%',
      height: canvasSize,
      borderRadius: 24,
      backgroundColor: GRAPH_BG,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: 'rgba(255,255,255,0.1)',
      overflow: 'hidden',
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 12 },
      shadowOpacity: 0.22,
      shadowRadius: 24,
      elevation: 6,
    },
    canvas: {
      width: canvasSize,
      height: canvasSize,
      alignSelf: 'center',
    },
    edge: {
      position: 'absolute',
      height: StyleSheet.hairlineWidth,
      opacity: 0.9,
    },
    node: {
      position: 'absolute',
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1.5,
    },
    nodeGlyph: {
      color: GRAPH_TEXT,
      fontSize: 11,
      lineHeight: 14,
      fontWeight: '600',
    },
    empty: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 28,
    },
    emptyTitle: {
      color: GRAPH_TEXT,
      fontSize: 14,
      lineHeight: 19,
      fontWeight: '600',
      textAlign: 'center',
    },
    emptyHint: {
      marginTop: 7,
      color: GRAPH_MUTED,
      fontSize: 10.5,
      lineHeight: 16,
      textAlign: 'center',
    },
    zoomBar: {
      position: 'absolute',
      right: 12,
      bottom: 12,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      padding: 4,
      borderRadius: 18,
      backgroundColor: 'rgba(16,18,22,0.82)',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: 'rgba(255,255,255,0.12)',
    },
    zoomButton: {
      minWidth: 30,
      height: 28,
      paddingHorizontal: 7,
      borderRadius: 14,
      alignItems: 'center',
      justifyContent: 'center',
    },
    zoomText: {
      color: GRAPH_TEXT,
      fontSize: 17,
      lineHeight: 21,
      fontWeight: '500',
    },
    zoomReset: {
      color: GRAPH_MUTED,
      fontSize: 9.5,
      lineHeight: 13,
      fontWeight: '600',
    },
    legend: {
      marginTop: 12,
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 12,
      paddingHorizontal: 4,
    },
    legendItem: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
    },
    legendDot: {
      width: 6,
      height: 6,
      borderRadius: 3,
    },
    legendLine: {
      width: 12,
      height: 2,
      borderRadius: 1,
    },
    legendText: {
      color: GRAPH_MUTED,
      fontSize: 9,
      lineHeight: 13,
    },
  });
