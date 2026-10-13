import { useEffect, useState } from 'react';
import type { HistoryPage } from '../../../../../packages/domain/src/history.js';
import { api } from '../../api.js';
export interface TrendBinding {id:string;signalId?:string;windowSeconds?:number;}
export interface TrendState extends HistoryPage {status:'loading'|'ready'|'error';error:string;}
export const emptyTrend:TrendState={items:[],nextBefore:null,status:'loading',error:''};

/** Bound history refreshes never overlap or keep presenting failed requests as live. */
export function useTrends(bindings:TrendBinding[]) {
  const [values,setValues]=useState<Record<string,TrendState>>({});
  const key=JSON.stringify(bindings.map(({id,signalId,windowSeconds})=>({id,signalId,windowSeconds})));
  useEffect(()=>{
    let active=true;let timer:ReturnType<typeof setTimeout>;let pending:AbortController|undefined;
    setValues({});
    async function poll(){
      const controller=new AbortController();pending=controller;const deadline=setTimeout(()=>controller.abort(),3000);
      try {
        const updates=await Promise.all(bindings.slice(0,8).map(async binding=>{
          const to=new Date();const from=new Date(to.getTime()-(binding.windowSeconds??300)*1000);
          try {
            const page=await api<HistoryPage>(`/signals/${binding.signalId}/history?${new URLSearchParams({from:from.toISOString(),to:to.toISOString(),limit:'1000'})}`,{signal:controller.signal});
            return [binding.id,{...page,status:'ready',error:''}] as const;
          } catch {return [binding.id,{items:[],nextBefore:null,status:'error',error:'Trend history is unavailable. Retrying…'}] as const;}
        }));
        if(active)setValues(Object.fromEntries(updates));
      } finally {clearTimeout(deadline);}
      if(active)timer=setTimeout(()=>{void poll();},2000);
    }
    if(bindings.length)void poll();
    return ()=>{active=false;clearTimeout(timer);pending?.abort();};
  },[key]);
  return values;
}
