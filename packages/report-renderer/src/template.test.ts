import { expect, it } from 'vitest';
import { reportHtml } from './template.js';
import { summarizeReport, type SignalReport } from '../../domain/src/history-report.js';
const data = (): SignalReport => ({ ...summarizeReport('day', '2026-10-12', 'digital', []), id: 'fixture', generatedAt: '2026-10-13T00:00:00.000Z', signal: { id: 'led', name: '<img src="http://attacker"> & LED', dataType: 'boolean' } });
it('escapes user text and renders bounded UTC metadata, quality gaps and hourly rows without executable content', () => {
  const html = reportHtml(data());
  expect(html).toContain('&lt;img'); expect(html).not.toContain('<img'); expect(html).not.toContain('<script');
  expect(html).toContain('Unknown'); expect(html).toContain('86,400'); expect(html).toContain('UTC');
  expect(html).toContain('2026-10-12T00:00:00.000Z'); expect(html).toContain('Template 1');
});
it('rejects oversized or malformed report payloads before passing them to Chromium', () => {
  for (const mutate of [(r: SignalReport) => { r.rows = Array(100).fill(r.summary); }, (r: SignalReport) => { r.signal.name = 'x'.repeat(1000); }, (r: SignalReport) => { r.summary.qualityMs.Good = NaN; }]) { const r = data(); mutate(r); expect(() => reportHtml(r)).toThrow(); }
});
