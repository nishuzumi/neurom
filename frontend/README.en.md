# frontend — Module Workbench

[中文](README.md) · **English**

`index.html` is the only entry point. Everything on the canvas is a **module**, for example params, code, random, loop, network, readout, bit wire, trainer, candidates, evaluator, execution, view and deployment. The code implements each module kind one time. A task is a **training module**: it contains modules and wires, and it is one composite template (a YAML data file), not code. Design: [docs/design.en.md](../docs/design.en.md). Terminology: [CONTEXT.md](../CONTEXT.md).

The canvas uses Vue 3 + TypeScript + Vue Flow. One host node component holds every module, and each kind has one body component. A composite node (`GroupNode.vue`) holds template instances and loop boxes. A training-module node draws an expanded prefab. The domain core (`core/`), the program interpreter (`ir/`), the trainers (`training/`) and the integer executors (`runtime/`) are separate from the canvas. Vite builds and serves, and ethers does the chain operations.

For first use, read the [user guide](../docs/user-guide.en.md) first. The [developer guide](../docs/development.en.md) gives the development environment, the test matrix and common development tasks.

## Starting

1. From the repository root, run `npm ci && npm run dev`.
2. Open the address that the terminal shows (default `http://localhost:5173/`).

The sources contain TypeScript and Vue SFCs, so `http.server` cannot serve them. The dev server sends `/api` to `127.0.0.1:18766`. Browser training works without Python.

For Python training, run these commands from the repository root:

```sh
npm ci && npm run build
python3 -m venv ~/.cache/neurom-venv
~/.cache/neurom-venv/bin/python -m pip install -r training/requirements-torch.txt
~/.cache/neurom-venv/bin/python training/workspace.py --port 18766
```

Then open **http://127.0.0.1:18766/**. The service serves the built single HTML from `frontend/dist/` and `/api` on the same origin. After source changes, build again or use the Vite dev server. Do not connect to the training service cross-origin from another static port or `file://`. Protocol and AI integration: [training guide](../docs/ai-module-training.en.md).

When you open an empty canvas with `?preset=<template id>`, the canvas places that preset directly. You can also use `#<template id>`. Examples of template ids are `mining-task`, `memory-map-task`, `arithmetic-add4` and `arithmetic-combiner`. This applies only to builtin templates that declare `preset`.

## Canvas

- The left rail has three drawers:
  - **Add**: presets, composite templates, my templates, single-module templates, blank modules.
  - **Templates**: the template library.
  - **Files**: clear the workspace.
- The header's "Save workspace / Open" export and import the whole workspace JSON. The workbench reads only `neurom-workbench` files. Some files do not open: the file is not JSON, has a different format tag, or fails validation. Then the status bar shows the format found, the failure location (for example `graph.nodes[2].config`) and the reason. The current workspace does not change.
- Every module is a node. A node has an editable title, a kind badge, a problem badge (hover for reasons), a port band and collapse / delete buttons.
  - Drag the bottom-right corner or any edge to resize. The node shows no handle, and the cursor changes to a resize arrow. Focus the corner with Tab, then use the arrow keys to nudge. Hold Shift for 1 px steps. Press `Home` to restore the default size.
  - The host sets the width, and the body arranges itself inside.
  - Without a height of its own, a code box fits its lines. Up to 20 lines, it is as tall as its code. Beyond 20 lines, it scrolls inside.
  - With a height of its own, the body fills the frame. The code box, the text box and a view's grid / chart / table stretch. Forms do not stretch, and the space stays below them.
  - When the frame is shorter than its content, code boxes shrink to 3 lines first. If that is not sufficient, the body scrolls inside the frame: the wheel scrolls it, and Ctrl + wheel still zooms the canvas. Nothing goes over the border. The minimum frame height is the header and port band plus a strip of body.
  - The frame is the only size control. Text boxes inside have no resize grip of their own, and the code box has no "Expand / Collapse".
- **Ports**: inputs are on the left and outputs on the right, fixed to their row.
  - A driver's `loop` and `structure` inputs are the exception. They are at the top of the right column and face the loop box they point at. Inside a training module, they are handles on the left edge of the sub-canvas (see below).
  - Value ports are solid. Call ports have the mark ƒ (italic).
  - A record-typed output is one whole object by default. A `+` is at the left of its name. Click it to show the next level of fields below it as a tree. You can drag a wire from each field directly. A field that is also a record has its own `+` to expand it.
  - Only one module's field tree is open at a time. Click another module or the empty canvas to fold it. When folded, only the fields that have wires stay on the module, with their full path as label (for example `params.steps`, `value.cfg.bonus`).
  - A required port without a wire shows `*` after its name. Hover a port to see its type or signature.
- **Two wire kinds**: value wires are solid lines, and call wires are dashed lines with ƒ.
  - When you drag a wire, the ports at the two ends set its kind.
  - The workbench refuses these wires:
    - Wires with a type or signature mismatch.
    - Wires that make a cycle. Only a loop's `action` and a network's `weights` can close a cycle.
    - Recursive calls.
  - The status bar at the bottom shows the reason, for example "call wires only connect call ports" or "type mismatch: needs report, got weights".
  - To disconnect a wire, select it and press `Delete`.
