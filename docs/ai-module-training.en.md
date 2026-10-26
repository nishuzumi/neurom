# Module training guide for users and AI

[中文](ai-module-training.md) · **English**

Training takes a **bundle (`neurom-bundle`)** as input. The trainer follows its inputs and collects the items below into one canonical JSON:

- The environment `env`: the loop that the trainer drives has a scenario module wired into it. `env` holds every program compiled from that scenario module, together with the values of the inputs and consts that those programs read. `env` also holds the step budget `budget` and the action table that the scenario exports, the episode kind of the driving partitions, and the tables.
- The loop `loop`: every node of the loop body. Frozen networks have their accepted integer models. The model of the trained network stays open.
- The partitions, the objective, the selection metric and the recipe.

A bundle has no separate params. Parameters occur only as static values bound into programs. The browser Worker, the Python Workspace and the offline CLI all use the same bundle. The scenario content is programs inside the bundle, not trainer code. For the system overview, refer to [design.en.md](design.en.md). For the terms, refer to [CONTEXT](../CONTEXT.md).

Executors and training methods still have limits: they do not support arbitrary PyTorch architectures, arbitrary uploaded scripts or automatic deployment.

## 1. Pick the training method

A trainer trains the one network that `loop.trained` names. The readout of this network is the readout in the loop body that consumes its `scores`. Every other network of the loop runs frozen on its accepted weights (whole-loop training, section 3).

| Method | Trained network and readout | Objective signature | Model format produced |
|---|---|---|---|
| `reinforce` | `dense-policy` (FF / LIF), `argmax` readout (`bits` readout when the last layer is a tool layer). This is the only method for a network with tool layers | reward `fn(Transition) → number` | `dense-policy` |
| `cross-entropy` | `dense-policy`, `argmax` readout | target `fn(State[, Table]) → bits[O]` (mask, called on the state before each step) | `dense-policy` |
| `hinge` | `threshold-layers`, `bits` readout | target `fn(State[, Table]) → bits[O]` (exact bits) | `threshold-layers` |

Objectives and selection metrics use these types:

- `Transition = { prev: State, action, next: State, done, truncated, success }`.
- When the loop has networks with tool layers, `Transition` also has the field `loop: { <network title>: { <tool port>: { choice: number, data: bits[D], result: bits[R] } } }` (ADR 0010 §10). For each tool layer, this field gives the tool that the layer chose on this step. It also gives the data bits that the layer gave to the tool and the result bits that the tool returned. During training, these values are the sampled decisions of the trained network. During evaluation and execution, these values are the decisions of the executor. In such a loop, network titles must be unique.
- A selection metric is `fn(Episode) → number`, with `Episode = { initial, final, steps, success, return }`.
- `Table` is the full data table. `Table` is present only when the driving partitions have a dataset wired.

FF / LIF decide the model structure and the state semantics. They do not decide between supervised training and reinforcement training. The builtin templates use these methods:

- Mining: REINFORCE.
- Memory map: cross-entropy (a shortest-path teacher).
- ADD4 / SUB4 / MUL4: hinge.
- Combiner: REINFORCE on the tool layer of the combiner's policy network (the tools ADD4 / SUB4 / MUL4 are frozen).

If the requirements of a method (`frontend/core/kinds/trainer.js METHODS`) are not met, the trainer shows a problem on the canvas. The Python server refuses the run before it queues it.

Model formats:

- `dense-policy`: `{ format, kind: 'feedforward'|'lif', inputs, outputs, weightBits, ticks, leak_shift, reset, layers: [{ hidden, W, b, scale, k, threshold? } | { tools, K, D, R, Wc, bc, scale_c, k_c, Wd, bd, scale_d, k_d }, …], output?: { W, b, scale, k } }`. This format has no task fields. The field rules are:
  - Regions: every region has its own `scale` and `k`. A region is a plain layer, the choice head or the data head of a tool layer, or the output layer.
  - Codes: `W` are `weightBits`-bit codes (8 or 16), `b` is int16, and `k` is in 0..20. `scale` is the number of codes per real unit, for information only.
  - Thresholds: only LIF plain layers have a `threshold` (1..2^31 − 1). FF plain layers fire at a value ≥ 1 and do not have this key. FF models have ticks 1, leak_shift 0 and reset 0.
  - Tool layers: a tool layer entry (ADR 0010) is the decision head on the layer before it. The head has K choice logits and D data-bit logits. The decision head is for the tools wired into port `tools`, and R is the widest result of these tools. When the last layer is a tool layer, the model has no `output` (outputs = R).
  - Weight blob: the weight blob is in layer order. First come `W | b` of every plain layer and `Wc | bc | Wd | bd` of every tool layer, then `W | b` of the output layer.
