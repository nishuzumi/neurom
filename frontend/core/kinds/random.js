// core/kinds/random.js — the random number generator of a scenario: a 32-bit linear congruential generator
// s' = (multiplier · s + increment) mod 2^32. It comes as jump-ahead tables, so a program reads any draw directly
// instead of stepping a state. From seed s, the (k+1)-th output is (mul[k] · s + add[k]) mod 2^32, that is
// `add32(imul32(rng.mul[k], u32(seed)), rng.add[k])`. Divide it by 2^32 for a number in [0, 1). The tables are a
// static value (computed once, bound into the programs that read them). The seed comes with the episode.
import { registerKind } from '../registry.js';
import { valueOut } from './common.js';
import { NUMBER, array, record } from '../types.js';
import { LIMITS } from '../../ir/index.js';
import { t } from '../../i18n.js';

const TWO32 = 4294967296;
const imul32 = (a, b) => Math.imul(a, b) >>> 0;
const add32 = (a, b) => (a + b) % TWO32;

/** `{ mul, add }` of length `draws`: mul[k] = a^(k+1), add[k] = c · (1 + a + … + a^k), both mod 2^32. */
export function randomTables({ multiplier, increment, draws }) {
  const mul = [], add = [];
  let m = 1, c = 0;
  for (let k = 0; k < draws; k++) { m = imul32(m, multiplier); c = add32(imul32(c, multiplier), increment); mul.push(m); add.push(c); }
  return { mul, add };
}
const tablesType = config => record({ mul: array(config.draws, NUMBER), add: array(config.draws, NUMBER) });

registerKind({
  kind: 'random',
  label: '随机数',
  config: {
    defaults: { multiplier: 1664525, increment: 1013904223, draws: 512 },
    schema: {
      multiplier: { type: 'int', min: 1, max: TWO32 - 1 },
      increment: { type: 'int', min: 0, max: TWO32 - 1 },
      draws: { type: 'int', min: 1, max: LIMITS.maxArrayLength },
    },
  },
  ports(node) { return { inputs: [], outputs: [{ ...valueOut('rng', tablesType(node.config)), doc: t('随机数表：从种子 s 出发的第 k+1 个输出是 add32(imul32(rng.mul[k], u32(s)), rng.add[k])') }] }; },
  docs: {
    output: (node, port) => (port === 'rng' ? { text: t('线性同余随机数表（每组配置算一次）'), fields: {
      mul: { text: t('mul[k] = 乘数的 k+1 次方（mod 2^32）') },
      add: { text: t('add[k] = 增量 ·（1 + 乘数 + … + 乘数^k）（mod 2^32）') },
    } } : null),
  },
  infer(node) { return { rng: tablesType(node.config) }; },
  problems(node) {
    const { multiplier, increment } = node.config;
    // Hull–Dobell: mod 2^32 the period is full only for an odd increment and a multiplier ≡ 1 (mod 4)
    return increment % 2 === 1 && multiplier % 4 === 1 ? [] : [{ message: t('乘数应当 ≡ 1 (mod 4)、增量应当是奇数，否则周期达不到 2^32') }];
  },
});
