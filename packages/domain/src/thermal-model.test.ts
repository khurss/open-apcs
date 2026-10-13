import { describe, expect, it } from 'vitest';
import { ThermalModel } from './thermal-model.js';
import { LogicEngine, type LogicGraph } from './logic.js';
describe('sampled virtual thermal process', () => {
  it('starts at ambient temperature with no invented elapsed interval', () => {
    const model = new ThermalModel(); expect(model.step(100, false)).toBe(20); expect(model.step(100, true)).toBe(20);
  });
  it('uses the preceding sampled heater state and cools toward ambient', () => {
    const model = new ThermalModel(); model.step(0, true);
    const warm = model.step(1000, false); expect(warm).toBeCloseTo(40 - 20 * Math.exp(-0.05), 10);
    const cool = model.step(2000, false); expect(cool).toBeCloseTo(20 + (warm - 20) * Math.exp(-0.05), 10);
  });
  it('approaches but never exceeds the configured fixed equilibrium', () => {
    const model = new ThermalModel(); model.step(0, true); let temperature = 20;
    for (let t = 1000; t <= 300000; t += 1000) { const next = model.step(t, true); expect(next).toBeGreaterThanOrEqual(temperature); expect(next).toBeLessThanOrEqual(40); temperature = next; }
    expect(temperature).toBeGreaterThan(39.99);
  });
  it('rejects invalid time and overdue sampling without modifying its last valid state', () => {
    for (const bad of [-1, NaN, Infinity]) expect(() => new ThermalModel().step(bad, false)).toThrow(/time/i);
    const model = new ThermalModel(); model.step(100, true);
    for (const bad of [99, 2601]) expect(() => model.step(bad, true)).toThrow(/time|sampling/i);
    expect(model.step(1100, false)).toBeCloseTo(40 - 20 * Math.exp(-0.05), 10);
  });
  it('closes a repeatable hysteresis loop using numeric input and a boolean heater', () => {
    const graph: LogicGraph = { schemaVersion: 1, nodes: [
      { id: 'temperature', kind: 'analog', label: 'Temperature', signalId: 'temperature', x: 0, y: 0 },
      { id: 'band', kind: 'hysteresis', label: 'Warm', low: 23, high: 24, x: 0, y: 0 },
      { id: 'heat', kind: 'not', label: 'Heat', x: 0, y: 0 },
      { id: 'heater', kind: 'output', label: 'Heater', signalId: 'heater', x: 0, y: 0 },
    ], edges: [{ id: 'a', source: 'temperature', target: 'band', port: 'in' }, { id: 'b', source: 'band', target: 'heat', port: 'in' }, { id: 'c', source: 'heat', target: 'heater', port: 'in' }] };
    const run = () => { const model = new ThermalModel(); const engine = new LogicEngine(graph); let heat = false; const trace = [];
      for (let t = 0; t <= 120000; t += 1000) { const temperature = model.step(t, heat); heat = engine.tick(t, { temperature: { value: temperature, quality: 'Good', reason: null } }).outputs.heater!.value as boolean; trace.push({ temperature, heat }); }
      return trace;
    };
    const trace = run(); expect(run()).toEqual(trace); expect(trace.slice(20).every((sample) => sample.temperature > 22 && sample.temperature < 26)).toBe(true);
    expect(trace.filter((sample, index) => index && sample.heat !== trace[index - 1]!.heat).length).toBeGreaterThan(8);
  });
});
