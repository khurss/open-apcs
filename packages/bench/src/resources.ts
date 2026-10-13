export function memoryBytes(text: string) {
  const m = /^(\d+(?:\.\d+)?)(B|KiB|MiB|GiB|TiB)$/.exec(text.split('/')[0]!.trim());
  if (!m) throw new Error('Missing or invalid Docker memory sample');
  return Number(m[1]) * 1024 ** ['B','KiB','MiB','GiB','TiB'].indexOf(m[2]!);
}
export interface ResourceSample {at:number;containers:{Name:string;MemUsage:string;CPUPerc:string}[];}
export function assessResources(rows: ResourceSample[]) {
  if (rows.length < 2 || rows.at(-1)!.at - rows[0]!.at < 3600) throw new Error('One hour of resource samples required');
  const names = rows[0]!.containers.map(c=>c.Name).sort();
  const totals = rows.map((r,i) => {
    if (!Number.isFinite(r.at) || (i > 0 && (r.at <= rows[i-1]!.at || r.at - rows[i-1]!.at > 90)) || !names.length || new Set(names).size !== names.length || JSON.stringify(r.containers.map(c=>c.Name).sort()) !== JSON.stringify(names)) throw new Error('Resource evidence has gaps or missing containers');
    const bytes = r.containers.reduce((n,c)=>n+memoryBytes(c.MemUsage),0);
    const cpu = r.containers.reduce((n,c)=>{const v=Number(c.CPUPerc.replace(/%$/,''));if (!c.CPUPerc.endsWith('%') || !Number.isFinite(v) || v<0) throw new Error('Invalid CPU sample');return n+v;},0);
    if (bytes <= 0) throw new Error('Empty memory evidence');
    return {at:r.at,bytes,cpu};
  });
  const end = totals.at(-1)!.at;
  const mean = (samples: typeof totals) => {if(samples.length<5) throw new Error('Insufficient memory windows');return samples.reduce((n,s)=>n+s.bytes,0)/samples.length;};
  const baseline = mean(totals.filter(s=>s.at >= end-1800 && s.at < end-1500));
  const final = mean(totals.filter(s=>s.at >= end-300));
  const growthPercent = 100*(final/baseline-1);
  const peakBytes = Math.max(...totals.map(s=>s.bytes));
  return {passed:peakBytes <= 12*1024**3 && growthPercent <= 5,peakBytes,growthPercent,peakCpuPercent:Math.max(...totals.map(s=>s.cpu)),samples:rows.length,containerNames:names};
}
