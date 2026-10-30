# Module system design

[中文](design.md) · **English**

This document tells how the workbench is built: module kinds, wires, loops, templates, bundles, the IR, the trainers and the chain bridge. [CONTEXT.md](../CONTEXT.md) defines the terms. The reasons for the main decisions are in [docs/adr](adr/).

## 1. Overview

Everything on the canvas is a module. You can save any set of modules as a template. A task is a **training module**, for example mining, the memory map, four-bit arithmetic and the combiner. A training module is one composite template, drawn expanded as one frame. The frame holds these parts:

- The left column: the trainer and its satellites, as sections. The satellites are the partitions, objective, metrics, candidates, evaluator, execution and views.
- The satellites in the left column also include the environment. The environment is the scenario module wired into the loop's `scenario`, plus the params and random that feed only the scenario module. The frame's trainer, evaluator and execution share the environment.
- The right side: a recessed sub-canvas that holds only per-step computation. The sub-canvas holds the **loop** and the frozen networks that tool layers call (ADR 0009, 0011, 0010). The loop is the loop box with the networks, readouts and bit wires.

The scenario module is a code module. It writes three roles: `init` (optional), `input` and `step`. It also writes a `budget` (max steps per episode) and optional `actions`. The whole file goes to the loop's `scenario`. On every step, the loop sends the bits that `input` returns into the loop body through `loop.input`. The action that the body computes comes back into `loop.action`, and then the loop gives the action to the scenario's `step`.

Trainers, evaluators and executions do not connect to the scenario directly. They drive the loop through its `loop` handle, and each one brings its partitions. The partitions decide where the episodes start. Rewards, supervised targets and metrics are other code modules. Other modules feed the code modules, and the code modules return outputs. If an output does not satisfy its consumer, this is an error.

A trainer trains one network of the loop. Every other network runs frozen on its accepted weights. This is whole-loop training. A network can also use other modules as tools. On each step, a **tool layer** in the network's `layers` picks one of the tools wired into it. It also picks the data bits to give to that tool, and then runs only that tool (ADR 0010).

A tool is a code function, or a frozen network through the `run` of its readout (a bits readout or an argmax readout, ADR 0019). The frozen network can be of any kind: FF, LIF, or a network with tool layers of its own (ADR 0010 §3). It is not possible to deploy a network tool with an argmax readout, because on chain a tool layer reads the scores of a tool as bits. The state of a network tool belongs to the calling session. This state includes the potentials of a LIF tool and the states of the tool's own tools. It is after the caller's own state, in tool-layer order and then wire order, nested level by level. The state of a tool advances only on the steps where the tool layer chooses the tool, and it resets with the session.

Tools nest at most 3 levels deep (`MAX_TOOL_DEPTH`), so the gas of a step has a limit. When tools nest deeper than 3 levels, the canvas shows a network problem and the Factory on chain refuses. The policy network of the combiner is one tool layer that picks one of the frozen ADD4 / SUB4 / MUL4 networks to run.

If the existing module kinds are sufficient, a new task is a new template. This needs no JS / Python / Vue changes. Datasets and window partitions are for table-driven tasks.

## 2. Three concepts

The three concepts are:

- **Module kind**: implemented in code, once per kind. A module kind declares its ports, port types and configuration (`frontend/core/kinds/`). Section 3 lists all the kinds.
- **Template**: a data file. It holds a set of modules, their configuration and wires, and the ports exposed outward. Templates have three levels:
  - Single-module template: one module plus configuration.
  - Composite template: several modules plus wires, for example the six builtin training modules (mining, memory map, the three four-bit arithmetic tasks, the combiner).
  - Canvas template: a whole canvas.
- **Wire**: value wires and call wires, see section 4.

Templates can only choose and configure kinds. They cannot redefine kinds. Network engines must agree with Solidity bit for bit. Trainers need gradients, QAT and BPTT. Thus these two stay in code.

## 3. Module catalogue

Port types = IR types + handles. The IR types are `number`, `boolean`, `string`, `vector[n]`, `array[n] of T`, `record{…}` and `table`. `bits[n]` is a `vector[n]` with values limited to 0/1. Handles are opaque tags: `module`, `partition`, `structure`, `weights`, `run`, `artifact`, `report`, `execution`, `deployment`, `text`, `loop`. Call ports carry a signature `fn(A…) → B`.

A record-typed output is one whole-object port. Its fields have path addresses, for example `params.steps` and `scene.cfg.bonus`, at any depth. A value wire can start at any field, and the wire carries the type of that field. On the canvas, fields are folded by default, and a `+` expands them as a tree. When fields are folded, only the wired fields show, by their full path.

### Definitions

| Module | Inputs | Outputs | Role |
|---|---|---|---|
| **Text** `text` | — | `text` | Notes |
| **Params** `params` | One call port `fn(params) → record` per declared function input. By default only `options`. You can add and remove them in the declarations | `params: record` (whole object, fields wireable by path) | Declares typed fields with ranges and defaults, and function inputs, and generates the form. A range or choice list can be a constraint expression over other fields, for example `max: grid - 1`. When a value is outside the range, the Params module shows a problem, and the problem blocks bundling (ADR 0007). Function inputs only compute derived values, for example a lookup table derived from the fields. The results merge by key. If two functions return the same key, this is an error (ADR 0006) |
| **Code** `code` | one required value input per name in `inputs` | One call output per `export function`, one value output per `export const`. Also `module` (the whole file, handle `module`) | One restricted-JavaScript file (top-level consts + functions only), compiled to IR. The file has no type syntax. Types come from the caller (ADR 0012). Its exports are its ports. The role of an exported function comes from what it is wired to (see "Code modules" below, ADR 0005) |

### Data

| Module | Inputs | Outputs | Role |
|---|---|---|---|
| **Dataset** `dataset` | — | `table` | Imports CSV / JSON. Checks column names, rectangularity and finiteness, and records a content hash. The data is in IndexedDB under a content id (`ds-` + hash). The rows of an id never change after they are written, and a re-import gets a new id. When the workbench adopts a workspace (startup, opening a file), it reclaims some rows. These rows satisfy two conditions. First, no module, run, artifact or dataset record references them. Second, they were written more than 10 minutes ago. The reason for this time limit: another tab possibly imported those rows just now and did not save them yet |
| **Partition** `partition` | `table` (required for windows, optional otherwise) | `training / validation / test: partition` | Three splits: seed ranges `{ seed, count }`, enumerated combinations and time windows (length / stride / embargo). An enumerated combination is the cartesian product of per-axis values. Each role takes `all`, `even`, `odd`, a list of indices, or `{ mod: N, rem: [r…] }`. `{ mod: N, rem: [r…] }` keeps the episodes whose enumeration index mod N is in `rem`, with N in 1..1000. The episode kind of the partition decides the loop's `Start`. The dataset wired into `table` is the table that the scenario reads |

### Loop, network and readout

