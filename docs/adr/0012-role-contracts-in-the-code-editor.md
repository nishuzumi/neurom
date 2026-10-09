---
status: accepted
---

# The consumer kind declares each role contract, and the code editor shows it

## Context

A code module implements roles that other modules call (ADR 0006, ADR 0005, ADR 0009). An author must see what to write, who calls the code, what arrives and what to return. The source is a restricted JavaScript subset, and the IR is pure dataflow. Types come from the caller, not from the source.

## Decision

The consumer kind declares the full contract of each role. The parser rejects type syntax. The editor shows the contract for each role.

### 1. Consumer kinds declare the whole contract

Every call signature has these items:

- `names`: the default parameter names. `callIn` refuses a signature without them.
- `docs` for each parameter.
- `returns`.
- `stub`: a body that compiles.

The port has `when`: who calls it and when. The scenario roles (`kinds/scenario.js`) have the same texts. This is protocol, and protocol belongs to the kind (AGENTS.md). Nothing task-specific moves into code.

### 2. Count and types are the protocol, but names are free

An implementation can give its parameters any names (`step(s, a)` is as good as `step(state, action)`). The checker enforces the parameter count, the argument types and the result type.

### 3. No type syntax in code modules

The parser rejects these items and gives their location: annotations, generics, `as`, `satisfies`, `<T>x`, `!`, `type`, `interface` and `declare`. Types come from the caller, and the editor shows them. The source is a restricted JavaScript subset.

### 4. Code is edited in vertical tabs, one per role

A role is a call wire into a call port, or the `module` of the file wired into the `scenario` of a loop.

Each code module gets one tab for each role, in file order. A missing required role is red. ⊕ lists the missing optional roles. The tab 全文 shows the full file. In a training module, the code modules share one 「代码」 section.

A role tab shows only that role. When the header of the role has the parameter count of the protocol, the editor locks all of the header other than the parameter names. The editor draws the types. `?` opens the help window of the role. The window shows the signature, the caller, the parameters and record fields, the return and an example.

If the parameter count is wrong, the tab shows the problem and a fix. The fix rewrites only the parameter list. The tab of a missing role shows a preview of the stub that 「添加」 inserts.

### 5. Examples come from a real episode

`core/sample.js` runs the environment of the loop on the first episode of the partition of its driver. The driver is the trainer. If there is no trainer, it is the evaluator. If there is no evaluator, it is the execution. The sample uses the constant action 0 and a maximum of 4096 steps. Then it runs the program of each role on those values. The window labels the result as a fixed-action sample, not as the behaviour of the policy.

## Considered Options

- **A class for each module with `implements Scenario`.** The IR is pure dataflow, so `this`, mutation, `new` and constructors would all be banned. The class would look like a language that it is not. Also, single-function modules would become one-method classes.
- **Fixed parameter names.** A name tells nothing that the type does not tell.
- **TypeScript annotations that the parser ignores.** The annotations look like constraints, but they are not constraints.
- **Checked annotations plus a checklist.** A checklist tells which functions exist, not what arrives in them.
- **Reference cards inside the editor.** The cards interrupt reading. They give no overview of the present and missing roles.
- **Exports that generate the wires.** An export tells what a module offers, not who takes it. To choose ends by name is to guess (AGENTS.md).
- **Reward and metric inside the environment file.** One environment serves several trainers. Also, `envHash` would change with each reward edit.

## Consequences

- Sources with type syntax do not parse.
- A new consumer kind must state its full protocol. If it does not, it does not load.
- Samples run synchronously on the UI thread. If long scenarios make editing slow, the fix is a worker.
