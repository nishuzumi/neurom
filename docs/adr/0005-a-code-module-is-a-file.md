---
status: accepted
---

# A code module is a file

## Context

Scenarios and all other task functions live in code modules. A scenario has several roles, and these roles share helpers. A kind that calls a module must find its functions without a second convention or a wire for each role. A misspelt role must not disappear silently.

## Decision

A code module holds one source file, `config: { inputs, source }`. The source is a restricted JavaScript subset without type syntax (ADR 0012). The file contains only top-level `const`s and `function`s (`ir.parseModule`).

The file declares its own ports:

- Each `export function` is a call output.
- Each `export const` is a value output that is computed one time from the inputs.
- Each name in `inputs` is a required value input that the file can read at file level.
- `module` gives the full file to a kind that calls several of its functions by role.

Unexported functions are helpers. The compiler inlines them where they are called. The title is only a label.

One shape, a file with exports, serves scenarios and all other functions. So a kind never needs a second convention or a wire for each role.

## Considered Options

- **Call wires for each role from one module (`scene.init → …`, `scene.step → …`).** Each slot takes exactly one function with a fixed signature from the same file. So the wires express no choice. Each shared helper must be bound again to each function that reads it. Also, a misspelt role is still only an export without a wire. One `module` wire says "this file is the scenario". The consuming kind checks the exports of the file.
- **One code module for each role.** A scenario that is spread over many boxes is not readable from top to bottom.
- **One-function modules next to file modules.** A one-function module holds one function, its parameters are the input ports, and its title is the function name. This gives two conventions for one thing. The parameter list gives ports next to the ports from the exports. The title gives a name next to the names in the source. The one-function form can express nothing that the file cannot express.

## Consequences

- The workbench derives `exports` from the source each time the source parses, and stores it in the config. So the ports stay when the source does not compile. Nobody writes `exports` by hand.
- When an export disappears, the editor disconnects its wires in the same history entry.
- Typo guard: an exported function of the scenario module can be neither a role nor connected to a wire. The workbench reports such a function on the consuming port (the `scenario` of the loop, ADR 0009). It also reports a missing required role on that port. The two are incomplete problems: they block bundles and runs, but not wiring.
- Partial application is a declared input that the file reads at file level. For example, the coefficients of a reward are an input, not a trailing parameter.
- A template wire can omit the source port if the module exports exactly one function or one const.
- The declared inputs of a module are static values. The compiler binds them into each program that reads them. Runners do not see Params.
