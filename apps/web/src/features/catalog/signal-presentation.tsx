import {memo,useState} from 'react';
import {api,type Signal} from '../../api.js';
export const SignalPresentation=memo(function SignalPresentation({signal,changed}:{signal:Signal;changed:()=>Promise<void>}){
  const [unit,setUnit]=useState(signal.unit??'');const [decimals,setDecimals]=useState(signal.displayDecimals??2);
  const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  return <details className="rename"><summary>Display settings</summary><form onSubmit={event=>{
    event.preventDefault();setBusy(true);setError('');
    void api(`/signals/${signal.id}`,{method:'PATCH',headers:{'If-Match':`"${signal.revision??1}"`},body:{name:signal.name,unit,displayDecimals:decimals}}).then(changed).catch((reason:unknown)=>setError(reason instanceof Error?reason.message:'Display settings failed')).finally(()=>setBusy(false));
  }}><label className="field"><span>Unit for {signal.name}</span><input maxLength={24} value={unit} onChange={event=>setUnit(event.target.value)}/></label><label className="field"><span>Decimal places for {signal.name}</span><input type="number" required min={0} max={6} step={1} value={decimals} onChange={event=>setDecimals(Number(event.target.value))}/></label><p className="muted">Display only; no unit conversion or control-value rounding.</p><button className="secondary" disabled={busy}>Save display settings</button></form>{error&&<p role="alert" className="alert">{error}. Refresh before retrying a conflicting edit.</p>}</details>;
});
