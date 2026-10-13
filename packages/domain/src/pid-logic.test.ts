import { expect, it } from 'vitest';
import { LogicEngine, validateGraph, portType, type LogicValue } from './logic.js';
import { pidGraph } from '../../../tests/fixtures/pid-graph.js';
const sample = (value: number): Record<string, LogicValue> => ({ temperature: { value, quality: 'Good', reason: null } });
it('runs a PID and time-proportioning branch and resets it on unavailable input', () => {
  const engine = new LogicEngine(pidGraph('temperature', 'heater'));
  expect(engine.tick(0, sample(20)).outputs.heater!.value).toBe(true);
  expect(engine.tick(100, sample(24)).outputs.heater!.value).toBe(false);
  expect(engine.tick(200).outputs.heater!.quality).toBe('Bad');
  expect(engine.tick(300, sample(24)).outputs.heater!.value).toBe(false);
});
it('propagates an overdue PID interval to the output instead of resuming an old duty', () => {
  const engine = new LogicEngine(pidGraph('temperature', 'heater')); engine.tick(0, sample(20));
  expect(engine.tick(2501, sample(20)).outputs.heater).toMatchObject({ quality: 'Bad', value: null, reason: 'PID control interval exceeded' });
});
it('enforces mixed PID port types, normalized conversion and strict controller parameters', () => {
  expect(portType('pid', 'pv')).toBe('number'); expect(portType('pid', 'auto')).toBe('boolean');
  const graph = pidGraph('temperature', 'heater'); expect(validateGraph(graph)).toEqual(graph);
  const direct = structuredClone(graph); direct.edges.at(-1)!.source = 'pid'; expect(() => validateGraph(direct)).toThrow(/type/i);
  const wrong = structuredClone(graph); wrong.edges.find((edge) => edge.port === 'auto')!.source = 'manual'; expect(() => validateGraph(wrong)).toThrow(/type/i);
  const settings = structuredClone(graph); settings.nodes.find((node) => node.kind === 'pid')!.pid!.ki = -1; expect(() => validateGraph(settings)).toThrow();
  const window = structuredClone(graph); window.nodes.find((node) => node.kind === 'pwm')!.windowMs = 999; expect(() => validateGraph(window)).toThrow();
  const extra = structuredClone(graph); extra.nodes[0]!.windowMs = 1000; expect(() => validateGraph(extra)).toThrow();
});
