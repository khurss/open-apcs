import type {ScreenItem} from '../../../../../packages/domain/src/screen.js';
import type {Sample} from '../../api.js';
import {HistoryTrend} from '../../history-trend.js';
import {emptyTrend,type TrendState} from './use-trends.js';
export function TrendPanel({item,state=emptyTrend,sample,inspect}:{item:ScreenItem;state?:TrendState;sample:Sample;inspect:()=>void}) {
  const digital=typeof sample.value==='boolean'||state.items.some(row=>typeof row.snapshot.value==='boolean');
  return <section className="trend-panel" aria-label={`Trend ${item.label}`}><div className="trend-title"><strong>{item.label}</strong><span className={`badge ${sample.quality==='Good'?'good':'warning'}`}>{sample.quality}</span></div>
    {state.status==='loading'?<p role="status">Loading archived observations…</p>:state.error?<p role="alert">{state.error}</p>:state.items.length?<HistoryTrend rows={state.items} boolean={digital}/>:<p>No archived observations in this window.</p>}
    <div className="trend-caption"><span>{item.windowSeconds}s window · {state.items.length} loaded observations{state.nextBefore?' · older observations omitted':''}</span><button className="text-button" onClick={inspect}>Inspect history</button></div>
  </section>;
}
