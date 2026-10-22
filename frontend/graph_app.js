// graph_app.js — the workbench behind index.html: a core Workspace (frontend/core) that the Vue Flow editor
// (frontend/editor) renders. Everything on the canvas is a module of a registered kind. Composites are template
// instances, stored as groups. This file owns:
//   - bootstrap
//   - persistence: localStorage (artifacts in IndexedDB, core/local-save.js) and `neurom-workbench` files (a local save
//     that it cannot read opens the conflict panel)
//   - the per-node sessions hub that the module bodies use
//   - the palette (kinds, templates, presets) and the template library drawer
//   - the Python Workspace connection.
import { shallowRef } from 'vue';
import './core/kinds/index.js';
import { Workspace } from './core/store.js';
import { createArtifactStore, localText, openLocal, savedIds } from './core/local-save.js';
import { kinds } from './core/registry.js';
import { instantiateInto } from './core/template.js';
import { structureOf } from './core/loop.js';
import { createTrainerSession, createCandidatesSession, createNetworkSession, createEvaluatorSession, createExecutionSession, createDeploymentSession, createDatasetSession, createDatasetStore, reclaimDatasets, WorkspaceClient } from './core/sessions/index.js';
import { builtinTemplates, builtinTemplate } from './templates/index.js';
import { builtinArtifacts } from './templates/artifacts/index.js';
import { connect as connectWallet } from './chain.js';
import { createVueEditor } from './editor/index.ts';
import { createTemplateLibrary } from './ui/template-library.js';
import { initLocale, locale, setLocale, onLocaleChange, t } from './i18n.js';
import { liveText, translateStatic } from './ui/static-text.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const STORAGE_KEY = 'neurom-workbench';
/** Debug / automation handle: `neurom.store`, `neurom.editor`, `neurom.session(kind, id)`. */
globalThis.neurom = { get store() { return store; }, get editor() { return editor; }, session: (kind, id) => session(kind, id) };
const PYTHON_RETRY_MS = 15000;

let store = new Workspace();
let editor = null, library = null, unsubscribeStore = null, saveTimer = null, wallet = null;
/** the header notes (save state, Python connection): set at boot, they follow the language */
let saveNote = null, pythonNote = null;
const datasets = createDatasetStore();
/** the artifacts of the local save (core/local-save.js): localStorage names them, IndexedDB holds them */
const artifactStore = createArtifactStore();
const python = { client: new WorkspaceClient(''), connected: shallowRef(false) };

// ------------------------------------------------------------------ sessions hub: one controller per (kind, node), disposed when the node leaves the graph
// Sessions change durable state only through the Workspace. Its subscription (adopt) is the only persistence route.
// The workbench does not save what a session keeps for itself (a report, the history of an execution).
const sessions = new Map();
const FACTORIES = {
  trainer: nodeId => createTrainerSession({ workspace: store, nodeId, client: python.client, datasets, evaluators: id => session('evaluator', id) }),
  candidates: nodeId => createCandidatesSession({ workspace: store, nodeId }),
  network: nodeId => createNetworkSession({ workspace: store, nodeId, builtins: builtinArtifacts }),
  evaluator: nodeId => createEvaluatorSession({ workspace: store, nodeId, datasets }),
  execution: nodeId => createExecutionSession({ workspace: store, nodeId, datasets }),
  deployment: nodeId => createDeploymentSession({ workspace: store, nodeId, connectChain, datasets, onStatus: text => status(text) }),
  dataset: nodeId => createDatasetSession({ workspace: store, store: datasets, nodeId }),
};
function session(kind, nodeId) {
  const node = store.graph.nodes.get(nodeId);
  if (!node) throw new Error(t('模块不存在：{id}', { id: nodeId }));
  if (node.kind !== kind) throw new Error(t('{id} 是 {actual} 模块，不是 {kind}', { id: nodeId, actual: node.kind, kind }));
  const key = `${kind}:${nodeId}`;
  if (!sessions.has(key)) sessions.set(key, FACTORIES[kind](nodeId));
  return sessions.get(key);
}
function sweepSessions() {
  for (const [key, s] of sessions) { const nodeId = key.slice(key.indexOf(':') + 1); if (!store.graph.nodes.has(nodeId)) { s.dispose(); sessions.delete(key); } }
}
function disposeSessions() { for (const s of sessions.values()) s.dispose(); sessions.clear(); }
async function connectChain(chainId) {
  if (wallet && wallet.chainId === chainId) return wallet;
  wallet = await connectWallet(chainId);
  if (window.ethereum?.on && !connectChain.hooked) { connectChain.hooked = true; window.ethereum.on('accountsChanged', () => { wallet = null; }); window.ethereum.on('chainChanged', () => { wallet = null; }); }
  return wallet;
}