| Module | Inputs | Outputs | Role |
|---|---|---|---|
| **Loop** `loop` | Call `scenario` (the scenario module's `module`, required). Value `action: number` (required, declared `loop`: it takes effect on the next step) | `input: bits[I]` (this step's input bits), `loop` (handle the drivers connect to) | The per-step boundary of the episode runner (ADR 0009). The loop body is every module on a value path from `input` to `action`, derived from the wires. The loop body can hold only networks, readouts and bit wires. Static values from outside the body can be wired in, for example a network's `weights` and a readout's `actions`. `Start` is the episode kind of every partition that its drivers run it on. If these kinds do not agree, the `loop` port shows a problem. If `action` is not on a path from `input`, the loop shows "loop not closed" |
| **Network** `network` | Values `in: bits[I]`, `weights` (declared `loop`). One call port per tool layer, named by the layer's `tools`, which takes any number of `(bits) → bits` tools | `scores: vector[O]`, `structure` | Integer network. The engine is `dense-policy` (FF / LIF) or `threshold-layers` (list of threshold layers). The layer list `layers` of `dense-policy` has plain layers `{ hidden }` and tool layers `{ tools, data? }` (ADR 0010), and the output layer is implicit. I is the hand-declared config `inputs` (1..65535), and the bits wired into `in` must have exactly the width I. O comes from the readout that consumes `scores`, and there must be exactly one such readout. `weights` is declared `loop`, so `net.structure → trainer → candidates → net.weights` is the normal cycle. Config `weightBits` is the weight width: 8 (default) or 16 (ADR 0015). The trainer picks the scale of each layer, and the config has no scale. Config `artifact` (optional content hash): a network that no trainer trains selects with it the artifact it runs (ADR 0010 §8). If a network has an `artifact` and also a `weights` wire or a trainer, this is a problem |
| **Readout** `readout` | Values `scores: vector[O]`, `actions` (optional) | `action: number`, `bits: bits[O]`. Both modes also have the call output `run`: the forward pass of its network, then the readout bits, usable as a tool. `bits` mode gives the bits of the bits readout. `argmax` mode gives the one-hot bits of the argmax (a tie gives the lowest index, and the width is the length of the map) | `argmax` mode has a map, and `null` is the explicit invalid action −1. `bits` mode has a width and `lsb-int` decoding |
| **Bit wire** `bits` | one `bits[n]` input per `parts` port | `bits` (concatenation) | Slices and concatenates bit vectors (`parts: [{port, offset, width}]`), total ≤ 65535 |
| **Random** `random` | — | `rng: { mul: number[draws], add: number[draws] }` | Jump-ahead tables of the 32-bit linear congruential generator. The generator is s' = (multiplier · s + increment) mod 2^32. The config is `multiplier / increment / draws`, defaults 1664525 / 1013904223 / 512. From seed s, the (k+1)-th output is `add32(imul32(rng.mul[k], u32(s)), rng.add[k])`. The tables are computed once per config. They go as a static value into an input of the scenario module (`rng.rng → scene.rng`, with `rng` in the scenario module's `inputs`) |

A network sees only the loop's input bits, that is, what the scenario's `input` returns. Scenario parameters (the scenario module's inputs) never go into the network.

### Drivers and results

| Module | Inputs | Outputs | Role |
|---|---|---|---|
| **Trainer** `trainer` | Values: `loop` (loop handle, required), `structure` (the network to train, required, must be in the loop body), `training` (required) / `validation: partition`. Calls: `objective` (required), `metric` (optional selection metric) | `run` | Trains the network wired into `structure` on the whole loop. Every other network of the loop runs frozen on its accepted weights. The readout of the trained network is the readout in the body that consumes its `scores`. There are three methods. REINFORCE: reward `fn(Transition) → number`, dense + argmax, and a bits readout after a trailing tool layer. REINFORCE is the only method for a network with tool layers. Cross-entropy: the target `fn(State[, Table]) → bits[O]` returns a mask, dense + argmax. Hinge: the target returns exact `bits[O]`, threshold + bits readout. The backend is `browser` (Worker) or `python` (Workspace) |
| **Candidates** `candidates` | values `run` (many) | `weights` (accepted), `artifact` | Lists the artifacts of its runs. You can preview, accept, export and import the artifacts. Compatibility is in section 6 |
| **Evaluator** `evaluator` | Values: `loop` (required), `partition` (required). Calls: `metrics: fn(Episode) → number` (many), `objective` (optional reward, for `return`) | `report` | Every network uses its accepted weights. The evaluator runs the whole loop greedily over the episodes of the partition and computes every metric. It can group by an axis of an enumerated partition, for example a retention curve by delay |
| **Execution** `execution` | Values: `loop` (required), `partition` (required) | `execution` | The execution steps the whole loop with every network on its accepted weights. It owns its clock, potentials and history. Every history step records three items: the values of every body module, which modules ran on that step, and the `{ choice, data, result }` of each tool layer. `{ choice, data, result }` is the tool that the layer called, the data bits it gave to the tool, and the result |

### Display and chain

| Module | Inputs | Outputs | Role |
|---|---|---|---|
| **View** `view` | values `execution` or `report` | — | There are two types of renderer. The first type is `grid / series / table / kv`, configured with a state path and marks, for example `state.map` + agent / base coordinates and tile colours. The second type is `script`: a view script (ADR 0013). The view script draws itself in a network-less sandboxed iframe, with a Vue component (`props: ['ctx']`) or `render(ctx, el)`. `ctx` holds the wired run data (at the step that the history slider selects). It also holds the static values of every member of its training module (`ctx.modules[title][port]`) |
| **Script module** `script` | declared function inputs (call, one per name) and value inputs (value, one per name) | — | Runs JavaScript files in the sandbox of a view script (ADR 0019). It does inference only, and no bundle contains it. The script calls a function input with `await ctx.call.<name>(…)` and reads a value input with `ctx.values.<name>`. The page runs the calls outside the sandbox (`core/script-calls.js`): a network through the `run` of its readout, on its accepted weights, from a zero state at each call; a code function by its program. The argument types come from the values at the time of the call. Problems: a function input without a wire, a name declared two times, a network that a trainer trains (the tool-layer rule) |
| **Deployment** `deployment` | value `artifact` | `deployment` | Deploys one artifact through ModuleFactory, then verifies it, reads state, resets, and steps it by transaction. The local mirror uses the same environment from the artifact's bundle and the integer executor |

### Code modules

A code module's configuration is `{ inputs, source }`. `source` is one restricted JavaScript file with only top-level `const`s and `function`s. The file has no type syntax, and types come from the caller (ADR 0012). `ir.parseModule` compiles the file (ADR 0005).

The main points of code modules are:

- **Exports are ports**: each `export function name(…)` is a call output `name`, and the caller gives the arguments by the function's own parameters. Each `export const name = …` is a value output `name`, evaluated once, statically, from the inputs. Unexported functions are helpers, inlined at their call sites and never recursive. Unexported consts are ordinary constants. One more output, `module`, is the whole file, given to a kind that calls several of its functions by role (a loop's `scenario`). No function or const can have the export name `module`.
- **Inputs**: every name in `inputs` is a required value input port. It is also a file-level name, readable anywhere in the file. It is bound as a static value into every function and const that reads it. The coefficients of a reward and the parameters of a scenario come in this way, for example `weights.params → reward.weights`, read as `weights.value` in the source.
- **Ports do not depend on compilation**: when the source compiles, the registry derives `exports` (`[{ name, kind: function | const }]`) from the source and stores it in the configuration. While the source does not compile, the registry keeps the previous list, so ports and wires do not disappear. Nobody writes `exports` by hand.
- **Doc comments**: the JSDoc before an `export function` documents the function. The JSDoc has a summary, `@param name`, `@param name.field` and `@returns`, and its texts travel with the ports. `{Type}`s in tags have no effect, and types come only from call sites and wires. A `/** … */` before a key of a record literal documents that field.
- **Module title**: the module title is only a label, and the function names are in the source. If the module exports exactly one function (call wire) or one const (value wire), template wires can omit the source port: `reward→trainer.objective`. Otherwise, write `module.exportName`.
- **Role contracts** (ADR 0012): when a kind calls an export by protocol, it declares these items:
  - Its parameter count and types.
  - Default parameter names (for stubs and the help).
  - When it calls the export.
  - What the result means.
  - A body that compiles.

  An implementation names its parameters as it likes, and the count and types are the protocol. The editor gives each role a vertical tab that shows only that function. The editor locks the function header except the parameter names, and shows its types in grey. A ? at the line end opens the help window of the role, with callers, parameters and their fields, result and a real example.

