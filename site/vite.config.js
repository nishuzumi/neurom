// vite.config.js — the site (ADR 0027): the home page at `/` (index.html), the ladder page at `/ladder/`
// (ladder/index.html) and the participation guide at `/guide/` (guide/index.html), three inputs of one Vite build.
// The Vite root is this directory. The pages import modules of `../frontend/` (chain configuration, chain bridge,
// scenario runtime), so the dev server may serve files of the whole repo. `vite build` writes `dist/`, which Vercel
// serves beside the functions in `api/`.
// In development the same server also serves the workbench at `/studio/`, as the hosted site does, with the proxy of
// the root `vite.config.ts` to the Python workspace and its `viem` virtual module. `/api/names` is the name service
// (scripts/dev-chain.mjs).
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';
import { viemGlobal, workspaceProxy } from '../vite.config.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const repo = fileURLToPath(new URL('..', import.meta.url));
const frontend = `${repo}frontend/`;

/** Dev only: the paths of the hosted site. `/ladder`, `/studio` and `/guide` go to the directory URL, as vercel.json does.
 *  `/studio/` and `/studio/index.html` are `frontend/index.html` through the HTML pipeline of Vite. Every other
 *  `/studio/<path>` is the file `frontend/<path>` through the module pipeline, so the relative `src` and `href` of the
 *  workbench page and its imports resolve as they do under the root config. Vite serves `/ladder/` and `/guide/` itself. */
function sitePaths() {
  return {
    name: 'ladder-site-paths',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url, 'http://localhost');
        if (url.pathname === '/ladder' || url.pathname === '/studio' || url.pathname === '/guide') { res.writeHead(302, { Location: `${url.pathname}/${url.search}` }); res.end(); return; }
        if (!url.pathname.startsWith('/studio/')) { next(); return; }
        const rest = url.pathname.slice('/studio/'.length);
        if (rest !== '' && rest !== 'index.html') { req.url = `/@fs${frontend}${rest}${url.search}`; next(); return; }
        try {
          const html = await readFile(`${frontend}index.html`, 'utf8');
          res.setHeader('Content-Type', 'text/html');
          res.end(await server.transformIndexHtml('/studio/index.html', html, req.originalUrl));
        } catch (error) { next(error); }
      });
    },
  };
}

export default defineConfig({
  root: here,
  envDir: repo,
  publicDir: false,
  plugins: [vue(), sitePaths(), viemGlobal()],
  // A fixed port: Privy accepts only the origins listed in its dashboard (http://localhost:5174 and
  // http://127.0.0.1:5174). A busy port stops the server instead of moving it to an origin Privy refuses.
  server: {
    port: 5174,
    strictPort: true,
    fs: { allow: [repo] },
    proxy: {
      // the workspace API of the workbench at /studio/; /api/names stays on this server
      '^/api/(session|runs|artifacts)(/|$)': workspaceProxy,
    },
  },
  preview: { port: 5174, strictPort: true },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        home: `${here}index.html`,
        ladder: `${here}ladder/index.html`,
        guide: `${here}guide/index.html`,
      },
    },
  },
});
