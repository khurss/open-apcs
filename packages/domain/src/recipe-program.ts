import {advanceRecipe,beginRecipe,validateRecipe,type RecipeParameters,type RecipeSnapshot} from './recipe.js';
export type ThermalStep =
 | {kind:'heat'|'cool';name:string;targetC:number;timeoutSeconds:number}
 | {kind:'hold';name:string;targetC:number;durationSeconds:number};
export interface RecipeProgram {schemaVersion:2;steps:ThermalStep[];}
export type RecipeDefinition=RecipeParameters|RecipeProgram;
export interface ProgramSnapshot extends Omit<RecipeSnapshot,'parameters'|'step'> {
 parameters:RecipeProgram;stageIndex:number;step:'Heating'|'Holding'|'Cooling'|'Finished';
}
export type RecipeRunSnapshot=RecipeSnapshot|ProgramSnapshot;
export function isRecipeProgram(value:RecipeDefinition):value is RecipeProgram {return 'schemaVersion' in value;}
function object(value:unknown):Record<string,unknown> {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Expected recipe object');
 return value as Record<string,unknown>;
}
function exactKeys(value:Record<string,unknown>,keys:string[]) {
 if(Object.keys(value).sort().join(',')!==keys.sort().join(','))throw new Error('Unexpected recipe properties');
}
export function validateRecipeDefinition(input:unknown):RecipeDefinition {
 const source=object(input);
 if(!('schemaVersion' in source))return validateRecipe(input);
 exactKeys(source,['schemaVersion','steps']);
 if(source.schemaVersion!==2||!Array.isArray(source.steps)||source.steps.length<1||source.steps.length>16)throw new Error('Expected version 2 with 1–16 steps');
 const steps=source.steps.map((value):ThermalStep=>{
  const step=object(value);const kind=step.kind;
  if(kind!=='heat'&&kind!=='hold'&&kind!=='cool')throw new Error('Unsupported thermal step');
  const timeKey=kind==='hold'?'durationSeconds':'timeoutSeconds';
  exactKeys(step,['kind','name','targetC',timeKey]);
  if(typeof step.name!=='string'||!step.name.trim()||Array.from(step.name).length>64)throw new Error('Step name must contain 1–64 characters');
  if(typeof step.targetC!=='number'||!Number.isFinite(step.targetC)||step.targetC<(kind==='cool'?20.5:21)||step.targetC>35)throw new Error('Invalid step temperature');
  const seconds=step[timeKey];
  if(typeof seconds!=='number'||!Number.isInteger(seconds)||seconds<1||seconds>(kind==='hold'?3600:600))throw new Error('Invalid step time');
  return kind==='hold'?{kind,name:step.name,targetC:step.targetC,durationSeconds:seconds}:{kind,name:step.name,targetC:step.targetC,timeoutSeconds:seconds};
 });
 return {schemaVersion:2,steps};
}
const stepState=(kind:ThermalStep['kind'])=>kind==='heat'?'Heating':kind==='hold'?'Holding':'Cooling';
const heating=(step:ThermalStep,temperature:number)=>step.kind!=='cool'&&temperature<step.targetC;
export function beginRecipeRun(input:unknown,now:number):RecipeRunSnapshot {
 const parameters=validateRecipeDefinition(input);
 if(!isRecipeProgram(parameters))return beginRecipe(parameters,now);
 if(!Number.isFinite(now)||now<0)throw new Error('Invalid recipe clock');
 const first=parameters.steps[0]!;
 return {parameters,stageIndex:0,status:'Running',step:stepState(first.kind),temperatureC:20,heater:heating(first,20),startedAt:now,stepAt:now,lastAt:now,reason:null};
}
export function abortRecipeRun(state:RecipeRunSnapshot,reason:string):RecipeRunSnapshot {
 return state.status==='Running'?{...state,status:'Aborted',heater:false,reason}:state;
}
export function advanceRecipeRun(state:RecipeRunSnapshot,now:number,input:{permit:boolean;quality:string;temperatureC?:number}):RecipeRunSnapshot {
 if(!('stageIndex' in state))return advanceRecipe(state,now,input);
 if(state.status!=='Running')return state;
 if(!Number.isFinite(now)||now<state.lastAt)return abortRecipeRun(state,'Invalid simulation clock');
 if(now-state.lastAt>2500)return abortRecipeRun(state,'Simulation sampling overdue');
 if(input.permit!==true)return abortRecipeRun(state,'Simulation permit lost');
 if(input.quality!=='Good')return abortRecipeRun(state,'Simulation signal quality is not Good');
 if(input.temperatureC!==undefined&&!Number.isFinite(input.temperatureC))return abortRecipeRun(state,'Invalid measured temperature');
 const equilibrium=state.heater?40:20;
 const next:ProgramSnapshot={...state,lastAt:now,temperatureC:input.temperatureC??(equilibrium+(state.temperatureC-equilibrium)*Math.exp(-(now-state.lastAt)/20000))};
 const current=next.parameters.steps[next.stageIndex]!;
 const elapsed=now-next.stepAt;
 const complete=current.kind==='hold'?elapsed>=current.durationSeconds*1000:current.kind==='heat'?next.temperatureC>=current.targetC:next.temperatureC<=current.targetC;
 if(complete) {
  // Enter at most one next step per observation. Never borrow time from the preceding step.
  if(next.stageIndex===next.parameters.steps.length-1)return {...next,status:'Completed',step:'Finished',heater:false};
  next.stageIndex++;next.stepAt=now;next.step=stepState(next.parameters.steps[next.stageIndex]!.kind);
 } else if(current.kind!=='hold'&&elapsed>=current.timeoutSeconds*1000) {
  return abortRecipeRun(next,`Step ${next.stageIndex+1} (${current.name}): ${current.kind==='heat'?'heating':'cooling'} timeout`);
 }
 next.heater=heating(next.parameters.steps[next.stageIndex]!,next.temperatureC);
 return next;
}
/** The index distinguishes consecutive steps of the same kind in durable journals. */
export function recipeStepDescription(state:RecipeRunSnapshot):string {
 return 'stageIndex' in state?`${state.stageIndex+1}: ${state.parameters.steps[state.stageIndex]!.name} (${state.step})`:state.step;
}
