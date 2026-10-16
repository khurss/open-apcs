import type {RecipeDefinition} from '../../../../../packages/domain/src/recipe-model.js';
import {isUniversalRecipe} from '../../../../../packages/domain/src/universal-recipe.js';
import {UniversalRecipeEditor} from './universal-editor.js';
import {isRecipeProgram,type RecipeProgram,type ThermalStep} from '../../../../../packages/domain/src/recipe-program.js';
export function multiStepDemo():RecipeProgram {
 return {schemaVersion:2,steps:[{kind:'heat',name:'Warm chamber',targetC:22,timeoutSeconds:60},{kind:'hold',name:'Hold temperature',targetC:22,durationSeconds:5},{kind:'cool',name:'Cool chamber',targetC:21,timeoutSeconds:60}]};
}
export function recipeSummary(parameters:RecipeDefinition):string {
 if(isUniversalRecipe(parameters))return `${parameters.steps.length} steps · ${parameters.ports.length} signal roles · Set / Wait / Delay`;
 return isRecipeProgram(parameters)?`${parameters.steps.length} steps · ${parameters.steps.map(step=>step.kind==='heat'?'Heat':step.kind==='hold'?'Hold':'Cool').join(' → ')}`:`${parameters.targetC} C · hold ${parameters.holdSeconds} s · heating timeout ${parameters.maxHeatSeconds} s`;
}
export function RecipeParametersView({parameters,frozen=true}:{parameters:RecipeDefinition;frozen?:boolean}) {
 if(isUniversalRecipe(parameters))return <><p className="muted">{frozen?'Frozen steps and roles':'Published steps and roles'}</p><ul>{parameters.ports.map(p=><li key={p.key}>{p.label} ({p.key}) · {p.kind}</li>)}</ul><ol>{parameters.steps.map((s,i)=><li key={i}>{s.name}: {s.kind==='delay'?`delay ${s.durationSeconds} s`:`${s.kind} ${s.port} ${s.kind==='wait'?s.operator:'='} ${s.value} · timeout ${s.timeoutSeconds} s`}</li>)}</ol></>;
 return isRecipeProgram(parameters)?<><p className="muted">{frozen?'Frozen steps':'Published steps'}</p><ol className="recipe-step-summary">{parameters.steps.map((step,index)=><li key={index}><strong>{step.name}</strong>: {step.kind} at {step.targetC} C · {step.kind==='hold'?`${step.durationSeconds} s duration`:`${step.timeoutSeconds} s timeout`}</li>)}</ol></>:<p className="muted">{frozen?'Frozen parameters':'Published parameters'}: {parameters.targetC} C / {parameters.holdSeconds} s hold / {parameters.maxHeatSeconds} s heating timeout</p>;
}
export function RecipeParameterEditor({value,onChange}:{value:RecipeDefinition;onChange:(value:RecipeDefinition)=>void}) {
 if(isUniversalRecipe(value))return <UniversalRecipeEditor value={value} onChange={onChange}/>;
 if(!isRecipeProgram(value))return <>
  {([['targetC','Target temperature (C)',21,35,0.1],['holdSeconds','Hold duration (seconds)',1,3600,1],['maxHeatSeconds','Heating timeout (seconds)',1,600,1]] as const).map(([key,label,min,max,step])=><label className="field" key={key}>{label}<input type="number" required min={min} max={max} step={step} value={Number.isFinite(value[key])?value[key]:''} onChange={e=>onChange({...value,[key]:e.target.valueAsNumber})}/></label>)}
  <button type="button" className="secondary" onClick={()=>onChange({schemaVersion:2,steps:[{kind:'heat',name:'Heat',targetC:value.targetC,timeoutSeconds:value.maxHeatSeconds},{kind:'hold',name:'Hold',targetC:value.targetC,durationSeconds:value.holdSeconds}]})}>Use step editor</button>
 </>;
 const change=(index:number,step:ThermalStep)=>onChange({...value,steps:value.steps.map((current,i)=>i===index?step:current)});
 const move=(from:number,to:number)=>{const steps=[...value.steps];const [step]=steps.splice(from,1);steps.splice(to,0,step!);onChange({...value,steps});};
 return <div className="recipe-step-editor"><p>Steps execute in order. Heat waits until at or above the target; cool waits until at or below it. Hold runs a timed thermostat and does not wait for the target.</p>
  {value.steps.map((step,index)=><fieldset key={index}><legend>Step {index+1}</legend><div className="recipe-step-fields">
   <label className="field">Name<input aria-label={`Step ${index+1} name`} required maxLength={64} value={step.name} onChange={e=>change(index,{...step,name:e.target.value})}/></label>
   <label className="field">Action<select aria-label={`Step ${index+1} action`} value={step.kind} onChange={e=>{
    const kind=e.target.value as ThermalStep['kind'];const targetC=Math.max(kind==='cool'?20.5:21,step.targetC);
    change(index,kind==='hold'?{kind,name:step.name,targetC,durationSeconds:5}:{kind,name:step.name,targetC,timeoutSeconds:60});
   }}><option value="heat">Heat</option><option value="hold">Hold</option><option value="cool">Cool</option></select></label>
   <label className="field">Target (C)<input aria-label={`Step ${index+1} target`} type="number" required min={step.kind==='cool'?20.5:21} max={35} step="0.1" value={Number.isFinite(step.targetC)?step.targetC:''} onChange={e=>change(index,{...step,targetC:e.target.valueAsNumber})}/></label>
   <label className="field">{step.kind==='hold'?'Duration (seconds)':'Timeout (seconds)'}<input aria-label={`Step ${index+1} seconds`} type="number" required min={1} max={step.kind==='hold'?3600:600} step={1} value={Number.isFinite(step.kind==='hold'?step.durationSeconds:step.timeoutSeconds)?(step.kind==='hold'?step.durationSeconds:step.timeoutSeconds):''} onChange={e=>change(index,step.kind==='hold'?{...step,durationSeconds:e.target.valueAsNumber}:{...step,timeoutSeconds:e.target.valueAsNumber})}/></label>
   </div><div className="recipe-actions"><button type="button" className="secondary" aria-label={`Move step ${index+1} up`} disabled={index===0} onClick={()=>move(index,index-1)}>Move up</button><button type="button" className="secondary" aria-label={`Move step ${index+1} down`} disabled={index===value.steps.length-1} onClick={()=>move(index,index+1)}>Move down</button><button type="button" className="secondary" aria-label={`Remove step ${index+1}`} disabled={value.steps.length===1} onClick={()=>onChange({...value,steps:value.steps.filter((_,i)=>i!==index)})}>Remove</button></div>
  </fieldset>)}
  <button type="button" className="secondary" disabled={value.steps.length>=16} onClick={()=>onChange({...value,steps:[...value.steps,{kind:'hold',name:`Step ${value.steps.length+1}`,targetC:22,durationSeconds:5}]})}>Add step</button><p className="muted">{value.steps.length} / 16 steps. Cooling is passive with the heater OFF; its minimum target is 20.5 C.</p>
 </div>;
}
