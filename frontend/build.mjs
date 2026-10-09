// frontend/build.mjs — single-file distribution. vite builds each page (with the same vite.config.ts as `npm run dev`).
// Then this script puts every emitted chunk / stylesheet / asset back into the HTML. So the result works from file://
// with no sibling files, ethers included.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const configFile = resolve(here, '..', 'vite.config.ts');
const { values } = parseArgs({ options: { out: { type: 'string' } } });
const out = values.out ? resolve(values.out) : resolve(here, 'dist');
const PAGE = 'index.html', OUTPUT = 'neurom-studio.html';
const WORKER_GLOBAL = '__NEUROM_WORKER_SOURCE__';

const common = {
  configFile, root: here, logLevel: 'warn', base: './',
  build: { write: false, target: 'es2022', modulePreload: false, assetsInlineLimit: () => true, cssCodeSplit: false, copyPublicDir: false },
};

/** training/client.js only gets to `new Worker(new URL('./worker.js', import.meta.url))` when the injected global is
 *  missing. Inside one HTML file that URL can never resolve. Without this plugin, vite emits the worker as a sibling
 *  chunk. The plugin replaces the base with document.baseURI (identical for an inline module script). So the dead
 *  fallback stays inert. */
const inertWorkerFallback = {
  name: 'neurom:inert-worker-fallback', enforce: 'pre',
  transform(code, id) {
    if (!id.endsWith('/training/client.js')) return null;
    return code.replace("new URL('./worker.js', import.meta.url)", "new URL('./worker.js', document.baseURI)");
  },
};

async function bundlePage(html) {
  const { output } = await build({
    ...common, plugins: [inertWorkerFallback],
    build: { ...common.build, rollupOptions: { input: resolve(here, html), output: { inlineDynamicImports: true } } },
  });
  const text = name => {
    const item = output.find(o => o.fileName === name);
    if (!item) throw new Error(`${html}: vite did not emit ${name}`);
    return item.type === 'chunk' ? item.code : Buffer.from(item.source).toString('utf8');
  };
  let page = text(html);
  const scripts = page.match(/<script type="module"[^>]*src="\.\/(assets\/[^"]+)"><\/script>/g) ?? [];
  if (scripts.length !== 1) throw new Error(`${html}: expected one module entry, found ${scripts.length}`);
  for (const tag of page.match(/<link rel="stylesheet"[^>]*href="\.\/(assets\/[^"]+)">/g) ?? []) {
    page = page.replace(tag, () => `<style>\n${text(/assets\/[^"]+/.exec(tag)[0]).replaceAll('</style', '<\\/style')}\n</style>`);
  }
  const entry = text(/assets\/[^"]+/.exec(scripts[0])[0]);
  page = page.replace(scripts[0], () => `<script type="module">\n${inlineJS(entry)}\n</script>`);
  if (/(src|href)="\.\/assets\//.test(page)) throw new Error(`${html}: an asset was not inlined`);
  return page;
}

// The training worker is a classic (IIFE) script. training/client.js gets it through a global, so no worker URL is necessary.
async function bundleWorker() {
  const { output } = await build({
    ...common,
    build: { ...common.build, rollupOptions: { input: resolve(here, 'training/worker.js'), output: { format: 'iife', entryFileNames: 'worker.js' }, preserveEntrySignatures: false } },
  });
  if (output.length !== 1 || output[0].type !== 'chunk') throw new Error('worker bundle must be a single chunk');
  return output[0].code;
}

// `<\/script` is the same string / regex / template character sequence, but no longer closes the inline script.
const inlineJS = js => js.replaceAll('</script', '<\\/script');

const worker = inlineJS(JSON.stringify(await bundleWorker()));
const html = (await bundlePage(PAGE)).replace('<script type="module">', () => `<script>globalThis.${WORKER_GLOBAL} = ${worker};</script>\n<script type="module">`);
await mkdir(out, { recursive: true });
await writeFile(resolve(out, OUTPUT), html);
console.log(`wrote ${OUTPUT} (${Buffer.byteLength(html)} bytes)`);
