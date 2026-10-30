// editor/renderers/script-module-runtime.js — the sandbox side of the script module (ADR 0019). This is a classic
// script, not an ES module. script-frame.js inlines it after Vue (the global `Vue`) into the frame document of
// scriptModuleDocument. It has no access to the workbench: the frame has the sandbox and the CSP of a view script
// (ADR 0013).
//
// Messages, host → frame:
// - { type: 'load', modules, text }: the rewritten files (script-module.js compileScript) and the texts of `@ui` in the
//   UI language. The frame runs `main.js` one time.
// - { type: 'text', text }: new texts after a change of the UI language.
// - { type: 'values', functions, values }: the declared function inputs, and each value input as `{ value }` or
//   `{ error }`. The host sends it before `load` and again when one of them changes.
// - { type: 'reply', id, result } or { type: 'reply', id, error }: the answer to the call `id`.
// - { type: 'play' }: play, as the play button of `Controls` does (「运行到这里」 sends it right after `load`).
// Messages, frame → host (`window.parent`):
// - { type: 'ready' } when the frame listens.
// - { type: 'ok' } after a reset (the host clears the error and drops the replies of the old run). A new frame
//   starts with no error.
// - { type: 'error', message, file, line } for an error that the script throws. file and line are null when unknown.
// - { type: 'error', code, params } for an error of the contract or of a view template. The host words it (`export`,
//   `views`, `layout`, `template`).
// - { type: 'call', id, name, args }: a call of the function input `name` (core/script-calls.js runs it on the page).
//
// The run: `main(ctx)` waits for `ctx.frame()` at the start of each round.
// - step releases one round. If `main` does not wait yet, its next `frame()` returns at once (one per step).
// - play releases rounds in sequence, one each INTERVAL ms. pause stops that.
// - reset starts `main` again with a new `ctx.state`. The old `main` waits forever on its next `frame()` and on the
//   calls it made: the frame drops their replies.
// `ctx.call.<name>(…args)` returns a promise of the result. `ctx.values.<name>` is the value of a value input. A name
// that is not declared, and a value input without a value, throw an error at the line of the script that reads it.
(() => {
  'use strict';
  const { reactive, shallowReactive, markRaw, createApp, h, toRaw } = Vue;
  const INTERVAL = 200;
  const send = m => parent.postMessage(m, '*');

  /** an error of the script: its message, and the file and line of the first stack frame in a file of the module */
  const located = (() => {
    // new Function adds lines in front of the body. A probe measures how many.
    let shift = 0;
    try { new Function('\nthrow new Error("probe")\n//# sourceURL=neurom-script/probe')(); }
    catch (e) { const m = /neurom-script\/probe:(\d+)/.exec(String(e && e.stack)); if (m) shift = Number(m[1]) - 2; }
    return err => {
      const m = /neurom-script\/([^:\s)]+):(\d+)/.exec(String((err && err.stack) || ''));
      return { type: 'error', message: String((err && err.message) || err), file: m ? m[1] : null, line: m ? Number(m[2]) - shift : null };
    };
  })();
  const fail = err => { run.running = false; clearTimeout(timer); send(located(err)); };
  // an error the script throws later, for example in its own setTimeout or in a promise that nothing waits for
  addEventListener('error', e => fail(e.error ?? e.message));
  addEventListener('unhandledrejection', e => fail(e.reason));

  // ------------------------------------------------------------------ `@ui`
  const text = reactive({ reset: 'reset', step: 'step', play: 'play', pause: 'pause', round: '{n}', done: 'done', call: 'no function input {name}', value: 'no value input {name}' });
  const fill = (s, params) => s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
  const Controls = {
    name: 'Controls',
    props: ['run'],
    setup(props) {
      return () => {
        const r = props.run;
        return h('div', { class: 'nm-controls' }, [
          h('button', { type: 'button', onClick: () => r.reset() }, text.reset),
          h('button', { type: 'button', disabled: r.done, onClick: () => r.step() }, text.step),
          r.running
            ? h('button', { type: 'button', class: 'on', onClick: () => r.pause() }, text.pause)
            : h('button', { type: 'button', disabled: r.done, onClick: () => r.play() }, text.play),
          h('span', { class: 'nm-round' }, r.done ? `${fill(text.round, { n: r.steps })} · ${text.done}` : fill(text.round, { n: r.steps })),
        ]);
      };
    },
  };
  const UI = Object.freeze({ Controls: markRaw(Controls) });

  // ------------------------------------------------------------------ loader
  let modules = {};
  const cache = new Map();
  function load(name) {
    if (name === '@ui') return UI;
    if (cache.has(name)) return cache.get(name);
    const exports = {};
    cache.set(name, exports);
    const star = from => { for (const k of Object.keys(from)) if (k !== 'default' && !(k in exports)) Object.defineProperty(exports, k, { enumerable: true, get: () => from[k] }); };
    new Function('__nm_import', '__nm_exports', '__nm_star', modules[name])(load, exports, star);
    return exports;
  }

  // ------------------------------------------------------------------ inputs: `ctx.call`, `ctx.values`
  let functions = new Set(), values = {}, lastId = 0;
  /** the calls that wait for a reply: id → { resolve, reject, error } */
  const waiting = new Map();
  /** a copy without Vue proxies, so postMessage can clone it (a script passes `ctx.state.…`) */
  const plain = v => {
    v = toRaw(v);
    if (Array.isArray(v)) return v.map(plain);
    if (v && typeof v === 'object' && !ArrayBuffer.isView(v)) { const o = {}; for (const k of Object.keys(v)) o[k] = plain(v[k]); return o; }
    return v;
  };
  function callInput(name, args) {
    // made here, so an error of the call shows the line of the script that called
    const error = new Error(name);
    return new Promise((resolve, reject) => {
      const id = ++lastId;
      waiting.set(id, { resolve, reject, error });
      send({ type: 'call', id, name, args: plain(args) });
    });
  }
  function answer({ id, result, error }) {
    const w = waiting.get(id);
    if (!w) return;   // a call of a run that was reset
    waiting.delete(id);
    if (error === undefined) w.resolve(result);
    else { w.error.message = String(error); w.reject(w.error); }
  }
  const call = new Proxy({}, {
    get(_, name) {
      if (typeof name !== 'string') return undefined;
      if (!functions.has(name)) throw new Error(fill(text.call, { name }));
      return (...args) => callInput(name, args);
    },
  });
  const valueOf = new Proxy({}, {
    get(_, name) {
      if (typeof name !== 'string') return undefined;
      const v = Object.hasOwn(values, name) ? values[name] : null;
      if (!v) throw new Error(fill(text.value, { name }));
      if (Object.hasOwn(v, 'error')) throw new Error(v.error);
      return v.value;
    },
    has: (_, name) => Object.hasOwn(values, name),
    ownKeys: () => Object.keys(values),
    getOwnPropertyDescriptor: (_, name) => (Object.hasOwn(values, name) ? { enumerable: true, configurable: true } : undefined),
  });

  // ------------------------------------------------------------------ run
  let main = null, gen = 0, pending = null, credit = 0, timer = 0;
  const run = reactive({ steps: 0, running: false, done: false, reset, step, play, pause, toggle: () => (run.running ? pause() : play()) });
  const view = shallowReactive({ state: reactive({}) });
  function release() {
    const p = pending; pending = null;
    if (p) { run.steps++; p(); }
  }
  function frame(g) {
    if (g !== gen) return new Promise(() => {});
    if (credit) { credit--; run.steps++; return Promise.resolve(); }
    return new Promise(resolve => {
      pending = resolve;
      if (run.running) timer = setTimeout(release, INTERVAL);
    });
  }
  function step() { pause(); if (pending) release(); else if (!run.done) credit++; }
  function play() { if (run.done) return; run.running = true; if (pending) release(); }
  function pause() { run.running = false; clearTimeout(timer); }
  function reset() {
    pause();
    gen++; pending = null; credit = 0; waiting.clear();
    Object.assign(run, { steps: 0, done: false });
    send({ type: 'ok' });
    view.state = reactive({});
    start();
  }
  function start() {
    const g = gen, ctx = { state: view.state, frame: () => frame(g), call, values: valueOf };
    Promise.resolve().then(() => main(ctx)).then(
      () => { if (g === gen) { run.done = true; pause(); } },
      err => { if (g === gen) { run.done = true; fail(err); } });
  }

  // ------------------------------------------------------------------ the module: load main.js, mount the views
  function layoutStyle(layout) {
    if (layout === undefined || layout === null) return null;
    const ok = typeof layout === 'object' && ['columns', 'rows'].every(k => layout[k] === undefined || typeof layout[k] === 'string')
      && (layout.areas === undefined || typeof layout.areas === 'string' || (Array.isArray(layout.areas) && layout.areas.every(a => typeof a === 'string')));
    if (!ok) throw Object.assign(new Error('layout'), { contract: 'layout' });
    const areas = Array.isArray(layout.areas) ? layout.areas.map(a => JSON.stringify(a.trim().split(/\s+/).join(' '))).join(' ') : layout.areas;
    return { gridTemplateColumns: layout.columns, gridTemplateRows: layout.rows, gridTemplateAreas: areas };
  }
  /** `state` and `run`, or only those of them that the component declares, so the others do not fall through as
   *  attributes of its root element */
  function viewProps(component) {
    const p = component.props, names = Array.isArray(p) ? p : p && typeof p === 'object' ? Object.keys(p) : null;
    const all = { state: view.state, run };
    return names ? Object.fromEntries(Object.entries(all).filter(([k]) => names.includes(k))) : all;
  }
  function mount() {
    const mod = load('main.js').default;
    if (!mod || typeof mod !== 'object' || typeof mod.main !== 'function') throw Object.assign(new Error('export'), { contract: 'export' });
    const views = mod.views ?? {};
    if (typeof views !== 'object' || Object.values(views).some(v => !v || (typeof v !== 'object' && typeof v !== 'function'))) throw Object.assign(new Error('views'), { contract: 'views' });
    const grid = layoutStyle(mod.layout);
    main = mod.main;
    const cells = Object.entries(views).map(([name, component]) => ({ name, component: markRaw(component) }));
    const app = createApp({
      render: () => h('div', { class: grid ? 'nm-grid' : 'nm-grid nm-auto', style: grid ?? undefined },
        cells.map(c => h('section', { key: c.name, class: 'nm-view', style: grid ? { gridArea: c.name } : undefined }, [h(c.component, viewProps(c.component))]))),
    });
    app.config.errorHandler = err => fail(err);
    // the production build of Vue does not report a template error itself
    app.config.compilerOptions.onError = err => { pause(); send({ type: 'error', code: 'template', params: { message: String(err.message) } }); };
    app.mount(document.getElementById('root'));
    start();
  }

  addEventListener('message', e => {
    if (e.source !== parent || !e.data) return;
    if (e.data.text) Object.assign(text, e.data.text);
    if (e.data.type === 'values') { functions = new Set(e.data.functions); values = e.data.values; return; }
    if (e.data.type === 'reply') { answer(e.data); return; }
    if (e.data.type === 'play') { play(); return; }
    if (e.data.type !== 'load') return;
    modules = e.data.modules;
    try { mount(); }
    catch (err) { if (err && err.contract) send({ type: 'error', code: err.contract, params: {} }); else send(located(err)); }
  });
  send({ type: 'ready' });
})();