// ------------------------------------------------------------------ persistence
// Every tab of this origin shares the one localStorage save. A tab writes only when it changed something itself. A
// stale tab that the user refreshes or closes must not write its old state over newer work. When another tab saves
// different work, this tab does not take it silently and does not write over it. It holds its own saves and asks
// (#sync-note). 载入 takes the save of the other tab. 用本页覆盖 writes the state of this tab over it.
// A local save that this tab cannot restore opens the conflict panel (#conflict, ADR 0008). While the panel is open,
// this tab writes nothing: no autosave, no 用本页覆盖, no answer to the save of another tab. The tab asks about that
// save when the panel closes. The panel stays open until the user exports the local save, opens a corrected file in
// its place or discards it.
let dirty = false;
/** the latest save of another tab that differs from this tab's work and has not been answered (its JSON text) */
let foreign = null;
/** the local save this tab could not restore, while the conflict panel is open: `{ text, error }` (its raw text, why) */
let conflict = null;
/** the artifact ids that the store is known to have (a save names only these, core/local-save.js). Nothing deletes
 *  from the store, so an id never leaves this set */
const stored = new Set();
/** the artifacts being written to the store now, or null. A failed write leaves the artifacts in the text from then on */
let storing = null, storeFailed = false;
/** Write the save now (synchronously, also on pagehide). An artifact that the store does not have yet stays in the
 *  text. Unless `final`, such artifacts first go to the store, and the save follows when they are there. */
function saveWorkspace(final = false) {
  clearTimeout(saveTimer); saveTimer = null;
  if (!dirty || conflict) return;
  if (foreign) { showForeign(); return; }
  if (editor) store.settings.canvas = editor.snapshot();
  const json = store.toJSON();
  const missing = artifactStore && !storeFailed ? json.artifacts.filter(a => !stored.has(a.id)) : [];
  if (missing.length && !final) { storeArtifacts(missing); return; }
  try {
    localStorage.setItem(STORAGE_KEY, localText(json, stored));
    dirty = false;
    saveNote.show('已自动保存 {time}', { time: new Date().toLocaleTimeString() });
  } catch (e) { saveNote.show('保存失败：{error}', { error: e.message }); }
}
function storeArtifacts(list) {
  storing ??= (async () => { for (const a of list) { await artifactStore.put(a); stored.add(a.id); } })()
    .catch(e => { storeFailed = true; saveNote.show('保存失败：{error}', { error: e.message }); })
    .finally(() => { storing = null; if (dirty) persist(); });
}
function persist() { dirty = true; clearTimeout(saveTimer); saveTimer = setTimeout(saveWorkspace, 300); }
/** a save's content without the canvas view, its artifacts as a sorted id list (in the text or named): a save that only
 *  moved the other tab's view, or stored other artifacts, is the same work */
