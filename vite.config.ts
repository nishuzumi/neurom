// vite.config.ts — source dev server for frontend/ (TS / SFC / JSON imports). frontend/build.mjs makes the single-file
// distribution. It uses this config through the build() API of vite.
import { fileURLToPath } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

/** training/workspace.py: every request must carry a loopback Host:port and, when present, a same-origin Origin. */
const WORKSPACE_ORIGIN = 'http://127.0.0.1:18766';

export default defineConfig({
  root: fileURLToPath(new URL('./frontend', import.meta.url)),
  publicDir: false,
  plugins: [vue()],
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      // The proxy forwards only the workspace API. The dev server serves all other paths from the frontend/ source.
      '/api': {
        target: WORKSPACE_ORIGIN,
        changeOrigin: true, // Host → 127.0.0.1:18766 (Handler._origin_ok)
        configure(proxy) {
          proxy.on('proxyReq', (proxyReq, req) => {
            // The browser sends Origin: http://localhost:5173 on POST/DELETE. The workspace refuses foreign origins.
            // So the proxy shows the request as same-origin, and the server rules stay strict.
            if (req.headers.origin) proxyReq.setHeader('Origin', WORKSPACE_ORIGIN);
          });
        },
      },
    },
  },
});
