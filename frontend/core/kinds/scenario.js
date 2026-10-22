// core/kinds/scenario.js — the runner protocol a scenario module is held to. A scenario is an ordinary code module
// (kinds/code.js) whose `module` output is wired into a loop's `scenario` port (kinds/loop.js). This file fixes only
// the protocol — the roles the runner (core/runner.js) calls and what each means. The scenario declares them by
// exporting functions and consts of those names:
//   init(start) → State (optional, absent: State is the Start record itself) · input(state[, table]) → bits[1..65535] ·
//   step(state, action[, table]) → { state: State, done: boolean, success: boolean } · const budget (the step limit) ·
//   const actions (optional: the action names).
// What a run starts from and the rows it may read come from the loop's drivers. `Start` is the record their
// partitions' episodes have (partition.js). `table` (the last argument of input / step) is the dataset wired into
// those partitions. The runner builds `Transition = { prev, action, next, done, truncated, success }` from step's result.
// Scenario parameters are the scenario module's own inputs: the runner never sees them. What the network sees is
// exactly what input returns.
import { NUMBER, STRING, BOOLEAN, MAX_BITS, record, binaryVector, recordWith, ref, isRef, unresolvedRefs, resolveSignature, typeName, mismatch } from '../types.js';
import { analyseModule, callFunction, functionResultDoc, incomplete } from './code.js';
import { mergeDocs, LIMITS } from '../../ir/index.js';
import { episodeTag } from './partition.js';
import { joinList, t } from '../../i18n.js';

/** The function roles, in bundle order. `init` is optional. */
export const SCENARIO_CALLS = Object.freeze(['init', 'input', 'step']);
export const REQUIRED_CALLS = Object.freeze(['input', 'step']);
/**
 * The export that fills each function role of loop `loop` (a loop node, or null): `{ init, input, step }` → export
 * names. The loop's `config.roles` maps a role to another export, so one scenario file serves several loops in
 * different modes. A role the config does not map is filled by the export of its own name.
 */
export function roleExports(loop) {
  const roles = loop?.config?.roles ?? {};
  return Object.fromEntries(SCENARIO_CALLS.map(role => [role, roles[role] || role]));
}
/** The const roles: `budget` (required) is the step limit, an exported `actions` the action table (bundle `env.actions`). */
export const BUDGET = 'budget';
export const ACTIONS = 'actions';
/** What the editor shows and inserts for the const roles (raw texts, translated where shown). `stub` is the value. */
export const SCENARIO_CONSTS = Object.freeze({
  budget: Object.freeze({ required: true, type: NUMBER, when: '回合开始前读取', returns: '每个回合最多走几步（正整数）。走满时回合截断（truncated）', stub: '1' }),
  actions: Object.freeze({ required: false, type: { type: 'array', of: STRING }, when: '执行实例和部署按名字显示动作时读取', returns: '每个动作的名字，下标就是动作编号', stub: "['left', 'right']" }),
});
/** Every role in file order: what the editor lists and where it inserts a missing one. */
export const SCENARIO_ORDER = Object.freeze(['budget', 'actions', 'init', 'input', 'step']);
/** The fields step returns, exactly. */
const STEP_FIELDS = Object.freeze(['done', 'state', 'success']);
const scalar = { number: NUMBER, string: STRING, boolean: BOOLEAN };

/** The record a partition's episodes have, from its handle's `episode` tag (partition.js episodeTag): what init receives. */
function startTypeOf(tag) {
  if (tag.kind === 'seed') return record({ seed: NUMBER });
  if (tag.kind === 'window') return record({ start: NUMBER, length: NUMBER });
  const fields = { index: NUMBER };
  for (const [name, type] of Object.entries(tag.axes)) fields[name] = scalar[type];
  return record(fields);
}

/** Transition as the runner delivers it. */
const transitionType = State => record({ prev: State, action: NUMBER, next: State, done: BOOLEAN, truncated: BOOLEAN, success: BOOLEAN });
/** Episode summary a metric receives. */
export const episodeType = State => record({ initial: State, final: State, steps: NUMBER, success: BOOLEAN, return: NUMBER });

/** `I` zero bits as an expression: one bits() takes at most LIMITS.maxBitsWidth, so wider ones concatenate. */
function zeroBits(I) {
  const parts = [];
  for (let left = I; left > 0; left -= LIMITS.maxBitsWidth) parts.push(`bits(0, ${Math.min(left, LIMITS.maxBitsWidth)})`);
  return parts.length > 1 ? `concat(${parts.join(', ')})` : parts[0];
}

/** The runner's calls, with `<ref>`s. `withTable` adds the table argument. `I` (when known) is the width input's stub
 *  returns. For the editor, each also gives the default parameter names (a scenario names its own, but the count and
 *  types are the protocol), one line per parameter, when the runner calls it, what the result means and a body that
 *  compiles (raw texts, translated where shown). */
