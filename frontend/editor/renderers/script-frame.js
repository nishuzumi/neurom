// editor/renderers/script-frame.js — the document a view script runs in (ADR 0013). It is loaded as the `srcdoc` of an
// `<iframe sandbox="allow-scripts">`. There is no allow-same-origin, so the origin is opaque and nothing of the
// workbench is reachable. A CSP forbids every request, so the script can neither load code nor send data out. Vue is
// inlined before the script as the global `Vue`. It is the full global build, with its template compiler. That is the
// reason for 'unsafe-eval', which is harmless inside the sandbox. The script is inlined as its own classic <script>,
// so a top-level `const component` / `function render` is visible to the host part after it.
// A script module (ADR 0019) runs in a document of the same kind: scriptModuleDocument, with the sandbox side of its
// loader (script-module-runtime.js) in place of the script.
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

/** the :root declarations of a frame: the workbench's colour variables (`--name` → value) and `color-scheme` */
function rootStyle(/** @type {Record<string, string>} */ vars, /** @type {string} */ scheme) {
  const props = Object.entries(vars).filter(([k]) => /^--[\w-]+$/.test(k)).map(([k, v]) => `${k}:${String(v).replace(/[;{}<]/g, '')}`);
  return [...props, `color-scheme:${String(scheme).replace(/[^\w ]/g, '')}`].join(';');
}
const meta = ['<!doctype html><html><head><meta charset="utf-8">', `<meta http-equiv="Content-Security-Policy" content="${SCRIPT_CSP}">`];

/**
 * The frame document for `source`. Its :root has the workbench's colour variables (`vars`: `--name` → value) and
 * `color-scheme`. A frame whose colour scheme differs from its embedder's is painted on an opaque backdrop. `vue` (the
 * text of vue.global.prod.js) is inlined before the script. `offset`: the document lines before the script's first
 * line (a document line minus offset = the script's line).
 * @param {string} source  @param {Record<string, string>} vars  @param {string} vue  @param {string} [scheme]
 * @returns {{ html: string, offset: number }}
 */
export function scriptDocument(source, vars, vue, scheme = 'normal') {
  const head = (/** @type {number} */ offset) => [
    ...meta,
    // the host sizes the frame to its content height, so the frame itself never scrolls (a scrollbar would narrow it)
    `<style>:root{${rootStyle(vars, scheme)}}html,body{margin:0;overflow:hidden;background:transparent;color:var(--ink,#e6e8ec);font:12px/1.4 system-ui,sans-serif}#root{display:block}</style>`,
    guard(offset),
    `<script>${inline(vue)}</script>`,
    '</head><body><div id="root"></div>',
    '<script>',
  ].join('\n');
  const offset = head(0).split('\n').length;
  const html = `${head(offset)}\n${inline(source)}\n</script>\n<script>${host(offset)}</script></body></html>`;
  return { html, offset };
}

/** the script module's frame: the views grid fills the frame, each view scrolls on its own, `@ui` looks like the
 *  workbench's controls */
const MODULE_STYLE = [
  'html,body,#root{height:100%;margin:0}',
  'body{overflow:hidden;background:transparent;color:var(--ink,#e6e8ec);font:12px/1.45 system-ui,"PingFang SC",sans-serif}',
  '*{box-sizing:border-box}',
  '.nm-grid{display:grid;gap:8px;height:100%;min-width:0;overflow:auto}',
  '.nm-auto{grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr));grid-auto-rows:minmax(140px,1fr)}',
  '.nm-view{min-width:0;min-height:0;overflow:auto;scrollbar-width:thin;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--bg)}',
  'button{font:inherit;font-size:12px;padding:2px 10px;border:1px solid var(--line-strong);border-radius:6px;background:var(--soft);color:var(--ink);cursor:pointer;line-height:1.5}',
  'button:hover{background:var(--line-strong)}',
  'button:focus-visible{outline:2px solid var(--focus);outline-offset:1px}',
  'button:disabled{opacity:.4;cursor:default}',
  'button.on{border-color:var(--focus);color:var(--focus)}',
  '.nm-controls{display:flex;flex-wrap:wrap;align-items:center;gap:6px;min-width:0}',
  '.nm-round{font-family:var(--mono);font-size:11px;color:var(--muted);white-space:nowrap}',
].join('');

/**
 * The frame document of a script module (ADR 0019): the same CSP and colours as a view script, Vue, then `runtime`
 * (the text of script-module-runtime.js). The files arrive later, in the `load` message.
 * @param {Record<string, string>} vars  @param {string} vue  @param {string} runtime  @param {string} [scheme]
 */
export function scriptModuleDocument(vars, vue, runtime, scheme = 'normal') {
  return [
    ...meta,
    `<style>:root{${rootStyle(vars, scheme)}}${MODULE_STYLE}</style>`,
    `<script>${inline(vue)}</script>`,
    '</head><body><div id="root"></div>',
    `<script>${inline(runtime)}</script>`,
    '</body></html>',
  ].join('\n');
}

/** the workbench's colour variables (every custom property a :root rule declares), so a script can use var(--spike) */
export function themeVars() {
  /** @type {Set<string>} */
  const names = new Set(), style = getComputedStyle(document.documentElement), /** @type {Record<string, string>} */ out = {};
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }
    for (const rule of rules) if (rule instanceof CSSStyleRule && rule.selectorText === ':root') for (const name of rule.style) if (name.startsWith('--')) names.add(name);
  }
  for (const name of names) { const v = style.getPropertyValue(name).trim(); if (v) out[name] = v; }
  return out;
}
