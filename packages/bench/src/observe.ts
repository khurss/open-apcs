/** Polling budget for observing durable results; this never retries or extends a command. */
export async function observeUntil(check:()=>Promise<boolean>, now:()=>number, wait:(ms:number)=>Promise<unknown>, timeoutMs=2000) {
  const start=now(), deadline=start+timeoutMs;
  let reads=0, readMs=0, waitMs=0, maxReadMs=0;
  do {
    const readStart=now(), ready=await check(), duration=now()-readStart;
    reads++; readMs+=duration; maxReadMs=Math.max(maxReadMs,duration);
    if(ready) return {reads,readMs,waitMs,elapsedMs:now()-start,maxReadMs};
    const waitStart=now();
    await wait(100);
    waitMs+=now()-waitStart;
  } while(now()<deadline);
  throw new Error('L0 observation deadline exceeded');
}