const work = text => {
  const o = JSON.parse(text); if (o.settings) delete o.settings.canvas;
  o.artifacts = [...(o.artifactIds ?? []), ...o.artifacts.map(a => a.id)].sort(); delete o.artifactIds;
  return JSON.stringify(o);
};
/** a training run in flight here: taking another save would dispose the sessions driving it */
const training = ws => [...ws.runs.values()].some(r => r.status === 'queued' || r.status === 'running');
function followOtherTab(event) {
  if (conflict || event.storageArea !== localStorage || event.key !== STORAGE_KEY || !event.newValue) return;
  for (const id of savedIds(event.newValue)) stored.add(id);           // the other tab stored them
  let same = false; try { same = work(event.newValue) === work(JSON.stringify(store.toJSON())); } catch { same = false; }
  foreign = same ? null : event.newValue;
  showForeign();
}
function showForeign() {
  $('sync-note').hidden = !foreign;
  if (!foreign) return;
  const busy = training(store);
  $('sync-load').disabled = busy;
  $('sync-load').title = busy ? t('本页有训练在运行。训练结束后再载入') : t('载入另一个标签页保存的工作区。这会丢掉本页还没保存的修改');
  if (dirty) saveNote.show('本页的修改未保存');
}
async function loadForeign() {
  const json = foreign; if (!json || training(store)) return;
  let ws; try { ws = await Workspace.parse(await openLocal(json, artifactStore)); } catch (e) { status(t('不能载入另一个标签页的工作区：{error}', { error: e.message }), 'bad'); return; }
  if (foreign !== json) return;   // a newer save arrived meanwhile: answer that one
  foreign = null; dirty = false; clearTimeout(saveTimer); saveTimer = null;
  for (const id of savedIds(json)) stored.add(id);                     // it opened, so the store has them
  adopt(ws); showForeign();
  saveNote.show('已载入另一个标签页的工作区 {time}', { time: new Date().toLocaleTimeString() });
}
function keepThisTab() { foreign = null; showForeign(); dirty = true; saveWorkspace(); }
/** The localStorage workspace (a fresh one when there is no save), or `conflict` when the save cannot be restored. */
async function restoreLocal() {
  const text = localStorage.getItem(STORAGE_KEY);
  if (text === null) return { workspace: new Workspace(), conflict: null };
  try { const workspace = await Workspace.parse(await openLocal(text, artifactStore)); for (const id of savedIds(text)) stored.add(id); return { workspace, conflict: null }; }
  catch (error) { return { workspace: new Workspace(), conflict: { text, error } }; }
}

// ------------------------------------------------------------------ conflict panel: the unreadable local save
function showConflict() {
  const reason = conflict.error.reason ?? { message: conflict.error.message };
  const shown = value => value === null || value === undefined || value === '' ? '—' : String(value);
  $('conflict-format').textContent = shown(reason.format);
  $('conflict-path').textContent = shown(reason.path);
  $('conflict-message').textContent = shown(reason.message);
  saveNote.show('自动保存已暂停');
  if (!$('conflict').open) $('conflict').showModal();
}
function conflictError(text) { $('conflict-error').textContent = text; $('conflict-error').hidden = !text; }
/** the unreadable local save, with the artifacts that the store still has back in their place */
async function exportConflict() {
  let text = conflict.text; try { text = await openLocal(text, artifactStore); } catch { /* an artifact is missing: export the save as it is */ }
  download(`neurom-workbench-local-${stamp()}.json`, text);
}
/** Close the panel with `ws` as this tab's workspace. A save another tab wrote while it was open is asked about like
 *  any other tab's save (#sync-note), so nothing here writes over it. */
function resolveConflict(ws) {
  const now = localStorage.getItem(STORAGE_KEY);
  foreign = now !== null && now !== conflict.text ? now : null;
  conflict = null; conflictError(''); $('conflict-confirm').hidden = true; $('conflict').close();
  dirty = false; adopt(ws); showForeign();
}
/** a corrected file takes the place of the local save, validated like any file */
async function openCorrected(file) {
  let ws; try { ws = await Workspace.parse(await file.text()); }
  catch (e) { conflictError(t('打不开这个文件。本地存档保持不变：{error}', { error: e.message })); return; }
  resolveConflict(ws); persist();
  status(t('已打开改好的工作区：{count} 个模块。', { count: store.graph.nodes.size }), 'ok');
}
function discardConflict() {
  // the local save, unless another tab has written over it meanwhile
  if (localStorage.getItem(STORAGE_KEY) === conflict.text) localStorage.removeItem(STORAGE_KEY);
  resolveConflict(new Workspace());
  saveNote.show('本地工作区');
  status(t('本地存档已丢弃。工作区从空白开始。'), 'ok');
  showDrawer('palette');
}
/** Make `ws` this tab's workspace (startup, opening a file, another tab's save, clearing). Only this function reclaims
 *  the dataset rows that nothing in `ws` references. The undo history that could still need them ends with the old
 *  workspace. While a conflict is open, nothing is reclaimed, because the unreadable save can reference rows. Stored
 *  artifacts are never reclaimed (core/local-save.js). */
