---
status: accepted
---

# 「运行到这里」 trains what upstream has not accepted

## Context

Each module has its own buttons. To see the battle of the tank template, a user clicks 12 buttons in order: train, accept and evaluate for each stage and structure. The 运行 (run) button of the script module only plays with the weights that are accepted now. In ComfyUI, one click on the last node runs every node above it that has no cached result. Users expect the same.

The upstream of neurom is not a fast and fixed computation. A training takes minutes, and it gives a candidate that a person accepts (ADR 0020). The accepted artifact is named by its content and does not change. Thus it can be the cache of everything above it.

## Decision

The modules of the kinds candidates, trainer, evaluator, execution and script have the header action 「运行到这里」 (run up to here). It runs one chain:

1. The chain walks upstream from the module along every wire. Each candidates module that it reaches is a need. The walk does not go above a candidates module.
2. A candidates module is ready when its accepted artifact is compatible with the current graph (the same check as the 兼容 label). A ready module stays as it is. When the trainer cannot tell (未知, for example because its own `init` has no weights yet), the module is not ready. Without a trainer, an accepted artifact is ready.
3. For a candidates module that is not ready, the chain gets the trainer that feeds it ready, then the trainer trains. The chain waits for the run and accepts the candidate that the run selected. The trainer selects that candidate on the validation partition.
4. A trainer is ready when the candidates modules above it are ready and its `gate` passes. For the gate, the chain runs the evaluator only when its report is missing or stale.
5. Then the module does its own action: an evaluator evaluates, an execution resets and runs, a trainer trains and the chain accepts its result, and a script module starts again and plays. A candidates module only gets ready.

The chain stops at the first step that fails, for example a gate that does not pass or a training that fails. The status bar tells the step and the reason. One chain runs at a time. A user cancels a chain with the 取消 (cancel) button of the trainer that trains. When the app replaces the workspace (a file, another tab's save, a clear), the chain stops at once. A training that runs stays as its trainer has it.

## Considered Options

- **Each button stays alone.** A user must know the order of 12 clicks, and a click on the last module does nothing useful.
- **Train everything above on each click.** Each click takes many minutes, and the accepted artifacts are thrown away.
- **A chain that stops before each acceptance.** The user is asked at each stage. A chain of 2 stages then needs the user 4 times, so it is not one click.

## Consequences

- The chain accepts candidates without a person. A person can still accept another candidate by hand later. The gate between stages is the check that the chain cannot skip.
- The chain lives in `frontend/core/sessions/run-chain.js`. It uses only the sessions of the workbench (trainer, candidates, evaluator, execution), so it has no task-specific code.
- A trainer whose `gate` or `init` reads its own candidates depends on itself. The chain refuses it and tells the user to accept an artifact by hand first.
- The page has a new message to the frame of a script module, `{ type: 'play' }`. The page sends it right after `load` of a new frame. A collapsed script module has no frame, so the chain only gets its upstream ready.
- An evaluator report is session state (ADR 0020). After a reload, the chain runs the evaluator of a gate again, but it does not train again when the accepted artifacts are still compatible.
