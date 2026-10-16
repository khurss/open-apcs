import {registerUniversalRecipeDemo} from './universal-recipe-demo.js';
import {isUniversalRecipe} from '../../../packages/domain/src/universal-recipe.js';
import {resolveUniversalBinding} from './recipe-bindings.js';
import {registerRecipeDemo} from './recipe-demo.js';
import {randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {beginRecipeRun as beginRecipe,abortRecipeRun as abortRecipe,validateRecipeDefinition as validateRecipe,type RecipeDefinition} from '../../../packages/domain/src/recipe-model.js';
import {requireProjectOwner} from './ownership.js';
import {audit,transaction} from './store.js';
import type {RuntimeControl} from './runtime-service.js';
import {saveRecipeRun,type RecipeBinding,type RecipeRun} from './recipe-service.js';
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
]}}}),object({schemaVersion:{const:3,type:'integer'},ports:{type:'array',minItems:1,maxItems:16,items:{type:'object'}},steps:{type:'array',minItems:1,maxItems:64,items:{type:'object'}}})]};
export function registerRecipes(app:FastifyInstance,pool:Pool,isAvailable:()=>boolean=()=>true,runtime?:RuntimeControl) {
 registerRecipeDemo(app,pool);registerUniversalRecipeDemo(app,pool);
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
   let definition:RecipeDefinition;try{definition=validateRecipe(input.parameters);}catch(error){throw new RecipeError(400,'INVALID_RECIPE',error instanceof Error?error.message:'Invalid recipe');}
   const row=(await client.query('INSERT INTO apcs_recipes(id,project_id,revision,name,parameters) VALUES($1,$2,$3,$4,$5) RETURNING *',[id,req.params.id,revision,input.name,definition])).rows[0];
   await audit(client,req.sessionUser!.id,'recipe.published',id,{revision,projectId:req.params.id}); return row;
  }); return reply.code(201).send(result);
 });
 app.get<{Params:{id:string}}>('/api/v1/projects/:id/recipe-runs',{schema:{params}},async req=>transaction(pool,async client=>{
  await requireProjectOwner(client,req.params.id,req.sessionUser!.id);
  return {items:(await client.query('SELECT * FROM apcs_recipe_runs WHERE project_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100',[req.params.id])).rows};
 }));
 app.post<{Params:{id:string};Body:{recipeId:string;revision:number;deviceId?:string;bindings?:Record<string,string>}}>('/api/v1/projects/:id/recipe-runs',{schema:{params,body:object({recipeId:uuid,revision:{type:'integer',minimum:1,maximum:10000},deviceId:uuid,bindings:{type:'object',maxProperties:16,additionalProperties:uuid}},['recipeId','revision'])}},async(req,reply)=>{
  if(!isAvailable()) throw new RecipeError(503,'SIMULATOR_UNAVAILABLE','Recipe simulator is unavailable');
  const run=await transaction(pool,async client=>{
   await requireProjectOwner(client,req.params.id,req.sessionUser!.id,true);
   const recipe=(await client.query('SELECT parameters FROM apcs_recipes WHERE project_id=$1 AND id=$2 AND revision=$3',[req.params.id,req.body.recipeId,req.body.revision])).rows[0];
   if(!recipe) throw new RecipeError(404,'NOT_FOUND','Recipe version not found');
   if((await client.query("SELECT id FROM apcs_recipe_runs WHERE project_id=$1 AND snapshot->>'status'='Running'",[req.params.id])).rowCount) throw new RecipeError(409,'RUN_ACTIVE','Cancel or complete the active simulation first');
   if(Number((await client.query('SELECT count(*) FROM apcs_recipe_runs WHERE project_id=$1',[req.params.id])).rows[0].count)>=100) throw new RecipeError(409,'RUN_LIMIT','Simulation preview supports 100 runs per project');
   let binding:RecipeBinding|null=null;
   if(isUniversalRecipe(recipe.parameters)){
    if(req.body.deviceId)throw new RecipeError(400,'INVALID_BINDING','Universal recipes use port bindings, not a thermal device ID');
    if(!runtime?.activateRecipe)throw new RecipeError(503,'RUNTIME_UNAVAILABLE','Recipe runtime unavailable');
    binding=await resolveUniversalBinding(client,req.params.id,recipe.parameters,req.body.bindings);
   }else if(req.body.bindings)throw new RecipeError(400,'INVALID_BINDING','Thermal recipes do not accept port bindings');
   else if(req.body.deviceId){
    if(!runtime?.activateRecipe)throw new RecipeError(503,'RUNTIME_UNAVAILABLE','Recipe runtime unavailable');
    const device=(await client.query('SELECT d.kind,p.revision FROM apcs_devices d JOIN apcs_projects p ON p.id=d.project_id WHERE d.id=$1 AND d.project_id=$2',[req.body.deviceId,req.params.id])).rows[0];
    if(!device)throw new RecipeError(404,'NOT_FOUND','Recipe device not found in this project');
    if(device.kind!=='virtual-thermal')throw new RecipeError(422,'UNSUPPORTED_BINDING','Recipes support virtual thermal devices only');
    const signals=(await client.query<{id:string;direction:string;data_type:string}>('SELECT id,direction,data_type FROM apcs_signals WHERE device_id=$1',[req.body.deviceId])).rows;
    const input=signals.filter(s=>s.direction==='input'&&s.data_type==='float64'),output=signals.filter(s=>s.direction==='output'&&s.data_type==='boolean');
    if(input.length!==1||output.length!==1)throw new RecipeError(422,'INVALID_BINDING','Recipe requires one temperature input and one heater output');
    binding={deviceId:req.body.deviceId,temperatureSignalId:input[0]!.id,outputSignalId:output[0]!.id,projectRevision:device.revision};
   }
   const now=Date.now(); const id=randomUUID();
   const result=(await client.query('INSERT INTO apcs_recipe_runs(id,project_id,recipe_id,revision,actor_id,snapshot,events,binding) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',[id,req.params.id,req.body.recipeId,req.body.revision,req.sessionUser!.id,beginRecipe(recipe.parameters,now),JSON.stringify([{at:now,message:'Run started'}]),binding])).rows[0];
   await audit(client,req.sessionUser!.id,'recipe.run.started',id,{recipeId:req.body.recipeId,revision:req.body.revision,environment:binding?'Virtual MQTT':'Isolated simulation'}); return result;
  });
  if(run.binding){
   try{await runtime!.activateRecipe!(run.id,req.sessionUser!.id);}
   catch(error){
    await runtime!.stopRecipe?.(run.id,'Recipe activation failed').catch(()=>{});
    await transaction(pool,async client=>{
     const current=(await client.query<RecipeRun>('SELECT * FROM apcs_recipe_runs WHERE id=$1 FOR UPDATE',[run.id])).rows[0]!;
     await saveRecipeRun(client,current,abortRecipe(current.snapshot,'Recipe activation failed'),Date.now());
    });
    const message=error instanceof Error&&/^(Recipe |Output belongs)/.test(error.message)?error.message:'Recipe runtime unavailable';
    return reply.code(409).send({code:'RECIPE_ACTIVATION_FAILED',message,correlationId:req.id});
   }
  }
  return reply.code(201).send(run);
 });
 app.post<{Params:{id:string;runId:string};Body:{cause?:'permit'|'quality'}}>('/api/v1/projects/:id/recipe-runs/:runId/cancel',{
  schema:{params:object({id:uuid,runId:uuid}),body:object({cause:{type:'string',enum:['permit','quality']}},[])}
 },async req=>{
  await transaction(pool,async client=>{await requireProjectOwner(client,req.params.id,req.sessionUser!.id);});
  const owned=(await pool.query<RecipeRun>('SELECT * FROM apcs_recipe_runs WHERE project_id=$1 AND id=$2',[req.params.id,req.params.runId])).rows[0];
  if(!owned)throw new RecipeError(404,'NOT_FOUND','Run not found');
  const reason=req.body.cause==='permit'?'Simulation permit lost':req.body.cause==='quality'?'Simulation signal quality is not Good':'Cancelled by operator';
  if(owned.binding)await runtime?.stopRecipe?.(owned.id,reason);
  return transaction(pool,async client=>{
  const run=(await client.query<RecipeRun>('SELECT * FROM apcs_recipe_runs WHERE project_id=$1 AND id=$2 FOR UPDATE',[req.params.id,req.params.runId])).rows[0];
  if(!run) throw new RecipeError(404,'NOT_FOUND','Run not found');
  return saveRecipeRun(client,run,abortRecipe(run.snapshot,reason),Date.now());
 });});
}