function adopt(ws) {
  unsubscribeStore?.(); disposeSessions();
  store = ws;
  if (!conflict) reclaimDatasets(ws, datasets).catch(e => status(e.message, 'bad'));
  unsubscribeStore = store.subscribe(what => {
    persist();
    if (what === 'graph') sweepSessions();
    if (what === 'templates') renderPalette();
    if (what === 'graph' || what === 'templates') library?.render();
  });
  editor?.reload(); library?.render(); renderPalette();
  recoverTrainers();
}
function recoverTrainers() { for (const n of store.graph.nodes.values()) if (n.kind === 'trainer') session('trainer', n.id).recover().catch(e => status(e.message, 'bad')); }
function status(text, tone = '') { const el = $('status'); el.textContent = text; el.className = tone; }

// ------------------------------------------------------------------ python workspace: connect on load, retry while disconnected
let pythonTimer = null;
async function connectPython() {
  try { await python.client.connect(); python.connected.value = true; pythonNote.show('Python 工作区已连接'); }
  catch { python.connected.value = false; pythonNote.show('Python 工作区未连接'); }
  clearTimeout(pythonTimer);
  if (!python.connected.value) pythonTimer = setTimeout(connectPython, PYTHON_RETRY_MS);
}

// ------------------------------------------------------------------ placing new things
function nextPosition() {
  const nodes = [...store.graph.nodes.values()];
  if (!nodes.length) return { x: 80, y: 120 };
  return { x: Math.max(...nodes.map(n => n.x + (n.uiSize?.w ?? 360))) + 120, y: Math.min(...nodes.map(n => n.y)) };
}
/** A new module: into the selected expanded group or training module when there is one (editor.insertionPoint),
 *  else right of everything on the canvas. Returns the node and the insertion point it used (or null). */
function addKind(kind) {
  const into = editor.insertionPoint(), at = into ?? nextPosition();
  const n = editor.edit(t('新建模块'), () => { const n = store.graph.addNode({ kind, x: at.x, y: at.y }); if (into) store.graph.addToGroup(into.group, n.id); return n; });
  return { n, into };
}
/** The blank training module (templates/training-module.yaml). It is the first blank entry of the palette and is not
 *  listed again under 组合模板. */
const TRAINING_MODULE = 'training-module';
function addTrainingModule() {
  const tpl = builtinTemplate(TRAINING_MODULE); if (!tpl) throw new Error(t('内置模板不存在：{id}', { id: TRAINING_MODULE }));
  return instantiate(tpl, nextPosition(), t('新建训练模块'));
}
/** Instantiate a template (builtin or user). User templates use the id@revision key `user:<id>@<rev>`. */
function templateByKey(key) {
  if (key.startsWith('user:')) { const at = key.lastIndexOf('@'); return store.template(key.slice(5, at), Number(key.slice(at + 1))); }
  return builtinTemplate(key);
}
/** A template instance, arranged. A prefab (a template with slots on its own group or on a nested group) opens as its
 *  frames: the instance's group and the groups nested in it are expanded, so the slots show at once. Call it inside an
 *  edit. */
function place(template, at) {
  const r = instantiateInto(store.graph, template, at), groups = r.group ? [r.group.id, ...Object.values(r.groupIds)] : [];
  if (groups.some(id => store.graph.group(id).prefab)) for (const id of groups) store.graph.setGroupLayout(id, { collapsed: false });
  editor.arrange(r.nodes.map(n => n.id));
  return r;
}
/** Imports with a template instance the builtin artifacts that it pins and that the workspace does not have yet. A pin
 *  is the `artifact` of a network (a frozen tool) or the `accepted` of a candidates node. So a pin always resolves. */
async function importPinned(nodes) {
  const pinned = new Set(nodes.map(n => (n.kind === 'network' ? n.config.artifact : n.kind === 'candidates' ? n.config.accepted : null)).filter(id => id && !store.artifacts.has(id)));
  if (!pinned.size) return;
  for (const e of await builtinArtifacts()) if (pinned.has(e.artifact.id) && !store.artifacts.has(e.artifact.id)) await store.addArtifact(e.artifact);
}
function instantiate(template, at = nextPosition(), label = t('实例化模板')) {
  return editor.edit(label, async () => { const r = place(template, at); await importPinned(r.nodes); return r; });
}
/** The palette's and the template library's 实例化: place it, close the drawer, show it. */
async function placeTemplate(tpl) {
  try { const { ids, group } = await instantiate(tpl); closeDrawer(); requestAnimationFrame(() => editor.focusNodes(group ? [group.id] : Object.values(ids))); status(t('已实例化模板 {name}。', { name: builtinTemplate(tpl.id) === tpl ? t(tpl.name) : tpl.name }), 'ok'); }
  catch (e) { status(t('实例化失败：{error}', { error: e.message }), 'bad'); }
}

