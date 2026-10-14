/** Independent 1 Hz device schedule. Slow peers cannot synchronize other peers into a burst. */
export async function cadence(options: {start:number; ticks:number; phaseMs:number; now:()=>number; wait:(ms:number)=>Promise<unknown>; step:(tick:number, latenessMs:number)=>Promise<void>; onMiss?:(event:{tick:number; latenessMs:number})=>void}) {
  const {start,ticks,phaseMs,now,wait,step} = options;
  if (!Number.isFinite(start) || !Number.isSafeInteger(ticks) || ticks < 1 || ticks > 3600 || !Number.isFinite(phaseMs) || phaseMs < 0 || phaseMs >= 1000) throw new Error('Invalid cadence');
  const until = async (deadline: number) => { while (now() < deadline) await wait(Math.ceil(deadline - now())); };
  for (let tick = 0; tick < ticks; tick++) {
    const due = start + phaseMs + tick * 1000;
    await until(due);
    const late = now() - due;
    if (late >= 1000) {
      options.onMiss?.({tick,latenessMs:late});
      throw new Error(`Load generator missed tick ${tick} by ${Math.round(late)} ms`);
    }
    await step(tick, late);
  }
  await until(start + phaseMs + ticks * 1000);
}
