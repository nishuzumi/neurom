// core/kinds/view.js — visualises an execution or a report. It uses a built-in renderer (grid / series / table / kv) over
// a path into the state (`state.map`, `report.metrics`…) with optional marks (for example `{ agent: 'state.pos' }`).
// Or it uses a view script (renderer `script`, ADR 0013): JavaScript run in a sandboxed frame with Vue, defining a
// `component` (prop `ctx`) or `render(ctx, el)`. ctx is what the view is wired to plus every member of its training
// module, by title.
import { registerKind } from '../registry.js';
import { valueIn } from './common.js';
import { handle } from '../types.js';
import { joinList, t } from '../../i18n.js';

export const RENDERERS = Object.freeze(['grid', 'series', 'table', 'kv', 'script']);
/** the script a view starts from when its renderer is switched to `script` (comments in the UI language) */
export function scriptStub() {
  return [
    `// ${t('视图组件：props.ctx 是视图接的数据，取滑条选中的那一步（例如 state、history、report）')}`,
    `// ${t('ctx.modules 是训练模块的成员，按标题读取：ctx.modules[标题][端口]。全局 Vue 可用。沙箱里不能联网。')}`,
    `// ${t('也可以不写 component，改写 function render(ctx, el) 自己画。')}`,
    'const component = {',
    "  props: ['ctx'],",
    '  template: `<pre style="margin:0;white-space:pre-wrap">{{ JSON.stringify(ctx.state ?? ctx.report ?? null).slice(0, 400) }}</pre>`,',
    '};',
  ].join('\n');
}

registerKind({
  kind: 'view',
  label: '视图',
  config: {
    defaults: { renderer: 'kv', path: 'state', marks: {}, script: '' },
    schema: {
      renderer: { type: 'enum', values: RENDERERS }, path: { type: 'string', pattern: '^[A-Za-z_][\\w]*(\\.[A-Za-z_][\\w]*)*$' }, marks: { type: 'map', of: { type: 'string' } },
      script: { type: 'string', max: 256 * 1024 },
    },
  },
  ports() { return { inputs: [valueIn('execution', handle('execution')), valueIn('report', handle('report'))], outputs: [] }; },
  infer() { return {}; },
  problems(node, ctx) {
    const out = [];
    const n = ctx.producers(node.id, 'execution').length + ctx.producers(node.id, 'report').length;
    if (n !== 1) out.push(n ? { message: t('视图只能接 execution 或 report 之一') } : { incomplete: true, message: t('视图需要接 execution 或 report') });
    if (node.config.renderer === 'script') {
      // ctx.modules reads the training module's members by title (ADR 0013): a title two members share is ambiguous
      const tm = ctx.trainingModuleOf(node.id), seen = new Set(), twice = new Set();
      for (const id of tm?.members ?? []) { const title = ctx.node(id).title; (seen.has(title) ? twice : seen).add(title); }
      if (twice.size) out.push({ message: t('训练模块 {module} 里的模块标题重复：{titles}。视图脚本按标题读 ctx.modules，标题必须唯一', { module: tm?.title ?? '', titles: joinList([...twice]) }) });
    }
    return out;
  },
});
