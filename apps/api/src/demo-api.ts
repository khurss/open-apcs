import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { validateGraph, type LogicGraph } from '../../../packages/domain/src/logic.js';
import { canonicalJson, validateScreen, type Screen } from '../../../packages/domain/src/screen.js';
import { pidThermostatGraph } from '../../../packages/domain/src/pid-template.js';
import { audit, transaction } from './store.js';

async function document(client: PoolClient, projectId: string, actor: string, kind: 'graph' | 'screen', name: string, value: LogicGraph | Screen) {
  const doc = kind === 'graph' ? validateGraph(value, true) : validateScreen(value);
  const id = randomUUID();
  const checksum = createHash('sha256').update(canonicalJson({ name, document: doc })).digest('hex');
  await client.query('INSERT INTO apcs_documents(id,project_id,kind,name,document) VALUES($1,$2,$3,$4,$5)', [id,projectId,kind,name,doc]);
  await client.query('INSERT INTO apcs_document_revisions(document_id,revision,name,document,checksum,actor_id) VALUES($1,1,$2,$3,$4,$5)', [id,name,doc,checksum,actor]);
  return id;
}

/** Install content only. Runtime activation remains an explicit audited user action. */
export function registerDemo(app: FastifyInstance, pool: Pool) {
  app.post('/api/v1/demo', { schema: { body: { type: 'object', properties: {}, additionalProperties: false } } }, async (request, reply) => {
    const result = await transaction(pool, async client => {
      const actor = request.sessionUser!.id;
      // An existing user row provides a per-owner lock even before an installation exists.
      await client.query('SELECT id FROM apcs_users WHERE id=$1 FOR UPDATE', [actor]);
      const previous = (await client.query('SELECT manifest FROM apcs_demo_installations WHERE owner_id=$1', [actor])).rows[0];
      if (previous) return { created: false, manifest: previous.manifest };
      const projectId = randomUUID(); const site = `demo-${projectId}`;
      await client.query("INSERT INTO apcs_projects(id,name,owner_id) VALUES($1,'Automation demo',$2)", [projectId,actor]);
      const ledId = randomUUID(); const thermalId = randomUUID();
      const ledSignal = randomUUID(); const temperature = randomUUID(); const heater = randomUUID();
      for (const [id,name,kind,address] of [[ledId,'Workbench LED','virtual-led','led'],[thermalId,'Climate chamber','virtual-thermal','climate']]) {
        await client.query('INSERT INTO apcs_devices(id,project_id,name,kind,site_id,protocol_device_id) VALUES($1,$2,$3,$4,$5,$6)', [id,projectId,name,kind,site,address]);
      }
      for (const [id,device,name,type,direction] of [[ledSignal,ledId,'Workbench LED.led','boolean','output'],[temperature,thermalId,'Chamber temperature (C)','float64','input'],[heater,thermalId,'Chamber heater','boolean','output']]) {
        await client.query('INSERT INTO apcs_signals(id,device_id,name,data_type,direction) VALUES($1,$2,$3,$4,$5)', [id,device,name,type,direction]);
      }
      const ledGraph = await document(client,projectId,actor,'graph','LED control', {schemaVersion:1,nodes:[
        {id:'power',kind:'constant',label:'LED power',value:true,x:60,y:100},
        {id:'led',kind:'output',label:'Workbench LED',signalId:ledSignal,x:380,y:100},
      ],edges:[{id:'power-led',source:'power',target:'led',port:'in'}]});
      const climateGraph = await document(client,projectId,actor,'graph','Climate PID',pidThermostatGraph(temperature,heater));
      const ledScreen = await document(client,projectId,actor,'screen','LED workbench', {schemaVersion:1,width:1000,height:500,items:[
        {id:'title',kind:'label',label:'LED WORKBENCH · VIRTUAL DEMO',x:40,y:30,width:920,height:70},
        {id:'state',kind:'indicator',label:'LED output',signalId:ledSignal,x:40,y:140,width:440,height:100},
        {id:'control',kind:'button',label:'Workbench LED',signalId:ledSignal,x:520,y:140,width:440,height:100},
        {id:'help',kind:'label',label:'Start the virtual LED in Devices. Use manual control or activate LED control.',x:40,y:300,width:920,height:80},
      ]});
      const climateScreen = await document(client,projectId,actor,'screen','Climate overview', {schemaVersion:1,width:1000,height:880,items:[
        {id:'title',kind:'label',label:'CLIMATE CHAMBER · PID SETPOINT 24 C',x:40,y:30,width:920,height:70},
        {id:'temperature',kind:'value',label:'Temperature (C)',signalId:temperature,x:40,y:140,width:440,height:100},
        {id:'heater',kind:'indicator',label:'Heater output',signalId:heater,x:520,y:140,width:440,height:100},
        {id:'help',kind:'label',label:'Start Climate chamber, then activate the prepared Climate PID graph.',x:40,y:290,width:920,height:80},
        {id:'temperature-history',kind:'trend',label:'Temperature history',signalId:temperature,x:40,y:560,width:920,height:280,windowSeconds:300},
        {id:'control',kind:'button',label:'Chamber heater',signalId:heater,x:40,y:410,width:440,height:90},
      ]});
      const manifest = {projectId,deviceIds:[ledId,thermalId],graphIds:[ledGraph,climateGraph],screenIds:[ledScreen,climateScreen]};
      await client.query('INSERT INTO apcs_demo_installations(owner_id,project_id,manifest) VALUES($1,$2,$3)', [actor,projectId,manifest]);
      await audit(client,actor,'demo.installed',projectId,manifest);
      return {created:true,manifest};
    });
    return reply.code(result.created ? 201 : 200).send(result.manifest);
  });
}
