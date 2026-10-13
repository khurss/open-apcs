import { fork } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import { request } from '@playwright/test';
import { supervise } from '../../packages/bench/src/supervise.js';
const child = fork(new URL('./rigol-led.ts', import.meta.url), [process.env.APCS_HIL_MODE ?? 'led-pulse'], { execArgv: ['--import', '/workspace/apps/api/node_modules/tsx/dist/loader.mjs'], stdio: ['ignore','inherit','inherit','ipc'] });
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => child.kill('SIGKILL'));
await supervise(child, async (armed, locked) => {
  try {
    if (armed) {
      const cfg = JSON.parse(readFileSync('/run/bench/config.json', 'utf8'));
      const access = readFileSync(cfg.credentialsFile, 'utf8');
      const api = await request.newContext({ baseURL: cfg.origin, extraHTTPHeaders: { origin: cfg.origin }, timeout: 5000 });
      try {
        const login = await api.post('/api/v1/auth/login', { data: { username: access.match(/^Username: (.+)$/m)?.[1], password: access.match(/^Password: (.+)$/m)?.[1] } });
        if (!login.ok()) throw new Error('Supervisor login failed; inspect physical bench');
        const { csrfToken } = await login.json();
        const response = await api.post(`/api/v1/devices/${cfg.deviceId}/commission`, { headers: { 'x-csrf-token': csrfToken }, data: { action: 'stop', reason: 'Independent HIL supervisor cleanup' } });
        if (!response.ok() || (await response.json()).state !== 'stopped') throw new Error('Supervisor could not disarm; inspect physical bench');
        console.log('Independent supervisor confirmed stopped runtime.');
      } finally { await api.dispose(); }
    }
  } finally {
    if (locked) try { unlinkSync('/artifacts/rigol.lock'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}, 90000);
