import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  root: 'src/agent-editor',
  base: '/agent/',
  build: { outDir: '../../dist/agent', emptyOutDir: true },
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:4318' },
  },
});
