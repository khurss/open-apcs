import type { SignalReport } from '../../domain/src/history-report.js';
export class ReportClient {
  constructor(private readonly url: string) { const parsed = new URL(url); if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') throw new Error('Invalid report renderer URL'); }
  async render(report: SignalReport): Promise<Buffer> {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`${this.url.replace(/\/$/, '')}/render`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(report), signal: controller.signal, redirect: 'error' });
      if (!response.ok || !response.headers.get('content-type')?.startsWith('application/pdf') || !response.body) throw new Error('Report renderer unavailable');
      const reader = response.body.getReader(); const chunks: Buffer[] = []; let size = 0;
      try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 2097152) { await reader.cancel(); throw new Error('Report PDF too large'); } chunks.push(Buffer.from(part.value)); } }
      finally { reader.releaseLock(); }
      return Buffer.concat(chunks);
    } finally { clearTimeout(timer); controller.abort(); }
  }
}
