export interface RecipePort {key:string;label:string;kind:'boolean-output'|'boolean-input'|'number-input';}
export type UniversalStep=
 |{kind:'set';name:string;port:string;value:boolean;timeoutSeconds:number}
 |{kind:'wait';name:string;port:string;operator:'eq'|'gt'|'gte'|'lt'|'lte';value:boolean|number;timeoutSeconds:number}
 |{kind:'delay';name:string;durationSeconds:number};
export interface UniversalRecipe {schemaVersion:3;ports:RecipePort[];steps:UniversalStep[];}
export interface UniversalSnapshot {
 parameters:UniversalRecipe;status:'Running'|'Completed'|'Aborted';step:'Setting'|'Waiting'|'Delay'|'Finishing'|'Finished';
 stageIndex:number;startedAt:number;stepAt:number;lastAt:number;reason:string|null;values:Record<string,boolean|number|null>;
}
export function isUniversalRecipe(input:unknown):input is UniversalRecipe {return !!input&&typeof input==='object'&&'schemaVersion' in input&&input.schemaVersion===3;}
export function isUniversalSnapshot(input:{parameters:unknown}):input is UniversalSnapshot {return isUniversalRecipe(input.parameters);}
function object(input:unknown,keys:string[]):Record<string,unknown>{
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!==[...keys].sort().join(','))throw new Error('Unexpected universal recipe properties');
 return input as Record<string,unknown>;
}
const label=(input:unknown)=>typeof input==='string'&&!!input.trim()&&Array.from(input).length<=64;
const seconds=(input:unknown,max:number)=>typeof input==='number'&&Number.isInteger(input)&&input>=1&&input<=max;
export function validateUniversalRecipe(input:unknown):UniversalRecipe {
 const p=object(input,['schemaVersion','ports','steps']);
 if(p.schemaVersion!==3||!Array.isArray(p.ports)||p.ports.length<1||p.ports.length>16||!Array.isArray(p.steps)||p.steps.length<1||p.steps.length>64)throw new Error('Universal recipes require 1–16 ports and 1–64 steps');
 const ports=new Map<string,RecipePort>();
 for(const raw of p.ports){const port=object(raw,['key','label','kind']);
  if(typeof port.key!=='string'||!/^[a-z][a-z0-9_]{0,31}$/.test(port.key)||['constructor','prototype','__proto__'].includes(port.key)||ports.has(port.key)||!label(port.label)||!['boolean-output','boolean-input','number-input'].includes(String(port.kind)))throw new Error('Invalid or duplicate recipe port');
  ports.set(port.key,port as unknown as RecipePort);
 }
 const outputs=[...ports.values()].filter(p=>p.kind==='boolean-output');if(outputs.length<1||outputs.length>8)throw new Error('Universal recipes require 1–8 boolean outputs');
 for(const raw of p.steps){
  if(!raw||typeof raw!=='object')throw new Error('Invalid recipe step');
  const kind=(raw as {kind?:unknown}).kind;
  const step=object(raw,kind==='delay'?['kind','name','durationSeconds']:kind==='set'?['kind','name','port','value','timeoutSeconds']:['kind','name','port','operator','value','timeoutSeconds']);
  if(!label(step.name))throw new Error('Invalid recipe step name');
  if(kind==='delay'){if(!seconds(step.durationSeconds,3600))throw new Error('Invalid recipe delay');continue;}
  const port=ports.get(step.port as string);if(!port)throw new Error('Unknown recipe port');
  if(kind==='set'){
   if(port.kind!=='boolean-output'||typeof step.value!=='boolean'||!seconds(step.timeoutSeconds,2))throw new Error('Set requires a boolean output and a 1–2 second verification timeout');
  }else if(kind==='wait'){
   const numeric=port.kind==='number-input';
   if(!seconds(step.timeoutSeconds,3600)||!(numeric?['eq','gt','gte','lt','lte']:['eq']).includes(step.operator as string)||!(numeric?typeof step.value==='number'&&Number.isFinite(step.value):typeof step.value==='boolean'))throw new Error('Wait condition must match its port type');
  }else throw new Error('Unknown recipe action');
 }
 return structuredClone(input) as UniversalRecipe;
}
const stepState=(step:UniversalStep)=>step.kind==='set'?'Setting':step.kind==='wait'?'Waiting':'Delay';
export function beginUniversalRecipe(input:unknown,now:number):UniversalSnapshot {
 if(!Number.isFinite(now)||now<0)throw new Error('Invalid recipe clock');const parameters=validateUniversalRecipe(input);
 return {parameters,status:'Running',step:stepState(parameters.steps[0]!),stageIndex:0,startedAt:now,stepAt:now,lastAt:now,reason:null,values:{}};
}
export function abortUniversalRecipe(s:UniversalSnapshot,reason:string):UniversalSnapshot {return s.status==='Running'?{...s,status:'Aborted',reason}:s;}
export function advanceUniversalRecipe(s:UniversalSnapshot,now:number,values:Record<string,boolean|number|null>,verified:boolean):UniversalSnapshot {
 if(s.status!=='Running')return s;
 if(!Number.isFinite(now)||now<s.lastAt||now-s.lastAt>2500)return abortUniversalRecipe(s,'Recipe sampling overdue or invalid clock');
 const next={...s,lastAt:now,values:{...values}};if(s.step==='Finishing')return next;
 const step=s.parameters.steps[s.stageIndex]!;const elapsed=now-s.stepAt;let done=false;
 if(step.kind==='set')done=verified;
 else if(step.kind==='delay')done=elapsed>=step.durationSeconds*1000;
 else {
  const value=values[step.port],expected=step.value;
  if(typeof value!==typeof expected||typeof value==='number'&&!Number.isFinite(value))return abortUniversalRecipe(next,'Invalid recipe observation');
  done=step.operator==='eq'?value===expected:typeof value==='number'&&typeof expected==='number'&&(step.operator==='gt'?value>expected:step.operator==='gte'?value>=expected:step.operator==='lt'?value<expected:value<=expected);
 }
 if(!done&&step.kind!=='delay'&&elapsed>=step.timeoutSeconds*1000)return abortUniversalRecipe(next,`Step ${s.stageIndex+1} (${step.name}): ${step.kind==='set'?'command verification':'condition'} timeout`);
 if(!done)return next;
 if(s.stageIndex===s.parameters.steps.length-1)return {...next,step:'Finishing'};
 return {...next,stageIndex:s.stageIndex+1,stepAt:now,step:stepState(s.parameters.steps[s.stageIndex+1]!)};
}
