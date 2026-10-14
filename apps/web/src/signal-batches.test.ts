import {expect,it,vi} from 'vitest';
import {readSignalBatches} from './signal-batches.js';
it('reads up to three bounded batches concurrently and returns one complete snapshot',async()=>{
  let active=0,peak=0;const sizes:number[]=[];
  const result=await readSignalBatches(Array.from({length:401},(_,i)=>String(i)),async ids=>{
    sizes.push(ids.length);peak=Math.max(peak,++active);await new Promise(r=>setTimeout(r,5));active--;
    return Object.fromEntries(ids.map(id=>[id,id]));
  });
  expect(peak).toBe(3);expect(sizes).toEqual([100,100,100,100,1]);expect(Object.keys(result)).toHaveLength(401);
});
it('does not return partial values or leave outstanding reads when a batch fails',async()=>{
  let active=0;const read=vi.fn(async(ids:string[])=>{
    active++;try{await new Promise(r=>setTimeout(r,ids[0]==='0'?1:10));if(ids[0]==='0')throw new Error('Unavailable');return {};}finally{active--;}
  });
  await expect(readSignalBatches(Array.from({length:1000},(_,i)=>String(i)),read)).rejects.toThrow('Unavailable');
  expect(active).toBe(0);expect(read).toHaveBeenCalledTimes(3);
});
