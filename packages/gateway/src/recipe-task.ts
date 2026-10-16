import {abortRecipeRun,advanceRecipeRun,type RecipeRunSnapshot} from '../../domain/src/recipe-program.js';
import type {CommandSnapshot,CommandState} from '../../domain/src/commands.js';
export interface RecipeControl {
 outputs?:Record<string,{commandId:string;state:CommandState;value:boolean}>;
 phase:'Controlling'|'Awaiting verification'|'Finishing'|'Verified OFF'|'Revoked';
 commandId:string|null;commandState:CommandState|null;observedOutput:boolean|null;
}
export interface RecipeIO {
 read():Promise<{temperature:number;output:boolean;quality:string;bootId:string|null}>;
 request(value:boolean):Promise<CommandSnapshot>;
 command(id:string):Promise<CommandSnapshot>;
 save(snapshot:RecipeRunSnapshot,control:RecipeControl):Promise<boolean>;
 revoke():Promise<void>;
}
/** Runs beside the gateway. Completion requires a journaled, verified final OFF. */
export class RecipeTask {
 private ended=false;
 private pending:{id:string;value:boolean;deadline:number;completion:RecipeRunSnapshot|null}|null=null;
 private bootId:string|null=null;
 private applied:boolean|undefined;
 private control:RecipeControl={phase:'Controlling',commandId:null,commandState:null,observedOutput:null};
 private flight:Promise<void>=Promise.resolve();
 private timer:ReturnType<typeof setTimeout>|undefined;
 private watchdog:ReturnType<typeof setTimeout>|undefined;
 private started=false;
 private revocation:Promise<void>|undefined;
 constructor(private snapshot:RecipeRunSnapshot,private readonly io:RecipeIO,private readonly now=Date.now){}
 get finished(){return this.ended;}
 start(){if(this.ended||this.started)return;this.started=true;this.armWatchdog();const schedule=()=>{this.timer=setTimeout(()=>{void this.tick().catch(()=>{}).finally(()=>{if(!this.ended)schedule();});},250);};schedule();}
 private armWatchdog(){clearTimeout(this.watchdog);if(this.started&&!this.ended)this.watchdog=setTimeout(()=>{void this.stop('Recipe execution watchdog expired').catch(()=>{});},2500);}
 tick():Promise<void>{this.flight=this.flight.then(()=>this.cycle()).finally(()=>this.armWatchdog());return this.flight;}
 private revoke(){return this.revocation??=this.io.revoke();}
 async stop(reason:string):Promise<void>{
  if(this.ended){await this.flight;return;}
  this.ended=true;clearTimeout(this.timer);clearTimeout(this.watchdog);
  // Remove authority before waiting for any in-flight database or command operation.
  await this.revoke();await this.flight;
  this.snapshot=abortRecipeRun(this.snapshot,reason);this.control.phase='Revoked';
  await this.io.save(this.snapshot,this.control);
 }
 private async save(){
  if(!await this.io.save(this.snapshot,{...this.control})){this.ended=true;await this.revoke();}
 }
 private async cycle():Promise<void>{
  if(this.ended)return;
  try{
   const input=await this.io.read();if(this.ended)return;
   const now=this.now();
   if(!Number.isFinite(now)||now<this.snapshot.lastAt||now-this.snapshot.lastAt>2500)throw new Error('Recipe sampling overdue or invalid clock');
   if(input.quality!=='Good'||!input.bootId||!Number.isFinite(input.temperature))throw new Error('Recipe signal quality is not Good');
   if(this.bootId&&input.bootId!==this.bootId)throw new Error('Recipe device session changed');
   this.bootId=input.bootId;this.control.observedOutput=input.output;
   if(this.pending){
    const command=await this.io.command(this.pending.id);if(this.ended)return;
    this.control.commandState=command.state;
    if(command.state==='Verified'){
     this.applied=this.pending.value;
     if(this.pending.completion){
      this.snapshot={...this.pending.completion,lastAt:now,temperatureC:input.temperature};
      this.control.phase='Verified OFF';await this.save();this.ended=true;await this.revoke();return;
     }
     this.pending=null;
    }else{
     if(!['Accepted','Dispatched','DeviceAccepted'].includes(command.state))throw new Error(`Recipe command ${command.state.toLowerCase()}`);
     if(now>=this.pending.deadline)throw new Error('Recipe command verification timed out');
     this.snapshot={...this.snapshot,lastAt:now,temperatureC:input.temperature};await this.save();return;
    }
   }
   const next=advanceRecipeRun(this.snapshot,now,{permit:true,quality:input.quality,temperatureC:input.temperature});
   if(next.status==='Aborted')throw new Error(next.reason??'Recipe aborted');
   const completing=next.status==='Completed';
   if(completing||next.heater!==this.applied){
    const command=await this.io.request(next.heater);if(this.ended)return;
    this.control={...this.control,phase:completing?'Finishing':'Awaiting verification',commandId:command.id,commandState:command.state};
    if(!['Accepted','Dispatched','DeviceAccepted','Verified'].includes(command.state))throw new Error(`Recipe command ${command.state.toLowerCase()}`);
    this.pending={id:command.id,value:next.heater,deadline:now+2000,completion:completing?next:null};
   }else this.control.phase='Controlling';
   this.snapshot=completing?{...this.snapshot,lastAt:now,temperatureC:input.temperature,heater:false}:next;
   await this.save();
  }catch(error){
   if(this.ended)return;
   this.ended=true;clearTimeout(this.timer);clearTimeout(this.watchdog);
   this.snapshot={...this.snapshot,status:'Aborted',heater:false,reason:error instanceof Error?error.message:'Recipe execution failed'};
   this.control.phase='Revoked';
   await this.revoke().catch(()=>{});await this.io.save(this.snapshot,this.control).catch(()=>false);
  }
 }
}
