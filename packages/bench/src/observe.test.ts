import {expect,it} from 'vitest';
import {observeUntil} from './observe.js';
it('takes another read when an old receipt arrives late without reissuing the command',async()=>{
  let now=0, reads=0;
  await observeUntil(async()=>{reads++; if(reads===1){now=950;return false;} return true;},()=>now,async ms=>{now+=ms;});
  expect(reads).toBe(2);
  expect(now).toBe(1050);
});
it('fails missing observations and preserves terminal command errors',async()=>{
  let now=0;
  await expect(observeUntil(async()=>false,()=>now,async ms=>{now+=ms;})).rejects.toThrow(/deadline/);
  expect(now).toBe(2000);
  await expect(observeUntil(async()=>{throw new Error('Command expired');},()=>0,async()=>{})).rejects.toThrow('Command expired');
});
