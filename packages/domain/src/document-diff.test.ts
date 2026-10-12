import { describe, expect, it } from 'vitest';
import { diffDocuments } from './document-diff.js';
describe('bounded structural document comparisons', () => {
  it('ignores object key order while reporting changed fields precisely', () => {
    expect(diffDocuments({ name: 'LED', document: { value: true, x: 0 } }, { document: { x: 0, value: true }, name: 'LED' })).toEqual({ changes: [], total: 0, truncated: false });
    expect(diffDocuments({ value: false }, { value: true }).changes).toEqual([{ path: '/value', kind: 'changed', before: false, after: true }]);
  });
  it('distinguishes absent fields from null and uses escaped JSON pointer paths', () => {
    expect(diffDocuments({ 'a/b~c': null, removed: 1 }, { 'a/b~c': false, added: null }).changes).toEqual([
      { path: '/a~1b~0c', kind: 'changed', before: null, after: false }, { path: '/added', kind: 'added', after: null }, { path: '/removed', kind: 'removed', before: 1 },
    ]);
  });
  it('retains meaningful array ordering and detects appended and removed items', () => {
    expect(diffDocuments({ items: ['a', 'b'] }, { items: ['b', 'a', 'c'] }).changes).toEqual([
      { path: '/items/0', kind: 'changed', before: 'a', after: 'b' }, { path: '/items/1', kind: 'changed', before: 'b', after: 'a' }, { path: '/items/2', kind: 'added', after: 'c' },
    ]);
    expect(diffDocuments([1], []).changes).toEqual([{ path: '/0', kind: 'removed', before: 1 }]);
  });
  it('bounds displayed changes but reports the complete count', () => {
    const result = diffDocuments([0, 0, 0], [1, 1, 1], 2);
    expect(result).toMatchObject({ total: 3, truncated: true }); expect(result.changes).toHaveLength(2);
    expect(() => diffDocuments({}, {}, 0)).toThrow(/limit/);
  });
  it('never aliases stored snapshots and treats prototype-like keys as ordinary data', () => {
    const source = JSON.parse('{"__proto__":{"value":1}}'); const result = diffDocuments({}, source);
    expect(result.changes[0]?.path).toBe('/__proto__');
    (result.changes[0]!.after as { value: number }).value = 2; expect(source.__proto__.value).toBe(1);
    expect(Object.prototype).not.toHaveProperty('value');
  });
  it('rejects inputs outside bounded JSON documents', () => {
    for (const value of [undefined, NaN, { value: Infinity }, new Date(), { fn: () => 1 }, Object.assign(new Array(1), { extra: true })]) expect(() => diffDocuments({}, value)).toThrow(/JSON/);
    const cycle: Record<string, unknown> = {}; cycle.self = cycle; expect(() => diffDocuments({}, cycle)).toThrow(/JSON/);
  });
});