### Code-module roles

The role of an exported function comes from the port it is wired to. The receiving port sets the signature. `Table` appears only when the partitions that drive the loop have a dataset wired.

| Role | Wired to | Signature |
|---|---|---|
| Options | a Params function input (default `options`) | `fn(params) → record` (derived values) |
| Reward | trainer.`objective` (REINFORCE), evaluator.`objective` | `fn(Transition) → number`. Coefficients come from the code module's inputs |
| Supervised target | trainer.`objective` (cross-entropy / hinge) | `fn(State[, Table]) → bits[O]`: called on the current state before each step. `Table` is the full table |
| Selection metric | trainer.`metric` | `fn(Episode) → number` |
| Evaluation metric | evaluator.`metrics` | `fn(Episode) → number` |
| Scenario | loop.`scenario` (the whole file via `module`) | exports `init?` / `input` / `step` and consts `budget` / `actions?`, see the next section |

Exported consts are values that you use directly. For example, the scenario module's `export const actions = […]` goes into the readout's `actions`.

### The scenario module

There is no "environment" module. The scenario module is the code module wired into a loop's `scenario` (`scene.module → loop.scenario`). The runner calls the roles that it exports by one protocol (ADR 0009, `frontend/core/kinds/scenario.js`):

| Export | | Runner call | Returns |
|---|---|---|---|
| `init(start)` | optional | once per episode | `State`. Without `init`, `State` is the `Start` record itself |
| `input(state[, table])` | required | before every step | `bits[1..65535]`: the loop's input bits |
| `step(state, action[, table])` | required | every step | `{ state: State, done: boolean, success: boolean }`, exactly these three fields |
| `budget` | required const | | positive integer: max steps per episode |
| `actions` | optional const | | string array: action names, wired separately `scene.actions → readout.actions` |

The main points of the scenario module are:

- A one-question task makes `step` return `done: true` and writes `budget = 1` (the four arithmetic templates and the combiner).
- **Incomplete**: when `input`, `step` or `budget` is missing, the scenario is "incomplete". If the scenario exports a function that the runner does not call and that is not wired to something else, the scenario is also "incomplete". Such a function is most likely a misspelt role. The loop's `scenario` port shows "incomplete". Wiring works as usual, but bundles, training and evaluation refuse to run until the scenario is complete. While the loop has no driver, `Start` is unknown and the roles are also incomplete ("wire the loop to a trainer, evaluator or execution first").
- **Errors**: extra fields returned by `step`, `actions` that is not a string array and a non-numeric `budget` are errors. Parameter names are free, and parameter counts are fixed.
- **Scenario parameters** are the scenario module's inputs (`params.params → scene.params`, `sense.params → scene.sense`, `rng.rng → scene.rng`). The scenario reads them at file level (`params.grid`). Derived tables are top-level consts, computed once per bundle, for example grid geometry and random tables. The runner never sees parameters.
- **What the network sees** is exactly what `input` returns. To hide information from the network, do not encode it in `input`. For example, the memory map's target after the preview and the cells outside the mining agent's square view are not encoded. `input` can call unexported helpers. For example, the memory map first computes an intermediate record and then encodes it into bits. Mining changes view cells to map cells with `cellOf`.
- The `/** … */` before a function documents its return value. The `State` doc is the doc of `init`. Without `init`, the `State` doc is the doc of the partition episode record.

The runner has a JS version `frontend/core/runner.js` and a Python version `training/bundle_env.py`, with identical behaviour:

```
reset(start):  state = init ? init(start) : start;  t = 0
input():       bits = input(state, rows ≤ cursor)
step(action):  r = step(state, action, rows ≤ cursor + 1)
               truncated = !r.done && t + 1 ≥ budget;  done = r.done || truncated
               Transition = { prev: state, action, next: r.state, done, truncated, success: r.success }
               state = r.state;  t++
```

The main points of the runner are:

