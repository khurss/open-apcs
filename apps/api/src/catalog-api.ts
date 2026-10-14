import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { audit, transaction } from './store.js';

const uuid = {type:'string',format:'uuid'};
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({type:'object',additionalProperties:false,properties,required});
class CatalogError extends Error { constructor(readonly statusCode:number,readonly code:string,message:string) {super(message);} }

/** Catalog metadata is independent of protocol addresses and runtime commissioning. */
export function registerCatalog(app: FastifyInstance, pool: Pool) {
  for (const kind of ['devices','signals'] as const) {
    const fields = kind==='devices' ? 'd.id,d.project_id AS "projectId",d.name,d.kind,d.site_id AS "siteId",d.protocol_device_id AS "deviceId",d.revision'
      : 's.id,s.device_id AS "deviceId",s.name,s.data_type AS "dataType",s.direction,s.freshness_ms AS "freshnessMs",s.revision,s.unit,s.display_decimals AS "displayDecimals"';
    const source = kind==='devices' ? 'apcs_devices d JOIN apcs_projects p ON p.id=d.project_id'
      : 'apcs_signals s JOIN apcs_devices d ON d.id=s.device_id JOIN apcs_projects p ON p.id=d.project_id';
    const alias = kind==='devices'?'d':'s';
    app.get<{Querystring:{limit?:string;cursor?:string;projectId?:string;q?:string}}>(`/api/v1/${kind}`, {
      schema:{querystring:object({limit:{type:'string',pattern:'^(100|[1-9][0-9]?)$'},cursor:uuid,projectId:uuid,q:{type:'string',maxLength:128}},[])},
    }, async request => {
      const limit = Number(request.query.limit??100);
      const result = await pool.query(`SELECT ${fields} FROM ${source} WHERE p.owner_id=$1 AND ($2::uuid IS NULL OR p.id=$2) AND ($3::uuid IS NULL OR ${alias}.id>$3) AND strpos(lower(${alias}.name),lower($4))>0 ORDER BY ${alias}.id LIMIT $5`,
        [request.sessionUser!.id,request.query.projectId??null,request.query.cursor??null,request.query.q??'',limit+1]);
      return {items:result.rows.slice(0,limit),nextCursor:result.rows.length>limit?result.rows[limit-1].id:null};
    });
    app.patch<{Params:{id:string};Body:{name:string;unit?:string;displayDecimals?:number}}>(`/api/v1/${kind}/:id`, {
      schema:{params:object({id:uuid}),body:object({name:{type:'string',minLength:1,maxLength:128,pattern:'\\S'},...(kind==='signals'?{unit:{type:'string',maxLength:24,pattern:'^[^\\u0000-\\u001f\\u007f]*$'},displayDecimals:{type:'integer',minimum:0,maximum:6}}:{})},['name'])},
    }, async (request,reply) => {
      const match=request.headers['if-match'];
      if(typeof match!=='string'||!/^"[1-9][0-9]{0,8}"$/.test(match)) throw new CatalogError(428,'REVISION_REQUIRED','An If-Match revision is required');
      const updated=await transaction(pool,async client=>{
        const row=(await client.query(`SELECT ${fields} FROM ${source} WHERE ${alias}.id=$1 AND p.owner_id=$2 FOR UPDATE OF ${alias}`,[request.params.id,request.sessionUser!.id])).rows[0];
        if(!row) throw new CatalogError(404,'NOT_FOUND','Resource not found');
        if(row.revision!==Number(match.slice(1,-1))) throw new CatalogError(412,'REVISION_CONFLICT','Catalog revision changed');
        if(row.revision>=999999999) throw new CatalogError(422,'REVISION_LIMIT','Catalog revision limit reached');
        if(kind==='signals' && row.dataType!=='float64' && (request.body.unit!==undefined || request.body.displayDecimals!==undefined)) throw new CatalogError(422,'NUMERIC_PRESENTATION_REQUIRED','Display settings require a numeric signal');
        const presentation=kind==='signals'?{unit:request.body.unit??row.unit,displayDecimals:request.body.displayDecimals??row.displayDecimals}:{};
        if(kind==='signals') await client.query('UPDATE apcs_signals SET unit=$1,display_decimals=$2 WHERE id=$3',[presentation.unit,presentation.displayDecimals,row.id]);
        await client.query(`UPDATE apcs_${kind} SET name=$1,revision=revision+1 WHERE id=$2`,[request.body.name,request.params.id]);
        await audit(client,request.sessionUser!.id,`${kind==='devices'?'device':'signal'}.updated`,row.id,{name:request.body.name,...presentation,revision:row.revision+1});
        return {...row,...presentation,name:request.body.name,revision:row.revision+1};
      });
      return reply.header('ETag',`"${updated.revision}"`).send(updated);
    });
  }
}
