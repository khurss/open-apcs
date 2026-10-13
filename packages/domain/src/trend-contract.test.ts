import {it,expect} from 'vitest';
import {validateScreen} from './screen.js';
const item={id:'trend',kind:'trend',label:'Temperature trend',signalId:'temperature',x:20,y:30,width:800,height:280,windowSeconds:300};
it('accepts a bound trend with a bounded archive window and rejects unsupported dimensions or extra settings',()=>{
  const screen={schemaVersion:1,width:1000,height:800,items:[item]};
  expect(validateScreen(screen)).toEqual(screen);
  for(const changes of [{windowSeconds:0},{windowSeconds:86401},{windowSeconds:1.5},{signalId:undefined},{width:200},{height:100},{script:'alert(1)'}]) expect(()=>validateScreen({...screen,items:[{...item,...changes}]})).toThrow();
  expect(()=>validateScreen({...screen,items:Array.from({length:9},(_,index)=>({...item,id:`trend-${index}`}))})).toThrow();
  expect(()=>validateScreen({...screen,items:[{...item,kind:'value'}]})).toThrow();
});
