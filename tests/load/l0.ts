import {verifyBankEvidence,type BankUiEvent} from '../../packages/bench/src/bank-evidence.js';
import { closeSync, openSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium, request, type Browser, type Page } from '@playwright/test';
import {observeUntil} from '../../packages/bench/src/observe.js';
import {L0Qualification} from './l0-qualification.js';
import { cadence } from '../../packages/bench/src/cadence.js';
import { percentiles, verifyHistory, assessLoad } from '../../packages/bench/src/load-evidence.js';
import type { SignalSnapshot } from '../../packages/domain/src/signals.js';

const profile=process.env.APCS_L0_PROFILE??'led-16';
if(!['led-16','mixed-200'].includes(profile))throw new Error('Unknown L0 profile');
const mixed=profile==='mixed-200';
const seconds = Number(process.env.APCS_L0_SECONDS ?? 3600);
const cfg = JSON.parse(readFileSync('/run/bench/config.json', 'utf8')) as {origin: string; deviceId: string; gpio: number; credentialsFile: string};
if (!Number.isInteger(seconds) || seconds < 60 || seconds > 3600 || cfg.gpio !== 18 || !/^[0-9a-f-]{36}$/.test(cfg.deviceId) || new URL(cfg.origin).protocol !== 'https:') throw new Error('Explicit HTTPS GPIO18 bench and 60–3600 seconds required');
const access = readFileSync(cfg.credentialsFile, 'utf8');
const username = access.match(/^Username: (.+)$/m)?.[1], password = access.match(/^Password: (.+)$/m)?.[1];
if (!username || !password) throw new Error('Private credentials required');
async function notify(message: unknown) {
  if (!process.send) throw new Error('Run L0 through the independent supervisor');
  await new Promise<void>((resolve,reject) => process.send!(message, undefined, undefined, (error: Error | null) => error ? reject(error) : resolve()));
}
closeSync(openSync('/artifacts/rigol.lock', 'wx', 0o644));
await notify('locked');
const directory = `/artifacts/l0-${new Date().toISOString().replaceAll(':','-')}`;
mkdirSync(directory);
const api = await request.newContext({baseURL: cfg.origin, extraHTTPHeaders: {origin: cfg.origin}, timeout: 5000});
let browserMetrics:unknown;
let csrf = '', browser: Browser | undefined, page: Page | undefined, failure: unknown;
type Target = {id: string; signalId: string; revision: number; physical: boolean; bootId: string; inputSignalIds?:string[]};
const targets: Target[] = [], acceptance: number[] = [], verification: number[] = [], jitter: number[] = [];
const warmupTimings: number[] = [];
let commands = 0, verified = 0, historyChanges = 0, elapsedSeconds = 0, missedTicks = 0;
let measurementStarted: number | null = null;
let measuredFrom = '', measuredTo = '', baseline: Record<string, number> = {}, conclusion = 'failed';
const bankEvents=new Map<string,BankUiEvent[]>();
let bankStart:Record<string,SignalSnapshot>={},bankEnd:Record<string,SignalSnapshot>={};
let bankEvidence:unknown;
const uiEvents: {at: number; value: string; quality: string}[] = [];
const physicalSends: {at: number; value: boolean}[] = [];
async function get(path: string) {
  const r = await api.get(path);
  try { if (!r.ok()) throw new Error(`GET ${path} returned ${r.status()}`); return await r.json(); } finally { await r.dispose(); }
}
async function post(path: string, data: unknown, headers: Record<string,string> = {}) {
  const r = await api.post(path, {data, headers: {'x-csrf-token': csrf, ...headers}});
  try { if (!r.ok()) throw new Error(`POST ${path} returned ${r.status()}`); return await r.json(); } finally { await r.dispose(); }
}
async function put(path: string, data: unknown, headers: Record<string,string> = {}) {
  const r = await api.put(path, {data, headers: {'x-csrf-token': csrf, ...headers}});
  try { if (!r.ok()) throw new Error(`PUT ${path} returned ${r.status()}`); return await r.json(); } finally { await r.dispose(); }
}
const qualification = new L0Qualification(get, post, put, notify, directory);
let supplemental: unknown;
async function all(path: string) {
  const items = []; let cursor: string | null = null;
  do { const p = await get(`${path}?limit=100${cursor ? `&cursor=${cursor}` : ''}`); items.push(...p.items); cursor = p.nextCursor; } while (cursor);
  return items;
}
async function waitFor(check: () => Promise<boolean>) {
  return observeUntil(check,()=>performance.now(),sleep);
}
async function command(t: Target, value: boolean, measured: boolean) {
  const start = performance.now(), wall = Date.now();
  const accepted = await post('/api/v1/commands', {targetSignalId: t.signalId, value, ttlMs: 1000, expectedProjectRevision: t.revision, reason: 'L0 isolated LED endurance workload'}, {'idempotency-key': randomUUID()});
  const acceptedMs = performance.now() - start;
  appendFileSync(`${directory}/requests.jsonl`, JSON.stringify({measured, id:accepted.id, signalId:t.signalId, value, sentAt:new Date(wall).toISOString(), acceptedMs}) + '\n');
  if (measured) { commands++; acceptance.push(acceptedMs); if (t.physical) physicalSends.push({at: wall, value}); }
  const receiptObservation = await waitFor(async () => {
    const current = await get(`/api/v1/commands/${accepted.id}`);
    if (!['Accepted','Dispatched','Verified'].includes(current.state)) throw new Error(`L0 command ${accepted.id} ended ${current.state}`);
    return current.state === 'Verified';
  });
  const signalObservation = await waitFor(async () => {
    const sample: SignalSnapshot = await get(`/api/v1/signals/${t.signalId}/value`);
    if (sample.quality !== 'Good' || sample.bootId !== t.bootId) throw new Error('L0 output quality or boot changed');
    return sample.value === value;
  });
  if (measured) {
    verified++; verification.push(performance.now() - start);
  } else warmupTimings.push(performance.now() - start);
  appendFileSync(`${directory}/commands.jsonl`, JSON.stringify({measured, id: accepted.id, signalId: t.signalId, value, sentAt: new Date(wall).toISOString(), acceptedMs, verifiedAndObservedMs: performance.now() - start, receiptObservation, signalObservation}) + '\n');
}
async function inspectHistory() {
  const h = await get('/api/v1/history/status');
  if (!h.active || h.error || h.maintenanceError || ['dropped','failures','observerFailures'].some(k => h[k] !== baseline[k])) throw new Error('History service failed or lost samples');
  return h;
}
async function drainUi() {
  if (!page) return;
  const events = await page.evaluate(() => (window as unknown as {l0Events: typeof uiEvents}).l0Events.splice(0));
  uiEvents.push(...events);
  if(mixed){
    const numeric=await page.evaluate(()=>(window as unknown as {bankEvents:(BankUiEvent & {id:string})[]}).bankEvents.splice(0));
    for(const event of numeric){const list=bankEvents.get(event.id)??[];list.push(event);bankEvents.set(event.id,list);}
    if(numeric.length)appendFileSync(`${directory}/numeric-ui.jsonl`,numeric.map(event=>JSON.stringify(event)).join('\n')+'\n');
  }
  for (const event of events) appendFileSync(`${directory}/ui.jsonl`, JSON.stringify(event) + '\n');
}
async function readBankValues(){
  const ids=targets.flatMap(t=>t.inputSignalIds??[]);const result:Record<string,SignalSnapshot>={};
  for(let i=0;i<ids.length;i+=100)Object.assign(result,await get(`/api/v1/signals/values?ids=${ids.slice(i,i+100).join(',')}`));
  for(const id of ids)if(result[id]?.quality!=='Good'||result[id]?.sequence==null||!result[id]?.receivedTime)throw new Error('Missing bank boundary sample');
  return result;
}
async function inspectBanks(){
  const result=[];const failures:{signalId:string;error:string}[]=[];
  for(const target of targets)for(const [channel,id] of (target.inputSignalIds??[]).entries()){
    const first=bankStart[id]!,last=bankEnd[id]!;const rows:{snapshot:SignalSnapshot}[]=[];let before:string|null=null;
    do{
      const p=await get(`/api/v1/signals/${id}/history?from=${encodeURIComponent(new Date(Date.parse(first.receivedTime!)-1000).toISOString())}&to=${encodeURIComponent(new Date(Date.parse(last.receivedTime!)+1000).toISOString())}&limit=1000${before?`&before=${before}`:''}`);
      rows.push(...p.items.filter((r:{snapshot:SignalSnapshot})=>r.snapshot.sequence!==null && r.snapshot.sequence>=first.sequence! && r.snapshot.sequence<=last.sequence!));before=p.nextBefore;
    }while(before);
    rows.reverse();writeFileSync(`${directory}/history-${id}.json`,JSON.stringify(rows));
    if(first.bootId!==target.bootId||last.bootId!==target.bootId)throw new Error('Bank session changed');
    try{result.push({signalId:id,...verifyBankEvidence(rows.map(r=>r.snapshot),bankEvents.get(id)??[],{bootId:target.bootId,channel,first:first.sequence!,last:last.sequence!,seconds})});}catch(error){failures.push({signalId:id,error:error instanceof Error?error.message:String(error)});}
  }
  writeFileSync(`${directory}/bank-qualification.json`,JSON.stringify({result,failures},null,2));
  return {failures,channels:result.length,samples:result.reduce((n,r)=>n+r.samples,0),maxUiP95:Math.max(...result.map(r=>r.ui.p95)),maxUiP99:Math.max(...result.map(r=>r.ui.p99))};
}
try {
  ({csrfToken: csrf} = await post('/api/v1/auth/login', {username,password}));
  const devices = await all('/api/v1/devices');
  const physical = devices.find(d => d.id === cfg.deviceId && d.kind === 'esp32-led');
  if (!physical) throw new Error('Reviewed physical device not found');
  for (const device of devices) if ((await get(`/api/v1/devices/${device.id}/runtime`)).state === 'running') throw new Error('L0 requires all existing device runtimes stopped');
  const signals = await all('/api/v1/signals');
  const physicalSignals = signals.filter(s => s.deviceId === physical.id && s.direction === 'output' && s.dataType === 'boolean');
  if (physicalSignals.length !== 1) throw new Error('Expected one physical LED output');
  const catalogFile = mixed?'/artifacts/l0-bank-catalog.json':'/artifacts/l0-catalog.json';
  const virtualCount=mixed?13:15;
  if (existsSync(catalogFile)) {
    const saved = JSON.parse(readFileSync(catalogFile, 'utf8')) as Target[];
    if (!Array.isArray(saved) || saved.length !== virtualCount || new Set(saved.map(t => t.id)).size !== virtualCount) throw new Error('Invalid private L0 catalog');
    for (const t of saved) {
      const device = devices.find(d => d.id === t.id && d.kind === (mixed?'virtual-input-bank':'virtual-led') && d.name.startsWith('L0 '));
      if (!device || !signals.some(s => s.id === t.signalId && s.deviceId === t.id && s.direction === 'output' && s.dataType === 'boolean')) throw new Error('L0 catalog no longer matches the API');
      if(mixed){const inputs=signals.filter(s=>s.deviceId===t.id && s.direction==='input' && s.dataType==='float64').map(s=>s.id).sort();if(JSON.stringify(inputs)!==JSON.stringify(t.inputSignalIds)||inputs.length!==(targets.length<12?15:6))throw new Error('Bank catalog changed');}
      targets.push({...(t.inputSignalIds?{inputSignalIds:t.inputSignalIds}:{}),id:t.id,signalId:t.signalId,revision:(await get(`/api/v1/projects/${device.projectId}`)).revision,physical:false,bootId:''});
    }
  } else {
    const project = await post('/api/v1/projects', {name: `L0 ${new Date().toISOString()}`});
    for (let i = 0; i < virtualCount; i++) {
      const device = await post('/api/v1/devices', {projectId: project.id, name: `L0 ${project.id.slice(0,8)} LED ${i + 1}`, siteId: `l0-${project.id.slice(0,8)}`, deviceId: `led-${i + 1}`, kind:mixed?'virtual-input-bank':'virtual-led',...(mixed?{inputCount:i<12?15:6}:{})});
      targets.push({inputSignalIds:device.inputSignalIds,id: device.id, signalId: device.signalId, revision: project.revision, physical: false, bootId: ''});
    }
    writeFileSync(catalogFile, JSON.stringify(targets, null, 2), {flag:'wx'});
  }
  for (const target of targets) {
    await notify({virtualDevice: target.id});
    await post(`/api/v1/devices/${target.id}/runtime`, {action:'start', reason:'L0 isolated workload'});
  }
  const physicalProject = await get(`/api/v1/projects/${physical.projectId}`);
  targets.push({id: physical.id, signalId: physicalSignals[0].id, revision: physicalProject.revision, physical: true, bootId: ''});
  await notify('arming');
  await post(`/api/v1/devices/${physical.id}/commission`, {action:'start', gpio:18, acknowledgeLedOnly:true, reason:'L0 GPIO18 endurance workload'});
  for (const target of targets) {
    const sample = await get(`/api/v1/signals/${target.signalId}/value`);
    if (sample.quality !== 'Good' || sample.value !== false || !sample.bootId) throw new Error('Initial L0 output is not OFF/Good');
    target.bootId = sample.bootId;
  }
  await qualification.setup(physical.projectId, physicalSignals[0].id);
  writeFileSync(`${directory}/targets.json`, JSON.stringify({profile,seconds, warmupSeconds:60, periodMs:1000, phaseSpacingMs:1000/targets.length, targets}, null, 2));
  const cert = new X509Certificate(readFileSync('/run/bench/server-ca.crt'));
  const pin = createHash('sha256').update(cert.publicKey.export({type:'spki',format:'der'})).digest('base64');
  browser = await chromium.launch({args:[`--ignore-certificate-errors-spki-list=${pin}`]});
  const context = await browser.newContext({storageState: await api.storageState(), viewport:{width:1440,height:1000}});
  page = await context.newPage();
  page.on('pageerror', error => { failure ??= error; });
  await page.goto(cfg.origin);
  await page.getByRole('button', {name:'Signals',exact:true}).click();
  const visibleCatalog=await all('/api/v1/signals');
  await page.locator('tbody tr').first().waitFor();
  while(await page.locator('tbody tr').count()<visibleCatalog.length){
    const before=await page.locator('tbody tr').count();
    await page.getByRole('button',{name:'Load more signals',exact:true}).click();
    await page.waitForFunction(count=>document.querySelectorAll('tbody tr').length>count,before);
  }
  await page.getByRole('row').filter({has:page.getByText(physicalSignals[0].name,{exact:true})}).getByText('Good',{exact:true}).waitFor();
  await page.evaluate((name) => {
    const w = window as unknown as {l0Events: {at:number;value:string;quality:string}[]}; w.l0Events = [];
    let previous = '';
    new MutationObserver(() => {
      const row = [...document.querySelectorAll('tbody tr')].find(r => r.querySelector('strong')?.textContent === name);
      const value = row?.querySelector('.signal-value')?.textContent ?? '';
      if (value !== previous) {
        previous = value; const quality=row?.children[2]?.textContent ?? '';
        // Two animation frames include a rendering opportunity after DOM mutation.
        requestAnimationFrame(() => requestAnimationFrame(() => w.l0Events.push({at:Date.now(),value,quality})));
      }
      if (w.l0Events.length > 10000) throw new Error('L0 browser evidence overflow');
    }).observe(document.querySelector('main')!, {subtree:true,childList:true,characterData:true});
  }, physicalSignals[0].name);
  if(mixed){
    const freshSignals=await all('/api/v1/signals');
    const inputNames=targets.flatMap(t=>(t.inputSignalIds??[]).map(id=>({id,name:freshSignals.find(s=>s.id===id)!.name})));
    if(inputNames.length!==186)throw new Error('Expected 186 numeric inputs');
    await page.evaluate((inputs)=>{
      const w=window as unknown as {bankEvents:(BankUiEvent & {id:string})[]};w.bankEvents=[];
      const names=new Map(inputs.map(i=>[i.name,i.id]));const previous=new Map<string,string>();
      new MutationObserver(()=>{
        const pending:(BankUiEvent & {id:string})[]=[];
        for(const row of document.querySelectorAll('tbody tr')){
          const id=names.get(row.querySelector('strong')?.textContent??'');if(!id)continue;
          const value=row.querySelector('.signal-value')?.textContent??'',quality=row.children[2]?.textContent??'';
          const key=value+'|'+quality;if(previous.get(id)===key)continue;previous.set(id,key);
          pending.push({id,value,quality,at:0,mutatedAt:Date.now()});
        }
        if(pending.length)requestAnimationFrame(()=>requestAnimationFrame(()=>{const at=Date.now();for(const event of pending)w.bankEvents.push({...event,at});}));
        if(w.bankEvents.length>20000)throw new Error('Numeric browser evidence overflow');
      }).observe(document.querySelector('main')!,{subtree:true,childList:true,characterData:true});
    },inputNames);
  }
  baseline = await get('/api/v1/history/status');
  for (const measured of [false, true]) {
    const duration = measured ? seconds : 60;
    if (measured) { await drainUi(); uiEvents.length = 0; measuredFrom = new Date().toISOString(); if(mixed)bankStart=await readBankValues(); }
    const start = performance.now(), wallStart = Date.now();
    if (measured) measurementStarted = start;
    console.log(JSON.stringify({phase: measured ? 'measurement' : 'warmup', duration, directory}));
    const results = await Promise.allSettled(targets.map((target,index) => cadence({
      start,ticks:duration,phaseMs:index*1000/targets.length,now:()=>performance.now(),wait:sleep,
      onMiss: event => {
        missedTicks++;
        appendFileSync(`${directory}/missed-ticks.jsonl`, JSON.stringify({measured,signalId:target.signalId,...event,at:new Date().toISOString()}) + '\n');
      },
      step:async (tick,late) => {
        if (failure) throw failure;
        if (measured) jitter.push(late);
        if (Math.abs((Date.now()-wallStart)-(performance.now()-start)) > 100) throw new Error('Wall clock changed during measurement');
        try {
          await command(target, tick % 2 === 0, measured);
          if (index === 0 && tick % 10 === 0) await inspectHistory();
          // Bound browser IPC/serialization work; a minute of 186 channels can
          // block the load generator long enough to miss its own command slots.
          if(index===0 && tick % (mixed?5:60)===(mixed?4:59))await drainUi();
          if (index === 0 && tick % 60 === 59) { console.log(JSON.stringify({phase:measured?'measurement':'warmup',elapsedSeconds:tick+1,commands,verified,history:await inspectHistory()})); }
        } catch (error) { failure ??= error; throw error; }
      },
    }).catch(error => { failure ??= error; throw error; })));
    const failed = results.find(r=>r.status==='rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    if (measured) elapsedSeconds = (performance.now() - start) / 1000;
  }
  measuredTo = new Date().toISOString();
  if(mixed){bankEnd=await readBankValues();writeFileSync(`${directory}/bank-boundaries.json`,JSON.stringify({start:bankStart,end:bankEnd},null,2));}
  await sleep(2000); await drainUi(); await inspectHistory();
  let physicalHistory: SignalSnapshot[] = [];
  for (const target of targets) {
    const rows: {snapshot: SignalSnapshot}[] = []; let before: string | null = null;
    do {
      const p = await get(`/api/v1/signals/${target.signalId}/history?from=${encodeURIComponent(measuredFrom)}&to=${encodeURIComponent(measuredTo)}&limit=1000${before ? `&before=${before}` : ''}`);
      rows.push(...p.items); before = p.nextBefore;
    } while (before);
    rows.reverse();
    if(target.physical) physicalHistory=rows.map(r=>r.snapshot);
    historyChanges += verifyHistory(rows.map(r => r.snapshot), target.bootId, seconds);
    writeFileSync(`${directory}/history-${target.signalId}.json`, JSON.stringify(rows));
  }
  if(mixed){const evidence=await inspectBanks();bankEvidence=evidence;if(evidence.failures.length)throw new Error(`${evidence.failures.length} numeric channels failed qualification`);}
  supplemental = await qualification.verify({from:measuredFrom,to:measuredTo,seconds,history:physicalHistory,ui:uiEvents,deviceIds:targets.map(t=>t.id)});
  conclusion = assessLoad({requestedSeconds:seconds, elapsedSeconds, devices:targets.length, commands, verified, historyChanges, missedTicks, errors:[]});
} catch (error) {
  failure = error;
  if (measurementStarted !== null && !measuredTo) { elapsedSeconds = (performance.now() - measurementStarted) / 1000; measuredTo = new Date().toISOString(); }
  try { await drainUi(); } catch { /* Preserve the original failure when the browser is unavailable. */ }
}
finally {
  try { await qualification.stop(); } catch(error) { failure ??= error; }
  // All created/armed targets are also known to the independent supervisor.
  for (const t of targets) {
    try { const stopped = await post(`/api/v1/devices/${t.id}/${t.physical?'commission':'runtime'}`, {action:'stop',reason:'End L0 workload'}); if (stopped.state !== 'stopped') throw new Error('L0 target did not stop'); }
    catch (error) { failure ??= error; }
  }
  if(page)try{browserMetrics=await page.evaluate(()=>performance.getEntriesByType('resource').filter(r=>r.name.includes('/signals/values?')).map(r=>({duration:r.duration,startTime:r.startTime})));}catch{}
  await browser?.close(); await api.dispose();
  let metrics = {};
  try {
    const apiTiming = acceptance.length?percentiles(acceptance):null;
    if (apiTiming && apiTiming.p95 > 200) failure ??= new Error(`Command acceptance p95 ${apiTiming.p95.toFixed(1)} ms exceeds 200 ms`);
    metrics = {warmupTimingsMs:warmupTimings.length?percentiles(warmupTimings):null,acceptanceMs:apiTiming,verifiedAndObservedMs:verification.length?percentiles(verification):null,tickLatenessMs:jitter.length?percentiles(jitter):null}; }
  catch(error) {failure ??= error;}
  const report = {browserMetrics,profile,signals:targets.length+targets.reduce((n,t)=>n+(t.inputSignalIds?.length??0),0),bankEvidence,runId:process.env.APCS_L0_RUN_ID ?? 'manual',at:new Date().toISOString(),conclusion:failure?'failed':conclusion,requestedSeconds:seconds,elapsedSeconds,devices:targets.length,commands,verified,historyChanges,missedTicks,measuredFrom,measuredTo,...metrics,uiPhysicalTransitions:uiEvents.length,physicalSentTransitions:physicalSends.length,supplemental,limitations:['UI changes are sampled by the existing monitor; DOM coalescing is reported separately from durable history.','Browser evidence measures two animation-frame rendering opportunities on the same host clock, not optical paint.','Graph timing is a read-only 100-block task; continuous electrical trace is not included.','Resource acceptance requires the separate host resource log.'],error:failure instanceof Error?failure.message:failure?'Unknown failure':null};
  writeFileSync(`${directory}/result.json`, JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
}
if (failure) throw failure;
