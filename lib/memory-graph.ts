import type { MemoryItem } from './api/types';
import {
  memoryStatus,
  memoryTimestamp,
  memoryTypeLabel,
  type MemoryStatus,
} from './memory-center';

// Memory Center 的「神经图谱」只使用真实记忆字段做本地推导：
//   - 显式版本关系：supersededBy
//   - 关键词共现：同一条记忆的关键词交集（过滤掉过泛的关键词）
// 没有向量模型、没有服务端图数据库；布局用确定性力导向计算，刷新不会随机跳动。

export type MemoryGraphEdgeKind = 'keyword' | 'supersede';

export type MemoryGraphEdge = {
  id: string;
  a: string;
  b: string;
  kind: MemoryGraphEdgeKind;
  weight: number;
  label: string;
};

export type MemoryGraphNode = {
  id: string;
  item: MemoryItem;
  status: MemoryStatus;
  typeLabel: string;
  label: string;
  degree: number;
  radius: number;
  x: number;
  y: number;
};

export type MemoryGraph = {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  totalNodes: number;
  totalEdges: number;
  truncated: boolean;
};

type RawNode = {
  id: string;
  item: MemoryItem;
  keywords: string[];
};

function normalizeKeyword(keyword: string): string {
  return String(keyword || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[\p{P}\p{S}]/gu, '');
}

function nodeId(item: MemoryItem, index: number): string {
  return item.id || item.createdAt || `memory-${index}`;
}

function nodeLabel(item: MemoryItem): string {
  const compact = item.content.replace(/\s+/g, ' ').trim();
  return compact.length > 28 ? `${compact.slice(0, 28)}…` : compact;
}

// 确定性力导向布局：固定初值、固定迭代次数，没有任何随机源。
function layoutNodes(
  nodes: Array<{ id: string }>,
  edges: MemoryGraphEdge[]
): Array<{ x: number; y: number }> {
  const count = nodes.length;

  if (count === 0) return [];
  if (count === 1) return [{ x: 0.5, y: 0.5 }];

  const indexOf = new Map(nodes.map((node, index) => [node.id, index]));
  const positions = nodes.map((_, index) => {
    const angle = (index / count) * Math.PI * 2;
    return {
      x: 0.5 + Math.cos(angle) * 0.3,
      y: 0.5 + Math.sin(angle) * 0.3,
    };
  });
  const velocities = nodes.map(() => ({ x: 0, y: 0 }));
  const ideal = count > 14 ? 0.2 : 0.24;

  for (let iteration = 0; iteration < 150; iteration += 1) {
    const forces = nodes.map(() => ({ x: 0, y: 0 }));

    for (let i = 0; i < count; i += 1) {
      for (let j = i + 1; j < count; j += 1) {
        let dx = positions[j].x - positions[i].x;
        let dy = positions[j].y - positions[i].y;
        let distance = Math.hypot(dx, dy);

        if (distance < 0.0001) {
          dx = 0.0001;
          dy = 0.0001;
          distance = 0.0002;
        }

        const repulsion = 0.00055 / (distance * distance);

        forces[i].x -= (dx / distance) * repulsion;
        forces[i].y -= (dy / distance) * repulsion;
        forces[j].x += (dx / distance) * repulsion;
        forces[j].y += (dy / distance) * repulsion;
      }
    }

    for (const edge of edges) {
      const a = indexOf.get(edge.a);
      const b = indexOf.get(edge.b);

      if (a === undefined || b === undefined) continue;

      const dx = positions[b].x - positions[a].x;
      const dy = positions[b].y - positions[a].y;
      const distance = Math.max(0.0001, Math.hypot(dx, dy));
      const spring =
        (distance - ideal) *
        0.018 *
        (edge.kind === 'supersede' ? 1.5 : Math.min(1.6, 0.7 + edge.weight * 0.2));

      forces[a].x += (dx / distance) * spring;
      forces[a].y += (dy / distance) * spring;
      forces[b].x -= (dx / distance) * spring;
      forces[b].y -= (dy / distance) * spring;
    }

    for (let i = 0; i < count; i += 1) {
      forces[i].x += (0.5 - positions[i].x) * 0.004;
      forces[i].y += (0.5 - positions[i].y) * 0.004;

      velocities[i].x = (velocities[i].x + forces[i].x) * 0.82;
      velocities[i].y = (velocities[i].y + forces[i].y) * 0.82;

      positions[i].x = Math.min(
        0.92,
        Math.max(0.08, positions[i].x + velocities[i].x)
      );
      positions[i].y = Math.min(
        0.92,
        Math.max(0.08, positions[i].y + velocities[i].y)
      );
    }
  }

  return positions;
}

