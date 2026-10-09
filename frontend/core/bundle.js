// core/bundle.js — the `neurom-bundle` snapshot a trainer / evaluator / execution consumes (ADR 0009 §3).
// The builder walks the consumer's inputs in a resolved graph. Every exported function a call wire reaches becomes a
// compiled program plus the static values of the file-level names it reads. These names are its code module's inputs
// and top-level consts, and each const is evaluated once. The scenario module in the driven loop's `scenario` gives
// one program per role and its `budget` / `actions` consts. The partitions the loop's drivers run it on type them.
// The loop body is the `loop` section (core/loop.js loopSection). Partitions, recipe and metrics are copied as
// canonical JSON. `hash` identifies the whole bundle. `envHash` identifies the environment (env alone), so modules
// with different objectives and bodies can share one.
//
//   programs.<name> = { program, bound:{name: value}, boundTypes:{name: Type}, exact }   (also objective / metrics)
//   env = { programs: { init?, input, step }, budget, actions, start, types: { Start, State, Transition, I, table? }, tables? }
import * as ir from '../ir/index.js';
import { canonicalize, hashOf } from './canonical.js';
import { paramsValue } from './kinds/params.js';
import { METHODS } from './kinds/trainer.js';
import { SCENARIO_CALLS, REQUIRED_CALLS, BUDGET, ACTIONS } from './kinds/scenario.js';
import { loopAnalysis, driversStart, loopOf, graphView } from './kinds/loop.js';
import { analyseModule } from './kinds/code.js';
import { randomTables } from './kinds/random.js';
import { ROLES } from './kinds/partition.js';
import { loopSection } from './loop.js';
import { t } from '../i18n.js';

const BUNDLE_FORMAT = 'neurom-bundle';
const CONSUMERS = new Set(['trainer', 'evaluator', 'execution']);

export class BundleError extends Error {
  constructor(message, problems = []) { super(message); this.name = 'BundleError'; this.problems = problems; }
}

/** The output ports of `nodeId` that have a static value (staticValue's cases): a params module's `params`, a text's
 *  `text`, a random module's `rng`, a code module's exported consts. */
export function staticPorts(graph, nodeId) {
  const node = graph.node(nodeId);
  switch (node.kind) {
    case 'params': return ['params'];
    case 'text': return ['text'];
    case 'random': return ['rng'];
    case 'code': return node.config.exports.filter(e => e.kind === 'const').map(e => e.name);
    default: return [];
  }
}

/** Statically evaluate an output port: params values, a code module's exported consts (each computed once over the
 *  static values of its inputs), random tables, text. Throws BundleError for anything only known at run time. Also
 *  throws for params whose values break their declarations (a type, range or constraint-expression problem): no
 *  bundle carries them. */
export function staticValue(graph, res, nodeId, port) {
  const node = graph.node(nodeId);
  const dot = port.indexOf('.'), base = dot < 0 ? port : port.slice(0, dot);
  const whole = (() => {
    switch (node.kind) {
      case 'params': {
        const errors = res.problemsOf(nodeId).filter(p => !p.incomplete && !p.port);
        if (errors.length) throw new BundleError(t('参数 {title} 尚有问题：{message}', { title: node.title, message: errors[0].message }), errors);
        return paramsValue(node.config);
      }
      case 'text': return node.config.text;
      case 'random': if (base === 'rng') return randomTables(node.config); break;
      case 'code': if (node.config.exports.some(e => e.kind === 'const' && e.name === base)) return fileValues(graph, res, nodeId).value(base); break;
    }
    throw new BundleError(t('{title} 的 {port} 不是静态值', { title: node.title, port }));
  })();
  if (dot < 0) return whole;
  let at = whole;
  for (const field of port.slice(dot + 1).split('.')) {
    if (at === null || typeof at !== 'object' || Array.isArray(at) || !Object.hasOwn(at, field)) throw new BundleError(t('{title} 的 {port} 没有字段 {field}', { title: node.title, port, field }));
    at = at[field];
  }
  return at;
}

const producerOf = (graph, nodeId, port) => graph.producers(nodeId, port)[0] ?? null;
const value = (graph, res, nodeId, port) => {
  const p = producerOf(graph, nodeId, port);
  if (!p) throw new BundleError(t('必需输入 {port} 尚未连接', { port }));
  return staticValue(graph, res, p.node, p.port);
};

const fileMemo = new WeakMap();
/** A code module's file-level values: each input (the static value of its wire) and each top-level const (its program
 *  run once over the values it reads). `value(name)` evaluates on demand, memoised per resolution. */