export function scenarioSignatures(withTable, I = null) {
  const tbl = withTable ? [ref('Table')] : [], tblName = withTable ? ['table'] : [], tblDoc = withTable ? ['数据集：到当前行为止的行'] : [];
  return {
    init: { params: [ref('Start')], names: ['start'], docs: ['分区给出的一个回合'], result: { anyRecord: true },
      when: '每个回合开始时调用一次', returns: '回合的初始状态：之后每一步收到的 state', stub: 'return { ...start };' },
    input: { params: [ref('State'), ...tbl], names: ['state', ...tblName], docs: ['当前状态', ...tblDoc], result: binaryVector(1, MAX_BITS),
      when: '每一步开始时调用', returns: '网络这一步看到的输入位', stub: `return ${zeroBits(I ?? 1)};` },
    step: { params: [ref('State'), NUMBER, ...tbl], names: ['state', 'action', ...tblName], docs: ['当前状态', '回路这一步给出的动作编号', ...tblDoc], result: recordWith({ state: ref('State'), done: BOOLEAN, success: BOOLEAN }),
      when: '回路给出动作后调用', returns: '下一个状态，回合是否结束（done），是否成功（success）', stub: 'return { state, done: true, success: false };' },
  };
}

/** The text of role `name`: a function with signature `sig`'s default parameter names and its stub body, or — `sig`
 *  null — a const role of SCENARIO_CONSTS with its stub value. */
export function roleText(name, sig) {
  if (!sig) return `export const ${name} = ${SCENARIO_CONSTS[name].stub};\n`;
  return `export function ${name}(${sig.names.join(', ')}) {\n  ${sig.stub ?? ''}\n}\n`;
}
/** A scenario that satisfies the protocol: every function role and every required const, each its stub
 *  (`withTable`, `I`: scenarioSignatures). `exports` (roleExports) names the function of each role. */
export function scenarioStub(withTable, I = null, exports = roleExports(null)) {
  const sigs = scenarioSignatures(withTable, I);
  return SCENARIO_ORDER.filter(n => SCENARIO_CALLS.includes(n) || SCENARIO_CONSTS[n].required).map(n => roleText(exports[n] ?? n, sigs[n] ?? null)).join('');
}

/**
 * The scenario typed as the runner calls it. `scene` is the scenario code node (null while unwired). `sceneInType`
 * types that module's inputs. `tag` is the episode kind the loop's drivers run it on (null while unknown). `Table` is
 * their dataset's type (null without one). `exports` (roleExports) names the export that fills each role. → `{ scene,
 * analysis, refs, calls, signatures, exports }`: refs (Start, State, Transition, Episode, I, Table, each null while
 * unknown), each role's typed call `{ result, error, bound }` (absent when the scenario has no such export) and the
 * analysis of the file (kinds/code.js). Errors name the export.
 */
export function analyseScenario(scene, sceneInType, { tag = null, Table = null, exports = roleExports(null) } = {}) {
  const refs = { Start: tag ? startTypeOf(tag) : null, State: null, Transition: null, Episode: null, I: null, Table: Table ?? null }, calls = {}, sig = scenarioSignatures(!!Table);
  if (!scene) return { scene: null, analysis: null, refs, calls, signatures: sig, exports };
  const analysis = analyseModule(scene, sceneInType), fns = analysis.module.functions, tbl = Table ? [Table] : [];
  const fn = role => fns[exports[role]];
  const call = (role, args) => {
    const name = exports[role], r = callFunction(analysis, name, args, { exact: true });
    let error = r.error;
    if (!error) {
      const s = resolveSignature(sig[role], refs);
      if (unresolvedRefs({ params: [], result: s.result }).length) error = incomplete(t('{name} 的返回类型尚未确定', { name }));
      else { const problem = mismatch(r.result, s.result); if (problem) error = new Error(t('{name} 的返回值{problem}', { name, problem })); }
    }
    return (calls[role] = { result: r.result, error, bound: r.bound });
  };
  if (refs.Start) {
    if (!fn('init')) refs.State = refs.Start;
    else { const init = call('init', [refs.Start]); if (!init.error) refs.State = init.result; }
  }
  if (refs.State) {
    refs.Transition = transitionType(refs.State); refs.Episode = episodeType(refs.State);
    if (fn('input')) { const input = call('input', [refs.State, ...tbl]); if (!input.error) refs.I = input.result.width; }
    if (fn('step')) {
      const step = call('step', [refs.State, NUMBER, ...tbl]);
      const extra = step.error || step.result?.type !== 'record' ? [] : Object.keys(step.result.fields).filter(k => !STEP_FIELDS.includes(k));
      if (extra.length) step.error = new Error(t('{name} 只能返回 state、done、success 三个字段，多了 {names}', { name: exports.step, names: joinList(extra) }));
    }
  }
  // roles the chain above did not reach still say why
  const why = refs.Start ? name => incomplete(t('{name} 要等 {init} 的类型确定', { name, init: exports.init })) : () => incomplete(t('先把回路接到训练器、评估器或执行实例：它们的分区决定回合从什么开始'));
  for (const role of SCENARIO_CALLS) if (fn(role) && !(role in calls)) calls[role] = { result: null, error: fn(role).error ?? why(exports[role]), bound: null };
  return { scene, analysis, refs, calls, signatures: sig, exports };
}

