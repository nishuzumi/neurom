// core/kinds/partition.js — splits episodes into training / validation / test (episode sources):
//   seed       role → { seed, count }: episodes { seed: seed+i }
//   enumerate  axes {name: [values]} → the cartesian product. role → 'all' | 'even' | 'odd' | [indices] |
//              { mod: N, rem: [r…] } (indices whose remainder mod N is in rem): episodes { index, <axis>: value… }
//   window     time windows over a table: { length, stride, embargo, splits:{ role:[from, to] } fractions of the rows }.
//              episodes { start, length }. An embargo of rows is skipped at the start of every split but the first.
// Each role output is a partition handle tagged with the episode kind: a consumer types its scenario's `init` by it
// (kinds/scenario.js), and the dataset wired into `table` is the table the scenario's steps read.
import { registerKind } from '../registry.js';
import { valueIn, valueOut } from './common.js';
import { handle, STRING, BOOLEAN, NUMBER, ANY_TABLE } from '../types.js';
import { t } from '../../i18n.js';

export const ROLES = Object.freeze(['training', 'validation', 'test']);
const AXIS_VALUE = { type: 'json' };
const RANGE = { type: 'list', of: { type: 'number', min: 0, max: 1 }, min: 2, max: 2 };

const config = {
  defaults: {
    kind: 'seed',
    seed: { training: { seed: 1, count: 64 }, validation: { seed: 100000, count: 32 }, test: { seed: 200000, count: 100 } },
    enumerate: { axes: {}, roles: { training: 'all', validation: 'all', test: 'all' } },
    window: { length: 64, stride: 1, embargo: 0, splits: { training: [0, 0.7], validation: [0.7, 0.85], test: [0.85, 1] } },
  },
  schema: {
    kind: { type: 'enum', values: ['seed', 'enumerate', 'window'] },
    seed: { type: 'object', fields: Object.fromEntries(ROLES.map(role => [role, { type: 'object', fields: { seed: { type: 'int', min: 0, max: 0xffffffff }, count: { type: 'int', min: 0, max: 1_000_000 } } }])) },
    enumerate: { type: 'object', fields: { axes: { type: 'map', of: { type: 'list', of: AXIS_VALUE, min: 1 } }, roles: { type: 'object', fields: Object.fromEntries(ROLES.map(role => [role, { type: 'json' }])) } } },
    window: { type: 'object', fields: { length: { type: 'int', min: 1 }, stride: { type: 'int', min: 1 }, embargo: { type: 'int', min: 0 }, splits: { type: 'object', fields: Object.fromEntries(ROLES.map(role => [role, { ...RANGE, optional: true }])) } } },
  },
};

const axisType = values => (typeof values[0] === 'string' ? STRING : typeof values[0] === 'boolean' ? BOOLEAN : NUMBER);

/** The `episode` tag a partition's handles carry (kinds/scenario.js startTypeOf reads it). */
export function episodeTag(cfg) {
  return cfg.kind === 'enumerate' ? { kind: 'enumerate', axes: Object.fromEntries(Object.keys(cfg.enumerate.axes).sort().map(name => [name, axisType(cfg.enumerate.axes[name]).type])) } : { kind: cfg.kind };
}

function product(axes) {
  const names = Object.keys(axes);
  let out = [{}];
  for (const name of names) out = out.flatMap(partial => axes[name].map(value => ({ ...partial, [name]: value })));
  return out.map((episode, index) => ({ index, ...episode }));
}
const isModSelection = sel => sel !== null && typeof sel === 'object' && !Array.isArray(sel) && Object.keys(sel).sort().join() === 'mod,rem'
  && Number.isInteger(sel.mod) && sel.mod >= 1 && sel.mod <= 1000 && Array.isArray(sel.rem) && sel.rem.every(r => Number.isInteger(r) && r >= 0 && r < sel.mod);
function selectRole(all, selection) {
  if (selection === 'all') return all;
  if (selection === 'even') return all.filter(e => e.index % 2 === 0);
  if (selection === 'odd') return all.filter(e => e.index % 2 === 1);
  if (isModSelection(selection)) return all.filter(e => selection.rem.includes(e.index % selection.mod));
  return selection.map(i => all[i]);
}

/** The episodes of one role. `rows` (table length) is needed for window partitions. */
export function partitionEpisodes(cfg, role, { rows = 0 } = {}) {
  if (!ROLES.includes(role)) throw new Error(t('未知分区角色：{role}', { role: String(role) }));
  if (cfg.kind === 'seed') { const { seed, count } = cfg.seed[role]; return Array.from({ length: count }, (_, i) => ({ seed: seed + i })); }
  if (cfg.kind === 'enumerate') return selectRole(product(cfg.enumerate.axes), cfg.enumerate.roles[role]);
  const { length, stride, embargo, splits } = cfg.window;
  const range = splits[role];
  if (!range) return [];
  const first = Math.min(...Object.values(splits).filter(Boolean).map(r => r[0]));
  let lo = Math.floor(range[0] * rows) + (range[0] > first ? embargo : 0);
  const hi = Math.floor(range[1] * rows);
  const out = [];
  for (let start = lo; start + length <= hi; start += stride) out.push({ start, length });
  return out;
}

/** Why the config is inconsistent, or [] when fine. */
function partitionProblems(cfg) {
  const out = [];
  if (cfg.kind === 'enumerate') {
    const count = Object.values(cfg.enumerate.axes).reduce((n, values) => n * values.length, 1);
    if (!Object.keys(cfg.enumerate.axes).length) out.push({ message: t('枚举分区至少需要一条轴') });
    for (const [name, values] of Object.entries(cfg.enumerate.axes)) {
      const T = axisType(values);
      if (!values.every(v => typeof v === (T.type === 'number' ? 'number' : T.type))) out.push({ message: t('轴 {name} 的取值类型不一致', { name }) });
    }
    for (const role of ROLES) {
      const sel = cfg.enumerate.roles[role];
      if (!(sel === 'all' || sel === 'even' || sel === 'odd' || isModSelection(sel) || (Array.isArray(sel) && sel.every(i => Number.isInteger(i) && i >= 0 && i < count)))) out.push({ port: role, message: t('分区 {role} 的选择必须是 all / even / odd、合法下标数组或 { mod, rem }', { role }) });
    }
  }
  if (cfg.kind === 'window') {
    const ranges = ROLES.map(role => [role, cfg.window.splits[role]]).filter(([, r]) => r);
    for (const [role, [a, b]] of ranges) if (a >= b) out.push({ port: role, message: t('分区 {role} 的区间必须满足 from < to', { role }) });
    for (let i = 0; i < ranges.length; i++) for (let j = i + 1; j < ranges.length; j++) {
      const [ra, [a0, a1]] = ranges[i], [rb, [b0, b1]] = ranges[j];
      if (a0 < b1 && b0 < a1) out.push({ message: t('分区 {a} 与 {b} 的区间重叠', { a: ra, b: rb }) });
    }
  }
  return out;
}

registerKind({
  kind: 'partition',
  label: '分区',
  config,
  ports(node) {
    const tag = episodeTag(node.config);
    return { inputs: [valueIn('table', ANY_TABLE, { required: node.config.kind === 'window' })], outputs: ROLES.map(role => valueOut(role, handle('partition', { episode: tag }))) };
  },
  infer(node) {
    const tag = episodeTag(node.config);
    return Object.fromEntries(ROLES.map(role => [role, handle('partition', { episode: tag })]));
  },
  problems(node) { return partitionProblems(node.config); },
});