- `threshold-layers`: `{ format, inputs, outputs, weightBits, layers: [{ W, th, scale, k }] }`. `W` are `weightBits`-bit codes, and `th` is int16.
- Integer semantics: each region calculates z = (Σ W·x) · 2^k + f · b. f is the bias factor: ticks after a LIF layer, 1 in all other cases. Threshold layers calculate (Σ W·h) · 2^k − th. There is no network-level `scale` / `threshold`. When the system stores or imports an artifact, it validates the artifact against its network, and `weightBits` must agree with the network config.

The bundle sets the widths:

- `inputs` is the structure width of the trained network in `loop.nodes`. It is equal to the width wired into the `in` of the network. Examples are the width I that the scenario's `input` returns, or the width that a bit wire slices out.
- `outputs` comes from the readout of the network.

The on-chain engine `DensePolicyEngine` takes the widths as parameters. Before deployment, the system checks that the widths are in 1..65535 and that each layer has at most 65535. Weights can have any size. The system splits them into as many weight chunks as necessary.

## 2. Getting a bundle

- **From the canvas**: set the backend of the trainer to `python`, then click train. The canvas submits the bundle to the same-origin Workspace. The server keeps an immutable copy at `~/.cache/neurom-workspace/runs/<id>/bundle.json`, and `GET /api/runs/<id>` also returns this copy.
- **From an artifact**: the `bundle` field of any `neurom-module` artifact is the bundle that trained that artifact. Export an artifact JSON from a candidates module, or read the builtin artifacts in `frontend/templates/artifacts/*.json`. The only builtin artifacts are the four-bit arithmetic ADD4 / SUB4 / MUL4 and the combiner policy. Their bundles are the trainer bundles of the current templates, and `generate.mjs` trains these artifacts again. Mining and memory map have no builtin artifact. Build their bundle from the template (next item).
- **From a template**: in Node, use `instantiateInto` (`frontend/core/template.js`) to instantiate a template. Then call `buildBundle(graph, trainerId, { artifacts })` (`frontend/core/bundle.js`). `artifacts(id) → artifact | null` finds the accepted artifacts of the frozen networks. The tests do this.

The shape of the bundle:

```
format: 'neurom-bundle'
env:        { programs: { init?, input, step }, budget, actions, start: 'seed'|'enumerate'|'window',
              types: { Start, State, Transition, I, table? }, tables? }
loop:       { I, action: Ref, nodes: { <id>: loop node }, trained: <network id> }
objective:  { kind: 'reward'|'target', program, bound, boundTypes, exact: false }
selection:  { program, bound, boundTypes, exact: false } | null
partitions: { training, validation? }
recipe:     { method, epochs, lr, seed, replicas, … }
```

`Ref = { node, port }`. The input bits of the loop are `{ node: '$input', port: 'bits' }`. There are three types of loop node:

- `network { structure, in, model, artifactId, tools?, title? }`: only the trained network has `model: null`. A network with tool layers lists its tools per port in `tools`, in wire order. `title` is the key of the network in `Transition.loop`.
- `readout { readout, scores }`.
- `bits { parts, in }`.

Every program entry is `{ program, bound, boundTypes, exact }`: the IR program, plus the static values and types of the file-level names that it reads.

The bundle hash is `bundleHash = sha256(canonical JSON)`. The separate hash of `env` is the environment identity (`envHash`). `env.types.Transition` is the transition of the scenario. The reward receives this transition plus the `loop` field, which comes from the `loop` section (`core/loop.js transitionTypeOf`). A candidates module accepts an artifact when these conditions are true:

- The `bundle.env` of the artifact is equal to the `env` of the current trainer bundle.
- The structure of the trained network is equal.
- The readout spec of the trained network is equal.

## 3. Whole-loop training

All three methods run on the whole loop. Each step occurs in this sequence:

1. The runner supplies the input bits.
2. The loop executor evaluates on demand and runs the frozen networks until it needs the trained network.
3. The executor gives the input bits of the trained network to the trainer (intercept).
4. The trainer returns the readout result of that network.
5. The executor completes the step to the loop's action.
6. The runner calls `step`.

The methods and related rules:

- **REINFORCE**:
  - Readout: the trainer samples a readout slot from softmax(scores / (ticks · gain)). It records the log-probability of the slot. gain is the gain of the output layer (refer to "Quantisation" below).
  - Rewards: rewards settle per step from the `Transition`, and the return goes to the end of the episode. The baseline is a per-step EMA baseline, calculated only over the lanes that ran the network. LIF uses BPTT within an episode.
  - Tool layers (ADR 0010 §6): during training, the trainer samples the choice from softmax over the K choice logits. It samples each data bit from its own sigmoid. Only the chosen tool runs. The log-probabilities of every tool decision and of the readout slot go into one policy gradient. When the last layer is a tool layer, the tool result is the action, and only the tool decisions have log-probabilities. `entropy` covers every decision.
  - Gradients: gradients flow through the plain layers before a tool layer into its decision head. In the layers after the tool layer, gradients flow from the action down to `result ‖ layer before`. The result is a constant, and the layer-before bits pass straight through to the spike counts of that layer. No gradient flows through a tool. LIF BPTT stays within each segment, the same as the segments in execution.
  - Initialisation: decision heads initialise the same as every other layer (uniform ±√(3/fanIn), zero biases, no calibration).
  - Replay: the forward pass is bit-identical to `runtime/dense-policy.js`. Thus the exported model replays the greedy decisions that training measured.
- **Cross-entropy**: before each step, the trainer calculates the mask `target(state[, table])`. On a labelled step (≥ 1 mask bit), the readout gets a uniformly random correct slot with probability 1 − exploration. In all other cases, the readout gets a uniform random slot. Unlabelled steps have no loss.
- **Hinge**:
  - Teacher forcing: the trainer rolls out every episode of the training partition one time, with teacher forcing. The readout gets the target bits directly. episodesPerEpoch / replicas do not apply, in JS and in Python.
  - Rows: every step that demands the trained network becomes one row (X = the input bits of the network, Y = the target bits).
  - Loss: then the trainer calculates the full-batch hinge loss. The hidden-layer straight-through width is `surrogateWidth`. The mean gradients are clipped to the global norm `gradClip`, and 0 means no clipping.
  - Stop: training stops early when the validation partition is exact.
- **Quantisation** (ADR 0015, JS `frontend/training/quantize.js`, Python `bundle_train.quantize_region`, identical):
  - Config: the network config `weightBits` selects 8 (default) or 16. The config has no `scale`.
  - Float shadows: parameters are float shadows in real units. Every forward pass quantises each region again.
  - Scale and k: scale s = Q / max|w| (Q = 127 or 32767), and rounding takes .5 up. Biases are int16 in the unit 1/(s·2^k). k is the largest value in 0..20 at which the biases fit. For LIF, the threshold must also fit in int32. The threshold of a LIF plain layer = round(s·2^k), that is 1.0 real.
  - Gradients: the training forward pass uses `W`·2^k and `b`, bit-exact with integer execution. STE gradients are multiplied by gain = s·2^k. Cross-entropy logits are also scores / (ticks · gain). The z of hinge is in real units.
  - Clipping: by construction, weights never clip. If a bias is larger than the largest weight of the layer (it does not fit even at k = 0), the bias is clipped. The system counts the clipped biases.
- **Validation**: the trainer puts the integer model of the candidate in the loop. The other networks keep their accepted models. Then the trainer runs the validation partition with the same greedy integer runner that the evaluator uses (JS `frontend/core/loop.js runEpisodes`, Python `training/bundle_loop.py run_episodes`). If there is no selection metric, reward objectives select by the mean validation return, and target objectives select by the greedy-readout accuracy over labelled steps.

## 4. Offline training: `bundle_train.py`

```sh
python3 -m venv ~/.cache/neurom-venv
~/.cache/neurom-venv/bin/python -m pip install -r training/requirements-torch.txt
mkdir run-1 && cp bundle.json run-1/
echo '{"bundleHash": "0x…"}' > run-1/run.json          # optional; written into provenance.bundleHash
~/.cache/neurom-venv/bin/python training/bundle_train.py --run-dir run-1
```

The CLI reads these files:

- `DIR/bundle.json`.
- `DIR/tables.json` (optional): `{datasetId: {column: [numbers]}}`. This file is necessary when the environment reads a dataset.
- `DIR/run.json` (optional): supplies `bundleHash`.

The CLI prints `{"type":"progress", …}` JSON lines to stdout. When training is complete, the CLI writes `DIR/result.json`:

```json
{ "model": { … }, "evaluation": { "metricName": "validationMeanReturn", "metric": 2.9, "selectedEpoch": 240, "curves": { "loss": [], "metric": [] }, "validation": { … }, "quantization": [{ "region": "layers[0]", "scale": 52.1, "k": 9, "clippedWeights": 0, "clippedBiases": 0 }, …] }, "provenance": { "method": "reinforce", "backend": "python", "seed": 1, "epochs": 300, "bundleHash": "0x…", "recipe": { … }, "startedAt": "…", "durationMs": 1234 } }
```

