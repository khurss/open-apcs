export interface LatencySummary {count:number;p50:number;p95:number;p99:number;max:number;}
/** 1 ms upper-bound buckets through 1024 ms; the overflow bucket uses the actual maximum. */
export class LatencyHistogram {
  private readonly buckets=new Float64Array(1026);
  private count=0;
  private maximum=0;
  record(ms:number) {
    if(!Number.isFinite(ms) || ms<0) throw new Error('Invalid monotonic latency');
    this.buckets[Math.min(1025,Math.ceil(ms))]!++;
    this.count++; this.maximum=Math.max(this.maximum,ms);
  }
  summary():LatencySummary|null {
    if(!this.count) return null;
    const rank=(p:number)=>{
      const target=Math.ceil(this.count*p); let sum=0;
      for(let i=0;i<this.buckets.length;i++) {
        sum+=this.buckets[i]!;
        if(sum>=target) return i===1025?this.maximum:Math.min(i,this.maximum);
      }
      throw new Error('Latency histogram count mismatch');
    };
    return {count:this.count,p50:rank(.5),p95:rank(.95),p99:rank(.99),max:this.maximum};
  }
}
