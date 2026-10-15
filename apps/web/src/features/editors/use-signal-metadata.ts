import {useEffect,useState} from 'react';
import {api,type Signal} from '../../api.js';

/** A bounded snapshot on screen entry, independent of catalog pagination. */
export function useSignalMetadata(ids:string[]) {
  const key=JSON.stringify([...new Set(ids)].sort());
  const [attempt,setAttempt]=useState(0);
  const [state,setState]=useState<{key:string;signals:Record<string,Signal>;loading:boolean;error:boolean}>({key:'',signals:{},loading:true,error:false});
  useEffect(()=>{
    let active=true;const controllers=new Set<AbortController>();
    setState({key,signals:{},loading:true,error:false});
    const signals:Record<string,Signal>={};let error=false;
    async function load(){
      const unique=JSON.parse(key) as string[];
      for(let offset=0;offset<unique.length&&active;offset+=8){
        await Promise.all(unique.slice(offset,offset+8).map(async id=>{
          const controller=new AbortController();controllers.add(controller);
          const timeout=setTimeout(()=>controller.abort(),2000);
          try{signals[id]=await api<Signal>(`/signals/${id}`,{signal:controller.signal});}
          catch{error=true;}
          finally{clearTimeout(timeout);controllers.delete(controller);}
        }));
      }
      if(active)setState({key,signals,loading:false,error});
    }
    void load();return()=>{active=false;for(const controller of controllers)controller.abort();};
  },[key,attempt]);
  return {signals:state.key===key?state.signals:{},loading:state.key!==key||state.loading,error:state.key===key&&state.error,retry:()=>setAttempt(value=>value+1)};
}