function fileValues(graph, res, codeId, node = graph.node(codeId)) {
  let perRes = fileMemo.get(res);
  if (!perRes) fileMemo.set(res, (perRes = new Map()));
  if (perRes.has(node)) return perRes.get(node);
  const { module: mod, types } = analyseModule(node, name => res.inTypeOf(codeId, name));
  if (mod.error) throw new BundleError(t('{title} 的代码无法编译：{error}', { title: node.title, error: mod.error.message }));
  const memo = new Map();
  const valueOf = name => {
    if (memo.has(name)) return memo.get(name);
    const c = mod.consts.find(x => x.name === name);
    let v;
    if (!c) v = value(graph, res, codeId, name);
    else {
      if (c.error) throw new BundleError(t('常量 {name}：{error}', { name, error: c.error.message }));
      const deps = c.deps.map(n => types[n]);
      if (deps.some(T => !T)) throw new BundleError(t('常量 {name} 读的值类型尚未确定', { name }));
      v = ir.compile(c.program, deps, { exact: false }).run(...c.deps.map(valueOf));
    }
    memo.set(name, v);
    return v;
  };
  const out = { module: mod, types, value: valueOf };
  perRes.set(node, out);
  return out;
}
/** Bundle entry for the exported function `fn` of code module `codeId`, typed by `boundTypes`: its program and the
 *  static values of the file-level names it reads. */
function functionEntry(graph, res, codeId, fn, boundTypes, exact) {
  const values = fileValues(graph, res, codeId), f = values.module.functions[fn];
  return { program: f.program, bound: Object.fromEntries(f.bound.map(n => [n, values.value(n)])), boundTypes: { ...boundTypes }, exact };
}

/** Compiled-program entry for a call port: the called function's program with its bound values. */
export function programEntry(graph, res, nodeId, port, wire = null) {
  const site = wire ? res.callSites(nodeId, port).find(s => s.wire.id === wire) : res.callSite(nodeId, port);
  if (!site) {
    const problem = res.problems.find(p => p.node === nodeId && p.port === port);
    throw new BundleError(problem ? problem.message : t('调用端口 {port} 没有可用的函数', { port }), problem ? [problem] : []);
  }
  return { ...functionEntry(graph, res, site.node.id, site.fn, site.carries.bound, site.exact), result: site.result, node: site.node };
}

/**
 * The `env` section of loop `loopId`: every role its scenario module exports, as the runner calls it, and its
 * `budget` / `actions`. The partitions the loop's drivers run it on type them. Their episode kind is what init
 * receives, and the dataset wired into them is the table the steps read.
 */
export function envBundle(graph, loopId, res = graph.resolved()) {
  const loop = graph.node(loopId), sceneWire = producerOf(graph, loopId, 'scenario');
  if (!sceneWire) throw new BundleError(t('必需输入 {port} 尚未连接', { port: 'scenario' }));
  const errors = res.problemsOf(loopId).filter(p => p.port === 'scenario' || p.port === 'loop');
  if (errors.length) throw new BundleError(t('{title} 的场景尚有问题：{message}', { title: loop.title, message: errors[0].message }), errors);
  const view = graphView(graph, res), start = driversStart(view, loopId), { tag } = start;
  if (!tag) throw new BundleError(t('回路 {title} 还没有驱动它的分区', { title: loop.title }));
  const { refs, calls } = loopAnalysis(loop, view);
  const scene = graph.node(sceneWire.node), values = fileValues(graph, res, scene.id), mod = values.module;
  const programs = {};
  for (const name of SCENARIO_CALLS) if (mod.functions[name]) programs[name] = functionEntry(graph, res, scene.id, name, calls[name].bound, true);
  const out = {
    programs,
    budget: values.value(BUDGET),
    actions: mod.consts.some(c => c.exported && c.name === ACTIONS) ? values.value(ACTIONS) : null,
    start: tag.kind,
    types: { Start: refs.Start, State: refs.State, Transition: refs.Transition, I: refs.I, ...(refs.Table ? { table: refs.Table } : {}) },
  };
  const tables = tableEntries(graph, start.tableNode);
  if (tables.length) out.tables = tables;
  if (!Number.isInteger(out.budget) || out.budget < 1) throw new BundleError(t('budget 必须是正整数，得到 {value}', { value: String(out.budget) }));
  return out;
}
/** The dataset node `tableNode` the loop's drivers' partitions read (driversStart: they agree), as
 *  `[{ id, hash, columns }]`. [] for none. */
function tableEntries(graph, tableNode) {
  if (!tableNode) return [];
  const ds = graph.node(tableNode);
  if (ds.kind !== 'dataset') throw new BundleError(t('分区的 table 需要接数据集模块'));
  if (!ds.config.datasetId || !ds.config.hash) throw new BundleError(t('数据集 {name} 尚未导入', { name: ds.config.name }));
  return [{ id: ds.config.datasetId, hash: ds.config.hash, columns: [...ds.config.columns] }];
}

