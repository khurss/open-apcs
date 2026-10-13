import { TimedSequence, validateSequenceSettings, type SequenceSettings, type SequenceState } from './sequence.js';
import { WeeklySchedule, validateWeeklySettings, type WeeklySettings } from './weekly-schedule.js';
import { PidController, TimeProportioner, validatePidSettings, type PidSettings } from './pid.js';
export type BlockKind = 'constant' | 'input' | 'not' | 'and' | 'or' | 'xor' | 'ton' | 'tof' | 'pulse' | 'debounce' | 'latch' | 'interlock' | 'mode' | 'output' | 'script' | 'number' | 'analog' | 'add' | 'subtract' | 'multiply' | 'divide' | 'greater' | 'less' | 'hysteresis' | 'filter' | 'counter' | 'pid' | 'pwm' | 'schedule' | 'sequence';
export interface LogicNode { id: string; kind: BlockKind; label: string; x: number; y: number; signalId?: string; value?: boolean | number; low?: number; high?: number; timeConstantMs?: number; maxCount?: number; pid?: PidSettings; windowMs?: number; schedule?: WeeklySettings; sequence?: SequenceSettings; delayMs?: number; source?: string; language?: 'javascript' | 'typescript'; }
export interface ScriptEvaluation { source: string; language: 'javascript' | 'typescript'; inputs: { a: boolean; b: boolean }; nowMs: number; }
export type ScriptEvaluator = (request: ScriptEvaluation) => Promise<boolean>;
export interface LogicEdge { id: string; source: string; target: string; port: string; }
export interface LogicGraph { schemaVersion: 1; nodes: LogicNode[]; edges: LogicEdge[]; }
export interface LogicValue { value: boolean | number | null; quality: 'Good' | 'Bad'; reason: string | null; sequence?: SequenceState; }
export interface LogicContext { wallTimeMs: number; }
export interface LogicResult { nodes: Record<string, LogicValue>; outputs: Record<string, LogicValue>; }
export const ports: Record<BlockKind, string[]> = { constant: [], input: [], not: ['in'], and: ['a', 'b'], or: ['a', 'b'], xor: ['a', 'b'], ton: ['in'], tof: ['in'], pulse: ['in'], debounce: ['in'], latch: ['set', 'reset'], interlock: ['in', 'permit'], mode: ['auto', 'manual', 'isAuto', 'permit'], output: ['in'], script: ['a', 'b'], number: [], analog: [], add: ['a', 'b'], subtract: ['a', 'b'], multiply: ['a', 'b'], divide: ['a', 'b'], greater: ['a', 'b'], less: ['a', 'b'], hysteresis: ['in'], filter: ['in'], counter: ['in', 'reset'], pid: ['pv', 'setpoint', 'manual', 'auto', 'enable', 'reset'], pwm: ['in'], schedule: [], sequence: ['start', 'cancel', 'permit'] };
export type LogicType = 'boolean' | 'number';
const numericOutputs = new Set<BlockKind>(['number', 'analog', 'add', 'subtract', 'multiply', 'divide', 'filter', 'counter', 'pid']);
const numericInputs = new Set<BlockKind>(['add', 'subtract', 'multiply', 'divide', 'greater', 'less', 'hysteresis', 'filter', 'pwm']);
export const outputType = (kind: BlockKind): LogicType => numericOutputs.has(kind) ? 'number' : 'boolean';
export const portType = (kind: BlockKind, port: string): LogicType => numericInputs.has(kind) || (kind === 'pid' && ['pv', 'setpoint', 'manual'].includes(port)) ? 'number' : 'boolean';
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const kinds = Object.keys(ports);
const timers = new Set<BlockKind>(['ton', 'tof', 'pulse', 'debounce']);
export function record(value: unknown, allowed: string[], context: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`Invalid ${context} fields`);
  return value as Record<string, unknown>;
}
export function identifier(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value); }
export function coordinate(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 100000; }
export function title(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= 128; }
export function validateGraph(input: unknown, complete = true): LogicGraph {
  const graph = record(input, ['schemaVersion', 'nodes', 'edges'], 'graph');
  if (graph.schemaVersion !== 1 || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || graph.nodes.length > 256 || graph.edges.length > 1024) throw new Error('Invalid graph version or size');
  const nodes = new Map<string, LogicNode>(); const writers = new Set<string>(); const bindings = new Map<string, LogicType>();
  for (const value of graph.nodes) {
    const n = record(value, ['id', 'kind', 'label', 'x', 'y', 'signalId', 'value', 'delayMs', 'source', 'language', 'low', 'high', 'timeConstantMs', 'maxCount', 'pid', 'windowMs', 'schedule', 'sequence'], 'node');
    if (!identifier(n.id) || nodes.has(n.id) || typeof n.kind !== 'string' || !kinds.includes(n.kind) || !title(n.label) || !coordinate(n.x) || !coordinate(n.y)) throw new Error('Invalid or duplicate node');
    const kind = n.kind as BlockKind;
    if (kind === 'input' || kind === 'analog' || kind === 'output') {
      if (!identifier(n.signalId)) throw new Error('Signal binding required');
      const type = outputType(kind); if (bindings.has(n.signalId) && bindings.get(n.signalId) !== type) throw new Error('Conflicting signal binding types'); bindings.set(n.signalId, type);
    }
    else if ('signalId' in n) throw new Error('Unexpected signal binding');
    if (kind === 'constant') { if (typeof n.value !== 'boolean') throw new Error('Boolean constant required'); }
    else if (kind === 'number') { if (!finite(n.value)) throw new Error('Finite numeric constant required'); }
    else if ('value' in n) throw new Error('Unexpected constant value');
    if (kind === 'hysteresis') { if (!finite(n.low) || !finite(n.high) || n.low >= n.high) throw new Error('Invalid hysteresis band'); }
    else if ('low' in n || 'high' in n) throw new Error('Unexpected hysteresis fields');
    if (kind === 'filter') { if (!Number.isSafeInteger(n.timeConstantMs) || (n.timeConstantMs as number) < 1 || (n.timeConstantMs as number) > 86400000) throw new Error('Invalid filter time constant'); }
    else if ('timeConstantMs' in n) throw new Error('Unexpected filter time constant');
    if (kind === 'counter') { if (!Number.isSafeInteger(n.maxCount) || (n.maxCount as number) < 1) throw new Error('Invalid counter limit'); }
    else if ('maxCount' in n) throw new Error('Unexpected counter limit');
    if (kind === 'sequence') validateSequenceSettings(n.sequence);
    else if ('sequence' in n) throw new Error('Unexpected sequence settings');
    if (kind === 'schedule') validateWeeklySettings(n.schedule);
    else if ('schedule' in n) throw new Error('Unexpected weekly schedule settings');
    if (kind === 'pid') validatePidSettings(n.pid);
    else if ('pid' in n) throw new Error('Unexpected PID settings');
    if (kind === 'pwm') new TimeProportioner(n.windowMs as number);
    else if ('windowMs' in n) throw new Error('Unexpected time-proportioning window');
    if (timers.has(kind)) { if (!Number.isSafeInteger(n.delayMs) || (n.delayMs as number) < 0 || (n.delayMs as number) > 86400000) throw new Error('Invalid timer delay'); }
    else if ('delayMs' in n) throw new Error('Unexpected timer delay');
    if (kind === 'script') {
      if ((n.language !== 'javascript' && n.language !== 'typescript') || typeof n.source !== 'string' || !n.source.trim() || n.source.includes('\0') || new TextEncoder().encode(n.source).length > 16384) throw new Error('Invalid script source or language');
    } else if ('source' in n || 'language' in n) throw new Error('Unexpected script fields');
    if (kind === 'output') { if (writers.has(n.signalId as string)) throw new Error('Multiple writers for an output'); writers.add(n.signalId as string); }
    nodes.set(n.id, n as unknown as LogicNode);
  }
  if ([...nodes.values()].filter((n) => n.kind === 'script').length > 2) throw new Error('At most two script blocks are supported per graph');
  const edges = new Set<string>(); const connected = new Map<string, Set<string>>();
  for (const value of graph.edges) {
    const e = record(value, ['id', 'source', 'target', 'port'], 'edge');
    if (!identifier(e.id) || edges.has(e.id) || typeof e.source !== 'string' || typeof e.target !== 'string' || typeof e.port !== 'string') throw new Error('Invalid or duplicate edge');
    edges.add(e.id); const source = nodes.get(e.source); const target = nodes.get(e.target);
    if (!source || !target) throw new Error('Missing edge reference');
    if (source.kind === 'output') throw new Error('An output cannot be an edge source');
    if (!ports[target.kind].includes(e.port)) throw new Error('Unknown target port');
    if (outputType(source.kind) !== portType(target.kind, e.port)) throw new Error('Connection type mismatch');
    const used = connected.get(e.target) ?? new Set<string>();
    if (used.has(e.port)) throw new Error('Multiple connections to one port');
    used.add(e.port); connected.set(e.target, used);
  }
  if (complete) for (const n of nodes.values()) for (const port of ports[n.kind]) if (!connected.get(n.id)?.has(port)) throw new Error(`Unconnected port ${n.id}.${port}`);
  const cloned = structuredClone(input) as LogicGraph;
  order(cloned);
  return cloned;
}
function order(graph: LogicGraph): LogicNode[] {
  const incoming = new Map(graph.nodes.map((n) => [n.id, 0]));
  const successors = new Map<string, string[]>();
  for (const e of graph.edges) { incoming.set(e.target, incoming.get(e.target)! + 1); const list = successors.get(e.source) ?? []; list.push(e.target); successors.set(e.source, list); }
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const ready = graph.nodes.filter((n) => incoming.get(n.id) === 0).map((n) => n.id).sort(); const result: LogicNode[] = [];
  while (ready.length) { const id = ready.shift()!; result.push(byId.get(id)!); for (const next of successors.get(id) ?? []) { const count = incoming.get(next)! - 1; incoming.set(next, count); if (!count) { ready.push(next); ready.sort(); } } }
  if (result.length !== graph.nodes.length) throw new Error('Graph contains a cycle');
  return result;
}
interface State { out: boolean; previous: boolean; candidate: boolean; since: number | null; numeric: number; initialized: boolean; sampleAt: number; }
const fresh = (): State => ({ out: false, previous: false, candidate: false, since: null, numeric: 0, initialized: false, sampleAt: 0 });
const good = (value: boolean | number): LogicValue => ({ value, quality: 'Good', reason: null });
const bad = (reason: string): LogicValue => ({ value: null, quality: 'Bad', reason });
export class LogicEngine {
  private readonly ordered: LogicNode[];
  private readonly wires = new Map<string, Map<string, string>>();
  private readonly states = new Map<string, State>();
  private readonly sequences = new Map<string, TimedSequence>();
  private readonly schedules = new Map<string, WeeklySchedule>();
  private readonly pids = new Map<string, PidController>();
  private readonly proportioners = new Map<string, TimeProportioner>();
  private resetNode(id: string): void { this.states.set(id, fresh()); this.pids.delete(id); this.proportioners.delete(id); }
  private lastTime = 0;
  private evaluating = false;
  constructor(graph: LogicGraph) {
    const safe = validateGraph(graph); this.ordered = order(safe);
    for (const n of this.ordered) { this.wires.set(n.id, new Map()); this.states.set(n.id, fresh()); }
    for (const e of safe.edges) this.wires.get(e.target)!.set(e.port, e.source);
  }
  tick(now: number, inputs: Record<string, LogicValue> = {}, context?: LogicContext): LogicResult {
    if (this.evaluating) throw new Error('An evaluation is already in progress');
    if (this.ordered.some((n) => n.kind === 'script')) throw new Error('Script blocks require asynchronous evaluation');
    const execution = this.evaluate(now, inputs, context);
    try { return execution.next().value as LogicResult; } finally { execution.return({ nodes: {}, outputs: {} }); }
  }
  async tickAsync(now: number, inputs: Record<string, LogicValue>, execute: ScriptEvaluator, context?: LogicContext): Promise<LogicResult> {
    const execution = this.evaluate(now, inputs, context);
    try {
      let step = execution.next();
      while (!step.done) {
        const value = await execute(step.value);
        if (typeof value !== 'boolean') throw new Error('Script result must be boolean');
        step = execution.next(value);
      }
      return step.value;
    } finally { execution.return({ nodes: {}, outputs: {} }); }
  }
  private *evaluate(now: number, inputs: Record<string, LogicValue>, context?: LogicContext): Generator<ScriptEvaluation, LogicResult, boolean> {
    if (this.evaluating) throw new Error('An evaluation is already in progress');
    this.evaluating = true;
    try {
    if (!Number.isFinite(now) || now < this.lastTime) throw new Error('Monotonic time must be finite and nondecreasing');
    this.lastTime = now;
    const nodes: Record<string, LogicValue> = Object.create(null); const outputs: Record<string, LogicValue> = Object.create(null);
    for (const n of this.ordered) {
      const values = new Map([...this.wires.get(n.id)!].map(([port, id]) => [port, nodes[id]!]));
      const invalid = [...values.values()].find((v) => v.quality !== 'Good');
      let result: LogicValue;
      if (invalid) { if (n.kind === 'sequence') { const sequence = this.sequences.get(n.id) ?? new TimedSequence(n.sequence!); sequence.invalidate(); this.sequences.set(n.id, sequence); } this.resetNode(n.id); result = bad(invalid.reason ?? 'Invalid input'); }
      else if (n.kind === 'schedule') {
        let schedule = this.schedules.get(n.id);
        if (!schedule) { schedule = new WeeklySchedule(n.schedule!); this.schedules.set(n.id, schedule); }
        try { result = good(schedule.step(now, context?.wallTimeMs ?? NaN)); }
        catch (error) { result = bad(error instanceof Error ? error.message : 'Schedule clock failed'); }
      }
      else if (n.kind === 'constant' || n.kind === 'number') result = good(n.value!);
      else if (n.kind === 'input' || n.kind === 'analog') {
        const sample = Object.hasOwn(inputs, n.signalId!) ? inputs[n.signalId!] : undefined;
        result = sample?.quality === 'Good' && (n.kind === 'analog' ? finite(sample.value) : typeof sample.value === 'boolean') ? good(sample.value!) : bad(sample?.reason ?? 'Input unavailable');
      } else {
        const read = (port: string) => values.get(port)!.value as boolean;
        const number = (port: string) => values.get(port)!.value as number;
        const state = this.states.get(n.id)!;
        if (['add', 'subtract', 'multiply', 'divide'].includes(n.kind)) {
          const a = number('a'); const b = number('b');
          const value = n.kind === 'add' ? a + b : n.kind === 'subtract' ? a - b : n.kind === 'multiply' ? a * b : a / b;
          result = Number.isFinite(value) ? good(value) : bad(b === 0 && n.kind === 'divide' ? 'Division by zero' : 'Numeric result is not finite');
        }
        else if (n.kind === 'greater' || n.kind === 'less') result = good(n.kind === 'greater' ? number('a') > number('b') : number('a') < number('b'));
        else if (n.kind === 'hysteresis') { if (number('in') >= n.high!) state.out = true; else if (number('in') <= n.low!) state.out = false; result = good(state.out); }
        else if (n.kind === 'filter') {
          const value = number('in');
          if (!state.initialized) state.numeric = value;
          else {
            const alpha = -Math.expm1(-(now - state.sampleAt) / n.timeConstantMs!);
            // A convex combination avoids overflowing the subtraction of opposite-sign extremes.
            state.numeric = (1 - alpha) * state.numeric + alpha * value;
          }
          state.initialized = true; state.sampleAt = now;
          result = finite(state.numeric) ? good(state.numeric) : bad('Filter result is not finite');
          if (result.quality === 'Bad') this.states.set(n.id, fresh());
        }
        else if (n.kind === 'sequence') {
          let sequence = this.sequences.get(n.id);
          if (!sequence) { sequence = new TimedSequence(n.sequence!); this.sequences.set(n.id, sequence); }
          try { const state = sequence.step(now, { start: read('start'), cancel: read('cancel'), permit: read('permit') }); result = { ...good(state.value), sequence: state }; }
          catch (error) { result = bad(error instanceof Error ? error.message : 'Sequence failed'); }
        }
        else if (n.kind === 'counter') {
          const value = read('in');
          if (read('reset')) state.numeric = 0;
          else if (state.initialized && value && !state.previous && state.numeric < n.maxCount!) state.numeric++;
          state.previous = value; state.initialized = true; result = good(state.numeric);
        }
        else if (n.kind === 'pid' || n.kind === 'pwm') {
          try {
            if (n.kind === 'pid') {
              let controller = this.pids.get(n.id); if (!controller) { controller = new PidController(n.pid!); this.pids.set(n.id, controller); }
              result = good(controller.step(now, { pv: number('pv'), setpoint: number('setpoint'), manual: number('manual'), auto: read('auto'), enable: read('enable'), reset: read('reset') }));
            } else {
              let controller = this.proportioners.get(n.id); if (!controller) { controller = new TimeProportioner(n.windowMs!); this.proportioners.set(n.id, controller); }
              result = good(controller.step(now, number('in')));
            }
          } catch (error) { this.resetNode(n.id); result = bad(error instanceof Error ? error.message : 'Controller calculation failed'); }
        }
        else if (n.kind === 'not') result = good(!read('in'));
        else if (n.kind === 'and') result = good(read('a') && read('b'));
        else if (n.kind === 'or') result = good(read('a') || read('b'));
        else if (n.kind === 'xor') result = good(read('a') !== read('b'));
        else if (n.kind === 'script') result = good(yield { source: n.source!, language: n.language!, inputs: { a: read('a'), b: read('b') }, nowMs: now });
        else if (n.kind === 'output') result = good(read('in'));
        else if (n.kind === 'interlock' || n.kind === 'mode') result = !read('permit') ? bad('Interlock is not permitted') : good(n.kind === 'interlock' ? read('in') : read(read('isAuto') ? 'auto' : 'manual'));
        else if (n.kind === 'latch') { state.out = !read('reset') && (read('set') || state.out); result = good(state.out); }
        else {
          const value = read('in'); const delay = n.delayMs!;
          if (n.kind === 'ton') { if (!value) { state.since = null; state.out = false; } else { state.since ??= now; state.out = now - state.since >= delay; } }
          if (n.kind === 'tof') { if (value) { state.out = true; state.since = null; } else if (state.out) { state.since ??= now; if (now - state.since >= delay) state.out = false; } }
          if (n.kind === 'pulse') { if (state.since !== null && now - state.since >= delay) { state.out = false; state.since = null; } if (value && !state.previous && state.since === null) { state.since = now; state.out = delay > 0; } state.previous = value; }
          if (n.kind === 'debounce') { if (state.candidate !== value || state.since === null) { state.candidate = value; state.since = now; } if (now - state.since >= delay) state.out = value; }
          result = good(state.out);
        }
      }
      nodes[n.id] = result;
      if (n.kind === 'output') outputs[n.signalId!] = { ...result };
    }
    return { nodes, outputs };
    } finally { this.evaluating = false; }
  }
}
