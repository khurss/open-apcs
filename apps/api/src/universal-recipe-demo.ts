import {randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {audit,transaction} from './store.js';
import {requireProjectOwner} from './ownership.js';
import {createDemoDocument} from './demo-api.js';
import {recipePresets} from '../../../packages/domain/src/recipe-presets.js';
export function registerUniversalRecipeDemo(app:FastifyInstance,pool:Pool){
 app.post<{Params:{id:string}}>('/api/v1/projects/:id/universal-recipe-demo',{schema:{params:{type:'object',properties:{id:{type:'string',format:'uuid'}},required:['id'],additionalProperties:false},body:{type:'object',properties:{},additionalProperties:false}}},async(req,reply)=>{
  const result=await transaction(pool,async client=>{
   const projectId=req.params.id,actor=req.sessionUser!.id;await requireProjectOwner(client,projectId,actor,true);
   const previous=(await client.query('SELECT manifest FROM apcs_universal_recipe_demo_installations WHERE project_id=$1',[projectId])).rows[0];
   if(previous)return {created:false,manifest:previous.manifest};
   if(Number((await client.query('SELECT count(*) FROM apcs_recipes WHERE project_id=$1',[projectId])).rows[0].count)>=100)throw Object.assign(new Error('Recipe version limit reached'),{statusCode:409});
   const deviceIds:string[]=[],bindings:Record<string,string>={};const recipeId=randomUUID();
   for(const key of ['primary','secondary']){
    const device=randomUUID(),signal=randomUUID();deviceIds.push(device);bindings[key]=signal;
    const name=key==='primary'?'Sequence primary':'Sequence secondary';
    await client.query("INSERT INTO apcs_devices(id,project_id,name,kind,site_id,protocol_device_id) VALUES($1,$2,$3,'virtual-led',$4,$5)",[device,projectId,name,`sequence-${device}`,key]);
    await client.query("INSERT INTO apcs_signals(id,device_id,name,data_type,direction) VALUES($1,$2,$3,'boolean','output')",[signal,device,`${name} output`]);
   }
   await client.query("INSERT INTO apcs_recipes(id,project_id,revision,name,parameters) VALUES($1,$2,1,'Universal startup demo',$3)",[recipeId,projectId,recipePresets.find(p=>p.id==='sequential-start')!.program]);
   const screenId=await createDemoDocument(client,projectId,actor,'screen','Universal sequence overview',{schemaVersion:1,width:1000,height:700,items:[
    {id:'title',kind:'label',label:'UNIVERSAL SEQUENCE · VIRTUAL MQTT',x:40,y:20,width:920,height:70},
    {id:'primary',kind:'indicator',label:'Primary equipment',signalId:bindings.primary!,x:40,y:130,width:440,height:100},
    {id:'secondary',kind:'indicator',label:'Secondary equipment',signalId:bindings.secondary!,x:520,y:130,width:440,height:100},
    {id:'help',kind:'label',label:'Recipes: install universal demo, start both simulators, then start the published recipe.',x:40,y:280,width:920,height:100},
    {id:'sequence',kind:'label',label:'Primary ON → verify → delay → Secondary ON → verify → delay → verify both OFF.',x:40,y:430,width:920,height:100}
   ]});
   const manifest={deviceIds,bindings,recipeId,screenId,projectId};
   await client.query('INSERT INTO apcs_universal_recipe_demo_installations(project_id,manifest) VALUES($1,$2)',[projectId,manifest]);
   await audit(client,actor,'recipe.universal-demo.installed',projectId,manifest);return {created:true,manifest};
  });return reply.code(result.created?201:200).send(result.manifest);
 });
}