- Wire routing:
  - "Wire settings" at the top-right selects curve / step / straight and the default colour.
  - The context menu of a wire adds or removes reroute points, changes the colour or disconnects the wire.
  - Alt+click or double-click a wire to add a reroute point. Drag a reroute point to move it. Double-click a reroute point to remove it.
  - Reroute points change only the drawing. The workspace saves them.
- Move: drag the header or the port band of a module or composite. The port dots start wires. The body is for its controls and text selection. The blank area inside an expanded composite's frame is canvas.
- Pan in one of these ways:
  - Swipe with two fingers on a trackpad, or use the wheel. `Shift` + wheel pans sideways, as in Figma.
  - Drag with the middle button.
  - With the pointer over the canvas, hold Space and move the mouse, with no mouse button. This also works over modules and wires, and it does not move or select them. A button or select that you clicked last has no effect on it. Space types a space only when you type in a text field.
- Zoom: pinch, or use `⌘ / Ctrl` + wheel. `F` fits all, `0` resets to 100%, and `+ / −` zoom. The bottom-right "Selection / All" buttons focus the view. Over a module body that can scroll, the wheel scrolls the body first. Shortcuts do not operate inside form controls.
- Multi-select: drag with the left button on empty space to box-select. The blank area inside an expanded composite's frame also counts. `⌘ / Ctrl / Shift` + click adds to the selection. `⌘ / Ctrl A` selects all. Arrow keys nudge the selection.
- History and packing:
  - `Ctrl / ⌘ Z` undoes, and `Shift Z` or `Y` redoes.
  - `C / V` copy and paste. Pasted modules get fresh ids, and the wires inside the selection stay.
  - `G` packs the selected modules into a composite, and `Shift G` unpacks. The workbench packs a composite in the selection together with its members, and the members stay in it. When the selected modules belong to different composites, the workbench refuses to pack.
  - History records graph structure, configuration, layout and wire appearance. History does not roll back training runs, artifacts or chain transactions.
- **Composites**:
  - When collapsed, a composite is one node that shows only its exposed ports ("member · port"). Its header shows the source template `id@revision` and the member count.
  - Click the `+` / `−` at the right of the header (or double-click the title) to expand or collapse it. When expanded, a dashed frame encloses the members, and you edit them in place.
  - The header also has "Save as template", "Unpack", ⚙ composite settings (exposed ports, loop box) and delete.
  - Drop a module into an expanded composite's frame to make it a member. Drag it fully outside to take it out. When one expanded composite is selected, new modules go into it.
  - Composites can nest. The executable graph is always flat, and wires connect to member ports.
- **Loop boxes**: a composite marked as a loop box is the loop itself. Its badge is "回路" / loop, and its border is solid. The loop module has no separate drawing. The frame draws how one episode runs around its members.
  - The parts of the frame are:
    - On top is `Start ← loop`. The `loop` handle is on the left border of the frame, and the drivers (trainer, evaluator, execution) connect there. After it come the partitions and episode counts of each driver.
    - Under `Start` is `ƒ scenario ← scene`, with its handle on the left border.
    - The left column is `init(start) → State` → `State` → `input(state) → bits[I]`. `init` is optional, and the frame shows "未导出" / not exported when it is absent. The `input` handle is on its right edge and feeds the body.
    - On the right is `action: number`. When the scenario exports `actions`, the action names show here. The `action` handle is on its left edge.
    - Below are `step(state, action) → { state, done, success }` and the end condition `done ∨ t = budget`.
  - Thick lines are the loop's own run. The return line has the label `¬done ∧ t < budget`, and it is faded when budget is 1. Coloured lines are graph wires.
  - When an execution runs the loop, State shows `t / budget`. input shows the input bits of the step, and action shows the action of the step.
  - The frame shows only protocol signatures, values read from the graph and empty states (for example "未连接" / not connected, "未导出" / not exported). Hover `scene.init / input / step` to see the JSDoc of the scenario. A click opens the code.
  - The header shows `budget`. When the loop box is inside a training module, the problems show on the header of the training module.
  - When collapsed, the frame adds a one-line body summary, for example "each step: input bits → network → readout → action".
  - The wires decide the body, and the box is only the view of the body. When a box has extra or missing members, the loop reports that the members of the loop box differ from the loop body.
