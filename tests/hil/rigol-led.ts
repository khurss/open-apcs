import { openSync, closeSync, fstatSync, readSync, writeSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { request } from '@playwright/test';
import { Scpi } from '../../packages/bench/src/scpi.js';
import { assessFaultPulse, assessLow, failureDelay } from '../../packages/bench/src/fault-evidence.js';
import { decodeWaveform, assessPulse } from '../../packages/bench/src/rigol.js';

// Explicit, private LED-only bench config. This entry point is never included in make test.
const cfg = JSON.parse(readFileSync('/run/bench/config.json', 'utf8')) as { origin: string; deviceId: string; scopeSerial: string; gpio: number; credentialsFile: string };
const mode = process.argv[2] ?? 'led-pulse';
const faultMode = mode !== 'led-pulse';
const monotonic = () => Number(process.hrtime.bigint()) / 1e9;
if (!['led-pulse', 'lease-expiry', 'broker-loss', 'device-reset', 'server-loss'].includes(mode) || cfg.gpio !== 18 || !/^[0-9a-f-]{36}$/.test(cfg.deviceId) || !/^DS1[A-Z0-9]+$/.test(cfg.scopeSerial) || new URL(cfg.origin).protocol !== 'https:') throw new Error('Explicit HTTPS, scope identity, GPIO18 and a supported LED mode required');
if (['broker-loss', 'device-reset', 'server-loss'].includes(mode) && !/^[0-9a-f]{32}$/.test(process.env.APCS_FAULT_TOKEN ?? '')) throw new Error('External faults require scripts/hil-fault.py');
const access = readFileSync(cfg.credentialsFile, 'utf8');
const username = access.match(/^Username: (.+)$/m)?.[1], password = access.match(/^Password: (.+)$/m)?.[1];
if (!username || !password) throw new Error('Private credentials file is incomplete');
const lock = '/artifacts/rigol.lock';
closeSync(openSync(lock, 'wx', 0o644));
async function notify(message: string) {
  if (!process.send) throw new Error('Run hardware checks through the supervisor');
  await new Promise<void>((resolve, reject) => process.send!(message, undefined, undefined, (error: Error | null) => error ? reject(error) : resolve()));
}
await notify('locked');
const directory = `/artifacts/${new Date().toISOString().replaceAll(':', '-')}`;
mkdirSync(directory, { mode: 0o755 });
let fd: number | undefined;
let mayBeArmed = false;
let csrf = '';
let failure: unknown;
let result: unknown;
let observation: unknown;
let faultBracket: [number, number] | undefined;
const timebase = faultMode ? 1 : 0.5;
async function external(action: 'inject' | 'restore') {
  const token = process.env.APCS_FAULT_TOKEN;
  if (!token || !/^[0-9a-f]{32}$/.test(token)) throw new Error('External faults require the host orchestrator');
  const prefix = `/artifacts/fault-${token}-${action}`;
  writeFileSync(prefix + '.tmp', JSON.stringify({ mode, action }), { flag: 'wx' });
  renameSync(prefix + '.tmp', prefix + '.request');
  await waitFor(() => {
    try {
      const reply = JSON.parse(readFileSync(prefix + '.ack', 'utf8'));
      if (reply.ok !== true) throw new Error('Host fault action failed');
      return true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }, 20000);
}
const api = await request.newContext({ baseURL: cfg.origin, extraHTTPHeaders: { origin: cfg.origin }, timeout: 5000 });
const commands: unknown[] = [];
async function get(path: string) { const r = await api.get(path); if (!r.ok()) throw new Error(`API GET ${path} returned ${r.status()}`); return r.json(); }
async function post(path: string, data: unknown, headers: Record<string,string> = {}) { const r = await api.post(path, { data, headers: { 'x-csrf-token': csrf, ...headers } }); if (!r.ok()) throw new Error(`API POST ${path} returned ${r.status()}`); return r.json(); }
async function waitFor(test: () => boolean | Promise<boolean>, maximumMs = 10000) {
  const end = performance.now() + maximumMs;
  do { if (await test()) return; await sleep(100); } while (performance.now() < end);
  throw new Error('Bench observation deadline exceeded');
}
try {
  fd = openSync('/dev/usbtmc0', 'r+');
  if (!fstatSync(fd).isCharacterDevice()) throw new Error('Expected a USBTMC character device');
  const descriptor = fd;
  const scope = new Scpi({ write: b => { if (writeSync(descriptor, b) !== b.length) throw new Error('Partial SCPI write'); }, read: () => { const b = Buffer.alloc(4096); return b.subarray(0, readSync(descriptor, b)); } });
  const identity = scope.queryText('*IDN?');
  if (!identity.startsWith(`RIGOL TECHNOLOGIES,DS1054Z,${cfg.scopeSerial},`)) throw new Error('Unexpected scope identity');
  console.log(`Connected to ${identity.split(',').slice(0,2).join(' ')}`);
  ({ csrfToken: csrf } = await post('/api/v1/auth/login', { username, password }));
  const devices = await get('/api/v1/devices?limit=100');
  const device = devices.items.find((d: {id: string}) => d.id === cfg.deviceId);
  if (!device || device.kind !== 'esp32-led') throw new Error('Configured ESP32 is not in the first catalog page');
  const signals = await get('/api/v1/signals?limit=100');
  const outputs = signals.items.filter((s: {deviceId: string;direction: string;dataType: string}) => s.deviceId === device.id && s.direction === 'output' && s.dataType === 'boolean');
  if (outputs.length !== 1) throw new Error('Expected one boolean output on the configured LED');
  const project = await get(`/api/v1/projects/${device.projectId}`);
  if ((await get(`/api/v1/devices/${device.id}/runtime`)).state !== 'stopped') throw new Error('Bench must be stopped before this test');
  writeFileSync(`${directory}/scope-before.json`, JSON.stringify({ at: new Date().toISOString(), identity, bandwidth: scope.queryText(':CHAN1:BWL?'), probe: scope.queryText(':CHAN1:PROB?'), scale: scope.queryText(':CHAN1:SCAL?'), offset: scope.queryText(':CHAN1:OFFS?'), timebase: scope.queryText(':TIM:SCAL?') }, null, 2));
  // No factory reset. These settings are explicit and remain for inspection after the test.
  for (const command of [':STOP', ':CHAN1:DISP ON', ':CHAN1:PROB 10', ':CHAN1:COUP DC', ':CHAN1:BWL 20M', ':CHAN1:INV OFF', ':CHAN1:SCAL 1', ':CHAN1:OFFS -1.6', ':CHAN2:DISP OFF', ':CHAN3:DISP OFF', ':CHAN4:DISP OFF', ':TIM:MODE MAIN', `:TIM:SCAL ${timebase}`, ':TIM:OFFS 0', ':ACQ:TYPE NORM', ':TRIG:MODE EDGE', ':TRIG:COUP DC', ':TRIG:EDGE:SOUR CHAN1', ':TRIG:EDGE:SLOP POS', ':TRIG:EDGE:LEV 1.65', ':WAV:SOUR CHAN1', ':WAV:MODE NORM', ':WAV:FORM BYTE', ':WAV:STAR 1', ':WAV:STOP 1200']) scope.write(command);
  if (scope.queryText('*OPC?') !== '1' || Number(scope.queryText(':CHAN1:PROB?')) !== 10) throw new Error('Scope configuration was not confirmed');
  // This firmware times out on SYST:ERR?; verify settings directly and inspect ESR.
  const checks: [string, string | number][] = [[':CHAN1:BWL?', '20M'], [':CHAN1:COUP?', 'DC'], [':CHAN1:INV?', 0], [':CHAN1:SCAL?', 1], [':CHAN1:OFFS?', -1.6], [':TIM:SCAL?', timebase], [':TIM:OFFS?', 0], [':TRIG:MODE?', 'EDGE'], [':TRIG:EDGE:SOUR?', 'CHAN1'], [':TRIG:EDGE:SLOP?', 'POS'], [':TRIG:EDGE:LEV?', 1.65], [':WAV:SOUR?', 'CHAN1'], [':WAV:MODE?', 'NORM'], [':WAV:FORM?', 'BYTE'], [':ACQ:TYPE?', 'NORM']];
  for (const [query, expected] of checks) {
    const actual = scope.queryText(query);
    if ((typeof expected === 'number' ? Number(actual) : actual) !== expected) throw new Error(`Scope readback mismatch: ${query} ${actual}`);
  }
  const checkStatus = () => { const status = Number(scope.queryText('*ESR?')); if (!Number.isInteger(status) || (status & 60) !== 0) throw new Error('Scope event register reports an error'); };
  checkStatus();
  await notify('arming');
  mayBeArmed = true;
  const armed = await post(`/api/v1/devices/${device.id}/commission`, { action: 'start', gpio: 18, acknowledgeLedOnly: true, reason: 'Automated Rigol GPIO18 LED measurement' });
  if (armed.state !== 'running') throw new Error('Device did not arm');
  async function command(value: boolean) {
    const sentAt = new Date().toISOString();
    const start = monotonic();
    const accepted = await post('/api/v1/commands', { targetSignalId: outputs[0].id, value, ttlMs: 3000, expectedProjectRevision: project.revision, reason: 'Rigol GPIO18 pulse measurement' }, { 'idempotency-key': randomUUID() });
    await waitFor(async () => {
      const c = await get(`/api/v1/commands/${accepted.id}`);
      if (['Rejected','Failed','Expired','Uncertain','Cancelled'].includes(c.state)) throw new Error(`Command ended ${c.state}`);
      return c.state === 'Verified';
    }, 4000);
    const bracket: [number, number] = [start, monotonic()];
    commands.push({ id: accepted.id, value, sentAt, verifiedAt: new Date().toISOString(), bracket });
    return bracket;
  }
  await command(false);
  scope.write(':SING');
  await waitFor(() => scope.queryText(':TRIG:STAT?') === 'WAIT');
  // Allow the low pretrigger window to fill before commanding the rising edge.
  await sleep(faultMode ? 6500 : 3500);
  if (scope.queryText(':TRIG:STAT?') !== 'WAIT') throw new Error('Unexpected trigger before ON');
  console.log(`Capturing ${mode} on CH1.`);
  const on = await command(true);
  await sleep(faultMode ? 500 : 1000);
  if (!faultMode) await command(false);
  else {
    const start = monotonic();
    if (mode === 'lease-expiry') {
      const stopped = await post(`/api/v1/devices/${device.id}/commission`, { action: 'stop', reason: 'Measure GPIO lease expiry without an OFF command' });
      if (stopped.state !== 'stopped') throw new Error('Disarm was not confirmed');
    } else await external('inject');
    faultBracket = [start, monotonic()];
  }
  await waitFor(() => scope.queryText(':TRIG:STAT?') === 'STOP');
  const preamble = scope.queryText(':WAV:PRE?');
  const block = scope.queryBlock(':WAV:DATA?');
  writeFileSync(`${directory}/preamble.txt`, preamble + '\n');
  writeFileSync(`${directory}/waveform.bin`, block);
  const wave = decodeWaveform(preamble, block);
  writeFileSync(`${directory}/waveform.csv`, 'seconds,volts\n' + wave.map(p => `${p.seconds},${p.volts}`).join('\n') + '\n');
  const pulse = faultMode ? assessFaultPulse(wave) : assessPulse(wave);
  result = faultMode ? { ...pulse, on, faultBracket, delay: mode === 'device-reset' ? null : failureDelay({ pulseSeconds: pulse.widthSeconds, sampleSeconds: pulse.sampleIntervalSeconds, on, fault: faultBracket!, maximumSeconds: 3.5 }) } : pulse;
  if (faultMode) {
    if (mode !== 'lease-expiry') await external('restore');
    if (mode === 'server-loss') {
      await waitFor(async () => {
        try { return (await api.get('/api/v1/health/ready')).ok(); } catch { return false; }
      }, 20000);
      // Sessions are persisted, but verify access after the complete API process restart.
      await get(`/api/v1/devices/${device.id}/runtime`);
    }
    // A separate fresh AUTO sweep checks the recovered/stopped output. The gap is not covered.
    scope.write(':TRIG:SWE AUTO');
    if (scope.queryText(':TRIG:SWE?') !== 'AUTO') throw new Error('AUTO sweep was not confirmed');
    scope.write(':RUN');
    await sleep(14000);
    scope.write(':STOP');
    await waitFor(() => scope.queryText(':TRIG:STAT?') === 'STOP');
    const lowPreamble = scope.queryText(':WAV:PRE?');
    const lowBlock = scope.queryBlock(':WAV:DATA?');
    writeFileSync(`${directory}/recovery-preamble.txt`, lowPreamble + '\n');
    writeFileSync(`${directory}/recovery-waveform.bin`, lowBlock);
    const lowWave = decodeWaveform(lowPreamble, lowBlock);
    writeFileSync(`${directory}/recovery-waveform.csv`, 'seconds,volts\n' + lowWave.map(p => `${p.seconds},${p.volts}`).join('\n') + '\n');
    const runtime = await get(`/api/v1/devices/${device.id}/runtime`);
    if (!['stopped', 'faulted'].includes(runtime.state)) throw new Error('Runtime automatically resumed');
    observation = { low: assessLow(lowWave, 10), runtime };
  }
  checkStatus();
  console.log(JSON.stringify(result));
} catch (error) { failure = error; }
finally {
  if (mayBeArmed) {
    try {
      const stopped = await post(`/api/v1/devices/${cfg.deviceId}/commission`, { action: 'stop', reason: 'End automated Rigol LED check' });
      if (stopped.state !== 'stopped' || (!faultMode && stopped.error)) throw new Error('Bench did not stop cleanly');
      console.log('LED bench disarmed.');
    } catch (error) { failure ??= error; }
  }
  if (fd !== undefined) closeSync(fd);
  await api.dispose();
  writeFileSync(`${directory}/result.json`, JSON.stringify({ at: new Date().toISOString(), passed: !failure, mode, scopeBandwidth: '20M', gpio: 18, commands, measurement: result, observation, error: failure instanceof Error ? failure.message : failure ? 'Unknown failure' : null }, null, 2));
}
if (failure) throw failure;
console.log(`Evidence saved to ${directory}`);
