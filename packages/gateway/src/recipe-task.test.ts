import {expect,it,vi} from 'vitest';
import {RecipeTask} from './recipe-task.js';
import {beginRecipeRun} from '../../domain/src/recipe-program.js';
import type {CommandSnapshot} from '../../domain/src/commands.js';
function fixture(){
 let now=0;let temperature=20;let quality='Good';let commandState='Accepted';
 const commands:boolean[]=[];const saves:any[]=[];
 const io={read:async()=>({temperature,output:false,quality,bootId:'boot'}),request:async(value:boolean)=>{commands.push(value);return {id:String(commands.length),state:'Accepted'} as CommandSnapshot;},command:async(id:string)=>({id,state:commandState} as CommandSnapshot),save:async(snapshot:unknown,control:unknown)=>{saves.push({snapshot,control});return true;},revoke:vi.fn(async()=>{})};
 const task=new RecipeTask(beginRecipeRun({schemaVersion:2,steps:[{kind:'heat',name:'Heat',targetC:21,timeoutSeconds:60}]},0),io,()=>now);
 return {task,io,commands,saves,time:(n:number)=>{now=n;},temp:(n:number)=>{temperature=n;},quality:(s:string)=>{quality=s;},ack:(s:string)=>{commandState=s;}};
}
it('waits for verified OFF before completing and relinquishes authority',async()=>{
 const f=fixture();await f.task.tick();expect(f.commands).toEqual([true]);
 f.time(500);f.temp(22);await f.task.tick();expect(f.saves.at(-1).snapshot.status).toBe('Running');
 f.ack('Verified');f.time(1000);await f.task.tick();expect(f.commands).toEqual([true,false]);
 expect(f.saves.at(-1).snapshot.status).toBe('Running');
 f.time(1500);await f.task.tick();expect(f.saves.at(-1).snapshot.status).toBe('Completed');expect(f.io.revoke).toHaveBeenCalledOnce();
});
it.each(['Disconnected','Stale','Bad'])('latches %s quality and revokes without claiming verified OFF',async quality=>{
 const f=fixture();await f.task.tick();f.quality(quality);f.time(500);await f.task.tick();
 expect(f.saves.at(-1).snapshot.status).toBe('Aborted');expect(f.saves.at(-1).control.phase).toBe('Revoked');
 f.quality('Good');await f.task.tick();expect(f.commands).toEqual([true]);expect(f.io.revoke).toHaveBeenCalledOnce();
});
it('aborts unverified commands at their deadline',async()=>{
 const f=fixture();await f.task.tick();for(const t of [500,1000,1500,2000]){f.time(t);await f.task.tick();}
 expect(f.saves.at(-1).snapshot).toMatchObject({status:'Aborted',heater:false,reason:'Recipe command verification timed out'});
 expect(f.io.revoke).toHaveBeenCalledOnce();
});
it('revokes immediately on cancellation and never restarts',async()=>{
 const f=fixture();await f.task.tick();await f.task.stop('Cancelled by operator');await f.task.tick();
 expect(f.io.revoke).toHaveBeenCalledOnce();expect(f.commands).toEqual([true]);expect(f.saves.at(-1).snapshot.status).toBe('Aborted');
});
it('revokes when persistence fails',async()=>{
 const f=fixture();f.io.save=async()=>{throw new Error('Database unavailable');};
 await f.task.tick();expect(f.io.revoke).toHaveBeenCalledOnce();await f.task.tick();expect(f.commands).toHaveLength(1);
});
it('revokes a blocked read without waiting for the read to return',async()=>{
 vi.useFakeTimers();try{
 const f=fixture();let resolve!:()=>void;f.io.read=async()=>{await new Promise<void>(r=>resolve=r);return {temperature:20,output:false,quality:'Good',bootId:'boot'};};
 f.task.start();await vi.advanceTimersByTimeAsync(250);f.time(3000);await vi.advanceTimersByTimeAsync(3000);
 expect(f.io.revoke).toHaveBeenCalledOnce();resolve();await vi.advanceTimersByTimeAsync(1);await f.task.stop('Cleanup');expect(f.commands).toEqual([]);
 }finally{vi.useRealTimers();}
});
it('rejects a changed boot session before sending another command',async()=>{
 const f=fixture();await f.task.tick();f.io.read=async()=>({temperature:20,output:false,quality:'Good',bootId:'new-boot'});f.time(500);await f.task.tick();
 expect(f.saves.at(-1).snapshot.reason).toBe('Recipe device session changed');expect(f.commands).toEqual([true]);
});
it.each(['Rejected','Failed','Expired','Unknown'])('aborts a %s command',async state=>{
 const f=fixture();await f.task.tick();f.ack(state);f.time(500);await f.task.tick();
 expect(f.saves.at(-1).snapshot.status).toBe('Aborted');expect(f.io.revoke).toHaveBeenCalledOnce();
});
it('does not revive a run that another worker has already terminated',async()=>{
 const f=fixture();f.io.save=async()=>false;await f.task.tick();await f.task.tick();expect(f.io.revoke).toHaveBeenCalledOnce();expect(f.commands).toEqual([true]);
});
it('cancellation during a pending request revokes before the request returns',async()=>{
 const f=fixture();let release!:(value:CommandSnapshot)=>void;
 f.io.request=async()=>new Promise<CommandSnapshot>(resolve=>release=resolve);
 const cycle=f.task.tick();await Promise.resolve();await Promise.resolve();
 const stopped=f.task.stop('Cancelled');expect(f.io.revoke).toHaveBeenCalledOnce();
 release({id:'late',state:'Accepted'} as CommandSnapshot);await cycle;await stopped;
 expect(f.saves.at(-1).snapshot).toMatchObject({status:'Aborted',heater:false});
});
