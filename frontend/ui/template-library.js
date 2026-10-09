// ui/template-library.js — the template library drawer. It lists builtin and user templates by kind (module /
// composite / canvas). Each template has the actions instantiate / fork / export YAML / delete. The drawer also has
// YAML import, "save selection as template" and the usages list. The usages list shows which groups on the canvas came
// from which template id@revision. The drawer is hand-rendered like the palette.
import { parseTemplate, templateToYAML } from '../core/template.js';
import { t, joinList } from '../i18n.js';

const esc = s => String(s ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const KIND_LABEL = { module: '单模块模板', composite: '组合模板', canvas: '画布模板' };

/**
 * @param {HTMLElement} el
 * @param {{ workspace(): import('../core/store.js').Workspace, editor(): { selectedNodes(): string[], focusNodes(ids: string[]): boolean, saveTemplate(nodeIds: string[], suggested: string): void }, status(text: string, tone?: string): void,
 *           builtinTemplates(): object[], instantiate(template: object): void, persist(): void, download(name: string, text: string, type?: string): void }} ctx
 */
export function createTemplateLibrary(el, ctx) {
  function usages(id, revision) {
    return [...ctx.workspace().graph.groups.values()].filter(g => g.template?.id === id && (revision === undefined || g.template.revision === revision));
  }
  function nextRevision(id) { const latest = ctx.workspace().template(id); return latest ? latest.revision + 1 : 1; }
  function fork(tpl) {
    const id = prompt(t('新模板 id（小写字母、数字、- 或 _）'), `${tpl.id}-copy`)?.trim(); if (!id) return;
    const name = prompt(t('新模板名称'), `${tpl.name} · ${t('分叉')}`)?.trim(); if (!name) return;
    try { ctx.workspace().addTemplate({ ...tpl, id, name, revision: nextRevision(id) }); ctx.status(t('已分叉为 {id}@{revision}。', { id, revision: nextRevision(id) - 1 }), 'ok'); }
    catch (e) { ctx.status(t('分叉失败：{error}', { error: e.message }), 'bad'); }
  }
  function remove(tpl) {
    const used = usages(tpl.id, tpl.revision).length;
    if (!confirm(used ? t('删除模板 {key}？画布上 {count} 个实例保持不变（实例不随模板联动）。', { key: `${tpl.id}@${tpl.revision}`, count: used }) : t('删除模板 {key}？', { key: `${tpl.id}@${tpl.revision}` }))) return;
    ctx.workspace().removeTemplate(tpl.id, tpl.revision); ctx.status(t('已删除模板 {key}。', { key: `${tpl.id}@${tpl.revision}` }), 'ok');
  }
  function exportYAML(tpl) { ctx.download(`${tpl.id}@${tpl.revision}.yaml`, templateToYAML(tpl), 'application/yaml'); }
  async function importYAML(file) {
    try {
      const tpl = parseTemplate(await file.text());
      const existing = ctx.workspace().template(tpl.id, tpl.revision);
      const stored = existing ? { ...tpl, revision: nextRevision(tpl.id) } : tpl;
      ctx.workspace().addTemplate(stored);
      ctx.status(existing ? t('模板 {id}@{old} 已存在，已导入为第 {revision} 版。', { id: tpl.id, old: tpl.revision, revision: stored.revision }) : t('已导入模板 {id}@{revision}。', { id: tpl.id, revision: tpl.revision }), 'ok');
    } catch (e) { ctx.status(t('导入模板失败：{error}', { error: e.message }), 'bad'); }
  }
  /** the selection as a user template (editor saveTemplate), named after its one module or its size */
  function saveSelection() {
    const editor = ctx.editor(), ids = editor.selectedNodes();
    editor.saveTemplate(ids, ids.length === 1 ? ctx.workspace().graph.node(ids[0]).title : t('组合 · {count} 个模块', { count: ids.length }));
  }
  function row(tpl, builtin) {
    const key = `${tpl.id}@${tpl.revision}`, used = usages(tpl.id, tpl.revision).length;
    return `<div class="card tpl" data-key="${esc(key)}" data-builtin="${builtin ? 1 : 0}">
      <div><b>${esc(builtin ? t(tpl.name) : tpl.name)}</b> <span class="meta">${esc(key)}${builtin ? ` · ${t('内置')}` : ''}${used ? ` · ${t('{count} 个实例', { count: used })}` : ''}</span></div>
      ${tpl.description ? `<div class="meta">${esc(builtin ? t(tpl.description) : tpl.description)}</div>` : ''}
      <div class="meta">${t('{count} 个模块', { count: Object.keys(tpl.modules).length })}${tpl.expose.length ? ` · ${t('暴露 {ports}', { ports: esc(tpl.expose.join(' ')) })}` : ''}</div>
      <div class="row"><button class="mini" data-act="instantiate">${t('实例化')}</button><button class="mini" data-act="fork">${t('分叉')}</button><button class="mini" data-act="export">${t('导出 YAML')}</button>${used ? `<button class="mini" data-act="usages">${t('查看实例')}</button>` : ''}${builtin ? '' : `<button class="mini" data-act="remove">${t('删除')}</button>`}</div>
    </div>`;
  }
  function render() {
    if (el.hidden) return;
    const ws = ctx.workspace(), builtin = ctx.builtinTemplates(), user = [...ws.templates.values()].sort((a, b) => a.id.localeCompare(b.id) || a.revision - b.revision);
    const sections = ['composite', 'canvas', 'module'].map(kind => {
      const rows = [...user.filter(tpl => tpl.kind === kind).map(tpl => row(tpl, false)), ...builtin.filter(tpl => tpl.kind === kind).map(tpl => row(tpl, true))];
      return rows.length ? `<h3>${t(KIND_LABEL[kind])}</h3>${rows.join('')}` : '';
    }).join('');
    const instances = [...ws.graph.groups.values()].filter(g => g.template);
    el.innerHTML = `<div class="row"><button class="mini" id="tpl-save-selection">${t('把选中内容存为模板')}</button><button class="mini" id="tpl-import">${t('导入 YAML')}</button><input id="tpl-file" type="file" accept=".yaml,.yml,application/yaml,text/yaml" hidden></div>
      <p class="note">${t('实例是模板的副本，只记录来源 id@版本。修改模板不影响已有实例。分叉把模板复制到“我的模板”，并从第 1 版重新计数。')}</p>
      ${sections}
      <h3>${t('画布上的实例')}</h3>
      ${instances.length ? instances.map(g => `<div class="card tpl-use" data-group="${esc(g.id)}"><b>${esc(g.title)}</b> <span class="meta">${esc(g.template.id)}@${g.template.revision}</span></div>`).join('') : `<p class="note">${t('画布上还没有模板实例。')}</p>`}`;
    el.querySelector('#tpl-save-selection').onclick = saveSelection;
    el.querySelector('#tpl-import').onclick = () => el.querySelector('#tpl-file').click();
    el.querySelector('#tpl-file').onchange = e => { const f = e.target.files[0]; if (f) importYAML(f); e.target.value = ''; };
    el.querySelectorAll('.tpl [data-act]').forEach(b => b.onclick = () => {
      const card = b.closest('.tpl'), key = card.dataset.key, at = key.lastIndexOf('@'), id = key.slice(0, at), revision = Number(key.slice(at + 1));
      const tpl = card.dataset.builtin === '1' ? ctx.builtinTemplates().find(x => x.id === id) : ws.template(id, revision);
      if (!tpl) return;
      if (b.dataset.act === 'instantiate') ctx.instantiate(tpl);
      else if (b.dataset.act === 'fork') fork(tpl);
      else if (b.dataset.act === 'export') exportYAML(tpl);
      else if (b.dataset.act === 'remove') remove(tpl);
      else if (b.dataset.act === 'usages') { const ids = usages(id, revision).map(g => g.id); ctx.editor().focusNodes(ids); ctx.status(t('{key} 的实例：{titles}', { key, titles: joinList(usages(id, revision).map(g => g.title)) })); }
    });
    el.querySelectorAll('.tpl-use').forEach(c => c.onclick = () => ctx.editor().focusNodes([c.dataset.group]));
  }
  return { render, saveSelection };
}
