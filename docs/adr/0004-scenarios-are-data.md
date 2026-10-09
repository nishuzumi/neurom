---
status: accepted
---

# Scenarios are data: restricted source compiled to one IR, interpreted identically in JS and Python

## Context

Each task has its own content: the roles of the scenario, the reward, the supervised target, the metrics, the parameter options and the constraints. The browser must advance the environment without Python, for browser training, the single-file HTML, executions and on-chain verification. Python training must give the same results as the browser. A template must carry its task, not only name it. The system must also bound the resources that task content uses.

## Decision

- All task-specific content is source in a restricted JavaScript subset. The source compiles to `neurom-program` IR.
- Code modules hold the source (ADR 0005). A template (`frontend/templates/*.yaml`) stores the source together with the configuration of the parameters, network, readout and partition.
- The system contains no task-specific JS, Python or Vue. Each builtin task is a template.

The IR has two back ends:

- `frontend/ir/`: closures, in the browser.
- `training/ir.py`: one generated numpy function for each program, batched over lanes with masks.

Environment programs can use only the exact tier: IEEE operations with correct rounding, and no `ln / exp`. So the two back ends agree bit for bit. Rewards and metrics can use approximate operations, and the comparison of their results uses a tolerance.

The system does not evaluate user source. The browser does not use `eval` or `new Function`. Python `exec`s only code that it generated from a checked program.

The IR is bounded:

- ≤ 4096 nodes per program.
- Static lengths for `map / fold / scan`.
- A static worst-case cost of ≤ 2,000,000 node evaluations.
- No recursion and no unbounded loops.

## Considered Options

- **Code adapters (one JS and one Python implementation for each scenario).** To add a task, you will have to edit two codebases. Bit-for-bit agreement will depend on manual cross-checks. A template can only name a scenario. It cannot carry the scenario.
- **Scenarios only on a Python server (the ComfyUI approach).** In the browser, these features all advance the environment: browser training, the single-file HTML, executions and on-chain verification. The page must work without Python.
- **Pyodide.** The download is large, and the startup is slow. Each training step in the Worker will go into Python. Also, we will still have to maintain the semantics on the Python side.
- **Arbitrary JS source.** It cannot run on the Python side. Also, the system cannot enforce resource bounds on it.

## Consequences

- A new task is one YAML file.
- A new network engine or a new training method still needs code.
- The IR back ends set the performance, not the scenario author (`docs/design.md` section 11, correctness and performance).
- The type system binds scenario authors. `init` sets `State`. You cannot connect a call wire if its signature does not agree with its port.
