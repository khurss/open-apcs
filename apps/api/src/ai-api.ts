import {createHash} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {AiError,type AiProvider,type AiSignal} from './ai-provider.js';
import {requireProjectOwner} from './ownership.js';
import {audit,transaction} from './store.js';
import {validateDocument,validateBindings} from './document-validation.js';
import {canonicalJson,type Screen} from '../../../packages/domain/src/screen.js';
import type {LogicGraph} from '../../../packages/domain/src/logic.js';
const uuid={type:'string',format:'uuid'};
const object=(properties:Record<string,unknown>,required=Object.keys(properties))=>({type:'object',additionalProperties:false,properties,required});
export function registerAi(app:FastifyInstance,pool:Pool,provider?:AiProvider) {
  app.get('/api/v1/ai/status',async()=>({configured:Boolean(provider),provider:'OpenAI',model:provider?.model??null}));
  app.post<{Params:{id:string};Body:{kind:'graph'|'screen';prompt:string;signalIds:string[];allowExternal:true}}>('/api/v1/projects/:id/ai/proposals',{
    config:{rateLimit:{max:5,timeWindow:'1 minute'}},
    schema:{params:object({id:uuid}),body:object({kind:{enum:['graph','screen']},prompt:{type:'string',minLength:1,maxLength:4000,pattern:'\\S'},signalIds:{type:'array',maxItems:100,uniqueItems:true,items:uuid},allowExternal:{const:true}})},
  },async(request,reply)=>{
    const actor=request.sessionUser!.id;const projectId=request.params.id;const {kind,prompt,signalIds}=request.body;
    await requireProjectOwner(pool,projectId,actor);
    if(!provider)return reply.code(503).send({code:'AI_NOT_CONFIGURED',message:'AI authoring is not configured. Add a private OpenAI configuration on the server.',correlationId:request.id});
    const signals=(await pool.query<AiSignal>('SELECT s.id,s.name,s.data_type AS "dataType",s.direction FROM apcs_signals s JOIN apcs_devices d ON d.id=s.device_id WHERE d.project_id=$1 AND s.id=ANY($2::uuid[]) ORDER BY s.id',[projectId,signalIds])).rows;
    if(signals.length!==signalIds.length)throw new AiError(422,'INVALID_AI_CONTEXT','AI context contains a signal outside this project');
    await transaction(pool,client=>audit(client,actor,'ai.generation.requested',projectId,{kind,model:provider.model,signalCount:signals.length}));
    try {
      const proposal=await provider.generate({kind,prompt,signals});
      if(typeof proposal.document!=='string'||Buffer.byteLength(proposal.document)>65536||typeof proposal.name!=='string'||!proposal.name.trim()||proposal.name.length>128||typeof proposal.summary!=='string'||proposal.summary.length>2000)throw new AiError(422,'INVALID_AI_PROPOSAL','AI proposal exceeds the document limits');
      let input:unknown;try{input=JSON.parse(proposal.document);}catch{throw new AiError(422,'INVALID_AI_PROPOSAL','AI proposal is not a valid JSON document');}
      const document=validateDocument(kind,input,true);
      const entries=kind==='graph'?(document as LogicGraph).nodes:(document as Screen).items;
      if(!entries.length||entries.length>64||entries.some(item=>['script','schedule','sequence'].includes(item.kind)))throw new AiError(422,'INVALID_AI_PROPOSAL','AI drafts support 1–64 elements and exclude script, schedule and sequence blocks');
      if(entries.some(item=>item.signalId&&!signalIds.includes(item.signalId)))throw new AiError(422,'INVALID_AI_BINDING','AI proposal refers to a signal outside the disclosed context');
      await validateBindings(pool,projectId,kind,document);
      const checksum=createHash('sha256').update(canonicalJson(document)).digest('hex');
      await transaction(pool,client=>audit(client,actor,'ai.generation.completed',projectId,{kind,model:provider.model,checksum}));
      return {name:proposal.name,summary:proposal.summary,document,checksum,provider:'OpenAI',model:provider.model};
    }catch(error){
      await transaction(pool,client=>audit(client,actor,'ai.generation.failed',projectId,{kind,model:provider.model})).catch(()=>{});
      if(error instanceof AiError)return reply.code(error.statusCode).send({code:error.code,message:error.message,correlationId:request.id});
      throw error;
    }
  });
}
