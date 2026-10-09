# training

[中文](README.md) · **English**

Dependencies: `requirements.txt` (numpy) and `requirements-torch.txt` (PyTorch, used by the bundle trainer).

The Python side of the workbench has four files:

- `ir.py`: programs.
- `bundle_env.py`: environment runner.
- `bundle_loop.py`: loop executor.
- `bundle_train.py`: trainer.

`workspace.py` serves these four files as the same-origin service. The four files consume **bundles** (`neurom-bundle`) only and contain no scenario code. The scenario is the programs in the bundle, and the loop is the node table of the bundle. Usage for users and AI: [module training guide](../docs/ai-module-training.en.md). Design: [ADR 0009](../docs/adr/0009-loops-and-training-modules.md).

## Bundle protocol

| File | What it does |
|---|---|
| `ir.py` | `neurom-program` for Python: `check(program, param_types, exact)`, `compile(program, param_types, exact)` → `run(args, batch, mask)`. `compile` generates one numpy function per checked program. It execs the function in a namespace that holds only the helpers of that program. Every value is batched over lanes: number / boolean → `ndarray[B]`, vector → `[B, w]`, record → dict, table → shared columns + per-lane bounds. Lazy `select / and / or` evaluate under masks. Exact-tier results are bit-identical to JS (`test_ir.py` diffs against `frontend/ir/fixtures/programs.json`) |
| `bundle_env.py` | Twin of `frontend/core/runner.js`: `create_env(env_bundle, tables=None)` → `reset(starts)` / `input()` / `step(actions)` / `done` / `t` / `state` / `full_table()`. The scenario protocol is `init? / input / step / budget`. `step` returns the batched `Transition = {prev, action, next, done, truncated, success}` (`truncated = !done && t+1 ≥ budget`). Table views: `input` reads rows ≤ cursor, `step` reads rows ≤ cursor+1, targets read the full table. The runner masks finished lanes |
| `bundle_loop.py` | Twin of `frontend/core/loop.js`: `create_loop(loop_bundle, models)` → `reset(B)` / `step(bits, mask, intercept)` → `{action, values, ran, tools}` / `states()`. It is demand-driven per lane. Frozen networks run the integer executors (`dense_step` / `layers_scores`). Every region computes z = (Σ W·x)·2^k + f·b with its own shift k. FF fires at z ≥ 1, and each LIF plain layer fires at its own threshold. Dense layer lists with tool layers work exactly as in `frontend/runtime/dense-policy.js`. This includes LIF segments, greedy heads, and only the chosen tool runs. Network tools run through their bits readout, and program tools run through `ir.py`. Any frozen network can be a tool: FF, LIF, or a network with its own tool layers (ADR 0014). The state of a network is its own LIF potentials, followed by the states of its tools in tool-layer order, then wire order. The state of a network tool has the same layout, recursively. A code tool has no state. The state of a network tool advances only on the lanes and steps that choose it. `reset` sets this state to zero with the session. `states()` gives the whole state of each network (`ToolCaller`). `intercept` gives the trained network to the trainer. A slot that the trainer gives must be an integer in 0..O−1. Bits must be exactly O wide and are coerced to 0/1 by non-zero, as in `loop.js`. When the loop has tool layers, `transition(tr, out)` adds `loop.<title>.<port>` (ADR 0010 §10). `run_episodes(env, lx, starts, reward, intercept, on_step)` is the one greedy episode runner |
| `bundle_train.py` | Three methods train `loop.trained` inside the whole loop. `reinforce`: dense, reward objective `fn(Transition)`, argmax readout. When the last layer is a tool layer, `reinforce` uses a bits readout. `reinforce` is the only method for tool layers: the sampled choice and data bits enter one policy gradient. Each lane calls its tools from its own tool state. The tool state is zero at each episode start and advances only on the steps that choose the tool. Calibration calls the tools from rest. `cross-entropy`: dense, target mask `fn(State[, table])`, argmax readout. `hinge`: threshold layers, exact target bits, bits readout. `hinge` rolls out every episode of the training partition once and ignores episodesPerEpoch / replicas, as in the browser. `hinge` stops early when validation is exact. Dense networks are layer lists (any number of plain layers, tool layers). Every other network runs frozen. The trainer does torch QAT at the `weightBits` of the structure (8 \| 16, ADR 0015). The parameters are real-unit shadows. `quantize_region` quantises every region on every forward pass. The regions are: a plain layer, the choice and data heads of a tool layer, the output, a threshold layer. Each region has its own scale s = Q / max\|W\| and shift k. Biases are int16 at s·2^k. The threshold of a LIF layer is 1.0 real in its own units. FF / LIF use STE + triangular surrogate + BPTT. Threshold layers use boxcar STE. Validation and model selection use the greedy integer loop. The result is `{model, evaluation, provenance}`. CLI: `--run-dir DIR` reads `bundle.json` (+ `tables.json`, `run.json`), prints JSON-line progress and writes `result.json` |
| `workspace.py` | Same-origin service: `GET /api/session`, `POST /api/runs`, `GET /api/runs[/:id]`, `GET /api/runs/:id/events` (SSE), `DELETE /api/runs/:id`, `POST /api/artifacts`. `POST /api/runs` validates the bundle on the server side. When the env of a bundle reads a dataset, the request must carry the table rows as `tables`. The service keeps these rows with the run. The same id with a different hash gives 409. Each run has one private directory, the child process is `bundle_train.py`, and the default concurrency is 2. Boundaries: loopback, Host / Origin, token |
| `bench_bundle_train.py` | `BUNDLE.json --epochs N [--profile]`: measures the per-epoch time of the trainer (validation excluded), optionally with a cProfile |
| `bench_ir.py` | IR micro-benchmark (lanes / s of the generated functions) |
| `fixtures/bundle-env.mjs` | Generates two files with JS alone: the runner / loop-executor parity corpus `fixtures/bundle-env.json`, and `fixtures/bundles.json` (trainer bundles). The parity corpus contains scripted episodes, greedy loop traces and lockstep episodes. In the lockstep episodes, a script makes the decisions of the trained network. The corpus also contains cases both sides must refuse, partitions and validation under both labelling rules. `fixtures/parity.mjs` records each case, and `fixtures/bundle-env.test.mjs` runs the cases again in JS. To regenerate, run `node training/fixtures/bundle-env.mjs` |
| `fixtures/replays.mjs` | Generates `fixtures/replays.json`: Python-trained models (with the bundles they were trained on) replayed by the browser executor. This script runs the Python trainer: `NEUROM_PYTHON`, default the venv below |

