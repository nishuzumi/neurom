---
status: accepted
---

# Parameter constraints are declared expressions, checked by the kind

## Context

The range of a Params field often depends on other fields of the same module, for example `max: grid - 1`. The constraint must be visible in the declaration, so that a rename does not break it silently. A range of one line must not need a separate code module behind a wire. Constraints must stay bounded and exact, as all other programs do (ADR 0004).

## Decision

- The `min` / `max` (a number) and the `values` (a string list) of a Params field can be a constraint expression.
- A constraint expression is a restricted expression over the fields of the module. You write it in the declaration itself, for example `max: grid - 1`.
- The kind compiles the expression to IR and evaluates it over the current values.
- Function inputs (ADR 0006) only compute derived values. None of their keys constrains a field.

The Params module has a problem in these conditions:

- A value is outside its effective range.
- An expression does not compile.
- An expression returns the wrong kind of value.

`staticValue` refuses such a module, so no bundle carries its values.

## Considered Options

- **A function-input key with the name of a field constrains that field.** The declaration does not show this coupling. The coupling breaks silently after a rename.
- **An explicit reference to a function-input result (`bounds: options.x`).** The system can check it. But a range of one line will then be in a separate code module, behind a wire.
- **Full code modules for constraints.** Code modules stay the tool for all larger logic. An expression stays bounded and exact, as all other programs do (ADR 0004).

## Consequences

- Expressions see the values of the fields, not other constraints. So evaluation cycles cannot occur.
- The form accepts a value that is out of range and shows it as a problem. The form does not reject the keystroke.
