---
status: accepted
---

# A task is drawn as one frame: driver sections on the left, per-step modules in a well

## Context

A task contains drivers, an environment and the modules that run per step. Composites are a view over a flat graph (ADR 0003 §1), and composites nest (ADR 0003 §2). Full cards for each part of a task give many cards and short wires that hide the trained module. The workbench needs one drawing of a task that shows the task definition apart from the trained model.

## Decision

A task is drawn as one frame:

- The interfaces of the drivers are sections of a left column.
- A recessed sub-canvas (the well) holds only what runs per step.

All of this ADR is presentation. Modules, kinds, wires, bundles and runs do not change.

### 1. The frame is a prefab

An expanded group with a `prefab` record is drawn as the frame. The number of trainers is not important (none, one or several).

The system writes the record one time, when a template that declares `slots` is instantiated (`core/template.js`). Nothing counts members. A nested group of the template can also declare `slots`. That group then gets its own record, with the expected wires that have an end at its members.

A slot is a declared port of a template member, plus `create`. `create` is the modules that the 「+」 of the slot adds. A code module in `create` starts from the stub of the contract of that port (`core/prefab.js stubSource`).

The other wires of the template are expected wires. If an expected wire is missing, the frame lists it with 「恢复」 and counts it as a problem. But nothing is locked.

The system reads slot content from the wires and never stores it. If you remove all prefab records from a graph, the graph trains the same. The prefab mechanism knows nothing about training.

### 2. Sections and the well

Sections are in the left column and have no card or port band. The sections are:

- The direct `trainer`, `candidates`, `evaluator`, `execution`, `partition` and `dataset` members of the frame.
- The environment. This is the code module wired into the `scenario` of a loop in this frame.
- Each `code`, `params`, `random` or `view` member whose wires all join it to a section. The system adds these members until no more members agree with this rule (a fixed point).

Every other direct member is a canvas member, for example the loop box. The well draws canvas members at their stored positions.

The environment is in the column, not in the well. The environment is part of the task definition and of `envHash`, and all drivers share it. The trained model is only what runs in the loop box.

Several training modules can share one environment. Then the environment stays outside their frames, in the group around them, and no frame draws it as a section. Each frame shows it in its scenario slot, and the loop box shows `ƒ scenario ← <title>`. A copy of the scenario is not a solution, because the rules then exist two times.

### 3. Feeds and slots

If a wire has its two ends at sections of one frame, the frame does not draw it. Every other wire keeps a handle, so the user can get to every wire.

Feeds are on the left edge of the well. Feeds are:

- Section ports wired to canvas members.
- Section inputs that face the loop (`loop`, `structure`), also when they have no wire.

Slots are on the outer edges of the frame. Slots are:

- Every other section port that is not joined only to sections.
- Inputs that take many wires.
- The outputs of the picked section.

Drag or click-to-connect resolves `node/port` back to the member port. This is the same as for collapsed composites.

### 4. The loop box draws the loop's run

Every expanded loop box keeps its frame. The box draws the protocol of the loop around its members:

- `Start ← loop`, with the drivers and their partitions.
- `init(start) → State → input(state) → bits[I]` down the left side, with the `input` handle.
- `action` on the right side, with its handle and the `actions` names.
- `step` and the end condition `done ∨ t = budget` below.
- The return to `State`.

Wording rule: the frame writes only these items:

- The signatures and conditions of the protocol.
- Values read from the graph (`loopContract`).
- Empty states.

The frame does not write explanatory sentences.

### 5. Section columns

Sections go into columns of fixed width, in the order of §2. The `columns` of the group has one of two values:

- `null`. This is automatic. The system uses a contiguous split that makes the tallest column as short as possible. The aspect of the frame sets the number of columns. More columns make the frame wider to the left, and the count stops before the frame touches a neighbour at its level. While Arrange lays out the level of the frame, the count does not look at the neighbours. Arrange then puts the neighbours around the frame.
- A split that the user stored. The user drags a section by its kind label to store a split. After the user stores a split, the frame draws exactly that split.

If a section is not in the split, the frame puts it after its predecessor in the order of §2. `columns` is a view preference. It goes with the graph, not with templates.

### 6. Editing in place

The blank training module in the palette is the builtin template `training-module`. The workbench puts it on the canvas expanded.

If an expanded group is selected, a module that the user adds joins that group. If the user drags a node into or out of the frame of a group, the membership changes (one history entry). The header of each group has unpack and settings (exposed ports, `group.loop`).

## Considered Options

- **Make the well itself the loop box.** The well can hold modules that are not in the loop body. This would break the box = body check of ADR 0009.
- **Put the environment, or only `input`, in the well.** This would show the task definition as part of the model.
- **A rows handle into the well.** No such wire exists. The rows of the loop come from the partitions of its drivers.
- **Nested groups of full cards.** A task becomes about twelve cards with short wires between them. These wires only tell again that "this belongs to the trainer". The module that the trainer trains is lost among the cards.
- **Store only a section order, or a count adjacent to a split.** After rebalancing, a dropped section could jump back. Also, two fields could disagree about the number of columns.

## Consequences

- While their frame is expanded, section modules have no flow node. The user picks and moves them only through the column.
- A graph without prefab records trains the same. The frame never changes what runs.
- Slot content always follows the wires, because the system never stores it.
