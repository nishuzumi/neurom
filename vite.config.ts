// vite.config.ts — source dev server for frontend/ (TS / SFC / JSON imports). frontend/build.mjs makes the single-file
// distribution. It uses this config through the build() API of vite. site/vite.config.js imports `workspaceProxy`
// and `viemGlobal` from here: the ladder dev server serves the workbench at /studio/ with the same proxy to the Python
// workspace and the same virtual module.
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';
import vue from '@vitejs/plugin-vue';
import { defineConfig, type Plugin, type ProxyOptions } from 'vite';

/** The virtual module `virtual:viem-global`: its default export is the text of one classic script that defines the
 *  global `viem` (frontend/editor/renderers/viem-global.js bundled with esbuild). The script sandbox inlines it
 *  (script-frame.js), so the frame needs no network. One bundle per server or build. */
export function viemGlobal(): Plugin {
  const id = 'virtual:viem-global', resolved = `\0${id}`;
  const entry = fileURLToPath(new URL('./frontend/editor/renderers/viem-global.js', import.meta.url));
  let bundle: Promise<string> | null = null;
  return {
    name: 'neurom:viem-global',
    resolveId(source) { return source === id ? resolved : null; },
    async load(source) {
      if (source !== resolved) return null;
      bundle ??= esbuild({ entryPoints: [entry], bundle: true, write: false, format: 'iife', globalName: 'viem', minify: true, target: 'es2022', platform: 'browser', logLevel: 'silent' })
        .then(r => r.outputFiles[0].text);
      return `export default ${JSON.stringify(await bundle)};`;
    },
  };
}

/** training/workspace.py: every request must carry a loopback Host:port and, when present, a same-origin Origin. */
export const WORKSPACE_ORIGIN = 'http://127.0.0.1:18766';

/** The proxy entry of the workspace API (`/api/session`, `/api/runs`, `/api/artifacts`). */
export const workspaceProxy: ProxyOptions = {
  target: WORKSPACE_ORIGIN,
  changeOrigin: true, // Host → 127.0.0.1:18766 (Handler._origin_ok)
  configure(proxy) {
    proxy.on('proxyReq', (proxyReq, req) => {
      // The browser sends Origin: http://localhost:5173 on POST/DELETE. The workspace refuses foreign origins.
      // So the proxy shows the request as same-origin, and the server rules stay strict.
      if (req.headers.origin) proxyReq.setHeader('Origin', WORKSPACE_ORIGIN);
    });
  },
};

export default defineConfig({
  root: fileURLToPath(new URL('./frontend', import.meta.url)),
  envDir: fileURLToPath(new URL('.', import.meta.url)),
  publicDir: false,
  plugins: [vue(), viemGlobal()],
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      // The proxy forwards only the workspace API. The dev server serves all other paths from the frontend/ source.
      '/api': workspaceProxy,
    },
  },
});
