// training/fixtures/replays.mjs — generates replays.json: models the Python backend trains (training/bundle_train.py,
// each bundle's pinned recipe seed) replayed by the browser executor on their validation episodes — validateGreedy's
// summary and every step's action and tool layer records (parity.mjs replay). Each entry carries the bundle it was
// trained on (`source`: the bundles.json key or builtin artifact it came from), so bundle-env.json / bundles.json
// regenerate without Python; bundle-env.test.mjs re-runs the JS side, test_bundle_train.py the Python side.
//   node training/fixtures/replays.mjs        (NEUROM_PYTHON names the interpreter, default ~/.cache/neurom-venv/bin/python)
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { replay } from './parity.mjs';

const dir = dirname(fileURLToPath(import.meta.url));
const PYTHON = process.env.NEUROM_PYTHON ?? join(homedir(), '.cache', 'neurom-venv', 'bin', 'python');
/** The Python backend trains `bundle` → its exported model. */
const pythonModel = bundle => JSON.parse(execFileSync(PYTHON, ['-c', 'import json, sys; sys.path.insert(0, sys.argv[1]); import bundle_train as bt; print(json.dumps(bt.train_bundle(json.load(sys.stdin))["model"]))', join(dir, '..')],
  { input: JSON.stringify(bundle), maxBuffer: 1 << 26 }).toString());
const COMBINER = 'arithmetic-combiner-policy';
const bundles = JSON.parse(readFileSync(join(dir, 'bundles.json'), 'utf8'));
/** The tool-layer bundles: the gate task (trailing; reward reading transition.loop; a layer after it; a nested network
 *  tool; a LIF network tool), the builtin combiner. */
const sources = [...['gate', 'gateLoop', 'gateAfter', 'gateNested', 'gateLif'].map(name => [{ bundle: name }, bundles[name]]),
  [{ artifact: COMBINER }, JSON.parse(readFileSync(join(dir, '../../frontend/templates/artifacts', `${COMBINER}.json`), 'utf8')).bundle]];
const replays = sources.map(([source, bundle]) => { const model = pythonModel(bundle); return { source, bundle, model, ...replay(bundle, model) }; });
writeFileSync(join(dir, 'replays.json'), JSON.stringify({ format: 'neurom-replay-fixtures', replays }));
console.log(`wrote replays.json: ${replays.map(r => `${r.source.bundle ?? r.source.artifact} (validation ${r.summary.metric})`).join(', ')}`);
