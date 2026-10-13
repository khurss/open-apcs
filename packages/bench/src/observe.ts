/** Polling budget for observing durable results; this never retries or extends a command. */
export async function observeUntil(check:()=>Promise<boolean>, now:()=>number, wait:(ms:number)=>Promise<unknown>, timeoutMs=2000) {
  const deadline=now()+timeoutMs;
  do {
    if(await check()) return;
    await wait(100);
  } while(now()<deadline);
  throw new Error('L0 observation deadline exceeded');
}
