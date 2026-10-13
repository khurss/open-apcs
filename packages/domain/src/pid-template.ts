import type { LogicGraph } from './logic.js';
export function pidThermostatGraph(temperature: string, heater: string): LogicGraph {
  return { schemaVersion: 1, nodes: [
    { id: 'temperature', kind: 'analog', label: 'Temperature', signalId: temperature, x: 0, y: 0 },
    { id: 'setpoint', kind: 'number', label: 'Setpoint', value: 24, x: 0, y: 140 },
    { id: 'manual', kind: 'number', label: 'Manual duty', value: 0, x: 0, y: 280 },
    { id: 'enabled', kind: 'constant', label: 'Enabled / Auto', value: true, x: 230, y: 350 },
    { id: 'reset', kind: 'constant', label: 'Reset', value: false, x: 230, y: 490 },
    { id: 'pid', kind: 'pid', label: 'Temperature PID', pid: { kp: 0.15, ki: 0.02, kd: 0, derivativeMs: 100, maxIntervalMs: 2500 }, x: 460, y: 0 },
    { id: 'duty', kind: 'pwm', label: 'Heater duty', windowMs: 2000, x: 690, y: 0 },
    { id: 'heater', kind: 'output', label: 'Heater', signalId: heater, x: 920, y: 0 },
  ], edges: [
    { id: 'pv', source: 'temperature', target: 'pid', port: 'pv' },
    { id: 'sp', source: 'setpoint', target: 'pid', port: 'setpoint' },
    { id: 'manual', source: 'manual', target: 'pid', port: 'manual' },
    { id: 'auto', source: 'enabled', target: 'pid', port: 'auto' },
    { id: 'enable', source: 'enabled', target: 'pid', port: 'enable' },
    { id: 'reset', source: 'reset', target: 'pid', port: 'reset' },
    { id: 'pwm', source: 'pid', target: 'duty', port: 'in' },
    { id: 'heater', source: 'duty', target: 'heater', port: 'in' },
  ] };
}
