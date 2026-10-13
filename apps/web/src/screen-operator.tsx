import { formatSignalValue } from './signal-format.js';
import { useEffect, useRef, useState } from 'react';
import type { Screen, ScreenItem } from '../../../packages/domain/src/screen.js';
import { api, type Sample } from './api.js';
import { ManualControl } from './runtime-controls.js';
const unavailable: Sample = { value: null, quality: 'Disconnected', receivedTime: null };
export function ScreenOperator({ screen, revision, projectRevision, close }: { screen: Screen; revision: number; projectRevision: number; close: () => void }) {
  const [values, setValues] = useState<Record<string, Sample>>({});
  const received = useRef(new Map<string, number>());
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => { const timer = setInterval(() => setNow(performance.now()), 500); return () => clearInterval(timer); }, []);
  const [selected, setSelected] = useState<ScreenItem | null>(null);
  useEffect(() => {
    let active = true; let timer: ReturnType<typeof setTimeout>; const controllers = new Set<AbortController>();
    const ids = [...new Set(screen.items.flatMap((item) => item.signalId ? [item.signalId] : []))];
    async function poll() {
      // Bound concurrency independently of scene size and never overlap poll rounds.
      for (let offset = 0; offset < ids.length && active; offset += 8) {
        await Promise.all(ids.slice(offset, offset + 8).map(async (id) => {
          const controller = new AbortController(); controllers.add(controller);
          const timeout = setTimeout(() => controller.abort(), 2000);
          try { const sample = await api<Sample>(`/signals/${id}/value`, { signal: controller.signal }); if (active) { received.current.set(id, performance.now()); setValues((before) => ({ ...before, [id]: sample })); } }
          catch { if (active) setValues((before) => ({ ...before, [id]: { ...(before[id] ?? unavailable), quality: 'Disconnected' } })); }
          finally { clearTimeout(timeout); controllers.delete(controller); }
        }));
      }
      if (active) timer = setTimeout(() => { void poll(); }, 1000);
    }
    void poll(); return () => { active = false; clearTimeout(timer); for (const controller of controllers) controller.abort(); };
  }, [screen]);
  function sample(item: ScreenItem) {
    const value = item.signalId ? values[item.signalId] ?? unavailable : unavailable;
    return value.quality === 'Good' && now - (received.current.get(item.signalId!) ?? -Infinity) >= 3000 ? { ...value, quality: 'Stale' } : value;
  }
  const display = (value: Sample) => `${formatSignalValue(value.value)} · ${value.quality}`;
  const controls = screen.items.filter((item) => item.kind === 'button');
  return <div className="engineering"><section className="panel operator-heading"><div><span className="eyebrow">OPERATOR VIEW</span><h2>Prepared screen · r{revision}</h2><p className="muted">Values include data quality. Controls request an audited command.</p></div><button className="secondary" onClick={close}>Back to editor</button></section>
    {screen.items.some((item) => item.kind === 'value') && <section className="panel operator-values" aria-label="Live numeric values"><h2>Readings</h2><dl>{screen.items.filter((item) => item.kind === 'value').map((item) => { const current = sample(item); return <div key={item.id}><dt>{item.label}</dt><dd><strong>{formatSignalValue(current.value)}</strong><span className={`badge ${current.quality === 'Good' ? 'good' : 'warning'}`}>{current.quality}</span></dd></div>; })}</dl></section>}
    <section className="panel operator-scene"><div className="screen-canvas"><svg role="group" aria-label="Operator HMI" viewBox={`0 0 ${screen.width} ${screen.height}`}>{[...screen.items].sort((a, b) => Number(b.kind === 'group') - Number(a.kind === 'group')).map((item) => {
      const current = sample(item); const state = display(current); const control = item.kind === 'button';
      const enabled = control && current.quality === 'Good';
      return <g key={item.id} className={`screen-item ${item.kind} operator-item`} transform={`translate(${item.x},${item.y})`} role={control ? 'button' : 'img'} aria-label={control ? `Operate ${item.label}` : `${item.label}: ${item.signalId ? state : ''}`} tabIndex={enabled ? 0 : undefined} aria-disabled={control ? !enabled : undefined} onClick={() => { if (enabled) setSelected(item); }} onKeyDown={(event) => { if (enabled && ['Enter', ' '].includes(event.key)) { event.preventDefault(); setSelected(item); } }}>
        <rect width={item.width} height={item.height} rx={8} />{item.kind === 'indicator' && <circle cx={22} cy={item.height / 2} r={8} fill={current.quality !== 'Good' ? 'var(--warning)' : current.value ? 'var(--accent)' : 'var(--muted)'} />}<text x={item.kind === 'indicator' ? 42 : 14} y={item.kind === 'group' ? 26 : item.height / 2 - 4}>{item.label}</text>{item.signalId && <text x={item.kind === 'indicator' ? 42 : 14} y={item.height / 2 + 17} className="hmi-quality">{state}</text>}
      </g>;
    })}</svg></div></section>
    {!!controls.length && <section className="panel operator-controls"><h2>Equipment controls</h2><div>{controls.map((item) => <button key={item.id} className="secondary" disabled={sample(item).quality !== 'Good'} onClick={() => setSelected(item)}>Control {item.label}</button>)}</div></section>}
    {selected?.signalId && <ManualControl key={selected.id} signal={{ id: selected.signalId, name: selected.label, deviceId: '', dataType: 'boolean', direction: 'output' }} revision={projectRevision} quality={sample(selected).quality} close={() => setSelected(null)} />}
  </div>;
}