`evaluation.quantization` has one entry for each region of the selected model, in the order of the weight blob: `{ region, scale, k, threshold?, clippedWeights, clippedBiases }`. Examples of `region` are `layers[0]`, `layers[1].choice`, `layers[1].data` and `output`. Only LIF plain layers have `threshold`. The panel of the browser trainer shows the same data, for example "int8 clipped per layer (weights/biases) layers[0] k 9 · 0/0 …". Clipping that is not zero means that some bias did not fit. The exported model runs exactly as it trained, but we recommend that you examine these biases.

As a library:

- `training/bundle_train.py`: `train_bundle(bundle, on_progress, tables, bundle_hash)` is the same entry point. `validate_bundle(bundle, tables)` checks the format, the method requirements and the types of every program before training. `validate_model(model, network)` checks that an exported integer model agrees with the network structure in the bundle.
- `training/bundle_env.py`: the Python twin of `frontend/core/runner.js`. `create_env(bundle['env'], tables)` → `reset(starts)` / `input()` / `step(actions)`, in batches over lanes. `step` returns a batched `Transition`, and the environment masks the lanes that are finished.
- `training/bundle_loop.py`: the twin of `frontend/core/loop.js`. `create_loop(bundle['loop'], models)` → `reset(B)` / `step(bits, mask, intercept)` → `{ action, values, ran, tools }`. `intercept = (networkId, fn)`, and `fn(x, lanes)` returns `{'scores'}`, `{'slot'}` or `{'bits'}`. `run_episodes(env, lx, starts, reward, intercept, on_step)` is the one greedy episode runner.

You can use these three modules to build your own trainer or evaluation.

Seed, episodes per epoch, replicas, learning rate and the other recipe fields are in `bundle.recipe`. To change the recipe, change the bundle, and thus its hash. Do not add more parameters to the training script.

## 5. Workspace: the interface shared by page and AI

```sh
~/.cache/neurom-venv/bin/python training/workspace.py --host 127.0.0.1 --port 18766
```

Open `http://127.0.0.1:18766/`. The page connects to the same-origin `/api`. The server has these limits:

- It allows only loopback.
- Each `Origin` must be the server's own origin.
- Requests that change state must have `X-Workspace-Token`. The server prints this token at startup and also writes it to `~/.cache/neurom-workspace/session-token` (mode 0600).

| HTTP | Request / result |
|---|---|
| `GET /api/session` | `{ token, capabilities: { methods, engines }, limits }` |
| `POST /api/runs` | `{ run: { id, bundle, bundleHash[, tables] } }` → `{ run }`. The server validates the bundle before it queues the run. When the environment reads a dataset, `tables` must have the rows of every table (`{datasetId: {column: [numbers]}}`, kept with the run as `tables.json`). If `tables` is missing, the result is 400. The same id with a different hash returns 409. The same hash returns the existing run |
| `GET /api/runs` | `{ runs: [ … ] }` (without results, with the flag `hasResult`) |
| `GET /api/runs/:id` | The run record. When the run is complete, it includes `result: { model, evaluation, provenance }` |
| `GET /api/runs/:id/events?token=…` | SSE: `progress` / `status` / `complete` |
| `DELETE /api/runs/:id` | Cancel the run and stop the training process group |
| `POST /api/artifacts` | `{ bundleHash, bundle, model, evaluation, provenance }` → validated, then stored as a completed imported run |

The run states are `queued | running | completed | failed | cancelled`. The subprocess is `bundle_train.py --run-dir` from section 4, with one private directory for each run. By default, at most two runs operate at the same time, and the other runs queue. When the server restarts, it marks the runs that are not finished as failed. It never shows them as successful.

To submit a bundle from an AI, standard-library Python is sufficient. The input is an artifact JSON exported from a candidates module. This JSON has the bundle that trained it and the hash of that bundle:

```sh
python - artifact.json <<'PY'
import json, sys, urllib.request, uuid
base = 'http://127.0.0.1:18766'
artifact = json.load(open(sys.argv[1]))
token = json.load(urllib.request.urlopen(base + '/api/session'))['token']
def post(path, body):
    req = urllib.request.Request(base + path, data=json.dumps(body).encode(), method='POST',
        headers={'Content-Type': 'application/json', 'X-Workspace-Token': token})
    return json.load(urllib.request.urlopen(req))
run = post('/api/runs', {'run': {'id': uuid.uuid4().hex, 'bundle': artifact['bundle'], 'bundleHash': artifact['provenance']['bundleHash']}})
print(run['run']['id'], run['run']['status'])
PY
```

