import {expect,it} from 'vitest';
import {beginRecipeRun,advanceRecipeRun,validateRecipeDefinition,type RecipeProgram} from './recipe-program.js';
const program:RecipeProgram={schemaVersion:2,steps:[{kind:'heat',name:'Warm',targetC:21,timeoutSeconds:60},{kind:'hold',name:'Soak',targetC:21,durationSeconds:1},{kind:'cool',name:'Cool',targetC:20.9,timeoutSeconds:60}]};
const good={permit:true,quality:'Good'};
it('freezes ordered steps and executes heating, holding and cooling to completion',()=>{
 const input=structuredClone(program);let run=beginRecipeRun(input,0);input.steps[0]!.name='Changed';
 expect(run.parameters).toEqual(program);
 const seen=new Set([run.step]);
 for(let now=500;now<20000&&run.status==='Running';now+=500){run=advanceRecipeRun(run,now,good);seen.add(run.step);if(run.step==='Cooling')expect(run.heater).toBe(false);}
 expect([...seen]).toEqual(['Heating','Holding','Cooling','Finished']);expect(run.status).toBe('Completed');expect(run.heater).toBe(false);
});
it('observes only one transition per tick and retains consecutive step identities',()=>{
 let run=beginRecipeRun({schemaVersion:2,steps:[{kind:'cool',name:'First',targetC:21,timeoutSeconds:1},{kind:'cool',name:'Second',targetC:21,timeoutSeconds:1}]},0);
 run=advanceRecipeRun(run,500,good);expect(run).toMatchObject({stageIndex:1,stepAt:500,status:'Running',step:'Cooling'});
 expect(advanceRecipeRun(run,1000,good)).toMatchObject({status:'Completed',heater:false});
});
it('latches faults and times out unreachable steps',()=>{
 const first=beginRecipeRun({schemaVersion:2,steps:[{kind:'heat',name:'Too fast',targetC:35,timeoutSeconds:1}]},0);
 const one=advanceRecipeRun(first,500,good);const fault=advanceRecipeRun(one,1000,good);
 expect(fault).toMatchObject({status:'Aborted',heater:false,reason:'Step 1 (Too fast): heating timeout'});
 expect(advanceRecipeRun(fault,1500,good)).toEqual(fault);
 for(const input of [{permit:false,quality:'Good'},{permit:true,quality:'Bad'}])expect(advanceRecipeRun(first,500,input)).toMatchObject({status:'Aborted',heater:false});
 expect(advanceRecipeRun(first,3000,good)).toMatchObject({status:'Aborted',heater:false});
 expect(advanceRecipeRun(first,-1,good)).toMatchObject({status:'Aborted',heater:false});
});
it('rejects malformed, excessive and unsupported programs without coercing values',()=>{
 const invalid=[{schemaVersion:3,steps:program.steps},{schemaVersion:2,steps:[]},{schemaVersion:2,steps:Array(17).fill(program.steps[0])},
 {schemaVersion:2,steps:[{kind:'cool',name:'Cold',targetC:20,timeoutSeconds:10}]},{schemaVersion:2,steps:[{kind:'heat',name:' ',targetC:22,timeoutSeconds:10}]},
 {schemaVersion:2,steps:[{kind:'hold',name:'Hold',targetC:'22',durationSeconds:2}]},{schemaVersion:2,steps:[{...program.steps[0],extra:true}]}];
 for(const value of invalid)expect(()=>validateRecipeDefinition(value)).toThrow();
});
it('continues to execute legacy snapshots without rewriting their parameters',()=>{
 let run=beginRecipeRun({targetC:21,holdSeconds:1,maxHeatSeconds:60},0);
 for(let now=500;now<10000&&run.status==='Running';now+=500)run=advanceRecipeRun(run,now,good);
 expect(run).toMatchObject({status:'Completed',parameters:{targetC:21,holdSeconds:1,maxHeatSeconds:60}});expect(run).not.toHaveProperty('stageIndex');
});
it('starts each timer on entry and aborts passive cooling that misses its deadline',()=>{
 const parameters:RecipeProgram={schemaVersion:2,steps:[{kind:'heat',name:'Warm',targetC:21,timeoutSeconds:60},{kind:'hold',name:'Hold',targetC:21,durationSeconds:1},{kind:'cool',name:'Cold',targetC:20.5,timeoutSeconds:1}]};
 let run=beginRecipeRun(parameters,0);
 run=advanceRecipeRun(run,2000,good);expect(run).toMatchObject({stageIndex:1,stepAt:2000});
 run=advanceRecipeRun(run,2500,good);expect(run).toMatchObject({stageIndex:1,status:'Running'});
 run=advanceRecipeRun(run,3000,good);expect(run).toMatchObject({stageIndex:2,stepAt:3000,heater:false});
 run=advanceRecipeRun(run,3500,good);expect(run.status).toBe('Running');
 run=advanceRecipeRun(run,4000,good);expect(run).toMatchObject({status:'Aborted',heater:false,reason:'Step 3 (Cold): cooling timeout'});
});
it('counts step-name characters consistently with JSON Schema for Unicode names',()=>{
 const step={kind:'cool',name:'😀'.repeat(64),targetC:21,timeoutSeconds:10};
 expect(()=>validateRecipeDefinition({schemaVersion:2,steps:[step]})).not.toThrow();
 expect(()=>validateRecipeDefinition({schemaVersion:2,steps:[{...step,name:'😀'.repeat(65)}]})).toThrow();
});
