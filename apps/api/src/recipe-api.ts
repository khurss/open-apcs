import {randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {beginRecipeRun as beginRecipe,abortRecipeRun as abortRecipe,validateRecipeDefinition as validateRecipe,type RecipeDefinition} from '../../../packages/domain/src/recipe-program.js';
import {requireProjectOwner} from './ownership.js';
import {audit,transaction} from './store.js';
import {saveRecipeRun,type RecipeRun} from './recipe-service.js';
class RecipeError extends Error {constructor(readonly statusCode:number,readonly code:string,message:string){super(message);}}
const uuid={type:'string',format:'uuid'};
const object=(properties:Record<string,unknown>,required=Object.keys(properties))=>({type:'object',additionalProperties:false,properties,required});
const params=object({id:uuid});
const legacyParameters=object({targetC:{type:'number',minimum:21,maximum:35},holdSeconds:{type:'integer',minimum:1,maximum:3600},maxHeatSeconds:{type:'integer',minimum:1,maximum:600}});
const stepName={type:'string',minLength:1,maxLength:64,pattern:'\\S'};
const temperature=(minimum:number)=>({type:'number',minimum,maximum:35});
const timeout={type:'integer',minimum:1,maximum:600};
const parameters={oneOf:[legacyParameters,object({schemaVersion:{type:'integer',const:2},steps:{type:'array',minItems:1,maxItems:16,items:{oneOf:[
 object({kind:{const:'heat',type:'string'},name:stepName,targetC:temperature(21),timeoutSeconds:timeout}),
 object({kind:{const:'cool',type:'string'},name:stepName,targetC:temperature(20.5),timeoutSeconds:timeout}),
 object({kind:{const:'hold',type:'string'},name:stepName,targetC:temperature(21),durationSeconds:{type:'integer',minimum:1,maximum:3600}})
]}}})]};
export function registerRecipes(app:FastifyInstance,pool:Pool,isAvailable:()=>boolean=()=>true) {
 app.get<{Params:{id:string}}>('/api/v1/projects/:id/recipes',{schema:{params}},async req=>transaction(pool,async client=>{
  await requireProjectOwner(client,req.params.id,req.sessionUser!.id);
  return {items:(await client.query('SELECT * FROM apcs_recipes WHERE project_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100',[req.params.id])).rows};
 }));
 app.post<{Params:{id:string};Body:{name:string;parameters:RecipeDefinition;recipeId?:string;expectedRevision?:number}}>('/api/v1/projects/:id/recipes',{
  schema:{params,body:object({name:{type:'string',minLength:1,maxLength:128,pattern:'\\S'},parameters,recipeId:uuid,expectedRevision:{type:'integer',minimum:1,maximum:10000}},['name','parameters'])}
 },async(req,reply)=>{
  const result=await transaction(pool,async client=>{
   await requireProjectOwner(client,req.params.id,req.sessionUser!.id,true);
   const input=req.body;
   if(Boolean(input.recipeId)!==Boolean(input.expectedRevision)) throw new RecipeError(400,'INVALID_REVISION','Recipe ID and expected revision must be supplied together');
   const id=input.recipeId??randomUUID(); let revision=1;
   if(input.recipeId) {
    const found=(await client.query('SELECT max(revision) AS revision FROM apcs_recipes WHERE id=$1 AND project_id=$2',[id,req.params.id])).rows[0];
    if(!found.revision) throw new RecipeError(404,'NOT_FOUND','Recipe not found');
    if(found.revision!==input.expectedRevision) throw new RecipeError(412,'REVISION_CONFLICT','Recipe changed; reload before publishing');
    revision=found.revision+1;
   }
   if(Number((await client.query('SELECT count(*) FROM apcs_recipes WHERE project_id=$1',[req.params.id])).rows[0].count)>=100) throw new RecipeError(409,'RECIPE_LIMIT','Simulation preview supports 100 recipe versions per project');
   const row=(await client.query('INSERT INTO apcs_recipes(id,project_id,revision,name,parameters) VALUES($1,$2,$3,$4,$5) RETURNING *',[id,req.params.id,revision,input.name,validateRecipe(input.parameters)])).rows[0];
   await audit(client,req.sessionUser!.id,'recipe.published',id,{revision,projectId:req.params.id}); return row;
  }); return reply.code(201).send(result);
 });
 app.get<{Params:{id:string}}>('/api/v1/projects/:id/recipe-runs',{schema:{params}},async req=>transaction(pool,async client=>{
  await requireProjectOwner(client,req.params.id,req.sessionUser!.id);
  return {items:(await client.query('SELECT * FROM apcs_recipe_runs WHERE project_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100',[req.params.id])).rows};
 }));
 app.post<{Params:{id:string};Body:{recipeId:string;revision:number}}>('/api/v1/projects/:id/recipe-runs',{schema:{params,body:object({recipeId:uuid,revision:{type:'integer',minimum:1,maximum:10000}})}},async(req,reply)=>{
  if(!isAvailable()) throw new RecipeError(503,'SIMULATOR_UNAVAILABLE','Recipe simulator is unavailable');
  const run=await transaction(pool,async client=>{
   await requireProjectOwner(client,req.params.id,req.sessionUser!.id,true);
   const recipe=(await client.query('SELECT parameters FROM apcs_recipes WHERE project_id=$1 AND id=$2 AND revision=$3',[req.params.id,req.body.recipeId,req.body.revision])).rows[0];
   if(!recipe) throw new RecipeError(404,'NOT_FOUND','Recipe version not found');
   if((await client.query("SELECT id FROM apcs_recipe_runs WHERE project_id=$1 AND snapshot->>'status'='Running'",[req.params.id])).rowCount) throw new RecipeError(409,'RUN_ACTIVE','Cancel or complete the active simulation first');
   if(Number((await client.query('SELECT count(*) FROM apcs_recipe_runs WHERE project_id=$1',[req.params.id])).rows[0].count)>=100) throw new RecipeError(409,'RUN_LIMIT','Simulation preview supports 100 runs per project');
   const now=Date.now(); const id=randomUUID();
   const result=(await client.query('INSERT INTO apcs_recipe_runs(id,project_id,recipe_id,revision,actor_id,snapshot,events) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[id,req.params.id,req.body.recipeId,req.body.revision,req.sessionUser!.id,beginRecipe(recipe.parameters,now),JSON.stringify([{at:now,message:'Run started'}])])).rows[0];
   await audit(client,req.sessionUser!.id,'recipe.run.started',id,{recipeId:req.body.recipeId,revision:req.body.revision,environment:'Simulation'}); return result;
  }); return reply.code(201).send(run);
 });
 app.post<{Params:{id:string;runId:string};Body:{cause?:'permit'|'quality'}}>('/api/v1/projects/:id/recipe-runs/:runId/cancel',{
  schema:{params:object({id:uuid,runId:uuid}),body:object({cause:{type:'string',enum:['permit','quality']}},[])}
 },async req=>transaction(pool,async client=>{
  await requireProjectOwner(client,req.params.id,req.sessionUser!.id);
  const run=(await client.query<RecipeRun>('SELECT * FROM apcs_recipe_runs WHERE project_id=$1 AND id=$2 FOR UPDATE',[req.params.id,req.params.runId])).rows[0];
  if(!run) throw new RecipeError(404,'NOT_FOUND','Run not found');
  const reason=req.body.cause==='permit'?'Simulation permit lost':req.body.cause==='quality'?'Simulation signal quality is not Good':'Cancelled by operator';
  return saveRecipeRun(client,run,abortRecipe(run.snapshot,reason),Date.now());
 }));
}
