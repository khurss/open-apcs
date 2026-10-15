/** Simulation-only thermal recipe. It cannot produce real command intents. */
export interface RecipeParameters {targetC:number;holdSeconds:number;maxHeatSeconds:number;}
export interface RecipeSnapshot {
 parameters:RecipeParameters; status:'Running'|'Completed'|'Aborted'; step:'Heating'|'Holding'|'Finished';
 temperatureC:number; heater:boolean; startedAt:number; stepAt:number; lastAt:number; reason:string|null;
}
export function validateRecipe(input:unknown):RecipeParameters {
 if(!input||typeof input!=='object'||Array.isArray(input)) throw new Error('Expected recipe parameters');
 const p=input as Record<string,unknown>;
 if(Object.keys(p).sort().join(',')!=='holdSeconds,maxHeatSeconds,targetC') throw new Error('Unexpected recipe parameters');
 for(const [key,min,max] of [['targetC',21,35],['holdSeconds',1,3600],['maxHeatSeconds',1,600]] as const) {
  if(typeof p[key]!=='number'||!Number.isFinite(p[key])||p[key]<min||p[key]>max||(key!=='targetC'&&!Number.isInteger(p[key]))) throw new Error(`Invalid ${key}`);
 }
 return {targetC:p.targetC as number,holdSeconds:p.holdSeconds as number,maxHeatSeconds:p.maxHeatSeconds as number};
}
export function beginRecipe(parameters:unknown,now:number):RecipeSnapshot {
 if(!Number.isFinite(now)||now<0) throw new Error('Invalid recipe clock');
 return {parameters:validateRecipe(parameters),status:'Running',step:'Heating',temperatureC:20,heater:true,startedAt:now,stepAt:now,lastAt:now,reason:null};
}
export function abortRecipe(state:RecipeSnapshot,reason:string):RecipeSnapshot {
 return state.status==='Running'?{...state,status:'Aborted',heater:false,reason}:state;
}
export function advanceRecipe(state:RecipeSnapshot,now:number,input:{permit:boolean;quality:string}):RecipeSnapshot {
 if(state.status!=='Running') return state;
 if(!Number.isFinite(now)||now<state.lastAt) return abortRecipe(state,'Invalid simulation clock');
 if(now-state.lastAt>2500) return abortRecipe(state,'Simulation sampling overdue');
 if(input.permit!==true) return abortRecipe(state,'Simulation permit lost');
 if(input.quality!=='Good') return abortRecipe(state,'Simulation signal quality is not Good');
 const equilibrium=state.heater?40:20;
 const next={...state,parameters:{...state.parameters},lastAt:now,temperatureC:equilibrium+(state.temperatureC-equilibrium)*Math.exp(-(now-state.lastAt)/20000)};
 if(next.step==='Heating') {
  if(next.temperatureC>=next.parameters.targetC) {next.step='Holding';next.stepAt=now;}
  else if(now-next.startedAt>=next.parameters.maxHeatSeconds*1000) return abortRecipe(next,'Heating timeout');
 } else if(now-next.stepAt>=next.parameters.holdSeconds*1000) return {...next,status:'Completed',step:'Finished',heater:false};
 next.heater=next.temperatureC<next.parameters.targetC;
 return next;
}
