// core/runner.js — the browser episode runner over a bundle's `env` (training/bundle_env.py is the Python twin and must
// behave identically, ADR 0009 §1):
//   reset(start)   state = init ? init(start) : start; t = 0
//   input()        bits = input(state, rows ≤ cursor)                     (the table view only when a table is wired)
//   step(action)   r = step(state, action, rows ≤ cursor + 1)
//                  truncated = !r.done && t + 1 ≥ budget; done = r.done || truncated
//                  Transition = { prev: state, action, next: r.state, done, truncated, success: r.success }; state = r.state; t++
// cursor = start.start + t for window episodes, else t. Stepping after done is an error. `table` is the full table
// view (targets read it). Scenario parameters are not the runner's: each program carries the file-level values it
// reads as bound values.
import * as ir from '../ir/index.js';
import { checkValue, typeName, NUMBER } from './types.js';
import { REQUIRED_CALLS } from './kinds/scenario.js';
import { compileEntry } from './sessions/common.js';
import { t } from '../i18n.js';

export class RunnerError extends Error {
  constructor(message) { super(message); this.name = 'RunnerError'; }
}

function ensure(T, v, what) {
  const problem = checkValue(T, v);
  if (problem) throw new RunnerError(t('{what} 返回值不符合 {type}：{problem}', { what, type: typeName(T), problem }));
  return v;
}

/** The compiled programs of an env section, compiled once and shared by every runner on it. Programs keep no state
 *  between calls, so the lanes of a lockstep run share them as one runner's steps do. */
const compiled = new WeakMap();
function programsOf(envBundle) {
  let p = compiled.get(envBundle);
  if (p) return p;
  const { programs, types: { Start, State } } = envBundle, tbl = envBundle.types.table ? [envBundle.types.table] : [];
  p = { init: programs.init ? compileEntry(programs.init, [Start], 'init') : null, input: compileEntry(programs.input, [State, ...tbl], 'input'), step: compileEntry(programs.step, [State, NUMBER, ...tbl], 'step') };
  compiled.set(envBundle, p);
  return p;
}

/**
 * Create a runner for `envBundle` (a bundle's `env`). `tables` maps dataset id → `{ column: number[]|Float64Array }`
 * (needed only when the env reads a table).
 */
export function createEnv(envBundle, { tables = {} } = {}) {
  const { programs, budget, types } = envBundle;
  if (!programs || !types) throw new RunnerError(t('训练快照的 env 缺少 programs 或 types'));
  if (!Number.isInteger(budget) || budget < 1) throw new RunnerError(t('budget 必须是正整数，得到 {value}', { value: String(budget) }));
  for (const name of REQUIRED_CALLS) if (!programs[name]) throw new RunnerError(t('训练快照的 env 缺少程序 {name}', { name }));
  const { Start, I } = types;
  const columns = (() => {
    if (!envBundle.tables?.length) return null;
    const { id } = envBundle.tables[0];
    if (!tables[id]) throw new RunnerError(t('缺少数据集 {id} 的数据', { id }));
    return tables[id];
  })();
  const rows = columns ? Math.max(0, ...Object.values(columns).map(c => c.length)) : 0;
  const view = hi => (columns ? [ir.tableView(columns, 0, Math.min(hi, rows - 1))] : []);
  const { init, input, step } = programsOf(envBundle);
  const bitsType = { type: 'vector', width: I, binary: true };
  const full = columns ? ir.tableView(columns, 0, rows - 1) : null;

  const env = {
    state: null, t: 0, done: false, start: null, budget,
    get cursor() { return (envBundle.start === 'window' ? env.start.start : 0) + env.t; },
    /** The full table view (a target objective's second argument), or null. */
    get table() { return full; },
    reset(start) {
      env.start = ensure(Start, start, t('回合'));
      env.state = init ? init(start) : structuredClone(start);                 // the IR checks every program's result against its type
      env.t = 0; env.done = false;
      return env.state;
    },
    /** Input bits for the current state (0/1-ness is a port constraint the IR's vector type cannot express). */
    input() {
      if (env.state === null) throw new RunnerError(t('先调用 reset'));
      return Array.from(ensure(bitsType, input(env.state, ...view(env.cursor)), 'input'));
    },
    /** Advance one step. Returns the Transition `{ prev, action, next, done, truncated, success }`. */
    step(action) {
      if (env.state === null) throw new RunnerError(t('先调用 reset'));
      if (env.done) throw new RunnerError(t('回合已结束，所以不能继续 step'));
      if (typeof action !== 'number' || !Number.isFinite(action)) throw new RunnerError(t('动作必须是数字'));
      const r = step(env.state, action, ...view(env.cursor + 1));
      const truncated = !r.done && env.t + 1 >= budget, done = r.done || truncated;
      const tr = { prev: env.state, action, next: r.state, done, truncated, success: r.success };
      env.state = r.state; env.t += 1; env.done = done;
      return tr;
    },
  };
  return env;
}
