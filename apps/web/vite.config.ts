import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true, proxy: { '/api': { target: process.env.APCS_API_PROXY ?? 'http://api:3000', changeOrigin: false } } },
});
