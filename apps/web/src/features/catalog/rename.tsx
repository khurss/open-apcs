import { useState } from 'react';
import { api } from '../../api.js';

export function Rename({ kind, id, name, revision, changed }: {kind:'devices'|'signals'|'projects';id:string;name:string;revision:number;changed:()=>Promise<void>}) {
  const [value,setValue]=useState(name); const [busy,setBusy]=useState(false); const [error,setError]=useState('');
  return <details className="rename"><summary>Rename {kind==='projects'?'project':kind==='devices'?'device':'signal'}</summary><form onSubmit={event=>{
    event.preventDefault();setBusy(true);setError('');
    void api(`/${kind}/${id}`,{method:'PATCH',headers:{'If-Match':`"${revision}"`},body:{name:value}}).then(changed).catch((reason:unknown)=>setError(reason instanceof Error?reason.message:'Rename failed')).finally(()=>setBusy(false));
  }}><label className="field"><span>New name for {name}</span><input required maxLength={128} value={value} onChange={event=>setValue(event.target.value)}/></label><button className="secondary" disabled={busy||value===name}>Save name</button></form>{error&&<p role="alert" className="alert">{error}. Refresh before retrying a conflicting edit.</p>}</details>;
}
