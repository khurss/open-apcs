import {isUniversalRecipe,isUniversalSnapshot} from '../../../../../packages/domain/src/universal-recipe.js';
import {RecipePresetLibrary} from './universal-editor.js';
import {UniversalRecipeLaunch} from './universal-launch.js';
import {useEffect,useState} from 'react';
import {api,type Project,type Device,type Page} from '../../api.js';
import {recipeStepDescription,type RecipeDefinition as RecipeParameters,type RecipeRunSnapshot as RecipeSnapshot} from '../../../../../packages/domain/src/recipe-model.js';
import {VirtualDeviceControl} from '../../runtime-controls.js';
import {multiStepDemo,recipeSummary,RecipeParametersView,RecipeParameterEditor} from './parameters.js';
interface Recipe {id:string;revision:number;name:string;parameters:RecipeParameters;}
export interface Run {binding:({deviceId:string;kind?:never}|{kind:'universal';ports:Record<string,{signalId:string;deviceId:string}>})|null;control:{phase:string;commandId:string|null;commandState:string|null;observedOutput:boolean|null;outputs?:Record<string,{commandId:string;state:string;value:boolean}>}|null;id:string;recipe_id:string;revision:number;snapshot:RecipeSnapshot;events:{at:number;message:string}[];}
export function RecipeWorkspace({projects,initialProject,onProject}:{projects:Project[];initialProject:string;onProject:(id:string)=>void}) {
 const [projectId,setProjectId]=useState(initialProject||projects[0]?.id||'');
 useEffect(()=>{if(!projectId&&initialProject)setProjectId(initialProject);},[initialProject,projectId]);
 return <><label className="field">Project<select aria-label="Recipe project" value={projectId} onChange={e=>{setProjectId(e.target.value);onProject(e.target.value);}}><option value="">Select a project</option>{projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>{projectId?<RecipeProject key={projectId} projectId={projectId}/>:<p>Create or select a project to explore recipes.</p>}</>;
}
function RecipeProject({projectId}:{projectId:string}) {
 const [recipes,setRecipes]=useState<Recipe[]>([]); const [runs,setRuns]=useState<Run[]>([]);
 const [selected,setSelected]=useState<Recipe|null>(null); const [name,setName]=useState('Thermal chamber demo');
 const [parameters,setParameters]=useState<RecipeParameters>({targetC:22,holdSeconds:5,maxHeatSeconds:60});
 const [error,setError]=useState('');const [busy,setBusy]=useState(false);const [loaded,setLoaded]=useState(false);
 const [refresh,setRefresh]=useState(0);
 const [demo,setDemo]=useState<{recipeId:string;bindings:Record<string,string>}|null>(null);
 const [expanded,setExpanded]=useState('');
 const [devices,setDevices]=useState<Device[]>([]);const [deviceId,setDeviceId]=useState('');
 useEffect(()=>{let cancelled=false;const controller=new AbortController();void(async()=>{
  const items:Device[]=[];let cursor:string|null=null;do{const page:Page<Device>=await api(`/devices?projectId=${projectId}&limit=100${cursor?'&cursor='+cursor:''}`,{signal:controller.signal});items.push(...page.items.filter(d=>d.kind==='virtual-thermal'));cursor=page.nextCursor;}while(cursor&&!cancelled);if(!cancelled)setDevices(items);
 })().catch(()=>{if(!cancelled)setError('Could not load thermal devices');});return()=>{cancelled=true;controller.abort();};},[projectId,refresh]);
 useEffect(()=>{
  let stopped=false;let timer:ReturnType<typeof setTimeout>;let controller:AbortController;
  const load=async()=>{
   controller=new AbortController();const deadline=setTimeout(()=>controller.abort(),5000);
   try {
    const [r,h]=await Promise.all([api<{items:Recipe[]}>(`/projects/${projectId}/recipes`,{signal:controller.signal}),api<{items:Run[]}>(`/projects/${projectId}/recipe-runs`,{signal:controller.signal})]);
    if(!stopped){setRecipes(r.items);setRuns(h.items);setLoaded(true);}
   }catch(e){if(!stopped){setLoaded(false);setError(e instanceof Error?e.message:'Could not load recipes');}}
   finally{clearTimeout(deadline);if(!stopped)timer=setTimeout(()=>void load(),1000);}
  };void load();return()=>{stopped=true;clearTimeout(timer);controller.abort();};
 },[projectId,refresh]);
 const perform=async(work:()=>Promise<unknown>)=>{setBusy(true);setError('');try{await work();setRefresh(n=>n+1);}catch(e){setError(e instanceof Error?e.message:'Recipe action failed');}finally{setBusy(false);}};
 const active=runs.find(r=>r.snapshot.status==='Running');
 const choose=(recipe:Recipe|null)=>{setSelected(recipe);setName(recipe?.name??'Thermal chamber demo');setParameters(recipe?.parameters??{targetC:22,holdSeconds:5,maxHeatSeconds:60});};
 const cancel=(run:Run,cause?:'permit'|'quality')=>perform(()=>api(`/projects/${projectId}/recipe-runs/${run.id}/cancel`,{method:'POST',body:cause?{cause}:{}}));
 return <div className="recipe-workspace">
  <section className="panel"><span className="eyebrow">SIMULATION ONLY</span><h2>Automation recipes</h2><p>Build reusable Set / Wait / Delay sequences across virtual devices, or use thermal chamber programs. Runs continue on the server when you leave this page.</p><p className="muted">Universal recipes use explicit signal bindings over MQTT. Thermal recipes also support an isolated model. Physical device bindings are not supported. Restarting the service aborts active runs. Holding is timed thermostat control, not certified temperature dwell.</p></section>
  {error&&<div role="alert" className="error">{error}<button className="secondary" onClick={()=>{setError('');setRefresh(n=>n+1);}}>Retry loading</button></div>}
  <RecipePresetLibrary choose={preset=>{setSelected(null);setName(preset.name);setParameters(structuredClone(preset.program));document.getElementById('recipe-draft')?.scrollIntoView({behavior:'smooth',block:'start'});}}/>
  <section className="panel" id="recipe-draft"><div className="panel-heading"><h2>{selected?`Publish version after v${selected.revision}`:'Create a recipe'}</h2><div className="recipe-actions"><button className="secondary" onClick={()=>choose(null)}>New demo recipe</button><button className="secondary" onClick={()=>{setSelected(null);setName('Multi-step thermal demo');setParameters(multiStepDemo());}}>New multi-step demo</button></div></div>
   <form className="device-form" onSubmit={e=>{e.preventDefault();void perform(async()=>{const saved=await api<Recipe>(`/projects/${projectId}/recipes`,{method:'POST',body:{name,parameters,...(selected?{recipeId:selected.id,expectedRevision:selected.revision}:{})}});setSelected(saved);});}}>
    <label className="field">Recipe name<input required maxLength={128} value={name} onChange={e=>setName(e.target.value)}/></label>
    <RecipeParameterEditor value={parameters} onChange={setParameters}/>
    <button className="primary" disabled={busy||!loaded}>Publish recipe version</button>
   </form><p className="muted">Publishing saves an immutable version. Starting uses its exact parameters; later edits never change an active run.</p>
  </section>
  <section className="panel"><h2>Thermal execution target</h2><label className="field">Recipe execution target<select aria-label="Recipe execution target" value={deviceId} disabled={busy||!!active} onChange={e=>setDeviceId(e.target.value)}><option value="">Isolated thermal model</option>{devices.map(d=><option key={d.id} value={d.id}>{d.name} · MQTT</option>)}</select></label>
   <button className="secondary" disabled={busy} onClick={()=>void perform(async()=>{const demo=await api<{deviceId:string}>(`/projects/${projectId}/recipe-demo`,{method:'POST',body:{}});setDeviceId(demo.deviceId);})}>Install MQTT recipe demo</button>
   {deviceId&&<><VirtualDeviceControl key={deviceId} deviceId={deviceId}/><p className="muted">Start this simulator before running a recipe. The recipe exclusively owns its heater; completion or cancellation stops the simulator. Restart it explicitly for another run.</p></>}
  </section>
  <section className="panel"><h2>Universal recipe demo</h2><p>Install a prepared two-device sequence and operator screen. Installation does not start any device or recipe.</p><button className="secondary" disabled={busy} onClick={()=>void perform(async()=>{const installed=await api<{recipeId:string;bindings:Record<string,string>}>(`/projects/${projectId}/universal-recipe-demo`,{method:'POST',body:{}});setDemo(installed);setExpanded(`${installed.recipeId}-1`);})}>Install universal recipe demo</button></section>
  <section className="panel"><h2>Published versions</h2>{!recipes.length&&<p>Demo parameters are ready above. Publish the first version to start.</p>}
   {recipes.map(recipe=><article className="recipe-version" key={`${recipe.id}-${recipe.revision}`}><div><strong>{recipe.name} · v{recipe.revision}</strong><p>{recipeSummary(recipe.parameters)}</p><details><summary>View parameters</summary><RecipeParametersView parameters={recipe.parameters} frozen={false}/></details></div><div className="recipe-actions"><button className="secondary" disabled={busy} onClick={()=>choose(recipe)}>Edit from v{recipe.revision}</button>{isUniversalRecipe(recipe.parameters)?<button className="secondary" onClick={()=>setExpanded(expanded===`${recipe.id}-${recipe.revision}`?'':`${recipe.id}-${recipe.revision}`)}>{expanded===`${recipe.id}-${recipe.revision}`?'Close configuration':'Configure and run'} v{recipe.revision}</button>:<button className="primary" disabled={busy||!loaded||!!active} onClick={()=>void perform(()=>api(`/projects/${projectId}/recipe-runs`,{method:'POST',body:{recipeId:recipe.id,revision:recipe.revision,...(deviceId?{deviceId}:{})}}))}>Start simulation v{recipe.revision}</button>}</div>{isUniversalRecipe(recipe.parameters)&&expanded===`${recipe.id}-${recipe.revision}`&&<UniversalRecipeLaunch projectId={projectId} parameters={recipe.parameters} revision={recipe.revision} disabled={busy||!loaded||!!active} defaults={demo?.recipeId===recipe.id&&recipe.revision===1?demo.bindings:undefined} onStart={bindings=>void perform(()=>api(`/projects/${projectId}/recipe-runs`,{method:'POST',body:{recipeId:recipe.id,revision:recipe.revision,bindings}}))}/>}</article>)}
  </section>
  <section className="panel"><h2>Execution journal</h2><p className="muted">One active simulation per project. Preview limits: 100 versions and 100 runs per project. Times use your local timezone.</p>
   {!runs.length&&<p>No runs yet.</p>}{runs.map(run=><article className="recipe-run" key={run.id} aria-label={`Recipe run ${run.id}`}><div className="panel-heading"><h3>{recipes.find(r=>r.id===run.recipe_id&&r.revision===run.revision)?.name??'Recipe'} · v{run.revision}</h3><strong data-testid="recipe-status">{run.snapshot.status}</strong></div>
    <p>Step: {run.snapshot.step==='Finished'?'Finished':recipeStepDescription(run.snapshot)} · {isUniversalSnapshot(run.snapshot)?Object.entries(run.snapshot.values).map(([key,value])=>`${key}: ${value??'Unknown'}`).join(' · '):`${run.snapshot.temperatureC.toFixed(2)} C · ${run.binding?'Requested heater':'Heater'} ${run.snapshot.heater?'ON':'OFF'}`}</p><RecipeParametersView parameters={run.snapshot.parameters}/>
    {run.binding&&<p>Virtual MQTT · {run.binding.kind==='universal'?`${Object.keys(run.binding.ports).length} bound roles`:run.binding.deviceId} · {run.control?.phase??'Starting'}{run.control?.commandState&&` · Command ${run.control.commandState}`}{run.control?.commandId&&<small> · {run.control.commandId}</small>}{run.snapshot.status==='Aborted'&&' · Authority revoked; OFF is not verified by this run.'}</p>}
    {run.control?.outputs&&<details><summary>Output command evidence</summary><ul>{Object.entries(run.control.outputs).map(([key,command])=><li key={key}>{key}: requested {command.value?'ON':'OFF'} · {command.state} · {command.commandId}</li>)}</ul></details>}
    {run.snapshot.reason&&<p>{run.snapshot.reason}</p>}{run.snapshot.status==='Running'&&<div className="recipe-actions"><button className="secondary" disabled={busy} onClick={()=>void cancel(run)}>Cancel simulation</button><button className="secondary" disabled={busy} onClick={()=>void cancel(run,'permit')}>Simulate permit loss</button><button className="secondary" disabled={busy} onClick={()=>void cancel(run,'quality')}>Simulate bad quality</button></div>}
    <details><summary>Run events ({run.events.length})</summary><ol>{run.events.map((event,index)=><li key={index}><time>{new Date(event.at).toLocaleString()}</time> — {event.message}</li>)}</ol></details>
   </article>)}
  </section>
 </div>;
}
