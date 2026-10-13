import { expect, it } from 'vitest';
import { LogicEngine, validateGraph } from './logic.js';
import { scheduleGraph } from '../../../tests/fixtures/schedule-graph.js';
it('requires explicit wall time, propagates schedule faults and keeps the fault latched', async () => {
  const engine = new LogicEngine(scheduleGraph('led'));
  expect(engine.tick(0).outputs.led!.quality).toBe('Bad');
  expect(engine.tick(100, {}, { wallTimeMs: Date.parse('2026-10-12T10:00:00Z') }).outputs.led!.quality).toBe('Bad');
  const valid = new LogicEngine(scheduleGraph('led')); const wall = Date.parse('2026-10-12T10:00:00Z');
  expect(valid.tick(0, {}, { wallTimeMs: wall }).outputs.led!.value).toBe(true);
  expect((await valid.tickAsync(100, {}, async () => false, { wallTimeMs: wall + 100 })).outputs.led!.value).toBe(true);
  expect(valid.tick(200, {}, { wallTimeMs: wall + 5000 }).outputs.led!.quality).toBe('Bad');
  expect(valid.tick(300, {}, { wallTimeMs: wall + 300 }).outputs.led!.quality).toBe('Bad');
});
it('rejects schedule settings on unrelated blocks and invalid weekly configuration', () => {
  const graph = scheduleGraph('led'); expect(validateGraph(graph)).toEqual(graph);
  const unrelated = structuredClone(graph); unrelated.nodes[1]!.schedule = graph.nodes[0]!.schedule!;
  expect(() => validateGraph(unrelated)).toThrow();
  graph.nodes[0]!.schedule!.zone = 'Unknown/Zone'; expect(() => validateGraph(graph)).toThrow();
});
