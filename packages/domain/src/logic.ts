export type BlockKind = 'constant' | 'input' | 'not' | 'and' | 'or' | 'xor' | 'ton' | 'tof' | 'pulse' | 'debounce' | 'latch' | 'interlock' | 'mode' | 'output';
export interface LogicNode { id: string; kind: BlockKind; label: string; x: number; y: number; signalId?: string; value?: boolean; delayMs?: number; }
export interface LogicEdge { id: string; source: string; target: string; port: string; }
export interface LogicGraph { schemaVersion: 1; nodes: LogicNode[]; edges: LogicEdge[]; }
export interface LogicValue { value: boolean | null; quality: 'Good' | 'Bad'; reason: string | null; }
export interface LogicResult { nodes: Record<string, LogicValue>; outputs: Record<string, LogicValue>; }
export const ports: Record<BlockKind, string[]> = { constant: [], input: [], not: ['in'], and: ['a', 'b'], or: ['a', 'b'], xor: ['a', 'b'], ton: ['in'], tof: ['in'], pulse: ['in'], debounce: ['in'], latch: ['set', 'reset'], interlock: ['in', 'permit'], mode: ['auto', 'manual', 'isAuto', 'permit'], output: ['in'] };
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
  const nodes = new Map<string, LogicNode>(); const writers = new Set<string>();
  for (const value of graph.nodes) {
    const n = record(value, ['id', 'kind', 'label', 'x', 'y', 'signalId', 'value', 'delayMs'], 'node');
    if (!identifier(n.id) || nodes.has(n.id) || typeof n.kind !== 'string' || !kinds.includes(n.kind) || !title(n.label) || !coordinate(n.x) || !coordinate(n.y)) throw new Error('Invalid or duplicate node');
    const kind = n.kind as BlockKind;
    if (kind === 'input' || kind === 'output') { if (!identifier(n.signalId)) throw new Error('Signal binding required'); }
    else if ('signalId' in n) throw new Error('Unexpected signal binding');
    if (kind === 'constant') { if (typeof n.value !== 'boolean') throw new Error('Boolean constant required'); }
    else if ('value' in n) throw new Error('Unexpected constant value');
    if (timers.has(kind)) { if (!Number.isSafeInteger(n.delayMs) || (n.delayMs as number) < 0 || (n.delayMs as number) > 86400000) throw new Error('Invalid timer delay'); }
    else if ('delayMs' in n) throw new Error('Unexpected timer delay');
    if (kind === 'output') { if (writers.has(n.signalId as string)) throw new Error('Multiple writers for an output'); writers.add(n.signalId as string); }
    nodes.set(n.id, n as unknown as LogicNode);
  }
  const edges = new Set<string>(); const connected = new Map<string, Set<string>>();
  for (const value of graph.edges) {
    const e = record(value, ['id', 'source', 'target', 'port'], 'edge');
    if (!identifier(e.id) || edges.has(e.id) || typeof e.source !== 'string' || typeof e.target !== 'string' || typeof e.port !== 'string') throw new Error('Invalid or duplicate edge');
    edges.add(e.id); const source = nodes.get(e.source); const target = nodes.get(e.target);
    if (!source || !target) throw new Error('Missing edge reference');
    if (source.kind === 'output') throw new Error('An output cannot be an edge source');
    if (!ports[target.kind].includes(e.port)) throw new Error('Unknown target port');
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
interface State { out: boolean; previous: boolean; candidate: boolean; since: number | null; }
const fresh = (): State => ({ out: false, previous: false, candidate: false, since: null });
const good = (value: boolean): LogicValue => ({ value, quality: 'Good', reason: null });
const bad = (reason: string): LogicValue => ({ value: null, quality: 'Bad', reason });
export class LogicEngine {
  private readonly ordered: LogicNode[];
  private readonly wires = new Map<string, Map<string, string>>();
  private readonly states = new Map<string, State>();
  private lastTime = 0;
  constructor(graph: LogicGraph) {
    const safe = validateGraph(graph); this.ordered = order(safe);
    for (const n of this.ordered) { this.wires.set(n.id, new Map()); this.states.set(n.id, fresh()); }
    for (const e of safe.edges) this.wires.get(e.target)!.set(e.port, e.source);
  }
  tick(now: number, inputs: Record<string, LogicValue> = {}): LogicResult {
    if (!Number.isFinite(now) || now < this.lastTime) throw new Error('Monotonic time must be finite and nondecreasing');
    this.lastTime = now;
    const nodes: Record<string, LogicValue> = Object.create(null); const outputs: Record<string, LogicValue> = Object.create(null);
    for (const n of this.ordered) {
      const values = new Map([...this.wires.get(n.id)!].map(([port, id]) => [port, nodes[id]!]));
      const invalid = [...values.values()].find((v) => v.quality !== 'Good');
      let result: LogicValue;
      if (invalid) { this.states.set(n.id, fresh()); result = bad(invalid.reason ?? 'Invalid input'); }
      else if (n.kind === 'constant') result = good(n.value!);
      else if (n.kind === 'input') {
        const sample = Object.hasOwn(inputs, n.signalId!) ? inputs[n.signalId!] : undefined;
        result = sample?.quality === 'Good' && typeof sample.value === 'boolean' ? good(sample.value) : bad(sample?.reason ?? 'Input unavailable');
      } else {
        const read = (port: string) => values.get(port)!.value!;
        const state = this.states.get(n.id)!;
        if (n.kind === 'not') result = good(!read('in'));
        else if (n.kind === 'and') result = good(read('a') && read('b'));
        else if (n.kind === 'or') result = good(read('a') || read('b'));
        else if (n.kind === 'xor') result = good(read('a') !== read('b'));
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
  }
}
