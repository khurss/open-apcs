import {useEffect,useState} from 'react';
import {api} from '../../api.js';
import {recipeStepDescription} from '../../../../../packages/domain/src/recipe-program.js';
import type {Run} from './workspace.js';
/** Project-level recipe status, independent of screen drawing coordinates. */
export function RecipeOperatorMonitor({projectId}:{projectId:string}){
 const [run,setRun]=useState<Run|null>(null);const [available,setAvailable]=useState(false);
 useEffect(()=>{
  let stopped=false;let timer:ReturnType<typeof setTimeout>;let controller:AbortController;
  const poll=async()=>{controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),2000);
   try{const result=await api<{items:Run[]}>(`/projects/${projectId}/recipe-runs`,{signal:controller.signal});if(!stopped){setRun(result.items.find(r=>r.binding&&r.snapshot.status==='Running')??result.items.find(r=>r.binding)??null);setAvailable(true);}}
   catch{if(!stopped)setAvailable(false);}finally{clearTimeout(timeout);if(!stopped)timer=setTimeout(()=>void poll(),1000);}
  };void poll();return()=>{stopped=true;clearTimeout(timer);controller.abort();};
 },[projectId]);
 return <section className="panel recipe-monitor" aria-label="Project recipe status"><h2>Project recipe</h2>{!available?<p role="status">Recipe status unavailable</p>:run?<><p><strong>{run.snapshot.status}</strong> · {run.snapshot.step==='Finished'?'Finished':recipeStepDescription(run.snapshot)} · {run.snapshot.temperatureC.toFixed(2)} C</p><p>{run.control?.phase??'Starting'}{run.control?.commandState&&` · Command ${run.control.commandState}`}</p>{run.snapshot.reason&&<p>{run.snapshot.reason}</p>}<p className="muted">Recorded recipe status. Live readings below include signal quality. {run.snapshot.status==='Aborted'?'Authority revoked; OFF is not verified by this run.':''}</p></>:<p>No MQTT recipe runs in this project.</p>}</section>;
}
