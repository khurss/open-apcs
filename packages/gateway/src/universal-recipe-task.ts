import {abortUniversalRecipe,advanceUniversalRecipe,type UniversalSnapshot} from '../../domain/src/universal-recipe.js';
import type {CommandSnapshot} from '../../domain/src/commands.js';
import type {RecipeControl} from './recipe-task.js';
export interface UniversalRecipeIO {
 read():Promise<Record<string,{value:unknown;quality:string;bootId:string|null}>>;
 request(port:string,value:boolean,ttlMs:number):Promise<CommandSnapshot>;
 command(id:string):Promise<CommandSnapshot>;
 save(snapshot:UniversalSnapshot,control:RecipeControl):Promise<boolean>;
 revoke():Promise<void>;
}
/** Sequential commands; group ownership is acquired before the first tick. */
export class UniversalRecipeTask {
 private ended=false;private started=false;private flight:Promise<void>=Promise.resolve();
 private timer:ReturnType<typeof setTimeout>|undefined;private watchdog:ReturnType<typeof setTimeout>|undefined;private revocation:Promise<void>|undefined;
 private pending:{id:string;port:string;deadline:number;final:boolean}|null=null;
 private readonly boots=new Map<string,string>();private finalIndex=0;
 private readonly outputs:string[];
 private control:RecipeControl={phase:'Controlling',commandId:null,commandState:null,observedOutput:null,outputs:{}};
 constructor(private snapshot:UniversalSnapshot,private readonly io:UniversalRecipeIO,private readonly now=Date.now){this.outputs=snapshot.parameters.ports.filter(p=>p.kind==='boolean-output').map(p=>p.key);}
 get finished(){return this.ended;}
 start(){if(this.started||this.ended)return;this.started=true;this.arm();const schedule=()=>{this.timer=setTimeout(()=>{void this.tick().catch(()=>{}).finally(()=>{if(!this.ended)schedule();});},250);};schedule();}
 private arm(){clearTimeout(this.watchdog);if(this.started&&!this.ended)this.watchdog=setTimeout(()=>{void this.stop('Recipe execution watchdog expired').catch(()=>{});},2500);}
 private revoke(){return this.revocation??=this.io.revoke();}
 tick(){this.flight=this.flight.then(()=>this.cycle()).finally(()=>this.arm());return this.flight;}
 async stop(reason:string){if(this.ended){await this.flight;return;}this.ended=true;clearTimeout(this.timer);clearTimeout(this.watchdog);await this.revoke();await this.flight;this.snapshot=abortUniversalRecipe(this.snapshot,reason);this.control.phase='Revoked';await this.io.save(this.snapshot,this.control);}
 private async save(){if(!await this.io.save(this.snapshot,structuredClone(this.control))){this.ended=true;await this.revoke();}}
 private async send(port:string,value:boolean,ttlMs:number,final:boolean,now:number){
  const command=await this.io.request(port,value,ttlMs);if(this.ended)return;
  this.control={...this.control,phase:final?'Finishing':'Awaiting verification',commandId:command.id,commandState:command.state,outputs:{...this.control.outputs,[port]:{commandId:command.id,state:command.state,value}}};
  if(!['Accepted','Dispatched','DeviceAccepted','Verified'].includes(command.state))throw new Error(`Recipe command ${command.state.toLowerCase()}`);
  this.pending={id:command.id,port,deadline:now+ttlMs,final};
 }
 private async cycle(){
  if(this.ended)return;
  try{
   const samples=await this.io.read();if(this.ended)return;const now=this.now();
   if(!Number.isFinite(now)||now<this.snapshot.lastAt||now-this.snapshot.lastAt>2500)throw new Error('Recipe sampling overdue or invalid clock');
   const values:UniversalSnapshot['values']={};
   for(const port of this.snapshot.parameters.ports){const sample=samples[port.key];
    if(!sample||sample.quality!=='Good'||!sample.bootId)throw new Error(`Recipe port ${port.label}: signal quality is not Good`);
    if(port.kind==='number-input'?typeof sample.value!=='number'||!Number.isFinite(sample.value):typeof sample.value!=='boolean')throw new Error(`Recipe port ${port.label}: invalid value type`);
    if(this.boots.has(port.key)&&this.boots.get(port.key)!==sample.bootId)throw new Error(`Recipe port ${port.label}: device session changed`);
    this.boots.set(port.key,sample.bootId);values[port.key]=sample.value as number|boolean;
   }
   let verified=false;
   if(this.pending){const command=await this.io.command(this.pending.id);if(this.ended)return;
    this.control.commandState=command.state;this.control.outputs![this.pending.port]!.state=command.state;
    if(command.state==='Verified'){if(this.pending.final)this.finalIndex++;else verified=true;this.pending=null;}
    else {
     if(!['Accepted','Dispatched','DeviceAccepted'].includes(command.state))throw new Error(`Recipe command ${command.state.toLowerCase()}`);
     if(now>=this.pending.deadline)throw new Error('Recipe command verification timed out');
     this.snapshot={...this.snapshot,values,lastAt:now};await this.save();return;
    }
   }
   this.snapshot=advanceUniversalRecipe(this.snapshot,now,values,verified);
   if(this.snapshot.status==='Aborted')throw new Error(this.snapshot.reason??'Recipe aborted');
   if(this.snapshot.step==='Finishing'){
    if(this.finalIndex===this.outputs.length){this.snapshot={...this.snapshot,status:'Completed',step:'Finished'};this.control.phase='Verified OFF';await this.save();this.ended=true;await this.revoke();return;}
    await this.send(this.outputs[this.finalIndex]!,false,2000,true,now);
   }else{
    const step=this.snapshot.parameters.steps[this.snapshot.stageIndex]!;
    if(step.kind==='set')await this.send(step.port,step.value,Math.min(2000,step.timeoutSeconds*1000-(now-this.snapshot.stepAt)),false,now);
    else this.control.phase='Controlling';
   }
   if(!this.ended)await this.save();
  }catch(error){
   if(this.ended)return;this.ended=true;clearTimeout(this.timer);clearTimeout(this.watchdog);
   this.snapshot={...this.snapshot,status:'Aborted',reason:error instanceof Error?error.message:'Recipe execution failed'};this.control.phase='Revoked';
   await this.revoke().catch(()=>{});await this.io.save(this.snapshot,this.control).catch(()=>false);
  }
 }
}