/** Bundle entry of the partition wired into `nodeId.port` (the episodes selectEpisode / episodesOf enumerate), or null. */
export function partitionEntry(graph, nodeId, port) {
  const p = producerOf(graph, nodeId, port);
  if (!p) return null;
  const node = graph.node(p.node);
  if (node.kind !== 'partition' || !ROLES.includes(p.port)) throw new BundleError(t('{port} 需要分区句柄', { port }));
  const c = node.config, role = p.port;
  if (c.kind === 'seed') return { kind: 'seed', ...c.seed[role] };
  if (c.kind === 'enumerate') return { kind: 'enumerate', axes: c.enumerate.axes, select: c.enumerate.roles[role] };
  const tableProducer = producerOf(graph, node.id, 'table');
  const rows = tableProducer ? graph.node(tableProducer.node).config.rows : 0;
  return { kind: 'window', length: c.window.length, stride: c.window.stride, embargo: c.window.embargo, range: c.window.splits[role] ?? null, first: Math.min(...Object.values(c.window.splits).filter(Boolean).map(r => r[0])), rows };
}

/** Build the bundle a consumer node (trainer / evaluator / execution) needs. `artifacts(id) → artifact | null` finds
 *  the accepted weights of the loop's networks (not of the trained one). Throws BundleError with the blocking
 *  problems when the graph is not ready. Pure JSON, canonical key order. */
export function buildBundle(graph, consumerId, { res = graph.resolved(), artifacts = null } = {}) {
  const consumer = graph.node(consumerId);
  if (!CONSUMERS.has(consumer.kind)) throw new BundleError(t('{title} 不是训练器 / 评估器 / 执行实例', { title: consumer.title }));
  const errors = res.problemsOf(consumerId).filter(p => !p.incomplete);
  if (errors.length) throw new BundleError(t('{title} 尚有问题：{message}', { title: consumer.title, message: errors[0].message }), errors);
  const bundle = { format: BUNDLE_FORMAT };
  const loop = loopOf(graph, consumer);
  if (!loop) throw new BundleError(t('必需输入 {port} 尚未连接', { port: 'loop' }));
  const trained = consumer.kind === 'trainer' ? producerOf(graph, consumerId, 'structure')?.node ?? null : null;
  if (consumer.kind === 'trainer' && !trained) throw new BundleError(t('必需输入 {port} 尚未连接', { port: 'structure' }));
  bundle.env = envBundle(graph, loop.id, res);
  bundle.loop = loopSection(graph, res, loop.id, { trained, artifacts });
  const partition = port => { const entry = partitionEntry(graph, consumerId, port); if (!entry) throw new BundleError(t('必需输入 {port} 尚未连接', { port })); return entry; };
  const program = (port, wire = null) => { const e = programEntry(graph, res, consumerId, port, wire); return { program: e.program, bound: e.bound, boundTypes: e.boundTypes, exact: false }; };
  if (consumer.kind === 'trainer') {
    const { method, ...recipe } = consumer.config;
    bundle.objective = { kind: METHODS[method].objective, ...program('objective') };
    bundle.selection = producerOf(graph, consumerId, 'metric') ? program('metric') : null;
    bundle.partitions = { training: partition('training') };
    const validation = partitionEntry(graph, consumerId, 'validation');
    if (validation) bundle.partitions.validation = validation;
    bundle.recipe = { method, ...recipe };
  }
  if (consumer.kind === 'evaluator') {
    bundle.partitions = { test: partition('partition') };
    if (producerOf(graph, consumerId, 'objective')) bundle.objective = { kind: 'reward', ...program('objective') };
    bundle.metrics = graph.producers(consumerId, 'metrics').map(p => ({ name: graph.node(p.node).title, ...program('metrics', p.wire.id) }));
    if (consumer.config.groupBy) bundle.groupBy = consumer.config.groupBy;
  }
  if (consumer.kind === 'execution') bundle.partitions = { test: partition('partition') };
  return canonicalize(bundle);
}

/** sha256 of the canonical bundle. */
export const bundleHash = bundle => hashOf(bundle);
/** Identity of the environment: sha256 of `env` alone (the "same environment" check). */
export function envHash(bundle) {
  if (!bundle.env) throw new BundleError(t('训练快照没有环境'));
  return hashOf(bundle.env);
}

/** Why a bundle is malformed. '' when it is well-formed. */
export function bundleProblem(bundle) {
  if (!bundle || bundle.format !== BUNDLE_FORMAT) return t('需要 {format} 快照', { format: BUNDLE_FORMAT });
  if (bundle.env) {
    const { programs, types } = bundle.env;
    if (!programs || !types) return t('训练快照的 env 缺少 programs 或 types');
    for (const name of REQUIRED_CALLS) if (!programs[name]?.program) return t('训练快照的 env 缺少程序 {name}', { name });
    if (!Number.isInteger(bundle.env.budget) || bundle.env.budget < 1) return t('budget 必须是正整数，得到 {value}', { value: String(bundle.env.budget) });
  }
  if (bundle.loop && !(bundle.loop.nodes && bundle.loop.action && Number.isInteger(bundle.loop.I))) return t('训练快照缺少回路');
  return '';
}
