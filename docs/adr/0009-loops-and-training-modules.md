---
status: accepted
---

# Training, evaluation and execution share one scenario protocol and one loop

## Context

Training, evaluation and execution all run a scenario. A trainer can need other networks at train time. An example is a policy over frozen tool networks. Lane batching, execution replay and on-chain step verification need the State of a scenario as a value. JS and Python must run the same semantics.

## Decision

Training, evaluation and execution run a scenario through one protocol and one loop. Every driver runs the same loop. Thus a trainer can train a network that needs other networks at train time.

### 1. One scenario protocol

A scenario module exports these items:

- `init(start)`. This export is optional. If it is absent, the State is the `Start` record.
- `input(state[, table]) → bits[1..256]`.
- `step(state, action[, table]) → { state, done, success }`.
- `export const budget`. This is the maximum number of steps.
- `export const actions`. This export is optional. It gives the labels for a readout.

The runner (`frontend/core/runner.js`, twin `training/bundle_env.py`) does these operations:

```
reset(start):  state = init ? init(start) : start;  t = 0
input():       bits = input(state, rows ≤ cursor)
step(action):  r = step(state, action, rows ≤ cursor + 1)
               truncated = !r.done && t + 1 ≥ budget;  done = r.done || truncated
               Transition = { prev: state, action, next: r.state, done, truncated, success: r.success }
               state = r.state;  t++
```

Objectives read the State directly:

- A reward is `fn(Transition) → number`.
- A target is `fn(State[, table]) → bits[O]`.
- A metric is `fn(Episode) → number`, with `Episode = { initial, final, steps, success, return }`.

The roles are pure functions over an explicit State record. They are not methods of a mutable class. Lane batching, execution replay and on-chain step verification need State as a value.

A task with one question writes a `step` that returns `done: true`. There is no second scenario shape.

The network sees exactly what `input` returns. The scenario author must hide information from the network.

There is no environment kind. The RL environment is the scenario plus its `budget`.

### 2. The loop (回路)

The kind `loop` is the per-step boundary. It has these ports:

- Input `scenario`. This input takes the `module` output of the scenario.
- Input `action`. This input is declared `loop`, so its value takes effect on the next step.
- Output `input: bits[I]`.
- Output `loop`. This output is the loop handle.

The loop body is every module on a value path from `input` to `action`. The body includes networks, readouts and bit wires. The system derives the body from the wires. A composite marked as the loop box is only a view. If the box is different from the body, the loop shows a problem.

A network declares its input width by hand (`network.inputs`). The workbench checks it against the width wired into `in`. The width does not come from the trainer, so you can read a network on its own.

The loop has no partition. `Start` is the episode kind of every partition on which its drivers run it. If the drivers do not agree, the loop shows a problem.

The trainer, the evaluator and the execution all take `loop`. They all run one executor (`frontend/core/loop.js`, twin `training/bundle_loop.py`).

Whole-loop training works as follows:

- The trainer names the network that it trains (`structure`).
- Every other network in the body runs frozen on its accepted weights.
- On each step, the executor gives the trainer the input bits of the trained network. Then the executor finishes the step from the readout decision of the trainer.
- Candidates stay manual. Only an explicit accept changes the weights that the loop runs.

Tools are layers inside a network (ADR 0010). The frame of a training module is presentation (ADR 0011).

### 3. The bundle

`neurom-bundle` contains two sections:

- `env`: the programs of the scenario, the budget, the actions, the `Start` kind, the types and the tables.
- `loop`: the body nodes, the action ref and the network that the trainer trains.

The full shape is in `docs/design.md` section 6. `envHash` is the hash of `env` only. Candidates are compatible when these three items agree: `env`, the structure of the trained network and the readout of that network.

## Considered Options

- **Separate perceive / encode roles.** This option gives a type-level guarantee that the network cannot see privileged data. But the guarantee applies only between two functions that the same author writes in one file. Its cost is four roles and two types.
- **A separate single-step protocol** (`encode(sample)`, `answer(sample)`, with fixed source appended for the rest). This gives a second shape, hidden appended source and a hash that depends on that source.
- **An environment module** that holds the budget, the episode kind and the loop ports. Its content is only two numbers and a tag.
- **Loop membership from a group.** Composites stay a view over a flat graph (ADR 0003). The body follows the wires.
- **IR autodiff for custom losses (capability B).** No template needs a loss other than the three methods of the trainer.
- **Deploy a whole loop on chain.** Deployment is per artifact (ADR 0014).

## Consequences

- JS and Python share one loop semantics. Fixtures that JS generates and Python replays keep the two the same.
- A scenario author controls what the network sees. Only `input` gives information to the network.
- Custom losses are not available. The trainer supports only its three methods.
- A loop is not deployed on chain. Only an artifact is deployed.
