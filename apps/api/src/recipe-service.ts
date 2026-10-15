import type {Pool,PoolClient} from 'pg';
import {abortRecipeRun as abortRecipe,advanceRecipeRun as advanceRecipe,recipeStepDescription,type RecipeRunSnapshot as RecipeSnapshot} from '../../../packages/domain/src/recipe-program.js';
import {audit,transaction} from './store.js';
export interface RecipeEvent {at:number;message:string;}
export interface RecipeBinding {deviceId:string;temperatureSignalId:string;outputSignalId:string;projectRevision:number;}
export interface RecipeRun {binding:RecipeBinding|null;control:import('../../../packages/gateway/src/recipe-task.js').RecipeControl|null;id:string;project_id:string;recipe_id:string;revision:number;actor_id:string;snapshot:RecipeSnapshot;events:RecipeEvent[];}
export async function saveRecipeRun(client:PoolClient,run:RecipeRun,next:RecipeSnapshot,at:number,message?:string) {
 const transition=message??(next.status!==run.snapshot.status?next.reason??`Run ${next.status.toLowerCase()}`:recipeStepDescription(next)!==recipeStepDescription(run.snapshot)?('stageIndex' in next?`Step ${recipeStepDescription(next)}`:`Step: ${next.step}`):null);
 const events=transition?[...run.events,{at,message:transition}]:run.events;
 const control=run.binding&&next.status==='Aborted'?{phase:'Revoked',commandId:run.control?.commandId??null,commandState:run.control?.commandState??null,observedOutput:run.control?.observedOutput??null}:run.control;
 await client.query('UPDATE apcs_recipe_runs SET snapshot=$2,events=$3,control=$4 WHERE id=$1',[run.id,next,JSON.stringify(events),control]);
 if(transition) await audit(client,run.actor_id,'recipe.run.event',run.id,{message:transition,status:next.status});
 return {...run,snapshot:next,events,control};
}
/** Bound runs are advanced only by their gateway task; this worker detects orphaned runs. */
export async function tickRecipes(pool:Pool,now?:number) {
 await transaction(pool,async client=>{
  const runs=await client.query<RecipeRun>("SELECT * FROM apcs_recipe_runs WHERE snapshot->>'status'='Running' ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED");
  const observedAt=now??Date.now();
  for(const run of runs.rows) {
   if(!run.binding)await saveRecipeRun(client,run,advanceRecipe(run.snapshot,observedAt,{permit:true,quality:'Good'}),observedAt);
   else if(observedAt-run.snapshot.lastAt>5000)await saveRecipeRun(client,run,abortRecipe(run.snapshot,'Recipe runtime heartbeat lost; authority is not restored'),observedAt);
  }
 });
}
export async function abortRunningRecipes(pool:Pool,reason:string) {
 await transaction(pool,async client=>{
  const runs=await client.query<RecipeRun>("SELECT * FROM apcs_recipe_runs WHERE snapshot->>'status'='Running' FOR UPDATE");
  for(const run of runs.rows) await saveRecipeRun(client,run,abortRecipe(run.snapshot,reason),Date.now());
 });
}
/** One simulator per application schema. A new process aborts persisted runs instead of resuming heat. */
export async function startRecipeSimulator(pool:Pool,onError:(error:unknown)=>void) {
 const lease=await pool.connect();
 try {
  const locked=(await lease.query('SELECT pg_try_advisory_lock(9021015, hashtext(current_schema())) AS locked')).rows[0].locked;
  if(!locked) throw new Error('Recipe simulator is already running');
  await abortRunningRecipes(pool,'Simulator restarted');
 } catch(error) {lease.release(true);throw error;}
 let stopped=false; let pending:Promise<void>=Promise.resolve();
 const onLeaseError=(error:Error)=>{stopped=true;clearTimeout(timer);onError(error);};
 lease.on('error',onLeaseError);
 let timer:ReturnType<typeof setTimeout>;
 const schedule=()=>{timer=setTimeout(()=>{
  pending=tickRecipes(pool).catch(onError).then(()=>{if(!stopped)schedule();});
 },500);};
 schedule();
 const close=async()=>{
  stopped=true;clearTimeout(timer);await pending;
  try {await abortRunningRecipes(pool,'Simulator stopped');} finally {lease.off('error',onLeaseError);lease.release(true);}
 };
 return Object.assign(close,{isAvailable:()=>!stopped});
}
