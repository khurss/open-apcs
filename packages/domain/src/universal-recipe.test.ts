import {expect,it} from 'vitest';
import {validateUniversalRecipe,beginUniversalRecipe,advanceUniversalRecipe} from './universal-recipe.js';
import {recipePresets} from './recipe-presets.js';
const program={schemaVersion:3,ports:[{key:'pump',label:'Pump',kind:'boolean-output'},{key:'level',label:'Level (%)',kind:'number-input'}],steps:[{kind:'set',name:'Fill',port:'pump',value:true,timeoutSeconds:2},{kind:'wait',name:'Full',port:'level',operator:'gte',value:80,timeoutSeconds:10},{kind:'delay',name:'Settle',durationSeconds:2}]};
it('validates references and types without coercion, and freezes the published program',()=>{
 const valid=validateUniversalRecipe(program);program.steps[0]!.name='Changed';expect(valid.steps[0]!.name).toBe('Fill');program.steps[0]!.name='Fill';
 for(const patch of [{steps:[{kind:'set',name:'Wrong',port:'level',value:true,timeoutSeconds:2}]},{steps:[{kind:'wait',name:'Wrong',port:'level',operator:'eq',value:true,timeoutSeconds:2}]},{steps:[{kind:'delay',name:'Wrong',durationSeconds:NaN}]},{extra:1},{ports:[program.ports[0],program.ports[0]]}])expect(()=>validateUniversalRecipe({...program,...patch})).toThrow();
});
it('advances only after verification or a typed condition and never borrows delay time',()=>{
 let s=beginUniversalRecipe(program,0);
 s=advanceUniversalRecipe(s,500,{pump:false,level:80},false);expect(s.stageIndex).toBe(0);
 s=advanceUniversalRecipe(s,1000,{pump:true,level:80},true);expect(s.stageIndex).toBe(1);
 s=advanceUniversalRecipe(s,1500,{pump:true,level:80},false);expect(s.stageIndex).toBe(2);expect(s.stepAt).toBe(1500);
 s=advanceUniversalRecipe(s,3000,{pump:true,level:80},false);expect(s.step).toBe('Delay');
 s=advanceUniversalRecipe(s,3500,{pump:true,level:80},false);expect(s.step).toBe('Finishing');expect(s.status).toBe('Running');
});
it('aborts bounded waits and invalid clocks',()=>{
 const s=beginUniversalRecipe({...program,steps:[{kind:'wait',name:'Full',port:'level',operator:'gte',value:80,timeoutSeconds:1}]},0);
 expect(advanceUniversalRecipe(s,1000,{pump:false,level:20},false)).toMatchObject({status:'Aborted',reason:'Step 1 (Full): condition timeout'});
 expect(advanceUniversalRecipe(s,3000,{pump:false,level:80},false).status).toBe('Aborted');
 expect(advanceUniversalRecipe(s,-1,{pump:false,level:80},false).status).toBe('Aborted');
});
it('ships at least twelve distinct, valid, independently editable process presets',()=>{
 expect(recipePresets.length).toBeGreaterThanOrEqual(12);expect(new Set(recipePresets.map(p=>p.id)).size).toBe(recipePresets.length);
 expect(new Set(recipePresets.map(p=>p.category)).size).toBeGreaterThanOrEqual(5);
 for(const preset of recipePresets){const copy=validateUniversalRecipe(preset.program);copy.steps[0]!.name='Edited';expect(preset.program.steps[0]!.name).not.toBe('Edited');}
});