- For window episodes `cursor = start.start + t`, and for other episodes `cursor = t`. The runner gives the table view as the last argument only when the driving partitions have a dataset. `input` sees the rows up to `cursor`. `step` sees one more row, that is, the outcome of the step. A supervised target sees the full table. A `step` after the end of the episode is an error.
- `Start` is the episode record of the driving partitions: `{ seed }` for seed partitions, `{ index, <axis>: value… }` for enumerated partitions, and `{ start, length }` for window partitions. All drivers of a loop (the trainer's `training / validation`, the evaluator's and execution's `partition`) must have the same episode kind and the same table.
- `Transition = { prev: State, action: number, next: State, done, truncated, success }`. `success` is the value that `step` returned. `truncated` means that the episode ended because of the `budget`. If the loop has networks with tool layers, the loop executor adds `loop: { <network title>: { <tool port>: { choice, data, result } } }` (ADR 0010 §10). In such a loop, network titles must be unique.
- `Episode = { initial: State, final: State, steps, success, return }`. `success` comes from the last transition. `return` is the sum of the rewards. When the evaluator has no `objective`, `return` is 0.
- Each role compiles to its own program. The program's parameters are first the runner's arguments, then the file-level names that the function reads (inputs, top-level consts). The values of these names are stored with the program in the bundle as static values. The return type of `init` sets the type of `State`. The `state` that `step` returns must have the same type.

## 4. Two kinds of wire

| Wire | Meaning | Examples | Rules |
|---|---|---|---|
| **Value wire** | Gives an output value to an input. The consumer reads it when it evaluates | params → code (the scenario module included), random.rng → scenario module, loop.input → network.in, network.scores → readout, readout.action → loop.action, loop.loop → trainer / evaluator / execution.loop, partition → drivers, candidates.weights → network.weights | Must be acyclic. The only exception is a cycle that closes into a loop input. A loop input is a port declared `loop`, and its value takes effect on the next step (weights come from an earlier training run). The loop inputs are only the loop's `action` and a network's `weights` |
| **Call wire** | Gives a function (or a whole code file) to the consumer. The consumer can call it any number of times | scene.module → loop.scenario, reward code → trainer.objective, metric code → evaluator.metrics | Checked by signature on connect: if parameter types or return types do not agree, the wire is refused. Return values are checked at run time. No recursive calls |

Cycles are checked separately for each wire kind. `params → options.params` and `options → params.options` can be present together, because the second one is a function boundary, not an evaluation cycle. On the canvas, value wires are solid lines, and call wires are dashed lines with an ƒ.

## 5. Templates

This is an excerpt of the combiner template (`arithmetic-combiner.yaml`):

```yaml
format: neurom-template
id: arithmetic-combiner
revision: 1
name: 组合器 · 工具层调用 3 个网络
kind: composite                       # module | composite | canvas
preset: { label: 组合器 · 内置 ADD4 / SUB4 / MUL4 与策略产物已接受 }   # the palette's example
modules:
  questions:
    kind: partition
    config:
      kind: enumerate
      enumerate:
        axes: { op: ['*', '+', '-'], a: [0, 1, …, 15], b: [0, 1, …, 15] }
        roles: { training: { mod: 5, rem: [2, 3, 4] }, validation: { mod: 5, rem: [1] }, test: { mod: 5, rem: [0] } }
  scene:
    kind: code
    title: 算术题
    config:
      source: |-                        # code module: top-level const + function, exports are ports (ADR 0005)
        export const budget = 1;
        export function init(start) { return { op: start.op, a: start.a, b: start.b, action: -1 }; }
        export function input(state) { return concat(oneHot(state.op === '*' ? 0 : state.op === '+' ? 1 : 2, 3), bits(state.a, 4), bits(state.b, 4)); }
        function want(q) { … }                                                    // unexported: a helper
        export function step(state, action) { return { state: { ...state, action }, done: true, success: action === want(state) }; }
  reward:    { kind: code, config: { source: 'export function reward(transition) { return transition.success ? 1 : 0; }' } }
  exact:     { kind: code, config: { source: 'export function exact(episode) { return episode.success ? 1 : 0; }' } }
  loop:      { kind: loop, title: 回路 }
  policy:    { kind: network, config: { engine: dense-policy, kind: feedforward, inputs: 11, layers: [{ tools: tools, data: 8 }], … } }   # its only layer is a tool layer
  policyOut: { kind: readout, config: { mode: bits, width: 8, decode: lsb-int } }   # a trailing tool layer: its result bits are the output
  add4:      { kind: network, config: { engine: threshold-layers, inputs: 8, layers: [12], …, artifact: '0xc024…6bd6' } }   # frozen: selects the builtin ADD4 artifact itself
  add4Readout: { kind: readout, config: { mode: bits, width: 5, decode: lsb-int } }   # its run is a tool
  # sub4 / sub4Readout ([16], 5 bits) and mul4 / mul4Readout ([112], 8 bits) likewise
  trainer:   { kind: trainer, config: { method: reinforce, epochs: 100, lr: 0.1, entropy: 0.03, replicas: 8, seed: 1, evalEvery: 10 } }
  cands:     { kind: candidates, config: { accepted: '0x29d8…c458' } }        # the builtin policy artifact
  evaluator: { kind: evaluator, config: { groupBy: op } }
  execution: { kind: execution }
wires:
  value:
    - questions.training→trainer.training
    - questions.test→evaluator.partition
    - loop.loop→trainer.loop                    # drivers run the loop through its handle
    - loop.loop→evaluator.loop
    - loop.input→policy.in                      # the body: input → … → action
    - policy.scores→policyOut.scores
    - policyOut.action→loop.action              # loop input: takes effect on the next step
    - add4.scores→add4Readout.scores
    - policy.structure→trainer.structure
    - trainer.run→cands.run
    - cands.weights→policy.weights              # loop input: from an earlier training run
    - …
  call:
    - scene.module→loop.scenario
    - add4Readout.run→policy.tools              # tools are numbered in wire order: ADD4, SUB4, MUL4
    - sub4Readout.run→policy.tools
    - mul4Readout.run→policy.tools
    - reward→trainer.objective
    - …
groups:                               # the template itself is the training module; the group inside it
  box:    { title: 回路, loop: loop, members: [loop, policy, policyOut], expose: [loop.loop, loop.scenario, policy.structure, policy.tools, policy.weights] }
expose: [cands.artifact]
slots:                                # the prefab's slots: a declared port of a member, plus the modules its + adds
  - { id: scenario, title: 场景, port: loop.scenario, create: [{ kind: code, title: 场景, ports: { module: scenario } }] }
  - { id: objective, title: 目标, port: trainer.objective, create: [{ kind: code, title: 奖励 }] }
  - …                                 # training set, validation set, metric, evaluation, execution
```

The main points of templates are:

- **Training-module groups**: every builtin template except the tank battle is itself the training module. The instantiated composite has the template name as its title. It directly holds the partitions, datasets, objective / reward and its parameters, metrics, trainer, candidates, evaluator, report view, execution and map view. It also directly holds the scenario module with its parameters and random tables. It also holds the nested group `box`, that is, the loop box (`loop: <loop module>`), whose members are exactly the loop module plus its body. Frozen networks run their own `artifact` and have no candidates module. The networks that tool layers call, and their readouts, are not part of the body and stay outside the box.

  When the composite is expanded, the first set of members shows as the sections of the left column. The scenario is the environment section, immediately after the data. The nested groups are in the sub-canvas on the right (ADR 0011).
- **Slots**: `slots` make the instance a prefab ([CONTEXT](../CONTEXT.md) Prefab, ADR 0011). When a code create entry has no `config`, a click on its + writes stub code from the contract of the slot port (`core/prefab.js stubSource`). For a call port, the stub follows the port's signature. For a loop's `scenario`, the stub follows the scenario roles, and `input` returns as many bits as the network that reads the loop's input declares. A nested group can also have `slots`, on its own members. Such a group is a prefab of its own, and its expected wires are only the wires with an end at its members. Thus several training modules can share the modules of the top level, for example the scene, params, random tables and metrics of the tank battle.
- **Preset**: `preset` lists the template among the palette's examples. `label` is the button text. `accept` names the builtin artifact that each candidates module accepts. An `accepted` that the template pins is imported as usual.
- **Wire order**: the canonical form sorts wires alphabetically. Only call wires into the same call port keep their written order, because a tool layer numbers its tools in this order.
- **Loop box**: the `loop` field of a group marks the group as the box of a loop. The loop box is only a view: the body comes from the wires. If the members of the box are different from the body, the loop shows a problem (ADR 0003, 0009).
- **Groups**: nested groups in a template are created with the instance, collapsed. Members that are not in a group stay at the top level. Groups can contain groups. "Save as template" records the nested groups in the selection, with their `loop` marks. Group ids have their own namespace: a group `box` can contain a module named `box`, and member names resolve to modules first.
- **Instantiation**: instantiation copies the template's modules onto the canvas with fresh ids, and expands them into a flat module graph. Then it wraps these modules in one composite. This composite shows only the ports in `expose`. `instantiateInto` creates the composite collapsed. When the workbench places a template with slots (palette, template library, examples), it expands the composite and its nested groups. Slots on the top level or on a nested group both count. Thus the slots show immediately (ADR 0011). Execution, bundles and deployment always see the flat graph (ADR 0003).

  Composites nest: a composite on the canvas (including a template instance) can be packed into another composite, to any depth. A template file can declare nested groups but never references other templates (ADR 0003).
- **Instances do not follow templates**: an instance is a copy that records only its origin `template id@revision`. Later changes to the template do not change existing instances.
- **Validation**: when the parser parses a template, it instantiates the template into a scratch graph. The parser checks every wire against the wiring rules. The finished instance can have no problems other than "incomplete". For example, after the loop sets the type of `Transition`, if a reward function has the wrong return type, the parser also rejects the template.
- **Storage**: YAML is only for authoring and import / export. Internal storage is always canonical JSON, with every configuration fully defaulted, so a template pins exact behaviour. A code module's `exports` comes from its source. The export to YAML omits `exports`, and the parser derives it again.
- **Template library**: the template library lists builtin and user templates at the three levels: single module, composite and canvas. It can instantiate, fork, import / export YAML and save the selection as a template. It also shows which composites on the canvas come from which `id@revision`. Builtin templates are `frontend/templates/*.yaml`. To add one, put the file in the directory. No registration is necessary.

## 6. Bundles, artifacts and programs

- **Bundle (`neurom-bundle`, `frontend/core/bundle.js`)**: on train / evaluate / execute, the driver calls `buildBundle(graph, id, { res, artifacts })`. This function follows the inputs of the driver and collects all the modules that it uses into one canonical JSON. This JSON goes to the Worker, Python or a session. The driver pins (`sessions/pinned.js`) that bundle and its table rows, and checks the rows against the content hashes in the bundle. A training run, a report and an execution each describe their own pinned bundle. Thus, if you edit the canvas after training starts, the running training does not change.

  If the canvas describes a different bundle, the report or the execution is marked stale, but it is not discarded and not recomputed. Only the latest requested asynchronous result is published. Browser training and Python training get the same table rows.

  ```
  env:   { programs: { init?, input, step }, budget, actions, start: 'seed'|'enumerate'|'window',
           types: { Start, State, Transition, I, table? }, tables? }
  loop:  { I, action: Ref, nodes: { <id>: loop node }, trained: <network id> | null }
  trainer    objective: { kind: 'reward'|'target', program, bound, boundTypes }, selection, partitions: { training, validation? }, recipe, init?
  evaluator  partitions: { test }, metrics: [{ name, program, … }], objective?, groupBy?
  execution  partitions: { test }
  ```

  - `env` is the "environment" in the RL sense. It holds the program that each role of the scenario module compiles to. It also holds the values and types of the file-level names that the program reads (inputs, top-level consts). Each const is computed once. `env` also holds `budget`, `actions` (`null` when not exported), the episode kind `start` of the driving partitions, the types and the table `[{ id, hash, columns }]`. A bundle has no params: parameters appear only as static values bound into programs.
  - `loop` is the loop body. `Ref = { node, port }`, and the loop's input bits are `{ node: '$input', port: 'bits' }`. There are three loop nodes: `network { structure, in, model, artifactId }`, `readout { readout, scores }` and `bits { parts, in: { <port>: Ref } }`. A network with tool layers also has `tools: { <port>: [tool…] }`, in wire order. The tools' own modules are not part of the body.

    A frozen-network tool has its structure, model, artifact id `artifactId` and bits readout. If a frozen-network tool has tool layers of its own, it also has its own `tools`. These tools must be the tools that its artifact was trained with, otherwise bundling fails. A code tool has its program.

    `model` is the integer model of the network's accepted artifact. This artifact is the network's own `artifact`. Without an `artifact`, it is the accepted artifact in the candidates wired into the network's `weights` (`core/loop.js acceptedArtifactId`). The trained network in the artifact must have the structure and readout of this network, otherwise bundling fails ("the artifact of network … does not fit"). Only the network that `trained` names has a `model` of `null`.

    In a trainer bundle, every other network needs accepted weights. In evaluator and execution bundles (`trained: null`), every network needs accepted weights. Otherwise bundling fails ("network … has no accepted weights"). Per-step inputs of the body can only come from the loop's `input` or the body itself.

    A trainer bundle has `init: { artifactId, model }` when the trainer's `init` has a wire (ADR 0020). `model` is the integer model of the accepted artifact in the candidates wired into `init` (`core/loop.js initModel`). The check is the same as for a frozen network: the trained network in the artifact must have the structure and readout of the trained network. Otherwise bundling fails ("the init artifact of trainer … does not fit"). If the candidates have no accepted artifact, bundling fails too. Without the wire, the bundle has no `init`, so its hash does not change.

    The trainer's `gate` and the condition `gate` in its configuration are not in the bundle. The workbench checks the condition before a run starts (`sessions/trainer.js`), so a `gate` wire does not change the bundle hash (ADR 0020).
  - A deployment builds no `env / loop` of its own. It deploys one artifact and uses the bundle in that artifact.
- **Hashes**: `bundleHash = sha256(canonical bundle)`. `envHash = sha256(canonical env)` looks only at `env`, so drivers with different objectives and different bodies can share one environment. The on-chain `taskId` is this hash.
- **Artifact (`neurom-module`)**: `{ bundle, model, provenance, evaluation, id }`. `id` is the SHA-256 of the canonical JSON of the rest. `bundle` is the trainer bundle that trained the artifact. `model` is the integer model of the trained network (`bundle.loop.trained`): `dense-policy` (FF / LIF) or `threshold-layers`. The widths and `weightBits` of the model agree with the network structure in the bundle. When an artifact is stored or imported, it is validated against its network.
- **Candidate compatibility** (`sessions/candidates.js compatibility`): an artifact must satisfy two conditions before you can accept it. First, its `bundle.env` deep-equals the `env` of the current trainer bundle of the loop that the candidates are in. Second, the structure of the trained network and its readout spec are equal. Rewards, selection metrics and the other networks of the loop have no effect on this check.
- **Programs**: every exported function and every top-level const of a code module compiles to IR (`neurom-program`). JS and Python execute the IR under the same rules. The JS side (`frontend/ir/`) compiles programs to closures. The Python side (`training/ir.py`) generates one numpy function per program, batched over lanes with masks. The shared fixture `frontend/ir/fixtures/programs.json` pins the results of the two sides. Browser training, Python training and the in-browser on-chain step check agree.

  User code is never evaluated, only executed as IR.
- **IR operations**: the IR has these operations:
  - Arithmetic and comparison.
  - Records (`record / get / set`).
  - Fixed-length arrays (`array / index / update / range`).
  - Bounded `map / fold / scan` (no unbounded loops, no recursion).
  - 32-bit unsigned arithmetic (`u32 / imul32 / add32 / sub32 / xor32 / and32 / or32 / shl32 / shr32`).
  - Deterministic random numbers `rand(key, counter)`.
  - String constants.
  - `sqrt / ln / exp`.
  - Discretisation `bucket / thermometer`.
  - Table access `tableAt / tableWindow`.
  - Reductions, for example `minOf / argminFirst`.

  Limits: ≤ 4096 nodes per program, static worst-case cost ≤ 2,000,000 node evaluations.
- **Numeric tiers**: environment programs are checked at the exact tier, which refuses `ln / exp`, so both ends agree bit for bit. Rewards, targets and metrics are the approximate tier. They can use `ln / exp`, and the comparison has a tolerance.

## 7. The loop executor

All parts that run a scenario run the loop through one loop executor. The loop executor is `frontend/core/loop.js`. The Python twin is `training/bundle_loop.py`, batched over lanes, with the same semantics. The main points are:

- **`loopSection(graph, res, loopId, { trained, artifacts })`** builds the `loop` section of the bundle. If the loop or its body has problems, it throws `BundleError`.
- **`createLoop(loop)`** → `{ reset(), step(bits) → { action, values, ran, tools }, states() }`. Every network runs its own model from the loop section. To replace a model (for example the candidate model of the trained network during validation and evaluation), use the `models` of the lockstep runner and the greedy runner. It replaces network models by id.
- **Demand-driven**: the executor works back from `action`, and evaluates each node at most once per step. A tool layer runs only the tool that it chose. `ran` is the set of nodes evaluated in this step. `values` is every evaluated output (`'<node>.<port>'` → bits, number or scores). `tools` is the `{ choice, data, result }` of each tool layer in this step. Executions and views show these values.

  Networks keep their executor state across steps. The state is first the network's own LIF potentials, then the state of each of its network tools. The tool states are in tool-layer order and then wire order, nested level by level (`toolCaller`'s `width`). The state of a tool advances only when the tool layer chooses the tool. `states()` gives the whole state of every network, and `reset()` sets all of it to zero. During REINFORCE training, each lane also has its own tool state, which goes to zero with the potentials when the episode of the lane starts.