// ------------------------------------------------------------------ presets: template instance + builtin artifacts accepted
/** The network whose structure the trainer feeding `candsId` trains — the one the candidates session judges compatibility against. */
function trainedNetwork(candsId) {
  for (const trainer of store.graph.producers(candsId, 'run')) for (const p of store.graph.producers(trainer.node, 'structure')) if (store.graph.node(p.node).kind === 'network') return p.node;
  return null;
}
/** Import a builtin artifact into a candidates node and accept it. First, the trained network takes the structure of the
 *  artifact. So the candidate is compatible, whatever the default network of the template is. */
async function acceptBuiltin(candsId, artifact) {
  const net = trainedNetwork(candsId);
  if (net) store.graph.patchConfig(net, structureOf(artifact));
  const cands = session('candidates', candsId);
  await cands.importArtifact(artifact);
  if (store.graph.node(candsId).config.accepted !== artifact.id) cands.accept(artifact.id);
}
/** The preset of a builtin template (template.js `preset`): the template placed with builtin artifacts accepted into its
 *  candidates nodes. `preset.accept` maps a candidates local id → builtin artifact name. A candidates node whose
 *  template config already pins `accepted` gets that builtin. (importPinned imports what the template pins with every
 *  instance.) */
async function templatePreset(tpl) {
  const accept = tpl.preset.accept, builtins = await builtinArtifacts();
  const at = nextPosition();
  return editor.edit(t('示例：{name}', { name: t(tpl.name) }), async () => {
    const { ids, group } = place(tpl, at);
    const nodes = Object.entries(ids).map(([local, id]) => [local, store.graph.node(id)]);
    await importPinned(nodes.map(([, n]) => n));   // first: the candidates' compatibility builds bundles over these networks
    for (const [local, n] of nodes) {
      if (n.kind !== 'candidates') continue;
      const entry = builtins.find(e => (accept[local] ? e.name === accept[local] : e.artifact.id === n.config.accepted));
      if (!entry) { if (accept[local]) throw new Error(t('内置产物不存在：{name}', { name: accept[local] })); continue; }
      await acceptBuiltin(n.id, entry.artifact);
    }
    return group ? [group.id] : Object.values(ids);
  });
}
async function runPreset(id) {
  const tpl = builtinTemplate(id);
  try { const ids = await templatePreset(tpl); closeDrawer(); requestAnimationFrame(() => editor.focusNodes(ids)); status(t('已放置示例：{label}', { label: t(tpl.preset.label) }), 'ok'); }
  catch (e) { status(t('示例失败：{error}', { error: e.message }), 'bad'); }
}

