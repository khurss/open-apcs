import { openSync, closeSync, fstatSync, readSync, writeSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { request } from '@playwright/test';
import { Scpi } from '../../packages/bench/src/scpi.js';
import { decodeWaveform, assessPulse } from '../../packages/bench/src/rigol.js';

// Explicit, private LED-only bench config. This entry point is never included in make test.
const cfg = JSON.parse(readFileSync('/run/bench/config.json', 'utf8')) as { origin: string; deviceId: string; scopeSerial: string; gpio: number; credentialsFile: string };
if (process.argv[2] !== 'led-pulse' || cfg.gpio !== 18 || !/^[0-9a-f-]{36}$/.test(cfg.deviceId) || !/^DS1[A-Z0-9]+$/.test(cfg.scopeSerial) || new URL(cfg.origin).protocol !== 'https:') throw new Error('Explicit HTTPS, scope identity, GPIO18 and led-pulse mode required');
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
  writeFileSync(`${directory}/scope-before.json`, JSON.stringify({ at: new Date().toISOString(), identity, probe: scope.queryText(':CHAN1:PROB?'), scale: scope.queryText(':CHAN1:SCAL?'), offset: scope.queryText(':CHAN1:OFFS?'), timebase: scope.queryText(':TIM:SCAL?') }, null, 2));
  // No factory reset. These settings are explicit and remain for inspection after the test.
  for (const command of [':STOP', ':CHAN1:DISP ON', ':CHAN1:PROB 10', ':CHAN1:COUP DC', ':CHAN1:INV OFF', ':CHAN1:SCAL 1', ':CHAN1:OFFS -1.6', ':CHAN2:DISP OFF', ':CHAN3:DISP OFF', ':CHAN4:DISP OFF', ':TIM:MODE MAIN', ':TIM:SCAL 0.5', ':TIM:OFFS 0', ':ACQ:TYPE NORM', ':TRIG:MODE EDGE', ':TRIG:COUP DC', ':TRIG:EDGE:SOUR CHAN1', ':TRIG:EDGE:SLOP POS', ':TRIG:EDGE:LEV 1.65', ':WAV:SOUR CHAN1', ':WAV:MODE NORM', ':WAV:FORM BYTE', ':WAV:STAR 1', ':WAV:STOP 1200']) scope.write(command);
  if (scope.queryText('*OPC?') !== '1' || Number(scope.queryText(':CHAN1:PROB?')) !== 10) throw new Error('Scope configuration was not confirmed');
  // This firmware times out on SYST:ERR?; verify settings directly and inspect ESR.
  const checks: [string, string | number][] = [[':CHAN1:COUP?', 'DC'], [':CHAN1:INV?', 0], [':CHAN1:SCAL?', 1], [':CHAN1:OFFS?', -1.6], [':TIM:SCAL?', 0.5], [':TIM:OFFS?', 0], [':TRIG:MODE?', 'EDGE'], [':TRIG:EDGE:SOUR?', 'CHAN1'], [':TRIG:EDGE:SLOP?', 'POS'], [':TRIG:EDGE:LEV?', 1.65], [':WAV:SOUR?', 'CHAN1'], [':WAV:MODE?', 'NORM'], [':WAV:FORM?', 'BYTE'], [':ACQ:TYPE?', 'NORM']];
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
    const accepted = await post('/api/v1/commands', { targetSignalId: outputs[0].id, value, ttlMs: 3000, expectedProjectRevision: project.revision, reason: 'Rigol GPIO18 pulse measurement' }, { 'idempotency-key': randomUUID() });
    await waitFor(async () => {
      const c = await get(`/api/v1/commands/${accepted.id}`);
      if (['Rejected','Failed','Expired','Uncertain','Cancelled'].includes(c.state)) throw new Error(`Command ended ${c.state}`);
      return c.state === 'Verified';
    }, 4000);
    commands.push({ id: accepted.id, value, sentAt, verifiedAt: new Date().toISOString() });
  }
  await command(false);
  scope.write(':SING');
  await waitFor(() => scope.queryText(':TRIG:STAT?') === 'WAIT');
  // Allow the low pretrigger window to fill before commanding the rising edge.
  await sleep(3500);
  if (scope.queryText(':TRIG:STAT?') !== 'WAIT') throw new Error('Unexpected trigger before ON');
  console.log('Capturing one ON/OFF pulse on CH1.');
  await command(true);
  await sleep(1000);
  await command(false);
  await waitFor(() => scope.queryText(':TRIG:STAT?') === 'STOP');
  const preamble = scope.queryText(':WAV:PRE?');
  const block = scope.queryBlock(':WAV:DATA?');
  writeFileSync(`${directory}/preamble.txt`, preamble + '\n');
  writeFileSync(`${directory}/waveform.bin`, block);
  const wave = decodeWaveform(preamble, block);
  writeFileSync(`${directory}/waveform.csv`, 'seconds,volts\n' + wave.map(p => `${p.seconds},${p.volts}`).join('\n') + '\n');
  result = assessPulse(wave);
  checkStatus();
  console.log(JSON.stringify(result));
} catch (error) { failure = error; }
finally {
  if (mayBeArmed) {
    try {
      const stopped = await post(`/api/v1/devices/${cfg.deviceId}/commission`, { action: 'stop', reason: 'End automated Rigol LED check' });
      if (stopped.state !== 'stopped' || stopped.error) throw new Error('Bench did not stop cleanly');
      console.log('LED bench disarmed.');
    } catch (error) { failure ??= error; }
  }
  if (fd !== undefined) closeSync(fd);
  await api.dispose();
  writeFileSync(`${directory}/result.json`, JSON.stringify({ at: new Date().toISOString(), passed: !failure, gpio: 18, commands, measurement: result, error: failure instanceof Error ? failure.message : failure ? 'Unknown failure' : null }, null, 2));
}
if (failure) throw failure;
console.log(`Evidence saved to ${directory}`);
