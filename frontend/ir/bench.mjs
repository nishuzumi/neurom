// ir/bench.mjs — micro-benchmark (not a test). frontend/ir compiles a synthetic 8x8 grid step program. The benchmark runs
// it many times in JS and exports it, so training/bench_ir.py can replay it batched. Run: node frontend/ir/bench.mjs [seconds]
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFunction, compile } from './index.js';

const N = { type: 'number' }, B = { type: 'boolean' };
const R = fields => ({ type: 'record', fields }), A = (length, of) => ({ type: 'array', length, of });
const G = 8, CELLS = G * G;
const Cell = R({ ore: N, seen: B, wall: B, heat: N });
const State = R({ cells: A(CELLS, Cell), pos: N, t: N, bag: N, energy: N });
const Params = R({ seed: N, grid: N, decay: N, spawn: N });

const SOURCE = `function step(state, action, params) {
  const g = params.grid;
  const x = state.pos % g, y = Math.floor(state.pos / g);
  const dx = action === 1 ? 1 : action === 3 ? -1 : 0;
  const dy = action === 2 ? 1 : action === 0 ? -1 : 0;
  const tx = clamp(x + dx, 0, g - 1), ty = clamp(y + dy, 0, g - 1);
  const target = ty * g + tx;
  const blocked = state.cells[target].wall;
  const pos = blocked ? state.pos : target;
  const key = u32(params.seed);
  const tick = u32(state.t);
  const mined = action === 4 ? state.cells[state.pos].ore : 0;
  const cells = state.cells.map((c, i) => {
    const r = rand(key, add32(imul32(tick, 64), u32(i)));
    const cx = i % g, cy = Math.floor(i / g);
    const dist = Math.abs(cx - tx) + Math.abs(cy - ty);
    const visible = dist <= 2;
    const left = cx > 0 ? state.cells[i - 1].ore : 0, right = cx < g - 1 ? state.cells[i + 1].ore : 0;
    const up = cy > 0 ? state.cells[i - g].ore : 0, down = cy < g - 1 ? state.cells[i + g].ore : 0;
    const neighbours = left + right + up + down;
    const spread = neighbours >= 6 && r > 0.9 && !c.wall ? 1 : 0;
    const ore = i === state.pos && action === 4 ? 0 : c.ore + (r < params.spawn && !c.wall ? 1 : 0) + spread;
    const heat = c.heat * params.decay + (i === pos ? 1 : 0) + (visible ? 0.1 : 0) + neighbours / 100;
    return { ore: Math.min(ore, 9), seen: c.seen || visible, wall: c.wall, heat: Math.round(heat * 1000) / 1000 };
  });
  const stats = cells.reduce((acc, c, i) => ({
    seen: acc.seen + (c.seen ? 1 : 0),
    ore: acc.ore + c.ore,
    hot: c.heat > acc.maxHeat ? i : acc.hot,
    maxHeat: Math.max(acc.maxHeat, c.heat),
    walls: acc.walls + (c.wall ? 1 : 0),
  }), { seen: 0, ore: 0, hot: 0, maxHeat: -1, walls: 0 });
  const hx = stats.hot % g, hy = Math.floor(stats.hot / g);
  const danger = cells.map((c, i) => {
    const d = Math.abs(i % g - hx) + Math.abs(Math.floor(i / g) - hy);
    const w = c.wall ? 0 : d === 0 ? 4 : d === 1 ? 3 : d === 2 ? 2 : d <= 4 ? 1 : 0;
    return oneHot(w, 5);
  });
  const risk = danger.reduce((acc, v, i) => acc + v[4] * 4 + v[3] * 3 + v[2] * 2 + v[1], 0);
  const energy = state.energy - 1 + (mined > 0 ? mined * 2 : 0) - (blocked ? 1 : 0);
  const obs = concat(
    cells.map(c => c.seen && c.ore > 0 ? 1 : 0),
    cells.map(c => c.wall && c.seen ? 1 : 0),
    bits(pos, 6),
    thermometer(energy, [0, 5, 10, 20, 40]),
    thermometer(stats.ore, [1, 4, 16, 32]),
    bits(bucket(stats.seen, [8, 16, 32, 48, 64]), 3),
    thermometer(risk, [10, 20, 40, 80]),
    slice(danger[pos], 1, 5),
    bits(u32(Math.floor(rand(key, add32(tick, 7)) * 16)), 4),
  );
  const next = { ...state, cells, pos, t: state.t + 1, bag: state.bag + mined, energy };
  return { state: next, event: { mined, blocked, obs, stats, done: energy <= 0 || stats.seen === 64, reward: mined - (blocked ? 0.5 : 0) + stats.seen / 640 } };
}`;

function initialState(seed) {
  const cells = [];
  for (let i = 0; i < CELLS; i++) cells.push({ ore: (i * 7 + seed) % 5 === 0 ? 3 : 0, seen: false, wall: (i * 13 + seed) % 11 === 0 && i !== 27, heat: 0 });
  return { cells, pos: 27, t: 0, bag: 0, energy: 40 };
}
const PARAMS = { seed: 12345, grid: G, decay: 0.9, spawn: 0.05 };
const TYPES = [State, N, Params];

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const program = parseFunction(SOURCE);
  const count = program.nodes.length + program.nodes.reduce((n, node) => n + (node.body ? node.body.nodes.length : 0), 0);
  const compiled = compile(program, TYPES, { exact: true }), { cost } = compiled;
  const seconds = Number(process.argv[2] ?? 2);
  let state = initialState(1), runs = 0;
  const warm = performance.now();
  while (performance.now() - warm < 300) { state = compiled.run(state, runs % 5, PARAMS).state; runs++; }
  state = initialState(1); runs = 0;
  const start = performance.now();
  while (performance.now() - start < seconds * 1000) { state = compiled.run(state, runs % 5, PARAMS).state; runs++; }
  const elapsed = (performance.now() - start) / 1000;
  console.log(`grid step: ${count} nodes, static cost ${cost}`);
  console.log(`JS: ${runs} runs in ${elapsed.toFixed(2)} s → ${Math.round(runs / elapsed)} runs/s (${(elapsed / runs * 1e6).toFixed(1)} µs/run)`);
  const out = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'bench-grid.json');
  writeFileSync(out, JSON.stringify({ program, paramTypes: TYPES, params: PARAMS, states: [0, 1, 2, 3].map(initialState), result: compiled.result }));
  console.log(`wrote ${out} for training/bench_ir.py`);
}
