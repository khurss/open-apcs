import {percentiles} from './load-evidence.js';
export interface DeviceTrace {seq:number;atUs:number;event:string;hash:number;bytes:number;messageId:number;dropped:number;}
/** Pair stages only on the same monotonic device clock; fingerprints are correlation aids. */
export function summarizeDeviceTrace(input:DeviceTrace[]) {
  const events=[...input].sort((a,b)=>a.seq-b.seq);
  const rx=new Map<string,number[]>(),tx=new Map<string,number[]>(),acks=new Map<number,number>(),earlyAcks=new Map<number,number>();
  const ingress:number[]=[],enqueue:number[]=[],ack:number[]=[];
  let gaps=0,dropped=0,unmatched=0,previous=0;
  const take=(map:Map<string,number[]>,key:string)=>{const values=map.get(key);const value=values?.shift();if(!values?.length)map.delete(key);return value;};
  const push=(map:Map<string,number[]>,key:string,time:number)=>{const values=map.get(key)??[];values.push(time);map.set(key,values);};
  const measure=(start:number|undefined,end:number,values:number[])=>{if(start===undefined){unmatched++;return;}if(end<start)throw new Error('Invalid device clock evidence');values.push((end-start)/1000);};
  for(const e of events) {
    if(!Number.isSafeInteger(e.seq)||e.seq<=previous||!Number.isSafeInteger(e.atUs)||e.atUs<0||!Number.isSafeInteger(e.dropped)||e.dropped<0)throw new Error('Invalid trace sequence or clock');
    if(previous)gaps+=e.seq-previous-1;previous=e.seq;dropped=Math.max(dropped,e.dropped);
    const key=`${e.hash}:${e.bytes}`;
    if(e.event==='rx')push(rx,key,e.atUs);
    else if(e.event==='process')measure(take(rx,key),e.atUs,ingress);
    else if(e.event==='tx-enter')push(tx,key,e.atUs);
    else if(e.event==='tx-exit') {
      const start=take(tx,key);measure(start,e.atUs,enqueue);
      if(e.messageId>0&&start!==undefined) {
        if(earlyAcks.has(e.messageId)){measure(start,earlyAcks.get(e.messageId)!,ack);earlyAcks.delete(e.messageId);}
        else {if(acks.has(e.messageId))unmatched++;acks.set(e.messageId,start);}
      }else unmatched++;
    }
    else if(e.event==='ack'){if(acks.has(e.messageId)){measure(acks.get(e.messageId),e.atUs,ack);acks.delete(e.messageId);}else{if(earlyAcks.has(e.messageId))unmatched++;earlyAcks.set(e.messageId,e.atUs);}}
    else if(e.event!=='disconnect')throw new Error('Unknown device trace event');
  }
  unmatched+=[...rx.values(),...tx.values()].reduce((n,v)=>n+v.length,0)+acks.size+earlyAcks.size;
  return {complete:events.length>0&&gaps===0&&dropped===0&&unmatched===0,events:events.length,gaps,dropped,unmatched,ingressMs:ingress.length?percentiles(ingress):null,enqueueMs:enqueue.length?percentiles(enqueue):null,ackMs:ack.length?percentiles(ack):null};
}
