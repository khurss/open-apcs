import {expect,it} from 'vitest';
import {summarizeDeviceTrace} from './transport-evidence.js';
const event=(seq:number,event:string,atUs:number,hash=1,messageId=0)=>({seq,event,atUs,hash,bytes:10,messageId,dropped:0});
it('separates ingress scheduling, enqueue blocking and broker acknowledgement on the device clock',()=>{
  const result=summarizeDeviceTrace([event(1,'rx',1000),event(2,'process',6000),event(3,'tx-enter',7000,2),event(4,'tx-exit',407000,2,17),event(5,'ack',427000,0,17)]);
  expect(result).toMatchObject({complete:true,ingressMs:{max:5},enqueueMs:{max:400},ackMs:{max:420}});
});
it('reports missing or dropped evidence instead of claiming complete stage timing',()=>{
  expect(summarizeDeviceTrace([event(1,'rx',1000),event(3,'process',6000)])).toMatchObject({complete:false,gaps:1});
  expect(summarizeDeviceTrace([{...event(1,'rx',1000),dropped:2}])).toMatchObject({complete:false,dropped:2,unmatched:1});
  expect(()=>summarizeDeviceTrace([event(1,'rx',5000),event(2,'process',-1000)])).toThrow(/clock/);
});
it('handles concurrent producers and a broker ACK delivered before enqueue returns',()=>{
  const result=summarizeDeviceTrace([event(1,'tx-enter',1000,2),event(3,'ack',11000,0,17),event(2,'tx-exit',401000,2,17)]);
  expect(result).toMatchObject({complete:true,enqueueMs:{max:400},ackMs:{max:10}});
});