export function buildMemoryGraph(
  items: MemoryItem[],
  options: { maxNodes?: number; maxEdges?: number } = {}
): MemoryGraph {
  const maxNodes = options.maxNodes ?? 28;
  const maxEdges = options.maxEdges ?? 80;
  const rawNodes: RawNode[] = items.map((item, index) => ({
    id: nodeId(item, index),
    item,
    keywords: (item.keywords || [])
      .map(normalizeKeyword)
      .filter(keyword => keyword.length >= 2),
  }));
  const byId = new Map(rawNodes.map(node => [node.id, node]));

  const keywordFrequency = new Map<string, number>();
  for (const node of rawNodes) {
    for (const keyword of new Set(node.keywords)) {
      keywordFrequency.set(keyword, (keywordFrequency.get(keyword) || 0) + 1);
    }
  }

  const commonThreshold = Math.max(3, Math.ceil(rawNodes.length * 0.4));
  const pairMap = new Map<string, MemoryGraphEdge>();

  for (let i = 0; i < rawNodes.length; i += 1) {
    for (let j = i + 1; j < rawNodes.length; j += 1) {
      const left = new Set(rawNodes[i].keywords);
      const shared = [...new Set(rawNodes[j].keywords)].filter(keyword => {
        const frequency = keywordFrequency.get(keyword) || 0;
        return left.has(keyword) && frequency <= commonThreshold;
      });

      if (!shared.length) continue;

      const id = `keyword:${rawNodes[i].id}:${rawNodes[j].id}`;

      pairMap.set(id, {
        id,
        a: rawNodes[i].id,
        b: rawNodes[j].id,
        kind: 'keyword',
        weight: shared.length,
        label: `共享关键词：${shared.slice(0, 3).join('、')}`,
      });
    }
  }

  for (const node of rawNodes) {
    const targetId = node.item.supersededBy;

    if (!targetId || !byId.has(targetId)) continue;

    const id = `supersede:${node.id}:${targetId}`;

    pairMap.set(id, {
      id,
      a: node.id,
      b: targetId,
      kind: 'supersede',
      weight: 4,
      label: '版本取代关系',
    });
  }

  const degree = new Map<string, number>();
  const edges = [...pairMap.values()];
  for (const edge of edges) {
    degree.set(edge.a, (degree.get(edge.a) || 0) + 1);
    degree.set(edge.b, (degree.get(edge.b) || 0) + 1);
  }

  const sorted = rawNodes.slice().sort((a, b) => {
    const degreeDiff = (degree.get(b.id) || 0) - (degree.get(a.id) || 0);
    if (degreeDiff !== 0) return degreeDiff;

    const statusRank = (item: MemoryItem) => {
      const status = memoryStatus(item);
      return status === 'active' ? 0 : status === 'pending' ? 1 : 2;
    };
    const statusDiff = statusRank(a.item) - statusRank(b.item);
    if (statusDiff !== 0) return statusDiff;

    return memoryTimestamp(b.item) - memoryTimestamp(a.item);
  });
  const selected = sorted.slice(0, Math.max(1, maxNodes));
  const selectedIds = new Set(selected.map(node => node.id));
  const selectedEdges = edges
    .filter(edge => selectedIds.has(edge.a) && selectedIds.has(edge.b))
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'supersede' ? -1 : 1;
      return b.weight - a.weight;
    })
    .slice(0, Math.max(1, maxEdges));
  const positions = layoutNodes(selected, selectedEdges);

  const nodes: MemoryGraphNode[] = selected.map((node, index) => {
    const nodeDegree = degree.get(node.id) || 0;

    return {
      id: node.id,
      item: node.item,
      status: memoryStatus(node.item),
      typeLabel: memoryTypeLabel(node.item.type),
      label: nodeLabel(node.item),
      degree: nodeDegree,
      radius: Math.min(30, 20 + nodeDegree * 2),
      x: positions[index].x,
      y: positions[index].y,
    };
  });

  return {
    nodes,
    edges: selectedEdges,
    totalNodes: rawNodes.length,
    totalEdges: edges.length,
    truncated: selected.length < rawNodes.length,
  };
}
