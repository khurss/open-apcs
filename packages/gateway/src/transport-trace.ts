export type TransportEvent = 'send' | 'puback' | 'receive' | 'timeout' | 'disconnect';
export interface TraceEvent {sequence:number;event:TransportEvent;monotonicMs:number;at:string;hash:number;bytes:number;}
export interface TraceSnapshot {overwritten:number;events:TraceEvent[];}
/** Non-cryptographic correlation aid, never an authentication or uniqueness guarantee. */
export function frameFingerprint(payload:Uint8Array) {
  let hash=2166136261;
  for(const byte of payload) hash=Math.imul(hash^byte,16777619)>>>0;
  return {hash,bytes:payload.length};
}
/** Volatile bounded evidence survives stop, but not worker replacement or explicit rearming. */
export class TransportTrace {
  private readonly events:TraceEvent[]=[];
  private sequence=0;
  constructor(private readonly now:()=>number,private readonly wall:()=>Date) {}
  record(event:TransportEvent,payload:Uint8Array=new Uint8Array()) {
    this.events.push({sequence:++this.sequence,event,monotonicMs:this.now(),at:this.wall().toISOString(),...frameFingerprint(payload)});
    if(this.events.length>128) this.events.shift();
  }
  snapshot():TraceSnapshot {return {overwritten:Math.max(0,this.sequence-128),events:this.events.map(e=>({...e}))};}
}
