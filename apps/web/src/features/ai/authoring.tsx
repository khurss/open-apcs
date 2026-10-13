import {useEffect,useRef,useState} from 'react';
import {api,type Signal} from '../../api.js';
import {validateGraph} from '../../../../../packages/domain/src/logic.js';
import {validateScreen} from '../../../../../packages/domain/src/screen.js';
import type {Document} from '../editors/model.js';
interface Proposal {name:string;summary:string;document:Document;model:string;checksum:string;}
export function AiAuthoring({kind,projectId,signals,apply}:{kind:'graph'|'screen';projectId:string;signals:Signal[];apply:(value:Document)=>boolean}) {
  const [provider,setProvider]=useState<{configured:boolean;model:string|null}|null>(null);
  const [prompt,setPrompt]=useState('');const [consent,setConsent]=useState(false);
  const [selected,setSelected]=useState<string[]>([]);const initialized=useRef(false);
  const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [proposal,setProposal]=useState<Proposal|null>(null);const [applied,setApplied]=useState(false);
  const pending=useRef<AbortController|null>(null);
  const available=signals.filter(signal=>['boolean','float64'].includes(signal.dataType));
  useEffect(()=>{if(!initialized.current&&available.length){setSelected(available.slice(0,100).map(signal=>signal.id));initialized.current=true;}},[signals]);
  useEffect(()=>{let active=true;void api<{configured:boolean;model:string|null}>('/ai/status').then(value=>{if(active)setProvider(value);}).catch(()=>{if(active)setError('AI service status is unavailable');});return()=>{active=false;pending.current?.abort();};},[projectId]);
  async function generate(){
    setBusy(true);setError('');setProposal(null);setApplied(false);
    const controller=new AbortController();pending.current=controller;const deadline=setTimeout(()=>controller.abort(),35000);
    try{
      const next=await api<Proposal>(`/projects/${projectId}/ai/proposals`,{method:'POST',signal:controller.signal,body:{kind,prompt,signalIds:selected,allowExternal:consent}});
      const document=kind==='graph'?validateGraph(next.document,true):validateScreen(next.document);
      if(!controller.signal.aborted)setProposal({...next,document});
    }catch(cause){if(!controller.signal.aborted)setError(cause instanceof Error?cause.message:'AI generation failed');else setError('AI request timed out or was cancelled. No draft was changed.');}
    finally{clearTimeout(deadline);if(pending.current===controller){pending.current=null;setBusy(false);}}
  }
  return <section className="panel ai-authoring" aria-label="AI draft assistant"><div className="panel-heading"><div><h2>Draft with AI</h2><p className="muted">Describe the {kind==='graph'?'control logic':'operator screen'} you want. Review the proposal before applying it.</p></div><span className="badge">OpenAI · {provider?.model??'Not configured'}</span></div>
    <div className="ai-content">{provider&&!provider.configured&&<p role="status">Ask your administrator to configure OpenAI on this server. Manual editing and local operation remain available.</p>}
      <form onSubmit={event=>{event.preventDefault();void generate();}}><label className="field"><span>Draft requirements</span><textarea required maxLength={4000} rows={4} disabled={busy} value={prompt} onChange={event=>setPrompt(event.target.value)} placeholder={kind==='graph'?'Switch the LED on when the temperature exceeds 25 C.':'Create a temperature overview with a live trend and heater status.'}/></label>
      <details><summary>Signal context · {selected.length} selected (maximum 100)</summary><div className="ai-signals">{available.map(signal=><label className="checkbox-field" key={signal.id}><input type="checkbox" checked={selected.includes(signal.id)} disabled={busy||(!selected.includes(signal.id)&&selected.length>=100)} onChange={event=>{setConsent(false);setSelected(event.target.checked?[...selected,signal.id]:selected.filter(id=>id!==signal.id));}}/><span>{signal.name}<small>{signal.dataType} · {signal.direction} · {signal.id}</small></span></label>)}</div>{!available.length&&<p className="muted">No compatible signals selected. Unbound labels or constant-only logic can still be drafted.</p>}</details>
      <label className="checkbox-field ai-consent"><input type="checkbox" checked={consent} disabled={busy} onChange={event=>setConsent(event.target.checked)}/><span>Send this prompt and the selected signal IDs, names, types and directions to OpenAI. Provider usage charges may apply.</span></label>
      <p className="muted">No live values, archives or device credentials are included. A proposal does not save, publish or activate equipment.</p>
      <button className="primary" disabled={busy||!provider?.configured||!consent||!prompt.trim()}>{busy?'Generating proposal…':'Generate proposal'}</button></form>
      {error&&<p className="alert" role="alert">{error}</p>}
      {proposal&&<div className="ai-preview" role="region" aria-label="AI proposal preview"><span className="eyebrow">VALIDATED DRAFT PROPOSAL</span><h3>{proposal.name}</h3><p>{proposal.summary}</p><p className="muted">{'nodes' in proposal.document?`${proposal.document.nodes.length} blocks · ${proposal.document.edges.length} connections`:`${proposal.document.items.length} screen elements`} · Review the generated document and simulate control behavior before activation.</p><details><summary>Inspect generated document</summary><pre>{JSON.stringify(proposal.document,null,2)}</pre></details><button className="secondary" disabled={applied} onClick={()=>{if(apply(proposal.document))setApplied(true);}}>Apply proposal to draft</button>{applied&&<p role="status">Proposal applied locally. Review the canvas, then save when ready. Undo restores the previous document.</p>}</div>}
    </div></section>;
}
