import type {BlockKind,LogicGraph} from '../../../../../packages/domain/src/logic.js';
import type {Screen} from '../../../../../packages/domain/src/screen.js';
export type Document = LogicGraph | Screen;
export const labels: Record<BlockKind, string> = { constant: 'Constant', input: 'Input', output: 'Output', not: 'NOT', and: 'AND', or: 'OR', xor: 'XOR', ton: 'On-delay', tof: 'Off-delay', pulse: 'Pulse', debounce: 'Debounce', latch: 'Latch', interlock: 'Interlock', mode: 'Auto / Manual', script: 'JS / TS script', number: 'Numeric constant', analog: 'Numeric input', add: 'Add', subtract: 'Subtract', multiply: 'Multiply', divide: 'Divide', greater: 'Greater than', less: 'Less than', hysteresis: 'Hysteresis', filter: 'Low-pass filter', counter: 'Rising-edge counter', pid: 'PID controller', pwm: 'Time proportioning', schedule: 'Weekly schedule', sequence: 'Timed sequence' };
export const timed = new Set<BlockKind>(['ton', 'tof', 'pulse', 'debounce']);
export const displayValue = (value: boolean | number | null): string => value === null ? 'Unavailable' : typeof value === 'boolean' ? value ? 'ON' : 'OFF' : String(value);
