import type { LogicGraph } from '../../packages/domain/src/logic.js';
/** Delayed one-shot LED sequence. Review before activation; no automatic repetition. */
export function sequenceGraph(signalId: string): LogicGraph {
  return { schemaVersion: 1, nodes: [
    { id: 'power', kind: 'constant', label: 'Enable', value: true, x: 0, y: 0 },
    { id: 'cancel', kind: 'constant', label: 'Cancel', value: false, x: 200, y: 180 },
    { id: 'delay', kind: 'ton', label: 'Start delay', delayMs: 1000, x: 220, y: 0 },
    { id: 'sequence', kind: 'sequence', label: 'LED sequence', x: 480, y: 0, sequence: { maxIntervalMs: 2500, steps: [{ label: 'First light', value: true, durationMs: 1000 }, { label: 'Rest', value: false, durationMs: 1000 }, { label: 'Second light', value: true, durationMs: 1000 }] } },
    { id: 'out', kind: 'output', label: 'LED', signalId, x: 750, y: 0 },
  ], edges: [{ id: 'p-d', source: 'power', target: 'delay', port: 'in' }, { id: 'd-s', source: 'delay', target: 'sequence', port: 'start' }, { id: 'c-s', source: 'cancel', target: 'sequence', port: 'cancel' }, { id: 'p-s', source: 'power', target: 'sequence', port: 'permit' }, { id: 's-o', source: 'sequence', target: 'out', port: 'in' }] };
}
