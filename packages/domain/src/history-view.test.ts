import { describe, expect, it } from 'vitest';
import type { ArchivedSample } from './history.js';
import { historyCsv, historyTrend } from './history-view.js';
const row = (id: string, at: number, value: boolean | number | string | null, quality: ArchivedSample['snapshot']['quality'] = 'Good', bootId = 'boot'): ArchivedSample => ({ id, observedAt: new Date(at).toISOString(), snapshot: { value, quality, bootId, sequence: Number(id), sourceTime: null, receivedTime: new Date(at).toISOString() } });
describe('history presentation with explicit gaps', () => {
  it('orders copied samples and holds a value only until the next observation', () => {
    const rows = [row('3', 2000, false), row('1', 0, false), row('2', 1000, true)]; const before = structuredClone(rows);
    expect(historyTrend(rows)).toMatchObject({ from: 0, to: 2000, segments: [{ from: 0, to: 1000, value: 0 }, { from: 1000, to: 2000, value: 1 }], omitted: 0 });
    expect(rows).toEqual(before);
  });
  it('does not bridge quality loss, changed boots, excessive gaps or exact string numbers', () => {
    const rows = [row('1', 0, true), row('2', 1000, true, 'Disconnected'), row('3', 2000, false), row('4', 3000, true, 'Good', 'new'), row('5', 200000, '9223372036854775807', 'Good', 'new')];
    expect(historyTrend(rows)).toMatchObject({ segments: [{ from: 0, to: 1000, value: 1 }], omitted: 1 });
  });
  it('uses archive ordinals to resolve tied timestamps and bounds its input', () => {
    expect(historyTrend([row('11', 0, true), row('10', 0, false), row('12', 1000, false)]).segments).toEqual([{ from: 0, to: 1000, value: 1 }]);
    expect(historyTrend([])).toMatchObject({ from: null, to: null, segments: [] });
    expect(() => historyTrend(Array.from({ length: 1001 }, (_, i) => row(String(i + 1), i, false)))).toThrow(/1000/);
  });
});
describe('bounded typed history CSV', () => {
  it('preserves quality, UTC time and exact values using a JSON value column', () => {
    const csv = historyCsv({ id: 'signal', name: 'A, "B"', dataType: 'int64' }, [row('1', 0, '9223372036854775807', 'Stale')]);
    expect(csv).toContain('value_json'); expect(csv).toContain('"""9223372036854775807"""'); expect(csv).toContain('"Stale"');
    expect(csv).toContain('"1970-01-01T00:00:00.000Z"'); expect(csv).toContain('"A, ""B"""'); expect(csv.endsWith('\r\n')).toBe(true);
  });
  it('keeps negative numbers parseable and quotes formula-like string values as JSON', () => {
    expect(historyCsv({ id: 's', name: 's', dataType: 'float64' }, [row('1', 0, -2.5)])).toContain(',"-2.5",');
    expect(historyCsv({ id: 's', name: 's', dataType: 'string' }, [row('1', 0, '=1+1')])).toContain('"""=1+1"""');
  });
  it('neutralizes spreadsheet formulas in text metadata while retaining typed boolean/null values', () => {
    const csv = historyCsv({ id: 'signal', name: '  =1+1', dataType: 'boolean' }, [row('1', 0, true), row('2', 1000, null, 'Bad')]);
    expect(csv).toContain('"\'  =1+1"'); expect(csv).toContain('"true"'); expect(csv).toContain('"null"');
    expect(() => historyCsv({ id: 's', name: 's', dataType: 'boolean' }, Array.from({ length: 1001 }, (_, i) => row(String(i + 1), i, false)))).toThrow(/1000/);
  });
});
it('opts into versioned raw CSV metadata without rounding values or altering legacy headers',()=>{
  const signal={id:'s',name:'Temperature',dataType:'float64',unit:'=UNIT()',displayDecimals:1,revision:7};
  const rows=[row('1',0,21.456)];
  expect(historyCsv(signal,rows).split('\r\n')[0]).not.toContain('export_version');
  const csv=historyCsv(signal,rows,{version:2});
  expect(csv.split('\r\n')[0]).toContain('export_version,unit,display_decimals,signal_revision');
  expect(csv).toContain('"21.456"');expect(csv).toContain('"2","\'=UNIT()","1","7"');
});