- **Lockstep runner**: `createLockstep(bundle, { models, tables }).run(episodes, { decide, onStep, trace })` runs a batch of Start records to the end together, one lane per episode (Python twin `bundle_train.py Session.run_steps`). It owns the step protocol that all drivers share. The protocol rules are:
  - The env and the loop reset together.
  - A lane whose episode ended takes no more steps.
  - The target objective is read on the state before the step, and only on the lanes where the trained network decides.
  - The reward reads the Transition with `loop`.

  `decide(x, lanes, y)` is the intercepted trained network. On each step, all lanes that demand it go to the trainer at once. `x` is the input bits of these lanes. `y` is their target bits, or null without a target objective. For each lane, the trainer returns one of these results, optionally with `tools` (its tool layer records):
  - `{ scores }`: its readout decodes them as usual.
  - `{ slot }`: the slot that the argmax readout chose, an integer in 0..O−1.
  - `{ bits }`: the bits of the bits readout, exactly O bits, changed to 0/1 by non-zero.

  If no lane demands the trained network on a step, `decide` is not called. Without `decide`, the trained network runs its own model. These conditions are errors: a step that demands the same intercepted network twice, and a network read by two readouts.
- **Whole-loop training**: on every step, the trainer runs the loop with the trained network intercepted. The executor first evaluates everything that the `in` of the trained network depends on, frozen networks included. The trainer receives those input bits and returns the readout result. Then the executor completes the step to the loop's action. The readout result depends on the method:
  - REINFORCE: a slot sampled from softmax(scores / (ticks · gain)) (for gain, see the next item).
  - Cross-entropy: the slot that the teacher mask gives. On a labelled step, a random correct slot with probability 1 − exploration.
  - Hinge: the target bits.

  Only the trained network gets gradients. If the loop does not demand the trained network on a step, that step produces no decision. Hinge first runs every training episode once, teacher-forced. Every step that demands the trained network becomes one (X, Y) row.
