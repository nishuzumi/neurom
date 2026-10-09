---
status: accepted
---

# Port counts come from declarations, not from the kind

## Context

A module kind fixes the meaning of each port role: its signature, and how the module uses the value that comes to that port. For some roles, more than one supplier is useful. The system must cover scenarios that nobody wrote yet. A count that is fixed in kind code is a limit that only a release can remove.

## Decision

- If more than one supplier is useful for a role, the kind does not fix how many ports of that role a module has.
- The declarations of the module set that count, and the user edits the declarations.
- Role names are the protocol of the kind, and they stay fixed in the kind. A role that the runner calls has exactly one port.
- The module still declares which roles it fills. The system does not guess the roles from a name (ADR 0005).

Code modules use this rule: the declared `inputs` and the exports of the file are the ports (ADR 0005).

Params uses this rule for its function inputs:

- The function inputs are in `config.functions`.
- Each function input is a call port `fn(params) → record`.
- The default is one input named `options`.
- The results merge by key into computed values.
- If two inputs give the same key, the module reports a problem that names the two ports. No input takes precedence silently.

## Considered Options

- **One fixed port, composed upstream.** This option still works. But to extend this module, the user must know that they must edit the input list of a different module.
- **Several ports, the last wire wins.** The winner will depend on the wiring order. The canvas does not show this order, and templates do not keep it.
- **All ports of all kinds are declarable.** A role that the runner calls (the `init`, `input` or `step` of the scenario) has exactly one meaning. A second `step` will have no caller.

## Consequences

- If a kind accepts several suppliers of one role, the kind must also define how their results combine and how it reports conflicts.
- Some ports exist only because of a declaration. These ports exist also when no wire connects to them.
- A rename keeps the wires. If the count stays the same, the wires move by position. If not, they move by the names that remain.
- A new kind starts with declarable counts for such roles. It does not add a second fixed port later.
