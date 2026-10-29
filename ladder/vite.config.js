// vite.config.js — the ladder page (ADR 0027). The Vite root is this directory. The page imports modules of
// `../frontend/` (chain configuration, chain bridge, scenario runtime), so the dev server may serve files of the whole
// repo. `vite build` writes `dist/`, which Vercel serves beside the functions in `api/`.
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = fileURLToPath(new URL('.', import.meta.url));
const repo = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig({
  root: here,
  publicDir: false,
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: false,
    fs: { allow: [repo] },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
