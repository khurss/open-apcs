import type { LogicGraph } from '../../packages/domain/src/logic.js';
export function scheduleGraph(signalId: string): LogicGraph {
  return { schemaVersion: 1, nodes: [
    { id: 'weekly', kind: 'schedule', label: 'Weekly window', x: 0, y: 0, schedule: { zone: 'UTC', days: [1, 2, 3, 4, 5], startMinute: 540, endMinute: 1020 } },
    { id: 'output', kind: 'output', label: 'LED', signalId, x: 300, y: 0 },
  ], edges: [{ id: 'weekly-led', source: 'weekly', target: 'output', port: 'in' }] };
}
