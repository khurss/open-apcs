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
it('renders frozen v2 units and precision and rejects malformed presentation',()=>{
  const report={...summarizeReport('day','2026-10-12','analog',[]),templateVersion:2 as const,id:'v2',generatedAt:'2026-10-13T00:00:00.000Z',signal:{id:'s',name:'Temperature',dataType:'float64',unit:'<°C>',displayDecimals:1,revision:4}};
  report.summary.mean=21.456;report.summary.min=20.123;report.summary.max=22.987;
  const html=reportHtml(report);expect(html).toContain('Units: &lt;°C&gt;');expect(html).toContain('21.5');expect(html).not.toContain('21.456');expect(html).toContain('Template 2');
  for(const change of [{unit:'x'.repeat(25)},{unit:'bad\nunit'},{displayDecimals:7},{displayDecimals:1.5},{revision:0},{unit:undefined}])expect(()=>reportHtml({...report,signal:{...report.signal,...change}})).toThrow();
});
