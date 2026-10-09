// editor/renderers/script-frame.js — the document a view script runs in (ADR 0013). It is loaded as the `srcdoc` of an
// `<iframe sandbox="allow-scripts">`. There is no allow-same-origin, so the origin is opaque and nothing of the
// workbench is reachable. A CSP forbids every request, so the script can neither load code nor send data out. Vue is
// inlined before the script as the global `Vue`. It is the full global build, with its template compiler. That is the
// reason for 'unsafe-eval', which is harmless inside the sandbox. The script is inlined as its own classic <script>,
// so a top-level `const component` / `function render` is visible to the host part after it.
//
// A script defines one of these:
// - `component`: a Vue component that takes the prop `ctx` (template + setup…). It is mounted once on the root and
//   re-rendered with each new ctx.
// - `render(ctx, el)`: called with each new ctx.
//
// Messages, frame → host (`window.parent`):
// - { type: 'ready' } when the frame listens.
// - { type: 'size', h } the content height.
// - { type: 'ok' } after a render.
// - { type: 'error', message, line } (line in the script, or null).
// - { type: 'missing' } when the script defines neither.
// Host → frame: { type: 'ctx', ctx }.

const SCRIPT_CSP = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:";

/** `<\/script` is the same string / regex / template character sequence, but no longer closes the inline script */
const inline = (/** @type {string} */ js) => String(js).replace(/<\/(script)/gi, '<\\/$1');

/** before the script, on one line: reports its errors, syntax errors included, with the script's own line numbers.
 *  `__scriptFailed` makes sure that a script that did not load is not also reported as defining nothing */
const guard = (/** @type {number} */ offset) => `<script>addEventListener('error', e => { self.__scriptFailed = true; parent.postMessage({ type: 'error', message: String(e.message), line: e.lineno ? e.lineno - ${offset} : null }, '*'); });</script>`;
/** after the script: mounts its component (or calls its render) per ctx, reports the content height */
const host = (/** @type {number} */ offset) => `(() => {
  const send = m => parent.postMessage(m, '*');
  const el = document.getElementById('root');
  const lineOf = err => { const m = /about:srcdoc:(\\d+):\\d+/.exec(String((err && err.stack) || '')); return m ? Number(m[1]) - ${offset} : null; };
  const fail = err => send({ type: 'error', message: String((err && err.message) || err), line: lineOf(err) });
  new ResizeObserver(() => send({ type: 'size', h: Math.ceil(document.documentElement.scrollHeight) })).observe(document.body);
  const vue = typeof component === 'object' && component !== null;
  let current = null, failed = false;
  if (vue) {
    current = Vue.shallowRef(null);
    const app = Vue.createApp({ render: () => (current.value ? Vue.h(component, { ctx: current.value }) : null) });
    app.config.errorHandler = err => { failed = true; fail(err); };
    app.mount(el);
  }
  addEventListener('message', e => {
    if (e.source !== parent || !e.data || e.data.type !== 'ctx') return;
    if (vue) { failed = false; current.value = e.data.ctx; Vue.nextTick(() => { if (!failed) send({ type: 'ok' }); }); return; }
    if (typeof render !== 'function') { if (!self.__scriptFailed) send({ type: 'missing' }); return; }
    try { render(e.data.ctx, el); send({ type: 'ok' }); } catch (err) { fail(err); }
  });
  send({ type: 'ready' });
})();`;

/**
 * The frame document for `source`. Its :root has the workbench's colour variables (`vars`: `--name` → value) and
 * `color-scheme`. A frame whose colour scheme differs from its embedder's is painted on an opaque backdrop. `vue` (the
 * text of vue.global.prod.js) is inlined before the script. `offset`: the document lines before the script's first
 * line (a document line minus offset = the script's line).
 * @param {string} source  @param {Record<string, string>} vars  @param {string} vue  @param {string} [scheme]
 * @returns {{ html: string, offset: number }}
 */
export function scriptDocument(source, vars, vue, scheme = 'normal') {
  const props = Object.entries(vars).filter(([k]) => /^--[\w-]+$/.test(k)).map(([k, v]) => `${k}:${String(v).replace(/[;{}<]/g, '')}`);
  const root = [...props, `color-scheme:${String(scheme).replace(/[^\w ]/g, '')}`].join(';');
  const head = (/** @type {number} */ offset) => [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${SCRIPT_CSP}">`,
    // the host sizes the frame to its content height, so the frame itself never scrolls (a scrollbar would narrow it)
    `<style>:root{${root}}html,body{margin:0;overflow:hidden;background:transparent;color:var(--ink,#e6e8ec);font:12px/1.4 system-ui,sans-serif}#root{display:block}</style>`,
    guard(offset),
    `<script>${inline(vue)}</script>`,
    '</head><body><div id="root"></div>',
    '<script>',
  ].join('\n');
  const offset = head(0).split('\n').length;
  const html = `${head(offset)}\n${inline(source)}\n</script>\n<script>${host(offset)}</script></body></html>`;
  return { html, offset };
}