// ------------------------------------------------------------------ drawer: palette / template library / workspace
function closeDrawer() {
  $('library-drawer').hidden = true;
  document.querySelectorAll('[data-drawer]').forEach(b => { b.classList.remove('on'); b.setAttribute('aria-expanded', 'false'); });
}
const DRAWER_TITLES = { palette: '添加模块', templates: '模板库', workspace: '工作区文件' };
function showDrawer(name) {
  const drawer = $('library-drawer'), same = !drawer.hidden && drawer.dataset.section === name;
  closeDrawer(); if (same) return;
  drawer.hidden = false; drawer.dataset.section = name;
  $('drawer-title').textContent = t(DRAWER_TITLES[name]);
  $('palette').hidden = name !== 'palette'; $('template-lib').hidden = name !== 'templates'; $('ws-tools').hidden = name !== 'workspace';
  document.querySelectorAll('[data-drawer]').forEach(b => { const on = b.dataset.drawer === name; b.classList.toggle('on', on); b.setAttribute('aria-expanded', String(on)); });
  if (name === 'templates') library.render();
}
function renderPalette() {
  const el = $('palette'); if (!el) return;
  const composites = builtinTemplates().filter(tpl => tpl.kind !== 'module' && tpl.id !== TRAINING_MODULE);
  const singles = builtinTemplates().filter(tpl => tpl.kind === 'module');
  const user = [...store.templates.values()];
  el.innerHTML = `<h3>${t('示例')}</h3>
    ${builtinTemplates().filter(tpl => tpl.preset).map(tpl => `<button class="pal" data-preset="${esc(tpl.id)}">${esc(t(tpl.preset.label))}</button>`).join('')}
    <h3>${t('组合模板')}</h3>
    ${composites.map(tpl => `<button class="pal" data-template="${esc(tpl.id)}" title="${esc(tpl.description ? t(tpl.description) : '')}">${esc(t(tpl.name))} <span class="m">${esc(tpl.id)}@${tpl.revision}</span></button>`).join('')}
    ${user.length ? `<h3>${t('我的模板')}</h3>${user.map(tpl => `<button class="pal" data-template="user:${esc(tpl.id)}@${tpl.revision}">${esc(tpl.name)} <span class="m">${esc(tpl.id)}@${tpl.revision} · ${esc(t(KIND_LABEL[tpl.kind]))}</span></button>`).join('')}` : ''}
    ${singles.length ? `<h3>${t('单模块模板')}</h3>${singles.map(tpl => `<button class="pal" data-template="${esc(tpl.id)}">${esc(t(tpl.name))}</button>`).join('')}` : ''}
    <h3>${t('空白模块')}</h3>
    <div class="pal-grid"><button class="pal" data-training-module>+ ${esc(t('训练模块'))}</button>${kinds().map(k => `<button class="pal" data-kind="${k.kind}">+ ${esc(t(k.label))}</button>`).join('')}</div>`;
  el.querySelectorAll('[data-preset]').forEach(b => b.onclick = () => runPreset(b.dataset.preset));
  el.querySelectorAll('[data-template]').forEach(b => b.onclick = () => {
    const tpl = templateByKey(b.dataset.template);
    if (tpl) void placeTemplate(tpl); else status(t('实例化失败：{error}', { error: t('模板不存在') }), 'bad');
  });
  el.querySelectorAll('[data-kind]').forEach(b => b.onclick = () => {
    try {
      const { n, into } = addKind(b.dataset.kind); closeDrawer();
      // show the module where it landed. The group stays selected, so the next module also goes into it
      requestAnimationFrame(() => { editor.focusNodes([n.id]); if (into) editor.select([into.group]); });
      status(into ? t('已在 {group} 里新建 {title}。', { group: into.title, title: n.title }) : t('已新建 {title}。', { title: n.title }), 'ok');
    }
    catch (e) { status(t('不能创建：{error}', { error: e.message }), 'bad'); }
  });
  el.querySelector('[data-training-module]').onclick = async () => {
    try { const { group } = await addTrainingModule(); closeDrawer(); requestAnimationFrame(() => editor.focusNodes([group.id])); status(t('已新建训练模块：在左上的槽位里点「+」填入场景、分区和目标。'), 'ok'); }
    catch (e) { status(t('不能创建：{error}', { error: e.message }), 'bad'); }
  };
}
const KIND_LABEL = { module: '单模块', composite: '组合', canvas: '画布' };

