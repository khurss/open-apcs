import {expect,it} from 'vitest';
import {validateRecipe,beginRecipe,advanceRecipe} from './recipe.js';
const parameters={targetC:22,holdSeconds:2,maxHeatSeconds:60};
it('rejects invalid and unbounded parameters and freezes the start snapshot',()=>{
 for(const p of [{...parameters,targetC:40},{...parameters,holdSeconds:0},{...parameters,maxHeatSeconds:Infinity},{...parameters,extra:1}]) expect(()=>validateRecipe(p)).toThrow();
 const input={...parameters}; const run=beginRecipe(input,0); input.targetC=35; expect(run.parameters.targetC).toBe(22);
});
it('heats, holds and completes with the heater off without catching up missed cycles',()=>{
 let state=beginRecipe(parameters,0);
 for(let now=500;now<=10000&&state.status==='Running';now+=500) state=advanceRecipe(state,now,{permit:true,quality:'Good'});
 expect(state.status).toBe('Completed'); expect(state.heater).toBe(false); expect(state.step).toBe('Finished');
});
it('latches safety aborts, rejects stale scheduling and respects heat timeout',()=>{
 const initial=beginRecipe(parameters,0);
 for(const inputs of [{permit:false,quality:'Good'},{permit:true,quality:'Bad'}]) {
 const aborted=advanceRecipe(initial,500,inputs); expect(aborted.status).toBe('Aborted'); expect(aborted.heater).toBe(false);
 expect(advanceRecipe(aborted,1000,{permit:true,quality:'Good'})).toEqual(aborted);
 }
 expect(advanceRecipe(initial,3000,{permit:true,quality:'Good'}).reason).toBe('Simulation sampling overdue');
 expect(advanceRecipe(initial,-1,{permit:true,quality:'Good'}).status).toBe('Aborted');
 let state=beginRecipe({...parameters,targetC:35,maxHeatSeconds:1},0);
 state=advanceRecipe(state,500,{permit:true,quality:'Good'});
 expect(advanceRecipe(state,1000,{permit:true,quality:'Good'}).reason).toBe('Heating timeout');
});