- **Quantisation (ADR 0015)**: the network config `weightBits` selects the weight width: 8 (default) or 16. The config has no `scale` and no `threshold`. The trainer's parameters are float shadows in real units. On every forward pass, the trainer quantises each region again. A region is a plain layer, the choice head / data head of a tool layer, the output layer or a threshold layer. The quantisation rules are:
  - scale s = Q / max|w| (Q = 127 or 32767), with .5 rounded up.
  - Biases are int16 in the unit 1/(s·2^k). k is the largest value in 0..20 at which the biases fit. For LIF, the threshold must also fit in int32.
  - The threshold of a LIF plain layer = round(s·2^k), that is, 1.0 real.
  - The exported codes are `W` and `b`. The training forward pass uses `W`·2^k and `b`, and the result is bit-exact with integer execution.
  - STE gradients are multiplied by gain = s·2^k. REINFORCE and cross-entropy logits are scores / (ticks · gain), with the gain of the output layer. Hinge's z is in real units.
  - By construction, weights never clip. If a bias is larger than the largest weight of the layer (it does not fit even at k = 0), the bias is clipped and counted.

  The result's `evaluation.quantization` has one entry per region in blob order, `{ region, scale, k, threshold?, clippedWeights, clippedBiases }`. The trainer panel shows a line "int8 clipped per layer (weights/biases) layers[0] k 9 · 0/0 …".
- **One greedy runner**: `runEpisodes(bundle, { models, episodes, tables, onStep, trace })` → `[{ start, success, steps, return, initial, final, trace? }]` is one lockstep run without `decide`. It runs episodes greedily on the integer engines. A greedy run steps at most 16 episodes at once, wave after wave on the same lanes. Thus the number of lanes (an env and a loop executor each) does not increase with the episode count.

  The evaluator session and validation during training both use this runner. Thus an exported model is measured exactly as it will run, inside its loop. Without a `metric`, reward objectives select by mean validation return, and target objectives select by greedy-readout accuracy over labelled steps.
- **Execution** (`sessions/execution.js`) calls the same executor step by step. Every history step records the input bits, `values`, `ran`, the action, the transition and the potentials. You can give actions manually.

## 8. On chain

