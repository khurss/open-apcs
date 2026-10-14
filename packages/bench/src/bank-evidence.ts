import {percentiles} from './load-evidence.js';
type Sample={value:unknown;bootId:string|null;sequence:number|null;quality:string;receivedTime:string|null};
export type BankUiEvent={value:string;quality:string;at:number;mutatedAt?:number};
/** Exact archive endpoints come from observed runtime snapshots, not inferred counts. */
export function verifyBankEvidence(rows:Sample[],events:BankUiEvent[],range:{bootId:string;channel:number;first:number;last:number;seconds:number}) {
  const {bootId,channel,first,last,seconds}=range;
  if(!bootId || !Number.isInteger(channel)||channel<0||channel>14||!Number.isSafeInteger(first)||first<0||!Number.isSafeInteger(last)||last<first||!Number.isInteger(seconds)||seconds<60||seconds>3600||last-first<seconds-1||rows.length!==last-first+1) throw new Error('Incomplete numeric coverage');
  let prior=-Infinity;
  for(const [i,row] of rows.entries()) {
    const at=Date.parse(row.receivedTime??'');
    if(row.bootId!==bootId||row.quality!=='Good'||row.sequence!==first+i||row.value!==channel*100+(first+i)%100||!Number.isFinite(at)||at<=prior)throw new Error('Invalid numeric archive sequence');
    prior=at;
  }
  if(Date.parse(rows.at(-1)!.receivedTime!)-Date.parse(rows[0]!.receivedTime!)<Math.max(seconds-2,last-first-1)*1000)throw new Error('Insufficient numeric time coverage');
  // Retain all events after the first sample, then require exact ordered matches.
  // Later events belong to post-measurement collection; they cannot replace a gap.
  const observed=events.filter(e=>e.at>=Date.parse(rows[0]!.receivedTime!));
  if(observed.length<rows.length)throw new Error('Missing numeric UI transitions');
  const delays=rows.map((row,i)=>{
    const event=observed[i]!;const delay=event.at-Date.parse(row.receivedTime!);
    if(event.value!==(row.value as number).toFixed(2)||event.quality!=='Good'||!Number.isFinite(delay)||delay<0)throw new Error('Numeric UI differs from archive');
    return delay;
  });
  const ui=percentiles(delays);
  if(ui.p95>500||ui.p99>1000)throw new Error(`Numeric UI latency exceeds L0 criteria: p95=${ui.p95} p99=${ui.p99}`);
  return {samples:rows.length,first,last,ui};
}
