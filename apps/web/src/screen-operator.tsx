import {useSignalMetadata} from './features/editors/use-signal-metadata.js';
import {useTrends} from './features/editors/use-trends.js';
import {TrendPanel} from './features/editors/trend-panel.js';
import {SignalHistory} from './signal-history.js';
import { formatSignalValue } from './signal-format.js';
import { useEffect, useRef, useState, useMemo } from 'react';
import type { Screen, ScreenItem } from '../../../packages/domain/src/screen.js';
import { api, type Sample, type Signal } from './api.js';
import { ManualControl } from './runtime-controls.js';
const unavailable: Sample = { value: null, quality: 'Disconnected', receivedTime: null };
export function ScreenOperator({ screen, revision, projectRevision, close }: { screen: Screen; revision: number; projectRevision: number; close: () => void }) {
  const trendItems=useMemo(()=>screen.items.filter(item=>item.kind==='trend'),[screen]);
  const trends=useTrends(trendItems);
  const metadata=useSignalMetadata(screen.items.flatMap(item=>item.signalId?[item.signalId]:[]));
  const [historyTarget,setHistoryTarget]=useState<Signal|null>(null);
  const [mobile,setMobile]=useState(()=>window.matchMedia('(max-width:600px)').matches);
  useEffect(()=>{const query=window.matchMedia('(max-width:600px)');const update=()=>setMobile(query.matches);query.addEventListener('change',update);return()=>query.removeEventListener('change',update);},[]);
  const sceneHeight=mobile?Math.max(100,...screen.items.filter(item=>item.kind!=='trend').map(item=>item.y+item.height+30)):screen.height;
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
  const display = (value: Sample, item: ScreenItem) => `${formatSignalValue(value.value,metadata.signals[item.signalId??''])} · ${value.quality}`;
  function trend(item:ScreenItem) {const current=sample(item);return <TrendPanel item={item} {...(trends[item.id]?{state:trends[item.id]}:{})} sample={current} presentation={metadata.signals[item.signalId!]??{}} inspect={()=>setHistoryTarget(metadata.signals[item.signalId!]??{id:item.signalId!,name:item.label,deviceId:'',dataType:typeof current.value==='boolean'||trends[item.id]?.items.some(row=>typeof row.snapshot.value==='boolean')?'boolean':'float64',direction:'input'})}/>;}
  const controls = screen.items.filter((item) => item.kind === 'button');
  return <div className="engineering"><section className="panel operator-heading"><div><span className="eyebrow">OPERATOR VIEW</span><h2>Prepared screen · r{revision}</h2><p className="muted">Values include data quality. Controls request an audited command.</p></div><button className="secondary" onClick={close}>Back to editor</button></section>
    {metadata.loading&&<p role="status">Loading signal display settings…</p>}
    {metadata.error&&<p role="alert" className="alert">Some signal display settings are unavailable. Affected values use default precision without units. <button className="secondary" onClick={metadata.retry}>Retry display settings</button></p>}
    <p className="muted">Display settings are loaded on opening this screen; reopen it to refresh units and precision.</p>
    {screen.items.some((item) => item.kind === 'value') && <section className="panel operator-values" aria-label="Live numeric values"><h2>Readings</h2><dl>{screen.items.filter((item) => item.kind === 'value').map((item) => { const current = sample(item); return <div key={item.id}><dt>{item.label}</dt><dd><strong>{formatSignalValue(current.value,metadata.signals[item.signalId??''])}</strong><span className={`badge ${current.quality === 'Good' ? 'good' : 'warning'}`}>{current.quality}</span></dd></div>; })}</dl></section>}
    <section className="panel operator-scene"><div className="screen-canvas"><svg role="group" aria-label="Operator HMI" viewBox={`0 0 ${screen.width} ${sceneHeight}`}>{[...screen.items].filter(item=>!mobile||item.kind!=='trend').sort((a, b) => Number(b.kind === 'group') - Number(a.kind === 'group')).map((item) => {
      if(item.kind==='trend')return <foreignObject key={item.id} x={item.x} y={item.y} width={item.width} height={item.height}>{trend(item)}</foreignObject>;
      const current = sample(item); const state = display(current,item); const control = item.kind === 'button';
      const enabled = control && current.quality === 'Good';
      return <g key={item.id} className={`screen-item ${item.kind} operator-item`} transform={`translate(${item.x},${item.y})`} role={control ? 'button' : 'img'} aria-label={control ? `Operate ${item.label}` : `${item.label}: ${item.signalId ? state : ''}`} tabIndex={enabled ? 0 : undefined} aria-disabled={control ? !enabled : undefined} onClick={() => { if (enabled) setSelected(item); }} onKeyDown={(event) => { if (enabled && ['Enter', ' '].includes(event.key)) { event.preventDefault(); setSelected(item); } }}>
        <rect width={item.width} height={item.height} rx={8} />{item.kind === 'indicator' && <circle cx={22} cy={item.height / 2} r={8} fill={current.quality !== 'Good' ? 'var(--warning)' : current.value ? 'var(--accent)' : 'var(--muted)'} />}<text x={item.kind === 'indicator' ? 42 : 14} y={item.kind === 'group' ? 26 : item.height / 2 - 4}>{item.label}</text>{item.signalId && <text x={item.kind === 'indicator' ? 42 : 14} y={item.height / 2 + 17} className="hmi-quality">{state}</text>}
      </g>;
    })}</svg></div></section>
    {mobile && !!trendItems.length && <section className="operator-trends">{trendItems.map(item=><div key={item.id}>{trend(item)}</div>)}</section>}
    {historyTarget && <SignalHistory signal={historyTarget} close={()=>setHistoryTarget(null)}/>}
    {!!controls.length && <section className="panel operator-controls"><h2>Equipment controls</h2><div>{controls.map((item) => <button key={item.id} className="secondary" disabled={sample(item).quality !== 'Good'} onClick={() => setSelected(item)}>Control {item.label}</button>)}</div></section>}
    {selected?.signalId && <ManualControl key={selected.id} signal={{ id: selected.signalId, name: selected.label, deviceId: '', dataType: 'boolean', direction: 'output' }} revision={projectRevision} quality={sample(selected).quality} close={() => setSelected(null)} />}
  </div>;
}
