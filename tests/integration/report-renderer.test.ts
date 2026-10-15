import { expect, it } from 'vitest';
import { ReportClient } from '../../packages/report-renderer/src/client.js';
import { summarizeReport } from '../../packages/domain/src/history-report.js';
it('renders consecutive PDFs without a busy race and rejects invalid or unbounded input', async () => {
  const url = process.env.APCS_REPORT_URL; if (!url) throw new Error('Docker report renderer required');
  const report = { ...summarizeReport('month', '2026-10', 'analog', []), id: 'fixture', generatedAt: '2026-10-13T00:00:00.000Z', signal: { id: 'temperature', name: 'Bench temperature <untrusted>', dataType: 'float64' } };
  const pdf = await new ReportClient(url).render(report);
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-'); expect(pdf.length).toBeGreaterThan(5000); expect(pdf.length).toBeLessThan(2097152);
  const v2={...report,templateVersion:2 as const,signal:{...report.signal,unit:'°C',displayDecimals:1,revision:2}};
  expect((await new ReportClient(url).render(v2)).subarray(0, 5).toString()).toBe('%PDF-');
  const invalid = await fetch(`${url}/render`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...report, rows: Array(100).fill(report.summary) }) }); expect(invalid.status).toBe(400);
  const excessive = await fetch(`${url}/render`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: ' '.repeat(131073) }); expect(excessive.status).toBe(413);
});
