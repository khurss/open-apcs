import { expect, it } from 'vitest';
import { LogicEngine, validateGraph, type LogicGraph, type LogicValue } from './logic.js';
const document = (): LogicGraph => ({ schemaVersion: 1, nodes: [
  { id: 'start', kind: 'input', label: 'Start', signalId: 'trigger', x: 0, y: 0 },
  { id: 'cancel', kind: 'constant', label: 'Cancel', value: false, x: 0, y: 100 },
  { id: 'permit', kind: 'constant', label: 'Permit', value: true, x: 0, y: 200 },
  { id: 'sequence', kind: 'sequence', label: 'Timed sequence', sequence: { maxIntervalMs: 500, steps: [{ label: 'ON', value: true, durationMs: 200 }] }, x: 200, y: 0 },
  { id: 'out', kind: 'output', label: 'Output', signalId: 'led', x: 400, y: 0 },
], edges: [{ id: 's', source: 'start', target: 'sequence', port: 'start' }, { id: 'c', source: 'cancel', target: 'sequence', port: 'cancel' }, { id: 'p', source: 'permit', target: 'sequence', port: 'permit' }, { id: 'o', source: 'sequence', target: 'out', port: 'in' }] });
const good = (value: boolean): LogicValue => ({ value, quality: 'Good', reason: null });
it('validates sequence bindings and preserves step diagnostics through graph evaluation', () => {
  const engine = new LogicEngine(document()); engine.tick(0, { trigger: good(false) });
  expect(engine.tick(100, { trigger: good(true) })).toMatchObject({ nodes: { sequence: { sequence: { state: 'Running', step: 0, label: 'ON' } } }, outputs: { led: { value: true, quality: 'Good' } } });
  expect(engine.tick(300, { trigger: good(true) })).toMatchObject({ nodes: { sequence: { sequence: { state: 'Completed' } } }, outputs: { led: { value: false } } });
  const invalid = document(); invalid.nodes[1]!.sequence = invalid.nodes[3]!.sequence!;
  expect(() => validateGraph(invalid)).toThrow(/Unexpected sequence/i);
});
it('keeps a sequence fault latched across subsequent bad and recovered inputs', () => {
  const engine = new LogicEngine(document()); engine.tick(0, { trigger: good(false) }); engine.tick(1, { trigger: good(true) });
  expect(engine.tick(502, { trigger: good(true) }).outputs.led!.quality).toBe('Bad');
  engine.tick(503, { trigger: { value: null, quality: 'Bad', reason: 'Disconnected' } });
  expect(engine.tick(504, { trigger: good(false) }).outputs.led!.quality).toBe('Bad');
  expect(engine.tick(505, { trigger: good(true) }).outputs.led!.quality).toBe('Bad');
});
it('does not resume a partially executed sequence after losing a required input', () => {
  const engine = new LogicEngine(document()); engine.tick(0, { trigger: good(false) }); engine.tick(1, { trigger: good(true) });
  expect(engine.tick(2, {}).outputs.led!.quality).toBe('Bad');
  expect(engine.tick(3, { trigger: good(false) }).outputs.led!.quality).toBe('Bad');
});
