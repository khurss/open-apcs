export interface DocumentChange { path: string; kind: 'added' | 'removed' | 'changed'; before?: unknown; after?: unknown; }
export interface DocumentDiff { changes: DocumentChange[]; total: number; truncated: boolean; }
/** Bounded JSON pointer comparison. Array order remains significant, including HMI z-order. */
export function diffDocuments(before: unknown, after: unknown, limit = 200): DocumentDiff {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid comparison limit');
  for (const root of [before, after]) {
    let entries = 0;
    const check = (value: unknown, depth: number): void => {
      if (++entries > 32768 || depth > 32) throw new Error('JSON document exceeds comparison bounds');
      if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
      if (!value || typeof value !== 'object' || (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) throw new Error('Expected a JSON document');
      if (Array.isArray(value) && (value.length > 32768 || Object.keys(value).length !== value.length || Object.keys(value).some((key, index) => key !== String(index)))) throw new Error('Expected a dense JSON array');
      for (const entry of Object.values(value)) check(entry, depth + 1);
    };
    check(root, 0);
    if (JSON.stringify(root).length > 262144) throw new Error('JSON document exceeds comparison bounds');
  }
  const changes: DocumentChange[] = []; let total = 0;
  function add(change: DocumentChange) { total++; if (changes.length < limit) changes.push(structuredClone(change)); }
  function compare(left: unknown, right: unknown, path: string): void {
    if (left === right) return;
    if (left !== null && right !== null && typeof left === 'object' && typeof right === 'object' && Array.isArray(left) === Array.isArray(right)) {
      const keys = Array.isArray(left) && Array.isArray(right) ? Array.from({ length: Math.max(left.length, right.length) }, (_, i) => String(i)) : [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
      for (const key of keys) {
        const next = `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
        const a = left as Record<string, unknown>; const b = right as Record<string, unknown>;
        if (!Object.hasOwn(a, key)) add({ path: next, kind: 'added', after: b[key] });
        else if (!Object.hasOwn(b, key)) add({ path: next, kind: 'removed', before: a[key] });
        else compare(a[key], b[key], next);
      }
    } else add({ path, kind: 'changed', before: left, after: right });
  }
  compare(before, after, '');
  return { changes, total, truncated: total > changes.length };
}