// ------------------------------------------------------------------ workspace file import / export
function download(name, text, type = 'application/json') {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
function exportWorkspace() {
  store.settings.canvas = editor.snapshot();
  download(`neurom-workbench-${stamp()}.json`, JSON.stringify(store.toJSON(), null, 1));
}
/** a file that cannot be restored is refused with the reason. The current workspace stays */
async function importWorkspace(file) {
  try {
    adopt(await Workspace.parse(await file.text())); persist(); closeDrawer();
    status(t('工作区已导入。'), 'ok');
  } catch (e) { status(t('导入工作区失败，当前工作区保持不变。原因：{error}', { error: e.message }), 'bad'); }
}
function clearWorkspace() {
  if (!confirm(t('清空整个工作区（画布、运行、产物、我的模板）？此操作不可撤销，建议先“保存工作区”。'))) return;
  localStorage.removeItem(STORAGE_KEY); adopt(new Workspace()); persist(); closeDrawer(); status(t('工作区已清空。'), 'ok');
}

// ------------------------------------------------------------------ language
function showLocale() {
  document.documentElement.lang = locale() === 'zh' ? 'zh-CN' : 'en';
  for (const span of $('lang-toggle').querySelectorAll('[data-locale]')) span.classList.toggle('on', span.dataset.locale === locale());
}
function relabel(relabelStatic) {
  relabelStatic(); showLocale();
  const drawer = $('library-drawer'); if (!drawer.hidden) $('drawer-title').textContent = t(DRAWER_TITLES[drawer.dataset.section]);
  renderPalette(); library.render(); editor.draw();
}

// ------------------------------------------------------------------ boot
window.addEventListener('DOMContentLoaded', async () => {
  initLocale();
  const relabelStatic = translateStatic(document.documentElement);
  saveNote = liveText($('save-note')); pythonNote = liveText($('python-note'));
  showLocale(); status(t('加载工作区…')); saveNote.show('本地工作区');
  const local = await restoreLocal();
  store = local.workspace; conflict = local.conflict;
  editor = createVueEditor($('workspace-viewport'), {
    workspace: () => store, changed: persist, status, session, datasets, python,
  });
  library = createTemplateLibrary($('template-lib'), {
    workspace: () => store, editor: () => editor, status, builtinTemplates,
    instantiate: tpl => void placeTemplate(tpl),
    persist, download,
  });
  adopt(store);
  window.addEventListener('pagehide', event => { saveWorkspace(true); if (!event.persisted) { unsubscribeStore?.(); disposeSessions(); editor.dispose(); } });
  // while artifacts go to IndexedDB, the final save holds them in its text, which can exceed the localStorage quota
  window.addEventListener('beforeunload', event => { if (storing) event.preventDefault(); });
  window.addEventListener('storage', followOtherTab);
  $('sync-load').onclick = loadForeign; $('sync-keep').onclick = keepThisTab;
  document.querySelectorAll('[data-drawer]').forEach(b => b.onclick = () => showDrawer(b.dataset.drawer));
  document.querySelector('.drawer-close').onclick = closeDrawer;
  $('canvas-fit-all').onclick = () => { closeDrawer(); editor.fit('all'); };
  $('canvas-fit-selection').onclick = () => { closeDrawer(); if (!editor.fit('selection')) status(t('先选中要定位的模块。'), 'warn'); };
  $('canvas-zoom-in').onclick = () => editor.zoom(1.2);
  $('canvas-zoom-out').onclick = () => editor.zoom(1 / 1.2);
  for (const action of ['undo', 'redo', 'copy', 'paste', 'group', 'ungroup']) $(`editor-${action}`).onclick = () => editor[action]();
  $('editor-save-template').onclick = () => library.saveSelection();
  $('editor-arrange').onclick = () => { if (!editor.arrange()) status(t('先选中要整理的模块或组合。'), 'warn'); };
  window.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });
  $('ws-export').onclick = exportWorkspace; $('ws-import').onclick = () => $('ws-file').click();
  $('ws-file').onchange = () => { if ($('ws-file').files[0]) importWorkspace($('ws-file').files[0]); $('ws-file').value = ''; };
  $('ws-clear').onclick = clearWorkspace;
  $('conflict').oncancel = e => e.preventDefault();   // Escape does not dismiss it. Only its actions do
  $('conflict').onclose = () => { if (conflict) $('conflict').showModal(); };
  $('conflict-export').onclick = exportConflict;
  $('conflict-open').onclick = () => $('conflict-file').click();
  $('conflict-file').onchange = () => { if ($('conflict-file').files[0]) openCorrected($('conflict-file').files[0]); $('conflict-file').value = ''; };
  $('conflict-discard').onclick = () => { $('conflict-confirm').hidden = false; $('conflict-discard-no').focus(); };
  $('conflict-discard-no').onclick = () => { $('conflict-confirm').hidden = true; };
  $('conflict-discard-yes').onclick = discardConflict;
  $('lang-toggle').onclick = () => setLocale(locale() === 'zh' ? 'en' : 'zh');
  onLocaleChange(() => relabel(relabelStatic));
  connectPython();
  if (conflict) { showConflict(); status(t('无法读取本地工作区，自动保存已暂停：{error}', { error: conflict.error.message }), 'warn'); return; }
  const preset = new URLSearchParams(location.search).get('preset') ?? (location.hash.length > 1 ? location.hash.slice(1) : null);
  if (preset && builtinTemplates().some(tpl => tpl.id === preset && tpl.preset) && !store.graph.nodes.size) await runPreset(preset);
  else status(store.graph.nodes.size ? t('已恢复工作区：{count} 个模块。', { count: store.graph.nodes.size }) : t('从左侧“添加模块”放一个示例、一个模板或一个空白模块开始。'));
  if (!store.graph.nodes.size && !preset) showDrawer('palette');
});
