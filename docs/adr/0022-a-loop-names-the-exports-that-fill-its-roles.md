---
status: accepted
---

# A loop names the exports that fill its roles

## Context

The tank battle trains in stages. Stage 1 plays the level: the scene exports `init`, `input` and `step` for that mode. Stage 2 plays a battle between two tanks. The rules of the battle are the rules of the same scene, but an episode starts differently, the network sees a different input and a step moves two tanks. The runner calls a scenario by role (ADR 0004, ADR 0009). A role is the export of the same name, and a loop has no configuration. So one scene could serve one mode only. A second scene file would copy the rules, and a copy drifts.

## Decision

A loop gets an optional config `roles`. It maps a function role (`init`, `input`, `step`) to the name of an exported function of the scenario:

```yaml
loop_s3:
  kind: loop
  config: { roles: { init: duelInit, input: duelInput, step: duelStep } }
```

A role that `roles` does not name uses the export of its own name. The const roles `budget` and `actions` are not mapped. The helper `roleExports(loopNode)` in `core/kinds/scenario.js` gives the export of each role, and every consumer reads the mapping through it: the analysis of the scenario, its problems, the bundle, the Role Tabs, the help window and the loop box.

The bundle keys the programs by role: `env.programs.init` holds the program of the export that fills `init`. The runner (`runner.js`), the trainers and `bundle_env.py` do not see the mapping.

The check for an unused export reads all loops on the scene. An export that any loop uses as a role is not unused. An export that no loop uses and that no wire reads is still a problem, and the message lists the role exports of this loop.

## Considered Options

- **A mode field in the Start record, with one State type.** The scene reads `start.mode` and branches in `init`, `input` and `step`. Rejected: one State type must hold the fields of both modes, each step runs the checks of both modes, and a change of the battle mode changes the bundle of the training mode. Then every stage trains again.
- **Seed ranges as modes.** A partition gives seeds of one range to the battle. Rejected: the meaning of a seed is hidden in the scene, and a reader of the canvas cannot see which loop plays which mode.
- **A second scene file for the battle.** Rejected: two copies of the rules. A fix in one file does not reach the other.

## Consequences

- A loop without `roles` runs as before. Its bundle and its hash do not change. A loop with `roles` that names the default exports also does not change its bundle.
- A missing mapped export is a problem on the `scenario` port that names that export, for example "场景 X 没有导出函数 duelStep". The errors of a role call name the export too.
- The loop box shows the export that fills each role, for example `场景.duelStep`, and a click opens that export. The Role Tabs of the scene list the role exports of the first loop the scene feeds. The help window of a mapped export runs it in its role.
- A loop in a loop box has no card, so its `roles` changes in the template or in the config. The card of a loop outside a box has a form for `roles`.
- The on-chain mining game and the deployment do not read scenario exports by name, so they do not change.
