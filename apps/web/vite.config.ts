import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const tlsDirectory = process.env.APCS_WEB_TLS_DIR;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    fs: { deny: ['.env', '.env.*', '*.{crt,pem,key,p12,pfx,cer,der}', '.npmrc', '.yarnrc.yml', '**/.git/**', '**/.cache/**', join(import.meta.dirname, 'dist/**'), join(import.meta.dirname, '../../dist/**')] },
    ...(tlsDirectory ? { https: { key: readFileSync(join(tlsDirectory, 'server.key')), cert: readFileSync(join(tlsDirectory, 'server.crt')) } } : {}),
    proxy: { '/api': { target: process.env.APCS_API_PROXY ?? 'http://api:3000', changeOrigin: false } },
  },
});
