import {expect,it,vi} from 'vitest';
import {UniversalRecipeTask} from './universal-recipe-task.js';
import {beginUniversalRecipe} from '../../domain/src/universal-recipe.js';
import type {CommandSnapshot} from '../../domain/src/commands.js';
import {recipePresets} from '../../domain/src/recipe-presets.js';
function fixture(){
 let now=0,state='Accepted',quality='Good',boot='boot';const sent:{port:string;value:boolean}[]=[];const saved:any[]=[];
 const parameters=structuredClone(recipePresets.find(p=>p.id==='sequential-start')!.program);parameters.steps=[{kind:'set',name:'Run primary',port:'primary',value:true,timeoutSeconds:2}];
 const io={read:async()=>Object.fromEntries(parameters.ports.map(p=>[p.key,{value:false,quality,bootId:boot}])),request:async(port:string,value:boolean)=>{sent.push({port,value});return {id:String(sent.length),state:'Accepted'} as CommandSnapshot;},command:async(id:string)=>({id,state} as CommandSnapshot),save:async(s:unknown,c:unknown)=>{saved.push({snapshot:structuredClone(s),control:structuredClone(c)});return true;},revoke:vi.fn(async()=>{})};
 const task=new UniversalRecipeTask(beginUniversalRecipe(parameters,0),io,()=>now);
 return {task,io,sent,saved,time:(n:number)=>now=n,ack:(s:string)=>state=s,quality:(s:string)=>quality=s,boot:(s:string)=>boot=s};
}
it('waits for set verification, then verifies every output OFF before completion',async()=>{
 const f=fixture();await f.task.tick();expect(f.sent).toEqual([{port:'primary',value:true}]);
 f.time(250);await f.task.tick();expect(f.sent).toHaveLength(1);
 f.ack('Verified');f.time(500);await f.task.tick();
 for(const t of [750,1000,1250,1500,1750]){f.time(t);await f.task.tick();}
 expect(f.sent).toEqual([{port:'primary',value:true},{port:'primary',value:false},{port:'secondary',value:false}]);
 expect(f.saved.at(-1).snapshot.status).toBe('Completed');expect(f.saved.at(-1).control.phase).toBe('Verified OFF');expect(f.io.revoke).toHaveBeenCalledOnce();
});
it.each(['Bad','Stale','Disconnected'])('revokes the entire group on %s quality',async quality=>{
 const f=fixture();await f.task.tick();f.quality(quality);f.time(250);await f.task.tick();expect(f.saved.at(-1).snapshot.status).toBe('Aborted');expect(f.io.revoke).toHaveBeenCalledOnce();await f.task.tick();expect(f.sent).toHaveLength(1);
});
it('rejects changed boots and uncertain commands',async()=>{
 const f=fixture();await f.task.tick();f.boot('reboot');f.time(250);await f.task.tick();expect(f.saved.at(-1).snapshot.reason).toContain('session changed');
 const g=fixture();await g.task.tick();g.ack('Unknown');g.time(250);await g.task.tick();expect(g.saved.at(-1).snapshot.status).toBe('Aborted');
});
it('times out an unverified command and never advances its step',async()=>{
 const f=fixture();await f.task.tick();for(const t of [500,1000,1500,2000]){f.time(t);await f.task.tick();}
 expect(f.saved.at(-1).snapshot).toMatchObject({status:'Aborted',stageIndex:0});expect(f.sent).toHaveLength(1);
});
it('revokes before waiting for a pending request during cancellation',async()=>{
 const f=fixture();let release!:(c:CommandSnapshot)=>void;f.io.request=async()=>new Promise(r=>release=r);
 const tick=f.task.tick();await Promise.resolve();await Promise.resolve();const stop=f.task.stop('Cancelled');expect(f.io.revoke).toHaveBeenCalledOnce();release({id:'late',state:'Accepted'} as CommandSnapshot);await tick;await stop;expect(f.saved.at(-1).snapshot.status).toBe('Aborted');
});
it('watchdog revokes a blocked I/O operation independently',async()=>{
 vi.useFakeTimers();try{const f=fixture();let release!:()=>void;f.io.read=async()=>{await new Promise<void>(r=>release=r);return {};};f.task.start();await vi.advanceTimersByTimeAsync(250);await vi.advanceTimersByTimeAsync(3000);expect(f.io.revoke).toHaveBeenCalledOnce();release();await vi.advanceTimersByTimeAsync(1);await f.task.stop('Cleanup');}finally{vi.useRealTimers();}
});
it('revokes on persistence failure without a second command',async()=>{
 const f=fixture();f.io.save=async()=>{throw new Error('DB failed');};await f.task.tick();await f.task.tick();expect(f.sent).toHaveLength(1);expect(f.io.revoke).toHaveBeenCalledOnce();
});