The client supplies `bundleHash` (`0x` + 64 hex digits). The server uses it only to check that repeated submissions under one id agree. The server does not calculate it again. If you change a bundle, calculate its hash again yourself (the rules are in section 6).

The page follows only the runs that it submitted. After a reload, the page connects again to the Python runs that still operate. Runs that an AI submits directly to the server, and the results of `POST /api/artifacts`, stay on the server. The page does not find them automatically. To give the results back to the canvas, use the procedure in section 6.

## 6. Handing results back to the canvas

The "import" of a candidates module accepts a `neurom-module` artifact:

```json
{ "format": "neurom-module", "bundle": { … }, "model": { … }, "provenance": { … }, "evaluation": { … }, "id": "0x…" }
```

`bundle` is the trainer bundle that trained the artifact. `model` is the integer model of the network that `bundle.loop.trained` names. `id` is the SHA-256 of the canonical JSON of the other five fields. The rules for canonical JSON are:

- The keys are in sorted order.
- There is no whitespace.
- Numbers have the format that JavaScript's `JSON.stringify` gives (integers without `.0`).

On import, the page calculates the `id` again and checks it. If the `id` does not agree, the page refuses the artifact. It never accepts a mismatch silently. To generate the `id` in Python, first change integer-valued floats to `int`. Then use `json.dumps(obj, sort_keys=True, separators=(',', ':'), ensure_ascii=False)`.

The system judges imported artifacts by bundle compatibility. Compatibility needs these conditions:

- `bundle.env` must be equal to the environment of the loop that contains the candidates module.
- The structure and readout spec of the trained network must agree with the trainer that feeds it.

The page lists an incompatible artifact, but marks it as incompatible, and you cannot accept it. After you accept an artifact, its weights go into the network. In the loop, evaluators, executions and other trainers (as a frozen network) use this network. A deployment can also select this artifact.

## 7. Semantics an AI must not break

1. Do not change these items in a bundle to improve a score: the environment programs (or their bound values), the step budget, the loop body, the models of the frozen networks, the readout or the partitions. `env` goes into `envHash`, and the whole bundle goes into `bundleHash`. Thus a change makes a different environment or a different training, and the artifact does not fit the original loop.
2. The network sees only the input bits that the scenario's `input` returns. `input` does not encode hidden information (a hidden target, cells outside the view), thus the network cannot see this information. Do not put hidden information into `input`. Do not change `input` to let the network see more.
3. Only `recipe` is a training-side degree of freedom, for example seed, epochs, learning rate, exploration and replicas.
4. Train only `loop.trained`. Every other network in the loop runs frozen on the model in the bundle. Do not update these networks at the same time.
5. Keep floating-point training scores separate from the exported integer execution scores. `evaluation.validation` must come from real runs of the integer loop executor (greedy readout, frozen networks on their models). `bundle_train.py` calculates it in this way.
6. LIF keeps its state across decisions within an episode, and its state is set to zero at the start of the episode. A network that did not run on a step keeps its potentials. Do not reset the state before every action, except as an explicit ablation.
7. Python, JS and the chain must give identical integer results for the same artifact. If you did not verify one side, write "not verified".
8. Do not claim that different backends train byte-identical weights. Record the actual environment and the limits of reproduction.
9. Keep real logs and failed results. If training is not sufficient, a method is not supported or a dependency is missing, report the cause. Do not show a lookup table as a learned model.
10. Artifact JSON contains no executable script. The programs in a bundle are IR, not scripts.

## 8. Task brief template for an AI

```text
Goal: train network [loop.trained] ([FF/LIF/threshold]) of the loop in bundle [bundleHash].
Bundle source: [exported artifact / Workspace run id / template id@revision + trainer id]; env, loop, partitions and objective must not be modified.
Method: [reinforce / cross-entropy / hinge], recipe fields [seed, epochs, lr, …].
Training budget: [epochs, device, resource limits].
Evaluation protocol: whole-loop integer execution on the validation partition (greedy readout, frozen networks on the bundle's models); report metricName / metric / selectedEpoch.
Working directory: [a new directory; never overwrite existing artifacts].
Deliverables: a neurom-module artifact JSON (correct id), the full commands and environment, the progress log, the integer evaluation results, what was not verified.
Limits: no editing the bundle to improve scores; no fake weights / results; no automatic deployment or transactions.
```
