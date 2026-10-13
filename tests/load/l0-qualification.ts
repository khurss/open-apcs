import {canonicalJson} from '../../packages/domain/src/screen.js';
import {writeFileSync} from 'node:fs';
import {qualifyAlarms, qualifyTiming, qualifyUi} from '../../packages/bench/src/qualification.js';
import type {SignalSnapshot} from '../../packages/domain/src/signals.js';

type Api = (path:string, data?:unknown, headers?:Record<string,string>) => Promise<any>;
/** Supplemental workload only reads the physical output; it never claims control ownership. */
export class L0Qualification {
  graphId: string | null = null;
  private alarmId = '';
  constructor(private get:Api, private post:Api, private put:Api, private notify:(message:unknown)=>Promise<void>, private directory:string) {}
  async setup(projectId:string, signalId:string) {
    const name='L0 timing observer';
    const document={schemaVersion:1,nodes:[{id:'input',kind:'input',label:'Physical LED feedback',x:0,y:0,signalId}, ...Array.from({length:99},(_,i)=>({id:`not-${i}`,kind:'not',label:`Not ${i+1}`,x:(i+1)*50,y:0}))],edges:Array.from({length:99},(_,i)=>({id:`wire-${i}`,source:i===0?'input':`not-${i-1}`,target:`not-${i}`,port:'in'}))};
    const graph=await this.post(`/api/v1/projects/${projectId}/graphs`,{name});
    this.graphId=graph.id;
    await this.notify({graphId:graph.id});
    writeFileSync(`${this.directory}/qualification-targets.json`,JSON.stringify({graphId:graph.id,projectId,signalId}));
    const saved=await this.put(`/api/v1/graphs/${graph.id}`,{name,document},{'if-match':`"${graph.revision}"`});
    await this.post(`/api/v1/graphs/${graph.id}/revisions`,undefined,{'if-match':`"${saved.revision}"`});
    const existing=await this.get(`/api/v1/projects/${projectId}/alarms`);
    const alarmName='L0 LED transition evidence';
    let alarm=existing.items.find((a:any)=>a.name===alarmName);
    const definition={condition:{kind:'boolean',value:true},activationDelayMs:0,returnDelayMs:0};
    if (alarm && (alarm.signalId!==signalId || canonicalJson(alarm.definition)!==canonicalJson(definition) || alarm.state.suppressedUntil)) throw new Error('Existing L0 alarm does not match the reviewed fixture');
    if (!alarm) alarm=await this.post(`/api/v1/projects/${projectId}/alarms`,{name:alarmName,signalId,priority:'low',definition});
    this.alarmId=alarm.id;
    writeFileSync(`${this.directory}/qualification-targets.json`,JSON.stringify({graphId:graph.id,alarmId:alarm.id,projectId,signalId}));
    await this.post(`/api/v1/graphs/${graph.id}/runtime`,{action:'activate',revision:saved.revision,reason:'L0 read-only 100-block timing workload'});
  }
  async verify(input:{from:string;to:string;seconds:number;history:SignalSnapshot[];ui:{at:number;value:string;quality:string}[];deviceIds:string[]}) {
    const {from,to,seconds,history,ui,deviceIds}=input;
    const changes:{value:boolean;receivedTime:string}[]=[]; let prior=false;
    for (const s of history) if (s.value!==prior) {
      if (typeof s.value!=='boolean' || !s.receivedTime) throw new Error('Missing physical telemetry timing');
      changes.push({value:s.value,receivedTime:s.receivedTime}); prior=s.value;
    }
    const evidence:any={};
    // Preserve raw evidence before any acceptance assertion can fail.
    writeFileSync(`${this.directory}/physical-changes.json`,JSON.stringify(changes));
    let before:string|null=null; const events:any[]=[];
    do {
      const page=await this.get(`/api/v1/alarms/${this.alarmId}/events${before?`?before=${before}`:''}`);
      events.push(...page.items.filter((e:any)=>e.at>=from && e.at<=to));
      before=page.items.some((e:any)=>e.at<from)?null:page.nextBefore;
    } while(before);
    events.reverse(); writeFileSync(`${this.directory}/alarm-events.json`,JSON.stringify(events));
    const graph=await this.get(`/api/v1/graphs/${this.graphId}/runtime`);
    const gateways=[];
    for (const id of deviceIds) { const status=await this.get(`/api/v1/devices/${id}/runtime`); if(status.state!=='running' || !status.telemetry) throw new Error('Gateway stopped or timing absent'); gateways.push(status.telemetry); }
    writeFileSync(`${this.directory}/timing.json`,JSON.stringify({graph,gateways},null,2));
    if(graph.state!=='running' || !graph.timing) throw new Error('Graph faulted or timing absent');
    evidence.timing=qualifyTiming(gateways,graph.timing,seconds+60);
    evidence.ui=qualifyUi(changes,ui);
    evidence.alarmTransitions=qualifyAlarms(events.map(e=>({...e,occurrence:Number(e.occurrence)})),seconds);
    writeFileSync(`${this.directory}/qualification.json`,JSON.stringify(evidence,null,2));
    return evidence;
  }
  async stop() { if(this.graphId) await this.post(`/api/v1/graphs/${this.graphId}/runtime`,{action:'stop',reason:'End L0 read-only timing workload'}); }
}
