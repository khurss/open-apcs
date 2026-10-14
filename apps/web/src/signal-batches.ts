/** Bounded concurrent reads; publish only a complete successful refresh. */
export async function readSignalBatches<T>(ids:string[],read:(ids:string[])=>Promise<Record<string,T>>):Promise<Record<string,T>> {
  const values:Record<string,T>={};let offset=0,failed=false;
  const worker=async()=>{
    while(!failed&&offset<ids.length){
      const batch=ids.slice(offset,offset+100);offset+=100;
      try{Object.assign(values,await read(batch));}catch(error){failed=true;throw error;}
    }
  };
  const results=await Promise.allSettled(Array.from({length:Math.min(3,Math.ceil(ids.length/100))},worker));
  const failure=results.find(result=>result.status==='rejected');
  if(failure?.status==='rejected')throw failure.reason;
  return values;
}