- The on-chain structure (ADR 0014, ADR 0016, ADR 0017) has these parts:
  - **Weight chunk**: a contract whose code is a STOP byte followed by up to 114,688 bytes (112 KiB) of weights. `ModuleFactory.createChunk` creates it with CREATE2 (salt = the content's keccak256). Thus its address follows from its content, and identical content is created once.
  - **Engine versions**: immutable contracts, each of which computes one engine id (version 1: `DensePolicyEngine`, `ThresholdLayersEngine`). All versions of one id are bit for bit the same. Modules call an engine version with STATICCALL, and the engine version cannot write anything.
  - **Factory**: the Factory is behind a `FactoryProxy`. Its state is in the proxy, and only UPGRADER can upgrade the Factory. The Factory lists the versions of each engine id and the latest version. The list is add-only, and ADMIN manages it.
  - **Roles**: the roles are in the immutable `Roles` contract.
  - **Module contract**: a small clone of the Factory's `NeuromModule` implementation. Its identity is in its code: its engine version for life, ids, shape, chunk and tool addresses. Its storage holds the state of each (actor, session) and `owner()`. `owner()` is the deployer, with two-step transfer and no other power.
- Weights are stored by column: one region per layer, width w = `weightBits`. Column i holds the w-bit weight of every neuron of the layer for input i. Each word holds 256 / w weights, that is, 32 int8 or 16 int16. Each column is padded to whole words. The last column holds the biases (`th` for threshold layers), always int16, 16 per word.

  A region of `rows` rows over `cols` columns takes cols · ⌈rows · w / 256⌉ · 32 + ⌈rows / 16⌉ · 32 bytes. A tool layer is two regions: K choice rows and D data rows. Each region has its own shift k (0..20): z = (Σ W·x) · 2^k + f · b. FF fires at z ≥ 1. A LIF plain layer fires at its own threshold. Threshold layers compute (Σ W·h) · 2^k − th.

  Shapes: dense uses four words, and threshold layers use two words. The four dense words hold, in sequence:
  - The layer layout, in two words. Each layer has a 64-bit descriptor with 16-bit widths.
  - The layer count, ticks, leakShift, weightBits, reset and the k of every region.
  - The threshold of each plain layer (exactly 1 for FF).

  The first threshold-layer word holds the widths. The second word holds weightBits and the k of each layer. The bit fields are in `contracts/README.en.md`.

  The engine adds the whole column of every input that is 1, and the numerics are identical to `integerStep` / `layersStep`. On each step it calls only the chosen tool. It gives that tool its slice of the state through `forwardFrom(state, data)`, and writes back the next state that the tool returns. A module's `stateWidth` = its own LIF potentials + its tools' states, at most 256 int32. The engine never touches the own storage of a tool module.

  `ModuleFactory.deploy(spec, data)` does three things in one transaction: it checks, then it creates the missing chunks that `data` brings, and then it creates the module. The result is all or nothing. `checkDeploy` is the same checks as a view. `deploy` refuses these items:
  - An engine id without a latest version, or a named version that the list does not have.
  - A chunk that is still missing after chunk creation (address recomputed from the content hash).
  - A shape that the engine refuses.
  - Weight bytes that do not agree.
  - A tool that is not a module of this Factory.
  - Tools nested deeper than `MAX_TOOL_DEPTH` = 3 (`depth`, and `depthOf` records the depth of each module).

  `modulesOf(artifactId)` lists the modules recorded with an artifact.
- Deployment is per artifact: one artifact is one network. A network with tool layers (ADR 0010 §11, ADR 0014) deploys its tools first. Every network tool is its own module, and it can be FF, LIF or a network with tool layers of its own. A network tool with tool layers of its own deploys its own tools first. If the Factory already holds a module for the same artifact (`modulesOf`) and that module verifies, the deployment uses that module again. Then the selector with those tool addresses is deployed.

  A code tool cannot be deployed (`代码工具不能部署`). Each module is deployed in one transaction together with its weight chunks that are not yet on chain. If the gas estimate (+ 10%) is more than the per-transaction limit (30M on Monad), the missing chunks go first, one `createChunk` transaction each. This continues until the module and the remaining chunks fit in the last transaction. Chunks already on chain are never sent again.

  The pre-deployment checks (`core/kinds/network.js deploymentProblem`) are:
  - Input and output widths are in 1..65535.
  - Dense has 1..8 layers. Plain hidden and tool-layer K / D / R are in 1..65535.
  - The state per session (plain LIF neurons plus the tools' states) is at most 256 int32.
  - Tools nest at most 3 deep.
  - Every network tool is deployable itself.
  - Threshold layer count + 1 ≤ 8.
  - Weights can be of any size, and they are split into as many chunks as necessary (`denseWeightBytes` / `thresholdWeightBytes` are the on-chain bytes).
  - A model's `W` fits `weightBits`, and its biases and `th` are int16 (model validation makes sure of this).

  A full weight chunk is 112 KiB, more than the 24 KB of EIP-170, so it relies on the 128 KB code limit of Monad.
- The bridge accepts `neurom-module` artifacts. `taskId = envHash(artifact.bundle)`, and `artifactId` is the artifact id. The local mirror runs the `env` of the artifact bundle. If the artifact's loop is only "input → this network → readout → action", its readout drives the local mirror. Otherwise, the input bits must be given explicitly. With tool layers, the local mirror also calls the tools.

  Deployment uses the latest engine version, but the caller can name a version. Verification applies to the selector and each of its tools. Verification checks these items:
  - `isModule`.
  - The descriptor.
  - The engine is a version that the Factory lists for its engine id.
  - The shape.
  - The chunk addresses (recomputed from the artifact's content).

  To verify a tool, the tool's artifact must be in the workspace.

  The gas data is in the gas table of `contracts/README.en.md` (`testGasOfMiningNetworks`). A one-transaction deployment (chunk + module) of the default mining network FF 185→32→7 (int8) uses 1,996,410 gas. A 63-step game uses 3,258,388 gas (int16: 3,295,015 / 3,286,572). On local Anvil, the combiner's 154 test questions decide on chain bit for bit as in the browser (`module-chain.test.js`).
- Stateful and nested tools (ADR 0014): there are two cases. The first case is a LIF selector with a LIF tool. The second case is a selector whose tool has a tool layer of its own. In both cases, the decisions through the bridge on a local Anvil agree bit for bit with the browser. The state also agrees, across resets and sessions (`module-chain.test.js`). The own storage of a tool module is not touched. Verification also compares the module's `stateWidth`.

  On Monad rules (`Modules.t.sol` testGasOfNetworkTools, a 2-bit selector), a step that chooses a LIF tool uses 47,013 gas. A step that chooses an FF tool uses 41,058 gas. Each level of nesting adds 22.5k–23.6k in the measurement, which is the cost of one tool call. An estimate at about 24k per level gives these limits: 8 tool layers nested 3 deep make at most 584 calls, about 14M. Nesting 4 deep needs about 112M, which is more than one transaction holds. This is the reason for the limit of 3.
- The deployment plan (`planDeployment`, read-only) has two steps. First, it finds by CREATE2 address how many of the weight chunks that this artifact needs are already on chain. The chunks that it needs include the chunks of the tools that it deploys first. Second, it calculates the transactions to send from gas estimates, by the same rule as deployment. The module's own gas is known only when its missing chunks fit in the estimate, otherwise it shows as pending. Deployment estimates again before every transaction, so at a boundary the forecast can be wrong by one transaction.

  The deployment module refreshes the deployment plan at these times: on "Connect", on "Deployment plan", before it deploys, and after each mined transaction of a deployment. It lists the mined transactions and the transactions still to send, one by one. If a deployment fails midway or the page closes, you can deploy again. Then the bridge first looks everything up on chain and sends only what is missing. Chunks on chain are not sent again, and tool modules that are deployed and verified are used again.
- On-chain inference, read-only preview and step use one check. On the same input, the decision on chain must be equal to the decision of the local integer executor, item by item. The items are scores, counts and voltages. For dense, counts are the spike counts of every plain layer. For threshold layers, counts are the activations of every hidden layer, concatenated in layer order, as the contract reports them. A read-only call only reports a disagreement. If a step transaction disagrees, the session ends (`STATE_MISMATCH`) and the local episode does not advance.

  The deployment session runs deploy, inference, preview, reset and step on local Anvil through the same `module-chain.js` (`core/sessions/deployment.test.js`, skipped without Foundry).

## 9. Code layers

| Layer | Location | Contents |
|---|---|---|
| IR | `frontend/ir/`, `training/ir.py` | Parsing (JS subset → IR), type checking and cost, compilation to closures (JS) / generated batched numpy functions (Python) |
| Core | `frontend/core/` | Port types, the module-kind registry, the module graph (nodes / wires / groups, a group can be marked as a loop box), type inference and problems, bundles (`bundle.js`), the runner (`runner.js`), the loop executor and greedy runner (`loop.js`), readouts, templates, the workspace, canonical JSON and hashing |
| Sessions | `frontend/core/sessions/` | Trainer, candidates, evaluator, execution, deployment, dataset, the drivers' pinned bundles (`pinned.js`), the integer-executor wrapper (`executor.js`), the Python Workspace client. The UI changes state only through sessions and `graph` |
| Integer engines | `frontend/runtime/` | `dense-policy.js` (FF / LIF) and `threshold-layers.js`, shared by the loop executor and the chain mirror |
| Browser training | `frontend/training/` | `run.js` (scheduling, episode sources, selection, validation through `runEpisodes`), `reinforce.js`, `cross-entropy.js`, `hinge.js` (all three run episodes through `createLockstep`'s `decide`), `train.js` (checks `METHODS`, then dispatches), `dense-core.js` (QAT / STE / BPTT), `quantize.js` (each region's scale, k, threshold and clipped counts). Runs in a Worker and contains no scenario code |
| Python training | `training/bundle_env.py`, `training/bundle_loop.py`, `training/bundle_train.py`, `training/workspace.py` | The runner twin (`create_env`, batched over lanes). The loop executor twin (`create_loop`, `run_episodes`, the integer executors). The three methods (through the lockstep runner twin `Session.run_steps`) and the CLI. The same-origin Workspace server |
| Templates and artifacts | `frontend/templates/` | Builtin YAML, builtin artifacts (`artifacts/`) with their generator and test |
| Canvas | `frontend/editor/`, `frontend/graph_app.js`, `frontend/ui/template-library.js` | One host node component + one content component per kind, composite nodes (loop boxes), the two wires, template library drawer, palette, persistence |
| Chain | `frontend/module-chain.js`, `contracts/src/modules/` | Deploy (weight chunks + module), verify, step. Roles, the Factory and its proxy (with the engine versions), both engines, the module implementation |

## 10. Builtin templates and artifacts

| Template | Method | Loop body | Builtin artifacts (exact scores on the evaluator's partition) |
|---|---|---|---|
| `mining-task` mining | REINFORCE | 185 → 32 → 7 FF network → argmax readout | No builtin artifact. The template recipe: seed 1, 600 epochs, browser JS trainer |
| `memory-map-task` memory map | cross-entropy (shortest-path teacher) | 55 → 32 → 7 LIF network → argmax readout | No builtin artifact. The template recipe: 3000 epochs |
| `arithmetic-add4 / sub4 / mul4` four-bit add / subtract / multiply | hinge | 8 → [12] / [16] / [112] → 5 / 5 / 8 threshold network → bits readout | `arithmetic-add4 / sub4 / mul4`: exact and bitAccuracy both 1 (all 256 pairs) |
| `arithmetic-combiner` combiner | REINFORCE (the policy only) | The policy network is one tool layer. Its decision head reads the 11 input bits and picks one of ADD4 / SUB4 / MUL4 (frozen networks through the `run` of their bits readouts). Then it gives 8 data bits → result bits → bits readout (8 bits) | `arithmetic-combiner-policy`: exact 1 |

- There are six task templates (plus the blank `training-module`) and four builtin artifacts (ADD4 / SUB4 / MUL4 and the combiner policy, `frontend/templates/artifacts/*.json`). Mining and memory map have no builtin artifact. The reason: a trained model is the result of the user, and the training of each person is different, so task templates contain only rules.

  For each of the four artifacts, `artifacts.test.js` checks two items:
  - The artifact's `bundle.env` is equal to the `env` of the evaluator bundle of a fresh instance of its template.
  - The template's own evaluator gets exactly the scores in the table above on the partition that the evaluator is wired to. In this evaluation, every network of the loop uses its accepted artifact. The partition is all 256 pairs for the four-bit arithmetic, and the test partition for the combiner.

  For the combiner, the test also checks these items:
  - In wire order, the tools are ADD4, SUB4, MUL4.
  - On the 154 test questions, the tool layer picks ADD4 for every `+`, SUB4 for every `-` and MUL4 for every `*`.
  - The data bits that it gives are exactly a‖b.
  - Every answer is correct.

  The scores are exact: they depend only on the template programs, the IR, the runner, the loop executor and the integer engines. Any drift in those parts is a behaviour change.
- **The combiner**: the partition is the 768 questions `op ∈ {*, +, −}` × a × b. The partition is split by enumeration index mod 5 into training (remainders 2, 3, 4), validation (1) and test (0). `input = oneHot(op, 3) ‖ a[4] ‖ b[4]` (11 bits). The policy network is `layers: [{ tools: tools, data: 8 }]`. The decision head of the tool layer reads those 11 bits directly, picks one frozen arithmetic network and decides the 8 data bits to give it. The result bits of that network (zero-extended to 8), read as an integer, are the answer.

  The reward only tells whether the answer is correct (`transition.success`). The head reads the input directly. If a hidden layer is in front of the head, that layer must carry the 8 operand bits through unchanged.

  Recipe: REINFORCE, 100 epochs, lr 0.1, entropy 0.03, replicas 8, seed 1, evalEvery 10. Validation exact reaches 1 at epoch 70, and all 154 test questions are correct.
- **Mining** (rules in ADR 0018): a 16×16 grid, 63 steps, bag capacity 3. The probabilities of empty / dirt / coal / gold are 0.67 / 0.2 / 0.1 / 0.03. The values are dirt 1, coal 2, gold 10, with settlement at the base and target value 1. The environment parameter `deliverEnds` (交付后结束回合, a delivery ends the episode) is off by default. When it is off, a delivery empties the bag and the episode continues to the step budget, so several trips are possible. The only perception parameter is `radius` (方形视野半径, the square view radius, 1..4, default 4).

  `input` is 185 bits:
  - Coal and gold, one bit each per cell over a 9×9 square view (81 + 81 bits). Dirt and empty read 0. Cells beyond the radius or off the map read empty.
  - The base x / y offset (5 bits each, +15).
  - The dirt / coal / gold in the bag (2 bits each, saturated at 3).
  - Bag full (1 bit).
  - Steps left (6 bits).

  `input` gives no direction or distance to the nearest target. The default network is FF 185 → 32 → 7 (`dense-policy`, int8 weights). The reward is the increment of the settled value. Success = delivered at least once (target value 1).
- **Memory map**: the default network is LIF 55 → 32 → 7, `weightBits: 16`. The template recipe is cross-entropy, 3000 epochs. The test partition is 35 targets × delays 0/1/2/4/8/16 = 210 episodes. Results are different for each run and each seed.
- After a template or the weight format changes, run `node frontend/templates/artifacts/generate.mjs`. This script trains the four builtin artifacts with the JS trainer, each on the trainer bundle of a fresh instance of its template. The seed is pinned, so every run writes the same artifact. For the combiner policy, the script sets the `artifact` of the frozen networks to the ADD4 / SUB4 / MUL4 that it just trained. All four are int8: ADD4 / SUB4 / MUL4 reach validation 1 at epochs 400 / 507 / 1341, and the combiner policy at epoch 70. None of the four clips.

  Then copy the printed ids into `arithmetic-combiner.yaml`, which pins them (the `artifact` of the tool networks, the `accepted` of the policy candidates). If the ids do not agree, `artifacts.test.js` fails.
- Palette presets (heading "Examples"): each of the six task templates declares one preset with `preset`. Mining and memory map accept no artifact, so their networks have no weights when placed, and you must train them first. ADD4 / SUB4 / MUL4 each accept their own artifact. The three tool networks of the combiner select their builtin artifacts, and the combiner also accepts the policy artifact.

## 11. Correctness and performance

### Correctness checks

| Check | What it pins |
|---|---|
| `frontend/ir/fixtures/programs.json` (`ir.test.js`, `training/test_ir.py`) | JS and Python IR results are equal lane by lane, including error attribution, signed zero and u32 boundaries |
| `training/fixtures/bundle-env.json` (the runner / loop executor parity corpus. `bundle-env.mjs` generates it with the browser code alone. The JS side `training/fixtures/bundle-env.test.mjs` runs every committed case again. The Python side `test_bundle_env.py`, `test_bundle_train.py` replays the same cases) | `envs`: scripted episodes (a scene without `init`, window episodes with a full-table target), with the input bits, the transition and the target per step. `loops`: greedy episodes of whole loops on fixed integer models (a frozen upstream network feeds another). They record per step the input bits, every evaluated value, `ran`, the action, the transition and the voltages of every network, plus the summaries of the lockstep runner. `intercepted`: trainer bundles in the lockstep runner, where a script decides the result of the trained network. The script results include slots, scores, bits with values beyond 0/1, tool layer records, a table target and lanes that end at different steps. They record per step the input and target bits given to the trained network, its result, the action, the Transition with `loop` and the reward. `errors`: intercepted results and bundles that both sides must refuse. `partitions`: the episodes of partition entries (enumerate `{ mod, rem }` included). `validations`: greedy validation of hand-made candidates under both accuracy rules (hinge: every decided step. Cross-entropy: steps with a target bit set) |
| `training/fixtures/replays.json` (generated by `replays.mjs`, which runs the Python trainer. `bundle-env.test.mjs`, `test_bundle_train.py`) | Python-trained models replayed by the browser executor. The models are the three tool-layer bundles of the gate task and the builtin combiner. The replay records the validation summary and the action and tool layer records of every step. The Python replay must get the same results. Each entry carries the bundle that it was trained on |
| `training/fixtures/bundles.json` (`test_bundle_train.py`) | Each Python training method learns its fixture bundle: REINFORCE / cross-entropy on the counter task, hinge on a two-bit adder, and REINFORCE of a policy (`frozenGates`). This policy reads its input bits and the outputs of two frozen threshold networks (AND / OR). The exported model gives the validation metric again |
| `frontend/templates/artifacts/artifacts.test.js` | Section 10: the environment and exact scores of the four builtin artifacts (ADD4 / SUB4 / MUL4, the combiner policy), and the tool choice and data of the combiner |

### Performance

There is no CPU profile. The main work of each step is:

- **The mining input program.** On every step, it gets the 9×9 view window around the agent (81 cells) with IR `range(81).map`. Then it encodes coal and gold as 81 bits each, and adds the base offset, the bag and the steps left.
- **LIF training** in JS goes through the BPTT path of `dense-core.js`, which is not related to the IR.

## 12. Known limits

- **Loops are not deployed on chain**: deployment is per artifact (ADR 0014). A code tool in a tool layer cannot be deployed (ADR 0010 §11).
- **Only three losses**: custom losses need autodiff over the IR (ADR 0009's "capability B"). The workbench does not have this function. No template needs a loss other than the three methods.
- **Canvas size**: mining expands to 18 modules, the memory map to 17, ADD4 / SUB4 / MUL4 to 12 each and the combiner to 18. These modules are in one training-module group that holds the group 回路 (loop). When placed, the training module and its 回路 group open expanded (a prefab, ADR 0011). When collapsed, it shows only the candidates' artifact. When expanded, the members of the sub-canvas are arranged by wire depth, and the sections of the left column are not arranged. The toolbar's "Arrange" does the layout again by measured sizes.
- **Performance**: see section 11. Call wires do not dispatch through the canvas. Training and execution first compile the bundle into closures (browser) or generated batched functions (Python), and then run them. The cost is in the execution of the programs.