/**
 * Why the scenario `a` (analyseScenario's result) cannot be run, as problems on the loop's `scenario` port. A missing
 * role or an unused export is `incomplete`: it blocks bundles, training and evaluation, but not wiring. A blank code
 * module can be wired before its roles are written. An export that any loop on this scene uses as a role is not
 * unused: one file serves several loops, each with its own role exports.
 */
export function scenarioProblems(ctx, a) {
  const { scene, analysis, calls, exports } = a;
  if (!scene) return [];
  const mod = analysis.module, out = [], port = 'scenario';
  if (mod.error) return [{ port, message: t('场景 {title} 的代码无法编译', { title: scene.title }), incomplete: true }];
  const exported = name => mod.consts.find(c => c.exported && c.name === name);
  const A = exported(ACTIONS) ? analysis.types[ACTIONS] : null;
  if (A && !(A.type === 'array' && A.of.type === 'string')) out.push({ port, message: t('actions 需要字符串数组，得到 {type}', { type: typeName(A) }) });
  // init is optional only under its own name: a loop that maps it to another export needs that export (ADR 0022)
  for (const role of [...REQUIRED_CALLS, ...(exports.init !== 'init' ? ['init'] : [])]) if (!mod.functions[exports[role]]) out.push({ port, message: t('场景 {title} 没有导出函数 {name}', { title: scene.title, name: exports[role] }), incomplete: true });
  for (const role of SCENARIO_CALLS) { const call = calls[role]; if (call?.error) out.push({ port, message: t('{name}：{error}', { name: exports[role], error: call.error.message }), incomplete: !!call.error.incomplete }); }
  // an exported function no loop on this scene calls and nothing else is wired to is most likely a misspelt role
  const used = new Set(ctx.consumers(scene.id, 'module').filter(c => c.port === 'scenario').flatMap(c => Object.values(roleExports(ctx.node(c.node)))));
  for (const name of Object.keys(mod.functions)) {
    if (used.has(name) || ctx.consumers(scene.id, name).length) continue;
    out.push({ port, incomplete: true, message: t('场景导出了 {name}，但运行器不调用它，也没有接到别处（运行器调用：{roles}）', { name, roles: joinList(SCENARIO_CALLS.map(role => exports[role])) }) });
  }
  if (!exported(BUDGET)) out.push({ port, message: t('场景 {title} 没有导出常量 budget（每回合最多几步）', { title: scene.title }), incomplete: true });
  else { const B = analysis.types[BUDGET]; if (B && mismatch(B, NUMBER)) out.push({ port, message: t('budget 需要数字，得到 {type}', { type: typeName(B) }) }); }
  return out;
}

/**
 * Doc trees of the scenario's named types on the loop `node` (core/docs.js): State is what init returns (Start without
 * init), Start the record of the drivers' partition episodes, Transition and Episode the runner's records. `part` is a
 * driver's partition node (null while none is wired). null for any other name.
 */
export function scenarioRefDoc(node, name, d, part) {
  const text = zh => ({ text: t(zh) }), withTable = !!part && d.producers(part.id, 'table').length > 0;
  const p = d.producers(node.id, 'scenario')[0], scene = p ? d.node(p.node) : null;
  switch (name) {
    case 'State': {
      const init = roleExports(node).init;
      if (!scene || !scene.config.exports.some(e => e.kind === 'function' && e.name === init)) return d.ref(node.id, 'Start');
      const params = scenarioSignatures(withTable).init.params;
      return functionResultDoc(scene, init, i => (isRef(params[i]) ? d.ref(node.id, params[i].slice(1, -1)) : null), d);
    }
    case 'Start': {
      if (!part) return null;
      const { kind } = episodeTag(part.config);
      if (kind === 'seed') return { fields: { seed: text('回合种子：决定这一回合的随机内容') } };
      if (kind === 'window') return { fields: { start: text('窗口的起始行'), length: text('窗口的行数') } };
      return { fields: { index: text('回合序号') } };
    }
    case 'Transition': return { fields: {
      prev: mergeDocs(text('这一步之前的状态'), d.ref(node.id, 'State')),
      action: text('这一步的动作'),
      next: mergeDocs(text('这一步之后的状态'), d.ref(node.id, 'State')),
      done: text('回合结束：step 判定结束，或步数达到 budget'),
      truncated: text('步数达到 budget 时 step 没有判定结束，所以运行器截断了回合'),
      success: text('step 判定这一步成功'),
    } };
    case 'Episode': {
      const State = d.ref(node.id, 'State');
      return { fields: {
        initial: mergeDocs(text('回合开始时的状态'), State), final: mergeDocs(text('回合结束时的状态'), State),
        steps: text('回合用掉的步数'), success: text('回合是否成功（最后一步的 success）'), return: text('回合回报：各步 objective 奖励之和（没有 objective 时为 0）'),
      } };
    }
    default: return null;
  }
}
