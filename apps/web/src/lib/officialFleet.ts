import type { RunnerNodePublic } from './types';

export function isOfficialRunner(node: Pick<RunnerNodePublic, 'operatorType'>): boolean {
  return node.operatorType === 'official';
}

export function officialFleetTotals(nodes: RunnerNodePublic[]): {
  onlineNodes: number;
  activeLeases: number;
  maxConcurrency: number;
} {
  return nodes.reduce(
    (totals, node) => ({
      onlineNodes: totals.onlineNodes + (node.status === 'online' ? 1 : 0),
      activeLeases: totals.activeLeases + node.activeLeases,
      maxConcurrency: totals.maxConcurrency + node.maxConcurrency,
    }),
    { onlineNodes: 0, activeLeases: 0, maxConcurrency: 0 },
  );
}