- **Training modules**: a composite instantiated whole from a template with slots (`slots`) is a **prefab**. A nested group of a template that declares `slots` is also a prefab. Several training modules can share the modules outside it, for example the scene of the tank battle. When expanded, it shows as one dark frame with the badge "训练模块 · method" / training module. Its header has save as template, collapse and delete. Only that prefab record makes it a training module, not the number of trainers in it. Added or removed members never make the frame disappear.
  - The top of the left column shows the **slots**:
    - The template declares the slots, for example scenario, training set, validation set, objective, metric, evaluation, execution. Each slot has one chip, and the chips wrap in one run.
    - A chip names the modules wired to its slot. Click a module name to go to that section.
    - An empty slot has buttons such as “+ 场景”, “+ 分区” and “+ 奖励”. A button adds the template’s stub module inside the frame and wires it to that port.
    - A required slot that is empty shows its name in red.
    - When there is more than one section column, the outer inputs use the first column, and the slot chips wrap through the other columns. Thus the slots use only a few rows at the top.
    - The real wires tell what fills a slot. The workbench does not store it.
  - The template’s wires outside the slots are **expected wires**:
    - When an expected wire is cut or another wire replaces it, a row “missing member.port → member.port” with “Restore” shows under the slots. The problem count in the header includes it.
    - “Restore” replaces the wire that holds that input. You can undo this.
    - You can change wires on purpose. Runs read only the wires, never the prefab record.
  - Below the slots, the column holds the trainer and its satellite modules as sections, not cards. The section order is:
    1. Data: dataset, partition.
    2. Environment: the scenario module wired into the loop's `scenario`, with the params and random that feed only it. The trainer, evaluator and execution share the environment.
    3. Objective: reward or supervised target, with the params that feed only them.
    4. Metrics.
    5. Trainer.
    6. Candidates.
    7. Evaluator, with its report view.
    8. Execution, with its views.
  - Each section has a head row (kind, title, problems, fold, delete) above the module's body. A folded section keeps only its head row.
  - On the right is a recessed sub-canvas that holds only per-step computation. The loop box and the members that are not sections (for example frozen networks) are ordinary nodes. The blank area of the sub-canvas is canvas.
  - Every wire is a real graph wire, and you can disconnect it and connect it again:
    - Wires between a section and a module in the sub-canvas end at **handles** on the left edge of the sub-canvas. A handle is a dot on the edge, with its label "member · port" above it.
    - The `loop` / `structure` inputs that face the loop keep a handle also when they have no wire.
    - Ports wired outside the frame and unwired ports are on the outer edges of the frame, inputs left and outputs right.
    - The frame does not draw wires between two sections.
  - When collapsed, a training module is an ordinary collapsed composite.
  - Section columns:
    - The sections flow into columns that make the whole frame about 1.5 : 1. They go in order, column by column. When a section grows at run time, its column gets longer, and the section does not move to another column.
    - The kind label at the left of a head row is a drag grip. Drop a section between two sections of a column to put it there. Drop it in the gap between two columns to start a new column. The workbench then stores the split and does not rebalance it automatically. Arrange also keeps it.
    - Drag the bottom-right handle to split the current order into a new number of columns. Sideways drags use column width, and up / down drags use height. Double-click the handle to go back to automatic columns.
    - Click a section (an accent bar shows), then click "Selection" to zoom to it. A parameters section also has ⚙ in its head row.
    - A drop or a wire can move a module into or out of the column. Then the status line says "X moved to the left column" or "X is back on the canvas". A section that goes into the column becomes the picked section.
- **Automatic layout**:
  - Layers go from left to right by wire depth, one column per layer.
  - When there are many layers, the columns wrap into several rows, as in a paragraph. The rows have balanced widths, and the whole shape stays near the aspect of the window. Thus the layout uses both horizontal and vertical space.
  - The layout does not wrap between two adjacent columns that both have a training module. Thus stages that follow one another stay in one row from left to right.
  - `loop` and `structure` wires count as wires from the driver to the loop, so drivers stand before the loop.
  - A training module is laid out as one unit. The members of its sub-canvas are arranged inside it, and its sections are not arranged. The layout keeps the width of the left column free, so the frame never overlaps its neighbours.
  - A module without inputs goes one column before its first consumer, not at the far left.
  - In a column, modules are in the order of the positions they connect to, for fewer crossings. Modules also align with the modules that feed them, for straighter wires.
  - When you place a template, the layout arranges the composite together with every nested composite in it. Collapsed composites are arranged too, so they open tidy.
  - After you expand or collapse a composite, the level of the composite that contains it is laid out again. The top level of the canvas is laid out again only when modules overlap there. Thus your manual arrangement stays.
  - After the browser measures the real sizes of modules that just opened, the layout adjusts them one more time. This adjustment is part of the same undo step.
  - The toolbar's "Arrange": when modules are selected, it arranges only the selection. When the selection is exactly the members of a composite, it arranges the whole composite. When nothing is selected, it arranges the whole canvas.
- Workspace autosave:
  - The workspace autosaves to `localStorage` (key `neurom-workbench`), isolated per origin. The workspace includes the module graph, wires, composites, runs, artifacts, datasets, my templates, viewport and wire appearance.
  - To move between ports / domains, export the workspace, then import it.
  - All tabs of one origin share that save. A tab writes only after it changes something itself, so a refresh or the close of a stale tab never writes its stale state back. A tab without unsaved changes follows the saves of other tabs, except when a training run is in progress.
- **Conflict panel**:
  - Sometimes the local save cannot be restored. The cause can be: the save is not JSON, has a different format tag, or fails validation (for example a config with an unknown field). Then the page does not change to an empty workspace. It opens the conflict panel with the format found, the failure location and the reason (ADR 0008).
  - While the panel is open, this tab does not write the save: no autosave, and no answer to the saves of other tabs.
  - The panel has three actions:
    - **Export local save**: downloads the JSON as it is.
    - **Open corrected file**: validates the file as strictly as "Open". On success, the panel closes, and the file becomes the workspace and is saved.
    - **Discard local save**: after a second confirmation, deletes the local save and starts with an empty workspace.

## Module kinds