```sh
python3 -m venv ~/.cache/neurom-venv
~/.cache/neurom-venv/bin/python -m pip install -r training/requirements.txt -r training/requirements-torch.txt
~/.cache/neurom-venv/bin/python training/workspace.py --port 18766       # open http://127.0.0.1:18766/ on the same origin
~/.cache/neurom-venv/bin/python training/bundle_train.py --run-dir DIR   # train one bundle offline
```

Result shape (identical in JS and Python):

- `model` is the model of the trained network, in one of these two formats:
  - `dense-policy` (FF / LIF): `weightBits`, per region codes `W`, int16 `b`, `scale`, `k`. LIF plain layers have their own `threshold`. There is no network-level `scale` / `threshold`.
  - `threshold-layers`: `weightBits`, per layer `W`, int16 `th`, `scale`, `k`.
- `evaluation = { metricName, metric, selectedEpoch, curves, validation, quantization, … }`. Validation comes from the greedy integer loop. `quantization` describes the selected model: one entry per region in blob order, `{ region, scale, k, clippedWeights, clippedBiases[, threshold] }`.
- `provenance = { method, backend: 'python', seed, epochs, bundleHash, recipe, startedAt, durationMs, … }`.

Before training, `validate_bundle` refuses a bundle with one of these problems:

- A wrong format.
- Method requirements not met (checked against the trained network and its readout).
- Missing weights of frozen networks.
- Wrong program types.

A structure needs `weightBits` 8 or 16.

`validate_model` checks the exported model against the structure of the trained network:

- Codes within `weightBits`.
- Biases and threshold `th` int16.
- k in 0..20.
- The same `weightBits`.

These are the same requirements that `frontend/module-chain.js` applies when it deploys.

The two backends do not promise identical weights. The execution semantics of one integer model must be identical.

## Tests

```sh
~/.cache/neurom-venv/bin/python -m unittest discover -s training -p 'test_*.py'
```

- `test_ir.py`: diff against JS-generated fixtures.
- `test_bundle_env.py` checks these items:
  - The replayed parity corpus agrees lane by lane with the JS runner, loop executor and lockstep runner. The state of every network also agrees. The cases cover:
    - Multi-step truncation.
    - Table views.
    - A frozen upstream network.
    - Two-layer FF / LIF.
    - Tool layers between / first / last.
    - Code and network tools.
    - A LIF network tool and a nested network tool.
  - The results of `Session.run_steps` agree:
    - The input and target bits given to the trained network.
    - The action after a slot / scores / bits / tool layer records.
    - The Transition with `loop` and the reward.
  - Both sides refuse the same intercepted results and bundles.
  - A LIF tool keeps its potential per lane, advances only on the steps that choose it, and `reset` clears it.
  - A nested tool runs, and its own tool's state comes after it in the state of the caller. The state of a LIF selector is its potentials, then the states of its tools.
  - `quantize_region` agrees exactly with the JS quantiser on every `quantizations` case.
- `test_bundle_train.py` checks these items:
  - Each method learns a fixture task.
  - Two-layer nets train with every dense method.
  - REINFORCE trains through tool layers:
    - Gate task.
    - A reward that reads `transition.loop`.
    - A nested network tool.
    - A LIF network tool over two-step episodes.
    - The builtin combiner to validation 1.
  - At weightBits 8 and 16, the forward passes of the dense and hinge trainers are the integer steps. This includes LIF voltages. With a LIF tool, it also includes the tool state of each lane.
  - `quantize_region` agrees with hand-computed values: round half up, k, bias clipping, the threshold bias range, the LIF threshold.
  - A policy learns on a small loop. This small loop reads the outputs of two frozen networks.
  - Validation under both labelling rules agrees with the browser. Python-trained tool-layer models also agree with the browser.
  - hinge rolls out each seed-partition episode once.
  - The exported model reproduces the validation metric on its own. `evaluation.quantization` lists every region with no clipped weight.
  - Cancellation and rejections are correct.
- `test_workspace.py`: tests submit / SSE / cancel / import / boundaries with real child processes. A bundle that reads a table is submitted with its rows, trains, and is read back after a restart.
