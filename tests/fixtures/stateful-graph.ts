import type { LogicGraph } from '../../packages/domain/src/logic.js';
/** A single delayed rising edge is counted, smoothed and compared before driving a boolean output. */
export function statefulGraph(signalId: string): LogicGraph {
  return { schemaVersion: 1, nodes: [
    { id: 'power', kind: 'constant', label: 'Power', value: true, x: 0, y: 0 },
    { id: 'reset', kind: 'constant', label: 'Reset', value: false, x: 0, y: 150 },
    { id: 'timer', kind: 'ton', label: 'Delay', delayMs: 1000, x: 230, y: 0 },
    { id: 'count', kind: 'counter', label: 'Count', maxCount: 4, x: 460, y: 0 },
    { id: 'smooth', kind: 'filter', label: 'Smoothed count', timeConstantMs: 750, x: 690, y: 0 },
    { id: 'limit', kind: 'number', label: 'Limit', value: 0.5, x: 690, y: 150 },
    { id: 'compare', kind: 'greater', label: 'Ready', x: 920, y: 0 },
    { id: 'out', kind: 'output', label: 'LED', signalId, x: 1150, y: 0 },
  ], edges: [
    { id: 'a', source: 'power', target: 'timer', port: 'in' },
    { id: 'b', source: 'timer', target: 'count', port: 'in' },
    { id: 'c', source: 'reset', target: 'count', port: 'reset' },
    { id: 'd', source: 'count', target: 'smooth', port: 'in' },
    { id: 'e', source: 'smooth', target: 'compare', port: 'a' },
    { id: 'f', source: 'limit', target: 'compare', port: 'b' },
    { id: 'g', source: 'compare', target: 'out', port: 'in' },
  ] };
}
