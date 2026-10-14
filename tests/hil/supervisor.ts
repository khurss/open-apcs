import {confirmedStopped} from '../../packages/bench/src/cleanup-state.js';
import { fork } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import { request } from '@playwright/test';
import { supervise } from '../../packages/bench/src/supervise.js';
const mode = process.env.APCS_HIL_MODE ?? 'led-pulse';
const seconds = Number(mode === 'transport-session' ? process.env.APCS_TRACE_SECONDS ?? 600 : process.env.APCS_L0_SECONDS ?? 3600);
if(mode === 'transport-session' && (!Number.isInteger(seconds)||seconds<10||seconds>3600))throw new Error('Session duration must be 10–3600 seconds');
if (mode === 'l0' && (!Number.isInteger(seconds) || seconds < 60 || seconds > 3600)) throw new Error('L0 duration must be 60–3600 seconds');
const virtualDevices = new Set<string>();
const graphs = new Set<string>();
const child = fork(new URL(mode === 'l0' ? '../load/l0.ts' : mode === 'transport-session' ? './transport-session.ts' : './rigol-led.ts', import.meta.url), [mode], { execArgv: ['--import', '/workspace/apps/api/node_modules/tsx/dist/loader.mjs'], stdio: ['ignore','inherit','inherit','ipc'] });
child.on('message', message => {
  if (mode === 'l0' && message && typeof message === 'object' && 'graphId' in message && typeof message.graphId === 'string' && /^[0-9a-f-]{36}$/.test(message.graphId)) graphs.add(message.graphId);
  if (mode === 'l0' && message && typeof message === 'object' && 'virtualDevice' in message && typeof message.virtualDevice === 'string' && /^[0-9a-f-]{36}$/.test(message.virtualDevice)) virtualDevices.add(message.virtualDevice);
});
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => child.kill('SIGKILL'));
await supervise(child, async (armed, locked) => {
  try {
    if (armed || virtualDevices.size || graphs.size) {
      const cfg = JSON.parse(readFileSync('/run/bench/config.json', 'utf8'));
      const access = readFileSync(cfg.credentialsFile, 'utf8');
      const api = await request.newContext({ baseURL: cfg.origin, extraHTTPHeaders: { origin: cfg.origin }, timeout: 5000 });
      try {
        const login = await api.post('/api/v1/auth/login', { data: { username: access.match(/^Username: (.+)$/m)?.[1], password: access.match(/^Password: (.+)$/m)?.[1] } });
        if (!login.ok()) throw new Error('Supervisor login failed; inspect physical bench');
        const { csrfToken } = await login.json();
        const paths = [...[...graphs].map(id => `/api/v1/graphs/${id}/runtime`), ...(armed ? [`/api/v1/devices/${cfg.deviceId}/commission`] : []), ...[...virtualDevices].map(id => `/api/v1/devices/${id}/runtime`)];
        const failures = [];
        for (const path of paths) {
          try {
            const response = await api.post(path, { headers: { 'x-csrf-token': csrfToken }, data: { action: 'stop', reason: 'Independent HIL supervisor cleanup' } });
            if (!response.ok() || !confirmedStopped(path,(await response.json()).state)) throw new Error('Supervisor could not stop target');
          } catch (error) { failures.push(error); }
        }
        if (failures.length) throw new Error('Supervisor could not stop every target; inspect bench');
        console.log('Independent supervisor confirmed stopped runtime.');
      } finally { await api.dispose(); }
    }
  } finally {
    if (locked) try { unlinkSync('/artifacts/rigol.lock'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}, mode === 'l0' ? (seconds + 600) * 1000 : mode === 'transport-session' ? (seconds + 60) * 1000 : 90000);
