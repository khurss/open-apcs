import {connectAsync,type MqttClient} from 'mqtt';
import type {SignalStore} from '../../domain/src/signals.js';
import {deviceTopic} from '../../led-protocol/src/index.js';
import type {LedConnection} from './mqtt-led.js';
import {parseInputBankFrame} from './input-bank-frame.js';
export interface InputBankConnection extends LedConnection {inputSignalIds:string[];}
export const inputBankTopic = (options:InputBankConnection) => `${deviceTopic(options.siteId,options.protocolDeviceId ?? options.deviceId,'out')}/inputs`;
/** Synthetic numeric inputs in the runtime's private MQTT namespace; never a physical driver. */
export class MqttInputBank {
  private publisher:MqttClient|null=null;
  private receiver:MqttClient|null=null;
  private timer:ReturnType<typeof setTimeout>|undefined;
  private work:Promise<void>=Promise.resolve();
  private started=false;
  private stopped=false;
  private sequence=0;
  private rejected=0;
  private initial:(()=>void)|null=null;
  private origin=0;
  constructor(private readonly options:InputBankConnection,private readonly boot:string,private readonly signals:SignalStore,private readonly fault:(reason:string)=>void) {
    if(options.inputSignalIds.length<1 || options.inputSignalIds.length>15 || new Set(options.inputSignalIds).size!==options.inputSignalIds.length) throw new Error('Expected 1–15 distinct bank inputs');
    inputBankTopic(options);
  }
  get rejectedFrames(){return this.rejected;}
  async start(){
    if(this.started || this.stopped) throw new Error('Input bank already started or stopped');
    this.started=true;
    const options={protocolVersion:5 as const,clean:true,reconnectPeriod:0,queueQoSZero:false,connectTimeout:2000,properties:{maximumPacketSize:4096}};
    try {
      this.receiver=await connectAsync(this.options.url,options);
      this.receiver.on('close',()=>this.fail('Input bank disconnected'));
      this.receiver.on('error',()=>this.fail('Input bank transport failed'));
      this.receiver.on('message',(topic,payload,packet)=>{
        if(this.stopped || topic!==inputBankTopic(this.options)) return;
        try {
          if(packet.retain || packet.qos!==1) throw new Error('Invalid bank delivery');
          const frame=parseInputBankFrame(payload,this.boot,this.options.inputSignalIds.length);
          let accepted=true;
          for(const [index,id] of this.options.inputSignalIds.entries()) {
            if(this.signals.ingest({signalId:id,bootId:this.boot,sequence:frame.sequence,value:frame.values[index]!,quality:'Good',sourceTime:null})!=='accepted') accepted=false;
          }
          if(accepted){this.initial?.();this.initial=null;} else this.rejected++;
        } catch {this.rejected++;}
      });
      await this.receiver.subscribeAsync(inputBankTopic(this.options),{qos:1,rap:true});
      this.publisher=await connectAsync(this.options.url,options);
      this.publisher.on('close',()=>this.fail('Input bank disconnected'));
      this.publisher.on('error',()=>this.fail('Input bank transport failed'));
      if(this.stopped) throw new Error('Input bank stopped during startup');
      this.origin=performance.now();
      let timeout:ReturnType<typeof setTimeout>|undefined;
      const first=new Promise<void>((resolve,reject)=>{this.initial=resolve;timeout=setTimeout(()=>reject(new Error('Input bank initial samples unavailable')),1500);});
      try{await Promise.all([first,this.send()]);}finally{clearTimeout(timeout);this.initial=null;}
      if(this.stopped) throw new Error('Input bank stopped during startup');
      this.schedule();
    } catch(error){await this.stop();throw error;}
  }
  async stop(){
    this.stopped=true;clearTimeout(this.timer);this.signals.disconnect(this.options.deviceId);
    await Promise.allSettled([this.publisher?.endAsync(true),this.receiver?.endAsync(true)]);
    await this.work;
  }
  private fail(reason:string){
    if(this.stopped)return;
    this.stopped=true;clearTimeout(this.timer);this.signals.disconnect(this.options.deviceId);
    void this.publisher?.endAsync(true).catch(()=>{});void this.receiver?.endAsync(true).catch(()=>{});
    this.fault(reason);
  }
  private schedule(){
    if(this.stopped)return;
    const now=performance.now();const next=this.origin+(Math.floor((now-this.origin)/1000)+1)*1000;
    this.timer=setTimeout(()=>{this.work=this.tick();},Math.ceil(next-now));
  }
  private async tick(){try{await this.send();this.schedule();}catch{this.fail('Input bank publication failed');}}
  private async send(){
    if(this.stopped || !this.publisher?.connected || !Number.isSafeInteger(this.sequence))throw new Error('Input bank unavailable');
    const sequence=this.sequence++;
    const values=this.options.inputSignalIds.map((_,index)=>index*100+sequence%100);
    let timeout:ReturnType<typeof setTimeout>|undefined;
    try{await Promise.race([
      this.publisher.publishAsync(inputBankTopic(this.options),JSON.stringify({v:1,bootId:this.boot,sequence,values}),{qos:1,retain:false,properties:{messageExpiryInterval:1}}),
      new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Input bank publication timeout')),1000);}),
    ]);}finally{clearTimeout(timeout);}
  }
}
