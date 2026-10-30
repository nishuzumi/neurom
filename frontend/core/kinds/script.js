// core/kinds/script.js — the script module (ADR 0019): plain JavaScript files that run in the view sandbox
// (editor/renderers/script-module.js). `main.js` has a default export `{ layout, views, main }`. `main(ctx)` writes
// its own loop and waits for `ctx.frame()` before each round, and the views draw `ctx.state` in the CSS grid of
// `layout`. The files import each other and the built-in `@ui`. The module is inference only: it has no outputs, so
// no bundle, trainer or environment hash reads it, and it has no Python version.
//
// The ports come only from the declarations (ADR 0006). Each name of `functions` is a call port: the script calls
// `await ctx.call.<name>(…)`, and the page runs the call outside the sandbox (core/script-calls.js). Each name of
// `inputs` is a value port: the script reads `ctx.values.<name>`. The calls are typed at run time from the arguments,
// so a call port has no signature. Only a network behind a readout's `run` is checked here, with the bits it reads:
// its callee applies the tool-layer rule (a trainer must not train it).
import { registerKind } from '../registry.js';
import { bits } from '../types.js';
import { joinList, t } from '../../i18n.js';

/** a file name: a plain `.js` name without a folder */
export const FILE_NAME = '^[A-Za-z0-9_-]+(\\.[A-Za-z0-9_-]+)*\\.js$';
export const MAIN_FILE = 'main.js';
/** a declared input name: an identifier of ASCII letters, digits and `_`, or of Chinese characters (`红方`). Not a
 *  name of the object prototype, so a name is an own key of the values that the frame gets. */
export const INPUT_NAME = /^(?!(__proto__|constructor|prototype)$)[A-Za-z_\u4e00-\u9fff][A-Za-z0-9_\u4e00-\u9fff]*$/;
export const MAX_INPUTS = 32;
const NAME_LIST = { type: 'list', of: { type: 'string', pattern: INPUT_NAME.source, max: 64 }, max: MAX_INPUTS };
/** the port names of a config: each name one time, the function inputs first */
const portNames = config => {
  const functions = [...new Set(config.functions)];
  return { functions, inputs: [...new Set(config.inputs)].filter(name => !functions.includes(name)) };
};

/** The `main.js` of a new script module: a counter view and the built-in run controls (comments in the UI language). */
function sampleMain() {
  return [
    `// ${t('main.js 默认导出 layout、views 和 main。')}`,
    `// ${t('layout 按 CSS grid 排列视图。views 的名字是 areas 里的格子名。')}`,
    `// ${t('main 自己写循环。每一轮开头写 await ctx.frame()：“单步”放行一轮，“运行”连续放行，“重置”重新启动 main。')}`,
    "import { Controls } from '@ui';",
    '',
    `// ${t('每个视图收到 state（main 写的数据）和 run（运行控制）。')}`,
    'const Counter = {',
    "  props: ['state'],",
    '  template: `<div style="height:100%;display:grid;place-items:center;font:600 40px var(--mono);color:var(--focus)">{{ state.count }}</div>`,',
    '};',
    '',
    'export default {',
    "  layout: { columns: '1fr', rows: 'auto 1fr', areas: ['controls', 'counter'] },",
    '  views: { controls: Controls, counter: Counter },',
    '  async main(ctx) {',
    '    ctx.state.count = 0;',
    '    while (true) {',
    '      await ctx.frame();',
    '      ctx.state.count += 1;',
    '    }',
    '  },',
    '};',
    '',
  ].join('\n');
}

registerKind({
  kind: 'script',
  label: '脚本模块',
  config: {
    // a getter, so a new module gets the sample in the UI language of the moment
    defaults: { get files() { return [{ name: MAIN_FILE, source: sampleMain() }]; }, functions: [], inputs: [] },
    schema: {
      files: { type: 'list', max: 64, of: { type: 'object', fields: { name: { type: 'string', pattern: FILE_NAME }, source: { type: 'string', max: 256 * 1024 } } } },
      functions: NAME_LIST,
      inputs: NAME_LIST,
    },
  },
  ports(node) {
    const { functions, inputs } = portNames(node.config);
    return {
      inputs: [
        ...functions.map(id => ({ id, wire: 'call', required: true, many: false, doc: t('函数输入：脚本里写 await ctx.call.{name}(…)', { name: id }) })),
        ...inputs.map(id => ({ id, wire: 'value', type: null, required: false, many: false, doc: t('值输入：脚本里读 ctx.values.{name}', { name: id }) })),
      ],
      outputs: [],
    };
  },
  infer() { return {}; },
  problems(node, ctx) {
    const out = [], names = node.config.files.map(f => f.name);
    if (!names.includes(MAIN_FILE)) out.push({ message: t('脚本模块缺少 {file}', { file: MAIN_FILE }) });
    const twice = [...new Set(names.filter((name, i) => names.indexOf(name) !== i))];
    if (twice.length) out.push({ message: t('文件名重复：{names}', { names: joinList(twice) }) });
    const { functions, inputs } = node.config;
    for (const [i, name] of functions.entries()) if (functions.indexOf(name) !== i) out.push({ message: t('函数输入 {name} 重复声明', { name }) });
    for (const [i, name] of inputs.entries()) if (inputs.indexOf(name) !== i) out.push({ message: t('输入 {name} 重复声明', { name }) });
    for (const name of new Set(inputs)) if (functions.includes(name)) out.push({ message: t('{name} 同时声明为函数输入和值输入', { name }) });
    for (const port of portNames(node.config).functions) {
      const [site] = ctx.callees(node.id, port);
      if (!site) continue;   // the required port reports it
      if (!site.callee) out.push({ port, wire: site.wire.id, message: t('调用端口 {port} 需要接代码模块导出的函数或读出的 run', { port }) });
      else if (Number.isInteger(site.callee.width)) {
        const r = site.callee.call([bits(site.callee.width)], { exact: false, caller: node.id });
        if (r.error) out.push({ port, wire: site.wire.id, error: r.error });
      }
    }
    return out;
  },
});
