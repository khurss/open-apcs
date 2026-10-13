import { describe, expect, it } from 'vitest';
import { EditHistory, validateScreen, type Screen, type ScreenItem } from './screen.js';
const item = (id: string, kind: ScreenItem['kind'], extra: Partial<ScreenItem> = {}): ScreenItem => ({ id, kind, label: id, x: 10, y: 20, width: 100, height: 40, ...extra });
const screen = (): Screen => ({ schemaVersion: 1, width: 1200, height: 800, items: [item('group', 'group'), item('led', 'indicator', { signalId: 'signal', groupId: 'group' })] });
describe('portable HMI scene', () => {
  it('accepts bound controls and groups without retaining mutable input', () => { const scene = screen(); scene.items.push(item('button', 'button', { signalId: 'signal' }), item('text', 'label')); const saved = validateScreen(scene); expect(saved).toEqual(scene); saved.items[0]!.label = 'Changed'; expect(scene.items[0]!.label).toBe('group'); });
  it('rejects scripts, raw SVG, external assets, unknown versions, and invalid dimensions', () => { for (const scene of [{ ...screen(), script: 'x' }, { ...screen(), schemaVersion: 2 }, { ...screen(), width: 0 }, { ...screen(), height: Infinity }, { ...screen(), items: [{ ...item('x', 'label'), svg: '<script/>' }] }, { ...screen(), items: [item('x', 'label', { width: -1 })] }]) expect(() => validateScreen(scene)).toThrow(); });
  it('rejects dangling groups, nested group cycles, and duplicate identities', () => { for (const items of [[item('x', 'label', { groupId: 'missing' })], [item('a', 'group', { groupId: 'b' }), item('b', 'group', { groupId: 'a' })], [item('a', 'label'), item('a', 'label')], [item('a', 'label'), item('b', 'label', { groupId: 'a' })]]) expect(() => validateScreen({ ...screen(), items })).toThrow(); });
  it('requires control bindings and bounds scene size', () => { expect(() => validateScreen({ ...screen(), items: [item('a', 'button')] })).toThrow(/binding/i); expect(() => validateScreen({ ...screen(), items: Array.from({ length: 513 }, (_, i) => item(`i${i}`, 'label')) })).toThrow(/size/i); });
});
describe('bounded editor history', () => {
  it('supports undo/redo and clears redo after a new edit', () => { const h = new EditHistory({ value: 0 }); h.set({ value: 1 }); h.set({ value: 2 }); expect(h.undo()).toEqual({ value: 1 }); expect(h.redo()).toEqual({ value: 2 }); h.undo(); h.set({ value: 3 }); expect(h.canRedo).toBe(false); expect(h.undo()).toEqual({ value: 1 }); });
  it('ignores object key order when deciding whether an edit changed a document', () => { const h = new EditHistory({ a: 1, b: 2 }); h.set({ b: 2, a: 1 }); expect(h.canUndo).toBe(false); });
  it('does not let reads or caller mutation change stored snapshots', () => { const state = { a: [1] }; const h = new EditHistory(state); state.a.push(2); h.current.a.push(3); expect(h.current.a).toEqual([1]); const next = { a: [5] }; h.set(next); next.a.push(6); expect(h.current.a).toEqual([5]); });
  it('bounds memory and handles end stops without duplicating no-op edits', () => { const h = new EditHistory(0, 2); h.set(1); h.set(2); h.set(3); h.set(3); expect(h.undo()).toBe(2); expect(h.undo()).toBe(1); expect(h.canUndo).toBe(false); expect(h.undo()).toBe(1); h.redo(); expect(h.redo()).toBe(3); expect(h.redo()).toBe(3); expect(() => new EditHistory(0, 0)).toThrow(); });
});

it('accepts a read-only numeric value widget and requires its signal binding', () => {
  const value = { id: 'temperature', kind: 'value', label: 'Temperature (C)', signalId: 'temperature', x: 0, y: 0, width: 180, height: 80 };
  expect(validateScreen({ ...screen(), items: [value] }).items[0]).toEqual(value);
  const { signalId: _signalId, ...unbound } = value; expect(() => validateScreen({ ...screen(), items: [unbound] })).toThrow(/binding/i);
  expect(() => validateScreen({ ...screen(), items: [{ ...value, script: 'fetch()' }] })).toThrow();
});
