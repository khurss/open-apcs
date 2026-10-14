export function nextSampleDeadline(origin:number,previous:number,now:number,period=1000):number {
  return Math.max(previous+period,origin+(Math.floor((now-origin)/period)+1)*period);
}
