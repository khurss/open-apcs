import {expect,it} from 'vitest';
import {beginRecipeRun,advanceRecipeRun} from './recipe-program.js';
it('uses measured temperature without integrating an imaginary heater',()=>{
 let state=beginRecipeRun({targetC:22,holdSeconds:2,maxHeatSeconds:60},0);
 for(let now=500;now<=5000;now+=500)state=advanceRecipeRun(state,now,{permit:true,quality:'Good',temperatureC:20});
 expect(state.temperatureC).toBe(20);expect(state.step).toBe('Heating');
 state=advanceRecipeRun(state,5500,{permit:true,quality:'Good',temperatureC:22});
 expect(state.step).toBe('Holding');expect(state.heater).toBe(false);
});
it('uses measured temperature for ordered programs and rejects nonfinite measurements',()=>{
 const state=beginRecipeRun({schemaVersion:2,steps:[{kind:'heat',name:'Heat',targetC:22,timeoutSeconds:60}]},0);
 expect(advanceRecipeRun(state,500,{permit:true,quality:'Good',temperatureC:20}).temperatureC).toBe(20);
 expect(advanceRecipeRun(state,500,{permit:true,quality:'Good',temperatureC:23}).status).toBe('Completed');
 expect(advanceRecipeRun(state,500,{permit:true,quality:'Good',temperatureC:NaN}).status).toBe('Aborted');
});
