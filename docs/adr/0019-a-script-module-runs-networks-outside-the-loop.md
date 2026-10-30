---
status: accepted
---

# A script module runs networks outside the loop

## Context

The tank battle template trains several networks for a game with two sides. Each network trains alone against a scripted bot. Then two trained networks play against each other. The loop has one `input` and one `action`, and whole-loop training trains one network at a time (ADR 0009). A battle is inference only. It must be interactive: a user steps it, pauses it and changes its code while it runs. Rules that change with the task stay in template data (ADR 0004). A view script only draws (ADR 0013).

## Decision

A new module kind, the script module, runs plain JavaScript that calls networks and code functions and draws the result. It does not train, and no bundle contains it.

- It holds several files. `main.js` has a default export `{ layout, views, main }`. Files import each other.
- `layout` is a CSS grid: `columns`, `rows` and `areas`. `views` maps each area name to a Vue component. Each view gets `state` (the data that `main` writes) and `run` (reset, step, run and pause).
- `main(ctx)` writes its own loop. Each round starts with `await ctx.frame()`. Step releases one round, run releases rounds in sequence, and reset starts `main` again.
- Its configuration declares function inputs (like the `functions` of a Params module, ADR 0006) and value inputs. The script calls `await ctx.call.<name>(…)`. A network fills a function input through its readout `run`. An argmax readout thus also offers `run`, not only a bits readout (ADR 0010 §3). An exported function of a code module can also fill it.
- `@ui` gives built-in components to every script, for example `Controls` (reset, step, run).
- It runs in the same sandbox as a view script. The page does each call outside the sandbox and sends back only the result.
- The scenario writes the rules one time. It exports `view(state, side)` and `play(state, a, b)` for two sides. In a battle, the script module calls `view` and `play` through its function inputs, and both actions come from networks. In training, the loop calls the roles of the same scenario, and a scripted bot plays the opponent. The roles and the battle functions use the same rule code. In the first version, `input(state)` returned `view(state, 0)` and `step` called `play`. Since the Battle City level, the level and the battle are two modes of one scene. They share the code for movement, bullets, walls, hits and the input bits.

A prototype showed the layout (a vertical module, one 编辑代码 button, an editor with a file list on the left, views in the grid of `layout`) and the `frame()` rule.

## Considered Options

- **Two networks in one loop, joined by a packed action.** A prototype ran this with only existing kinds, in JS and Python. Its cost is a frozen identity network that changes bits into a number, and a battle that only replays a finished episode.
- **A function input on the scenario, called as the opponent.** The battle is not symmetric, and it still only replays.
- **A loop with several agents.** This changes the loop, the runner in JS and Python, and the Transition type, for a battle that does not train.
- **Function inputs on a view script.** A view must have one execution or report wired to it, and it only draws.
- **A separate battle program outside the workbench.** It needs a second copy of the world rules.

## Consequences

- The script module is browser-only. Python does not run it, because it does not train.
- A network that a script calls starts from zero potentials on each call. So a LIF network keeps no memory across calls. The tank battle uses only feedforward networks.
- If a script has no `Controls` (or its own buttons), the user cannot step it. Templates include `Controls`.
- An exported function of the scenario that only a script module calls is wired. So the scenario check does not report it as a misspelt role.
