import {randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {audit,transaction} from './store.js';
import {requireProjectOwner} from './ownership.js';
import {createDemoDocument} from './demo-api.js';
/** A dedicated chamber avoids stealing the output used by the existing PID demo. */
export function registerRecipeDemo(app:FastifyInstance,pool:Pool){
 app.post<{Params:{id:string}}>('/api/v1/projects/:id/recipe-demo',{schema:{params:{type:'object',properties:{id:{type:'string',format:'uuid'}},required:['id'],additionalProperties:false},body:{type:'object',properties:{},additionalProperties:false}}},async(req,reply)=>{
  const result=await transaction(pool,async client=>{
   const projectId=req.params.id,actor=req.sessionUser!.id;await requireProjectOwner(client,projectId,actor,true);
   const previous=(await client.query('SELECT manifest FROM apcs_recipe_demo_installations WHERE project_id=$1',[projectId])).rows[0];
   if(previous)return {created:false,manifest:previous.manifest};
   if(Number((await client.query('SELECT count(*) FROM apcs_recipes WHERE project_id=$1',[projectId])).rows[0].count)>=100)throw Object.assign(new Error('Recipe version limit reached'),{statusCode:409});
   const deviceId=randomUUID(),temperature=randomUUID(),output=randomUUID(),recipeId=randomUUID();
   await client.query("INSERT INTO apcs_devices(id,project_id,name,kind,site_id,protocol_device_id) VALUES($1,$2,'Recipe chamber','virtual-thermal',$3,'recipe-chamber')",[deviceId,projectId,`recipe-${deviceId}`]);
   await client.query("INSERT INTO apcs_signals(id,device_id,name,data_type,direction) VALUES($1,$2,'Recipe temperature (C)','float64','input'),($3,$2,'Recipe heater','boolean','output')",[temperature,deviceId,output]);
   const parameters={schemaVersion:2,steps:[{kind:'heat',name:'Warm chamber',targetC:22,timeoutSeconds:60},{kind:'hold',name:'Hold temperature',targetC:22,durationSeconds:5},{kind:'cool',name:'Cool chamber',targetC:21,timeoutSeconds:60}]};
   await client.query("INSERT INTO apcs_recipes(id,project_id,revision,name,parameters) VALUES($1,$2,1,'MQTT thermal demo',$3)",[recipeId,projectId,parameters]);
   const screenId=await createDemoDocument(client,projectId,actor,'screen','Recipe chamber overview',{schemaVersion:1,width:1000,height:700,items:[
    {id:'title',kind:'label',label:'RECIPE CHAMBER · VIRTUAL MQTT',x:40,y:20,width:920,height:70},
    {id:'temperature',kind:'value',label:'Recipe temperature (C)',signalId:temperature,x:40,y:110,width:440,height:90},
    {id:'heater',kind:'indicator',label:'Recipe heater',signalId:output,x:520,y:110,width:440,height:90},
    {id:'help',kind:'label',label:'In Recipes, select Recipe chamber, start its simulator, then start MQTT thermal demo.',x:40,y:230,width:920,height:90},
    {id:'trend',kind:'trend',label:'Recipe temperature history',signalId:temperature,x:40,y:370,width:920,height:280,windowSeconds:300}
   ]});
   const manifest={deviceId,recipeId,screenId,projectId};
   await client.query('INSERT INTO apcs_recipe_demo_installations(project_id,manifest) VALUES($1,$2)',[projectId,manifest]);
   await audit(client,actor,'recipe.demo.installed',projectId,manifest);return {created:true,manifest};
  });return reply.code(result.created?201:200).send(result.manifest);
 });
}
