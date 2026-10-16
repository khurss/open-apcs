import type {PoolClient} from 'pg';
import type {UniversalRecipe} from '../../../packages/domain/src/universal-recipe.js';
export interface ThermalRecipeBinding {deviceId:string;temperatureSignalId:string;outputSignalId:string;projectRevision:number;}
export interface UniversalRecipeBinding {kind:'universal';projectRevision:number;ports:Record<string,{signalId:string;deviceId:string;kind:string}>;}
export type RecipeBinding=ThermalRecipeBinding|UniversalRecipeBinding;
export function isUniversalBinding(binding:RecipeBinding):binding is UniversalRecipeBinding{return 'kind' in binding&&binding.kind==='universal';}
const invalid=(message:string,statusCode=422)=>Object.assign(new Error(message),{statusCode,code:'INVALID_RECIPE_BINDING'});
export async function resolveUniversalBinding(client:PoolClient,projectId:string,definition:UniversalRecipe,mapping:Record<string,string>|undefined):Promise<UniversalRecipeBinding>{
 if(!mapping||Object.keys(mapping).sort().join(',')!==definition.ports.map(p=>p.key).sort().join(','))throw invalid('Bind every declared recipe port exactly once');
 const ids=Object.values(mapping);if(new Set(ids).size!==ids.length)throw invalid('Each port must use a distinct signal; use an output port directly for readback waits');
 const found=await client.query<{id:string;device_id:string;data_type:string;direction:string;kind:string;revision:number}>('SELECT s.id,s.device_id,s.data_type,s.direction,d.kind,p.revision FROM apcs_signals s JOIN apcs_devices d ON d.id=s.device_id JOIN apcs_projects p ON p.id=d.project_id WHERE s.id=ANY($1::uuid[]) AND d.project_id=$2',[ids,projectId]);
 if(found.rows.length!==ids.length)throw invalid('Recipe signals must belong to this project',404);
 const ports:UniversalRecipeBinding['ports']={};
 for(const port of definition.ports){const row=found.rows.find(r=>r.id===mapping[port.key])!;
  if(!['virtual-led','virtual-thermal','virtual-input-bank'].includes(row.kind))throw invalid('Universal recipes currently support virtual devices only');
  if(port.kind==='number-input'?row.data_type!=='float64'||row.direction!=='input':row.data_type!=='boolean'||port.kind==='boolean-output'&&row.direction!=='output')throw invalid(`Signal type does not match port ${port.label}`);
  ports[port.key]={signalId:row.id,deviceId:row.device_id,kind:port.kind};
 }
 return {kind:'universal',projectRevision:found.rows[0]!.revision,ports};
}