| Kind | Role | Ports |
|---|---|---|
| Text | Notes | — |
| Params | Declares fields (int / number / boolean / enum / string with ranges and defaults) and function inputs, and holds values. The form is generated. You edit the declarations in a dialog. ⚙ in the header, left of the collapse button, opens it. The dialog has a visual editor on the left and YAML on the right. A range or choice list can be a constraint expression over other fields (for example `max: grid - 1`). A value outside it gets a flag and blocks bundling. Wired code computes derived values, for example a lookup table derived from the fields. The results of several function inputs merge by key, and a key can have only one source | One call port per function input (by default `options`). Output: one whole object `params` (fields expandable) |
| Code | One restricted-JavaScript file (no type syntax) with only top-level consts and functions. Its exports are its ports. The port that an exported function connects to decides its role (below). A scenario is a code module too. It exports `init` (optional), `input`, `step` and `budget` (optionally `actions`), and goes through `module` to a loop that runs it | One value input per name in `inputs`. One call output per `export function`, one value output per `export const`, plus `module` (the whole file) |
| Dataset | Imports CSV / JSON (file, drop or paste) and records columns, row count and content hash. The data is in IndexedDB | Output `table` |
| Partition | Episode sources for the training / validation / test roles. The sources are seed ranges, enumerated combinations and time windows. In an enumerated combination, each role takes all, even / odd, a list of indices, or a `{ mod, rem }` remainder filter. A time window has a length, a stride and an embargo | Input `table` (optional). Three `partition` outputs |
| Random | Jump-ahead tables of a 32-bit linear congruential generator. The configuration is multiplier, increment and table length (defaults 1664525 / 1013904223 / 512). The card shows the draw formula and the first few values | Output `rng: { mul, add }` |
| Loop | The per-step boundary of an episode. The loop gives the bits that the scenario's `input` returns to the loop body, and gives the action of the body back to `step`. The loop body is the modules on wire paths from `input` to `action` (networks, readouts, bit wires). The loop usually shows as a loop box. As a standalone card, it shows the scenario status, I, the body summary and the drivers | Call `scenario` (the scenario's `module`). Value `action` (takes effect on the next step). Outputs `input` (bits[I]), `loop` (handle) |
| Readout | Scores → action. There are two modes: `argmax` + map (`null` = invalid action), or `bits` + decoding. Both modes have the function output `run`: the forward pass of its network, then the readout bits. `bits` mode gives the bits of the bits readout, and `argmax` mode gives the one-hot bits of the argmax (a tie gives the lowest index). A tool layer can use `run` as a tool. It is not possible to deploy a tool with an argmax readout | Inputs `scores`, `actions`. Outputs `action`, `bits` and the call output `run` |
| Network | Integer network in one of two formats. `dense-policy`: FF / LIF, with a layer list of plain layers `{ hidden }` and tool layers `{ tools, data? }`. You add, remove and resize layers on the card. Several layers and tool layers can deploy, except a code tool or a network tool with an argmax readout in a tool layer. `threshold-layers`: a list of layer widths. You declare the input width I by hand in config `inputs` (1–65535), and the bits wired into `in` must have that width. The card shows weight bytes and the deploy limit. When no trainer trains the network, select on the card the artifact it runs, `artifact`. The choices are workspace and builtin artifacts, with name, metric and compatibility, and you can import JSON. Use `artifact` or a `weights` wire, not both | Inputs `in` and `weights`. `weights` is the weights accepted in candidates when this network is trained, and can close a cycle. One call port per tool layer, for any number of tools. Outputs `scores`, `structure` |
| Bit wire | Slices and concatenates bit vectors (`parts: [{port, offset, width}]`), total ≤ 65535 | Several `bits` inputs. Output `bits` |
| Trainer | Methods: REINFORCE / cross-entropy / hinge. Backends: browser or Python. The card has start / cancel, progress and curves, and a run list. The trainer trains the network wired into `structure` on the whole loop, and every other network stays frozen. Episodes come from the `training` partition | Values `loop`, `structure`, `training`, `validation`. Calls `objective`, `metric`. Output `run` |
| Candidates | Artifacts of its runs: compatibility, preview, accept, export, import | Input `run` (many). Outputs `weights`, `artifact` |
| Evaluator | Runs the whole loop greedily over the `partition` partition with every network on its accepted weights, and computes metrics. The evaluator can group by an enumerated axis | Values `loop`, `partition`. Calls `metrics`, `objective`. Output `report` |
| Execution | Steps the whole loop with every network on its accepted weights. Operations: pick an episode, reset / step / run, manual actions. The history records the input bits of each step and the value of every body module. It also records which tool each tool layer called, with its data bits and result | Values `loop`, `partition`. Output `execution` |
| View | Renders an execution or a report. The renderers are `grid` (map + marks), `series`, `table`, `kv` and `script`. `script` is a view script (ADR 0013) that draws for itself in a sandboxed iframe | Input `execution` or `report` |
| Deployment | Deploys one artifact through the official ModuleFactory of the selected network. A network with tool layers deploys or reuses its tool modules first. The deployment also verifies the artifact and its tools, reads state, resets and steps by transaction. A local mirror is for comparison | Input `artifact`. Output `deployment` |

## Code modules

All logic is in code modules:

- The scenario (wired into a loop's `scenario`).
- Rewards.
- Supervised targets.
- Metrics.
- The function inputs of the Params module.
- Consts evaluated one time, for example a scenario's `export const budget`.

The port that an exported function connects to decides its role, and the port sets the signature. Call wires with mismatched types do not connect. The editor locates type errors to the line.

- A code module is **one file**. The file has only top-level `const`s and `function`s, and you edit it in one code box with no separate function header. The module title is only a label. Function names are in the source.
- **Exports are ports**:
  - Each `export function name(…)` is a call output (ƒ). A caller gives the parameters of that function.
  - Each `export const name = …` is a value output, computed one time, statically, from the inputs.
  - One more output, `module` (the whole file), goes to a kind that calls its functions by role. That kind is the loop (its `scenario` input).
  - Unexported functions are helpers, inlined where they are called. Unexported consts are ordinary consts.
  - When you edit the source, the ports change with it. When the source does not compile, the ports stay as they were.
  - When an export disappears or changes between function and const, it loses its wires in the same edit.
- **Inputs**: the `inputs` line above the code box (comma-separated).
  - Each name is a required value input on the left of the module and a name that you can read anywhere in the file. It binds as a static value into the functions and consts that read it. For example, a reward's `weights` comes from the reward-weights params module, a scenario's `sense` from the perception parameters and `rng` from the random module.
  - When the count stays the same, names change by position and the wires follow. When the count changes, the wires into removed names disconnect.
- Below the code box are the errors, located to the file / const / function / call site, each with a "locate" button. The 全文 tab also lists the exports that are not roles: ƒ or value, name, signature and where it is wired (including a `module` row).
- A function's **doc comment** (JSDoc) has a summary paragraph, then `@param name text`, `@param name.field text` and `@returns text`. The workbench ignores `{Type}`s in tags. Types come only from call sites and wires. The texts show in the hover tooltips of the ports.
- **Role tabs** (ADR 0012):
  - Each export that another module calls by protocol has a vertical tab. These exports are the functions wired into a call port, and the scenario roles `init / input / step / budget / actions` that go through `module` to a loop's `scenario`.
  - In a training module, its code modules share one 「代码」 section, grouped by module.
  - A role tab shows only that function.
  - When the header has the protocol's parameter count, it is locked except for its parameter names. A lock is at the start of the line. Hover it for the reason. You can rename parameters, but you cannot add or remove them. Grey types follow the parameters and the result (for example `step(state: State, action: number) → { state, done, success }`).
  - The **?** at the end of the line opens a window that you can drag. The window shows:
    - Who calls the function and when.
    - Each parameter (a record opens into its fields).
    - What to return.
    - An example: the first episode of the partition that drives the loop, action 0, and the arguments and result that a real run computes.
  - When the header has the wrong parameter count, it is not locked, and its **?** is red. The window has a "Change to (…)" button. This button writes the parameter list again with the default names and changes only the header.
  - A missing required function is a red tab. Optional functions are under ⊕. Open one to see a preview of its text, then click "添加" (Add) to insert it. The preview uses the loop it connects to, as a prefab's new scenario does: `input` returns as many bits as the loop body reads. You can delete an optional function from its window.
  - The 全文 (whole file) tab shows everything: helpers, consts, inputs, other exports.
- The box does not show the types of other names. Hover to see them, as in VS Code:
  - When the pointer is on a name, an outline with a background shows on it immediately. The tooltip shows after 300 ms. While a tooltip shows, it changes immediately when you move to another name.
  - Hover a function name to see its full signature, summary, callers and result doc.
  - Hover a name to see its static type and doc. This applies to:
    - Function parameters.
    - Inputs.
    - `const`s (their `/** … */`).
    - Callback parameters: element, index or accumulator of which `.map / .reduce / scan`.
    - Fields, for example `state.x`.
    - Record-literal keys.
    - Builtins and methods, for example `sum`, `Math.max`, `.map` …: signature, purpose and the result type at that location.
  - A function's own parameters get their types from its first call site, that is, a call wire from the export. For a scenario wired through `module` into a loop's `scenario`, the types come from the arguments that the runner gives for that role.
  - Inputs get their types from their wires, and consts from the names they depend on.
  - When type checking fails, the types inferred before the failure still show. When the source does not parse, no types show.
- **Docs follow values** (like the JSDoc of a TS property, visible wherever you read it):
  - The docs of a function parameter and its fields come from the module that gives the parameter. Thus you do not write them again in every function that uses them.
  - The source is the first caller: its protocol's line for that parameter, then the doc of the argument it gives. Examples of arguments:
    - The scenario's `State` is the result of `init`. Without `init`, `State` is the episode record of the partition.
    - `Transition` contains the two States and the step's `action / done / truncated / success`. The loop publishes it.
    - A Params function input receives the module's own fields.
  - An input gets its doc from its wire.
  - The declaration of each Params field is its doc: label, type, range or values, default.
  - For a returned record, write field docs before the keys of the returned object literal (`return { /** agent x */ x: …, … }`).
  - A field without a doc keeps the doc of the value put there:
    - `{ ...s, x }` keeps the field docs of `s`.
    - A conditional takes the docs of both branches.
    - `map` elements keep their docs.
  - Computed values (arithmetic, builtins) have no doc.
  - `@param name text` and `@param name.field text` in the function's own doc override the docs from the caller. Write them only to change the text.
- The editor is CodeMirror:
  - It highlights the source as JavaScript, also code that is not complete.
  - Error ranges get a wavy underline, and the messages are below the editor.
  - Completion shows while you type. After `transition.`, it lists the fields of the value and their types (from the types its caller gives). On a name prefix, it lists the names in scope, the builtins and the keywords. After `Math.`, it lists the math functions.
- Syntax:
  - The supported syntax: destructuring, `const`, `return`, conditional expressions, `if/else return`, object literals and spread (`{...s, x}`), array literals, `.map / .reduce` with inline arrows, `range(n)`, `u32 / imul32 / add32 / …`, `rand(key, counter)`, `Math.sqrt / log / exp`, `bucket / thermometer`, `table.at(i, 'col') / table.window(end, k, 'col')`, string literals.
  - Function parameters are plain names only.
  - Do not write types. Annotations, generics, `as / satisfies / !` and `type / interface` are errors. Types come from the caller, and the role tab header shows them.
  - The workbench refuses loops, assignment, imports, recursion and arbitrary dynamic calls. There is no `eval`.
- Templates and programs:
  - Templates write `config: { inputs: [...], source: |- … }`. The workbench derives `exports` from the source, so you do not write it.
  - When a module exports exactly one function (or one const), a wire can omit the source port (`reward→trainer.objective`).
  - Each exported function and each const compiles to one `neurom-program` program. The browser and Python interpret the same program.
  - Each program has ≤ 4096 nodes. `map / fold / scan` lengths are static, and the worst-case cost has a limit.
  - Rewards and metrics can use `ln / exp`.

The reward of the mining template is below. The exported `reward` connects to the trainer's `objective`. The value wire `weights.params→reward.weights` connects the input `weights` to a params module.

```ts
/**
 * Reward: settled-value gain times the value weight, minus the per-step and invalid-action costs; at episode end plus the success bonus or minus the failure cost.
 * @param transition this step's transition
 * @returns this step's reward
 */
export function reward(transition) {
  return weights.value * (transition.next.settledValue - transition.prev.settledValue)
    - weights.step
    - (transition.next.invalid ? weights.invalid : 0)
    + (transition.done ? (transition.success ? weights.success : -weights.failure) : 0);
}
```

## The scenario module

A scenario is an ordinary code module. There is no separate environment module. The `module` of the scenario goes into a loop's `scenario` (`scene.module → loop.scenario`). On each step, the loop calls the functions that the scenario exports, by role. The data flow is: state → `input` encodes input bits → loop body (network → readout → …) → action → `step` gives the new state. The protocol is in [design §3 The scenario module](../docs/design.en.md#the-scenario-module). It includes roles, `Transition`, `budget`, `actions`, scenario parameters and what the network sees. On the canvas:

- The loop's `scenario` port shows the scenario problems. These include missing roles, type errors and a missing `budget`.
- In the export list of the scenario module, a role function with no direct wire shows its runner and role. An example is "Via module: step of 回路". Hover the role function to see the argument types that the runner gives.

## Workflow

1. **Place a task**: in "Add", select a preset or a composite template.
   - A preset is a template instance. Only the four-bit arithmetic and the combiner come with accepted builtin artifacts. The mining and memory-map networks have no weights when placed, so train them first.
   - The mining task expands to 18 modules, all in the training module **挖矿** (mining):
     - Left column: seed partition, environment parameters, perception parameters, random, scenario, reward weights, reward, three metrics, trainer, candidates, evaluator, execution and map view.
     - Sub-canvas on the right: **回路** (the loop box: network → readout).
     - Seven handles on the left edge of the sub-canvas: 场景 · module, 场景 · actions, 训练器 · structure, 训练器 · loop, 评估器 · loop, 执行实例 · loop, 候选 · weights.
2. **Change rules**:
   1. Expand the composite.
   2. In environment parameters, in the environment section of the left column, edit grid, steps, settlement and whether a delivery ends the episode.
   3. In perception parameters, edit the square view radius.

   Ranges are in the parameter declarations. They can be expressions over other parameters (the base coordinates use `max: grid - 1`). An out-of-range value gets a flag and blocks bundling. The scenario module's `input` decides the network's input. The readout map controls the action slots. Environment and perception parameters never go into the network. Only encoded input bits go into the network.

   When you edit the scenario module, you edit the scenario. Environment changes include the scenario module, its inputs, `budget` and the episode kind of the driving partitions. After any environment change, old artifacts show "environment differs" in candidates.
3. **Train**:
   1. In the trainer, select the backend (browser Worker or Python Workspace), the method and the recipe.
   2. Click start.

   The trainer collects a **bundle** along its inputs (environment + loop + objective + partitions + recipe). Later canvas edits have no effect on the training that runs. The other networks of the loop must already have an artifact, and they run frozen. The same applies to the networks that tool layers call, for example the combiner's ADD4 / SUB4 / MUL4, each with its `artifact` selected.

   Progress, loss and metric curves update live. You can cancel a run. When training finishes, it only produces a candidate.
4. **Candidates**: candidates list the artifacts of every run (method, backend, metric, structure, compatibility). In candidates, you can preview, accept, export JSON and import a `neurom-module` artifact. When you accept an artifact, its weights go to the network.
5. **Evaluate**:
   1. In the evaluator, select a role (test partition by default).
   2. Run the evaluation.

   The report lists metric means, success rate, the artifact each network ran and samples. You can group enumerated partitions by an axis: the memory map's retention curve by delay, the combiner by operation.
6. **Execute**:
   1. In the execution, select an episode from its wired partition (seed / enumerated record).
   2. Use reset, step, run or manual actions.

   Every network runs on its accepted weights. The history shows the input bits of each step, the value of every body module, the action, the potentials and how the step ended. A network with tool layers also shows which tool it called on the step, the data bits it gave to the tool and the result. Only that tool ran. A view subscribes to the execution and renders the map or curves.
7. **Deploy**:
   1. In the deployment module, select a network.
   2. Connect.
   3. Deploy one artifact.
   4. Verify, read state, reset or step by transaction.

   The deployment module uses the **official Factory** of that network (ADR 0016). Its address is in `CHAINS` in `chain.js`, and you never type it in. The panel shows the address, with a link to the explorer when the network has one. The local mirror uses the same environment from the artifact's bundle and the integer executor for an item-by-item comparison.

   A module that any other Factory created fails verification and is never reused as a tool, also with identical code and weights. A network without an official Factory yet (testnet and mainnet for now) tells you this. You cannot deploy or verify on that network.

   Local dev uses the unlocked Anvil accounts at `http://127.0.0.1:18545`. If the node is a freshly started `anvil --network monad`, first run `contracts/script/Deploy.s.sol` from the default account 0. Then the Factory proxy is at `CHAINS[31337].factory`. Deploy / step / reset are transactions, and previews are eth_call.
8. **Save templates**:
   1. Select modules or a composite.
   2. Click "Save as template".

   In the library, you can instantiate, fork and export / import YAML. Each composite from a template shows `id@revision`. An instance does not follow template updates.

Loop-body rules:

- Each network's `in` has exactly one wire. The workbench refuses width mismatches, with no padding or truncation.
- Readouts select argmax or bits explicitly.
- Bit wires slice and concatenate the input bits of the loop or the output bits of a network, then give them to several networks.
- The tools that a tool layer calls are not part of the body. On each step, only the selected tool runs.

Combiner preset: `input` 11 bits → the tool layer of the policy network selects one of ADD4 / SUB4 / MUL4 and gives it 8 data bits → its result bits → bits readout → `action`.

## State boundaries

- Training runs, executions and evaluations each own their state. Two executions of the same loop share no episode, potentials or history. Several views can render one execution.
- An execution clears its temporal state only on explicit reset or when the episode changes. After canvas edits, the bundle it runs becomes stale. On reset, the execution builds the bundle again from the current canvas. Trainer edits, candidate preview and layout changes have no effect on it. Episodes, potentials and history are not saved with the workspace, so a reopen starts from the initial state.
- An evaluation report describes the bundle pinned when the evaluation ran. Canvas edits do not discard or recompute the report, also edits while the evaluation runs. Canvas edits only mark the report stale until the next evaluation. Reports are not saved with the workspace.
- A training run pins the bundle it started from and the rows of the tables it reads. Browser and Python training get the same rows (the Python side keeps them with the run). When you import a dataset again, the rows go to a new content id, and the rows of the old id do not change. Thus runs that pinned the old rows and copied dataset modules continue to work.
- The workbench reclaims table rows only when it loads a workspace (startup, file open). A reclaimed row must have no reference, and its write must be more than 10 minutes ago. The reason is that another tab can import rows and not save them yet.
- Browser training runs in a Web Worker. When you close the page, the training stops, and on reload it shows as failed. The Workspace owns Python runs and attaches them again after a reload.
- Candidate compatibility uses bundles. An artifact can be accepted only when these three items match the trainer that feeds the candidates module:
  - Environment (the bundle's `env`: scenario programs, budget, action table, episode kind, tables).
  - The structure of the trained network.
  - The readout spec.
- Manual steps do not call the model. LIF keeps its potentials across decisions in an episode. Cells outside the view and hidden targets never leak to the model through a view.

## Interface language

"中 / EN" at the top-right changes the interface language. The workbench stores the choice in `localStorage` (`neurom-locale`). On the first visit, it uses the browser language. The change is immediate. It does not reload the page and has no effect on training and execution.

- The Chinese text is the dictionary key. In English, `t('训练已取消')` looks up `i18n/en.json`. After the lookup, the `{name}` placeholders get their values. When an entry is missing, the Chinese text shows.
- User titles and template names show verbatim. Kind labels and the names, descriptions and preset labels of builtin templates go through `t()`.
- `i18n.test.js` in `npm test` runs `i18n/check.mjs`. It checks these rules:
  - Each Chinese literal, Vue template text, static `index.html` text and builtin template YAML `name` / `description` / `preset.label` needs an English entry.
  - The placeholders and HTML tags of an entry match the source text.
  - No entry is unused.

## File boundaries

| File | Responsibility |
|---|---|
| `graph_app.js` | Page orchestration: workspace persistence (localStorage, files, `neurom-workbench` only, the conflict panel for a local save that cannot be read), the per-(kind, module) sessions hub, palette and presets (the builtin templates that declare `preset`), template library drawer, Python connection, language |
| `ir/` | Program IR: `parse.js` (JS subset → IR), `check.js` (types, limits, cost), `compile.js` (closures), `docs.js` (value docs carried along the IR), `types.js`, `program.schema.json`. `index.js` is the public API |
| `core/types.js`, `registry.js`, `kinds/` | Port types and constraints. Kind registry and config schemas. One file per module kind (`kinds/scenario.js` is the scenario protocol, `kinds/loop.js` derives the loop body) |
| `core/graph.js`, `resolve.js` | Module graph (nodes, value / call wires, composites and loop-box marks). `admit` is the one way a graph description enters the graph. Load, undo, paste and template instantiation all use it. It does phase order, field-path wire retry, fresh-id mapping, reference pruning and rollback. Type inference, signature resolution and problems. `canConnect` |
| `core/bundle.js`, `runner.js`, `loop.js`, `readout.js` | Bundle (`neurom-bundle`) construction and hashing. Scenario runner. Loop executor and the one greedy episode runner. Readout |
| `core/template.js`, `store.js`, `canonical.js` | Template parse / instantiate / from-selection / YAML. Workspace and artifacts. Canonical JSON and SHA-256 |
| `core/sessions/` | Trainer, candidates, evaluator, execution, deployment, dataset. Pinned bundles of drivers (`pinned.js`): current versus pinned bundle, staleness, publication of asynchronous results, the table rows a bundle needs. The integer-executor wrapper (`executor.js`). Python client (`workspace-client.js`). The UI changes state only through sessions, and durable state is saved only through the workspace |
| `training/` | Browser trainers: `dense-core.js` (QAT / STE / BPTT), `reinforce.js`, `cross-entropy.js`, `hinge.js`, `train.js`, `run.js`, `worker.js`, `client.js` |
| `templates/*.yaml`, `templates/index.js` | Builtin training modules. Any YAML in the directory goes into the library |
| `templates/artifacts/` | Builtin artifacts of the four-bit arithmetic and the combiner policy, their generator and `artifacts.test.js` |
| `editor/index.ts`, `EditorRoot.vue`, `ModuleNode.vue`, `GroupNode.vue`, `TrainingModuleNode.vue`, `NodePorts.vue` | Vue Flow canvas and graph projection (measurement, drawing, gestures, history), host node, composite node (loop boxes included), training-module frame, port band |
| `editor/canvas-geometry.ts`, `training-module.js`, `sizes.ts` | Canvas geometry (pure, tested under node): which node draws each module, which slot a member port docks at, every unit's rect, arrange / untangle after a resize / drop membership. The training module's member split (sections / handles / outer slots) and section columns. The natural sizes assumed before measurement |
| `editor/modules/` | One body component per kind (`*Body.vue`, including `LoopBody.vue`), `ConfigForm.vue`, `registry.ts` |
| `editor/renderers/` | View renderers `grid / series / table / kv / script` (`script-frame.js` is the sandboxed iframe of view scripts) and state path resolution |
| `editor/CanvasEdge.vue`, `edge-presentation.ts`, `EdgeSettings.vue`, `EdgeMenu.vue`, `wiring.ts`, `wire-palette.js` | Drawing, appearance, reroute points, menu and colours of the two wire kinds |
| `editor/history.ts`, `layout.ts`, `workbench-context.ts` | Undo / redo and copy / paste. Viewport persistence. The injection that bodies use to get to the workbench |
| `ui/template-library.js`, `ui/static-text.js` | Template library drawer. Translation of static `index.html` text |
| `i18n.js`, `i18n/en.json`, `i18n/check.mjs` | Interface language, English dictionary, coverage check |
| `module-chain.js`, `chain.js` | ModuleFactory / module bridge (ADR 0014, ADR 0017). **Deployment plan** (read-only): how many weight chunks are necessary, how many are already on chain, which transactions to send. **Deploy**: on the latest engine version, unless the caller names one. Tools deploy first. When the Factory has a verified module of the same artifact, deploy reuses it. Each module goes with its missing weight chunks in one transaction. When that exceeds 30M, the missing chunks go first, one transaction each. Progress is reported when each transaction is sent and mined. Deploy first looks up everything on chain, so a new deploy after an interruption sends only what is missing. **Verify**: the official Factory must be given. The module must name it as its factory, and its `isModule` must say so. Verify also checks the descriptor, the engine, the shape and the chunk addresses. The engine must be a version that the Factory lists for its engine id. Verify reports its version number and whether it is the latest, and the deployment panel shows this. Also step and receipt checks. Only `neurom-module` artifacts. **Chain list**: the official Factory of each network, null where it is not deployed. Also wallet connection. **Tests**: with Foundry installed, `module-chain.test.js` runs five items on a local anvil: the four-bit arithmetic / combiner builtin artifacts, its own LIF artifact on the counter loop, a network across two weight chunks (and one that shares only the first), a three-chunk network resumed after its second transaction fails, and a network wider than 256 (1020 → 300 → 300). It checks that the Factory proxy is `CHAINS[31337].factory`. That proxy comes from `contracts/script/Deploy.s.sol` broadcast from account 0 on a fresh node (and from `anvil.fixture.js`, which deploys in its order). It also checks that modules of a second Factory with the same code and weights fail verification and are not reused as tools. `core/sessions/deployment.test.js` drives the deployment session through `module-chain.js` with the counter-loop LIF model from `core/sessions/fixtures.js` (`anvil.fixture.js`, skipped otherwise) |
| `runtime/dense-policy.js`, `runtime/threshold-layers.js` | Integer engines: dense FF / LIF (format `dense-policy`) and threshold layers (`threshold-layers`). They do not depend on the UI |
| `abi/` | ABIs generated from Solidity (ModuleFactory, NeuromModule, Roles) |

## Build and verify

From the repository root, run:

```sh
npm ci                         # Node.js >= 22.12
npm test
npm run typecheck
npm run abi                    # after contract changes; needs Foundry >= 1.8
npm run build
```

The build goes to `frontend/dist/neurom-studio.html` (not committed). The single file inlines code, styles, builtin templates and artifacts, ABIs and the training Worker, so it can train from `file://`. ethers is bundled too, so chain operations load nothing from a CDN. Python training needs the same-origin Workspace service.
