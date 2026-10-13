import { coordinate, identifier, record, title } from './logic.js';
export interface ScreenItem { id: string; kind: 'label' | 'indicator' | 'button' | 'group' | 'value'; label: string; x: number; y: number; width: number; height: number; signalId?: string; groupId?: string; }
export interface Screen { schemaVersion: 1; width: number; height: number; items: ScreenItem[]; }
export function validateScreen(input: unknown): Screen {
  const screen = record(input, ['schemaVersion', 'width', 'height', 'items'], 'screen');
  const dimension = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 10000;
  if (screen.schemaVersion !== 1 || !dimension(screen.width) || !dimension(screen.height) || !Array.isArray(screen.items) || screen.items.length > 512) throw new Error('Invalid screen version or size');
  const byId = new Map<string, ScreenItem>();
  for (const value of screen.items) {
    const item = record(value, ['id', 'kind', 'label', 'x', 'y', 'width', 'height', 'signalId', 'groupId'], 'screen item');
    if (!identifier(item.id) || byId.has(item.id) || !['label', 'indicator', 'button', 'group', 'value'].includes(item.kind as string) || !title(item.label) || !coordinate(item.x) || !coordinate(item.y) || !dimension(item.width) || !dimension(item.height)) throw new Error('Invalid or duplicate screen item');
    if (item.kind === 'indicator' || item.kind === 'button' || item.kind === 'value') { if (!identifier(item.signalId)) throw new Error('Signal binding required'); }
    else if ('signalId' in item) throw new Error('Unexpected signal binding');
    if ('groupId' in item && !identifier(item.groupId)) throw new Error('Invalid group reference');
    byId.set(item.id, item as unknown as ScreenItem);
  }
  for (const item of byId.values()) {
    const visited = new Set([item.id]); let current = item;
    while (current.groupId) {
      if (visited.has(current.groupId)) throw new Error('Group cycle'); visited.add(current.groupId);
      const parent = byId.get(current.groupId); if (parent?.kind !== 'group') throw new Error('Missing group reference'); current = parent;
    }
  }
  return structuredClone(input) as Screen;
}
/** Stable object ordering; array order remains significant. Documents contain JSON values only. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => entry && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : entry);
}
/** JSON-compatible document snapshots; returned values never alias history storage. */
export class EditHistory<T> {
  private value: T;
  private readonly past: T[] = [];
  private readonly future: T[] = [];
  constructor(initial: T, private readonly limit = 100) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid history limit');
    this.value = structuredClone(initial);
  }
  get current(): T { return structuredClone(this.value); }
  get canUndo(): boolean { return this.past.length > 0; }
  get canRedo(): boolean { return this.future.length > 0; }
  set(value: T): void {
    if (canonicalJson(value) === canonicalJson(this.value)) return;
    this.past.push(this.value); if (this.past.length > this.limit) this.past.shift();
    this.value = structuredClone(value); this.future.length = 0;
  }
  undo(): T { if (this.past.length) { this.future.push(this.value); this.value = this.past.pop()!; } return this.current; }
  redo(): T { if (this.future.length) { this.past.push(this.value); this.value = this.future.pop()!; } return this.current; }
}
