# Composable neural modules

The system composes modules with different computation styles into a network. Everything on the canvas is a module. A task is data made of modules and wires, not code. Module kind, learning method, training location and runtime memory are different concepts.

## Language

### Network and chain

**Module (模块 / large neuron)**: a composable computation unit with explicit inputs, outputs and computational behaviour. A module can contain several computation units and several pieces of memory.
_Avoid_: calling every internal potential a separate module.

**Memory Entry (内部记忆单元)**: one piece of runtime state that a module keeps, for example a membrane potential. A memory entry is not a separate module instance.

**Feedforward Module (FF 模块)**: a module without memory across calls. The current input and the fixed model parameters set its output. FF does not specify a training method.

**LIF Module (LIF 模块)**: a module that computes through leak, integration and firing. It can keep its runtime state across consecutive calls. An explicit execution convention decides whether and when the state resets.

**Execution Engine (执行引擎 / VM)**: the execution semantics that define how a kind of model computes. These semantics include numeric rules, time steps and state transitions.
_Avoid_: conflating the VM with the trainer.

**Module Instance (模块实例)**: a runnable module created from one specific model artifact. Two instances with the same weights do not have to share memory.

**Session (会话)**: one execution history whose state the system must keep continuously. An explicit definition must state whether separate episodes or separate users share state.

### Modules on the canvas

**Module Kind (模块种类)**: a class of module that the code implements once. The kind defines the port roles and the configuration. Every module on the canvas belongs to a kind. When a role accepts several suppliers, the declarations of the module set how many ports of that role it has, not the kind. Templates can only choose and configure kinds. Templates cannot define new kinds.
_Avoid_: node type, tool, functional block.

**Port (端口)**: a typed input or output that a module declares. Inputs are on the left edge of the module. Outputs are on the right edge.
_Avoid_: docking point, input / output circle.

**Declaration (声明)**: the part of the configuration or source of a module that the user edits and that decides which ports the module has. For a code module, the declarations are its `inputs` and the exports of its file. For a Params module, they are its fields and function inputs. For a network, they are its tool layers.
_Avoid_: schema, signature (a signature is what a call port checks).

**Value Wire (值线)**: a wire that gives an output value to an input. The consumer reads the value when it evaluates. One output can feed many inputs. The wires of a loop body are value wires.
_Avoid_: binding, edge, pass-through.

**Loop Input (回路输入)**: a value input declared `loop`. Its value takes effect on the next step. For weights, the value comes from an earlier training run. Thus a chain of value wires can close a cycle into a loop input. Only two loop inputs exist: the `action` of a loop and the `weights` of a network. The system refuses every other value-wire cycle.
_Avoid_: feedback wire, back edge (the wire is an ordinary value wire).

**Call Wire (调用线)**: a wire that gives a function to a consumer. The consumer can call the function any number of times. The system checks the signature when you connect the wire.
_Avoid_: fixed reference, internal reference.

**Bit Wire (位线 / bits)**: a module that slices and concatenates bit vectors into one bit vector. For example, a bit wire can slice part of the input bits of a loop. It can also join that part with the output bits of a frozen network. In both cases, the result goes to another network.
_Avoid_: treating it as a wire itself.

**Code Module (代码模块)**: a module that holds one restricted-JavaScript file of top-level consts and functions. The file has no type syntax. The exports of the file are the output ports of the module. Each `export function` is a call output that goes to a call port. The port that the output is wired to decides its role: reward, supervised target, metric or a Params function input. Each `export const` is a value output that the system computes once.

The output `module` gives the whole file to a kind that calls several of its functions by role. A loop does this with a scenario. Unexported functions are helpers, and the compiler inlines them where they are called. The title is only a label. The function names are in the source.
_Avoid_: code block, program block, script, one-function modules, the title as a function name.

**Code Input (代码输入)**: one name in the `inputs` of a code module. Each code input is a required value input port. It is also a file-level name that all of the file can read. The compiler binds its value as a static value into each function and const that reads the name.
_Avoid_: bare "参数" (that is the Params module), function parameter (a caller fills those through a call wire).

**Doc Comment (注释)**: the JSDoc-style text above an exported function. It contains a summary, one `@param name` or `@param name.field` for each parameter, and `@returns`. Its texts go with the ports. The system ignores `{Type}`s in tags, because types come from call sites and wires. The `/** … */` above a record key inside a literal documents that field. The State doc is the doc of `init`.
_Avoid_: annotation (type annotations are rejected in the source, and types come from the caller), docstring.

**Role (角色)**: an export that a module calls by protocol. The export goes through a call wire into a call port, or as a scenario role through `module` into the `scenario` of a loop. The consumer kind declares the contract of the role. The contract gives the parameter count and types, when the module calls the role, what the result means and a stub body (ADR 0012). The parameter names belong to the implementation, and the contract only gives defaults for stubs.
_Avoid_: slot, hook, interface.

**Role Tab (角色页)**: the tab of a code module for one role (CodeTabs). The editor shows only that role. When the role has the parameter count of the protocol, the header is locked, but you can change the parameter names. Grey types follow the parameters and the result. A `?` opens the help window of the role.

The help window shows who calls the role and when, each parameter and its fields, and what to return. It also shows an example run on the first episode of the driver of the loop, with action 0. 全文 is the tab with the whole file.
_Avoid_: card, tooltip, hint.

**Program (程序)**: the typed, acyclic, bounded computation that one exported function or top-level const of a code module compiles to. The browser and Python interpret it with the same rules.
_Avoid_: treating code and program as two independent execution sources.

**Params (参数)**: a module that declares a set of typed fields with ranges and defaults and supplies their values. It can also have any number of declared function inputs. These function inputs compute derived values, for example a lookup table derived from the fields. Other modules read its fields.

**Constraint Expression (约束表达式)**: the range or choice list of a field, written as an expression over the current values of the other fields. For example: `max: grid - 1`. If a value is outside it, you cannot use the Params module for training until you fix the value.
_Avoid_: dynamic range, options range (function inputs do not constrain fields).

**Function Input (函数输入)**: a call port that a module has because its declarations list it. An example is the `options` of a Params module. Each function input has the signature that its role sets. The module calls the function that is wired to it.
_Avoid_: code input (that is a value input of a code module), options slot.

### Loops and scenarios

**Loop (回路)**: the module that is the per-step boundary of an episode runner. Its `scenario` call input takes the scenario module. Its `input` output carries the bits that the `input` of the scenario returns. Its `action` loop input takes the action of the step back. Drivers run the loop through its `loop` handle.

The loop has no partition of its own. Its Start is the episode kind of each partition that its drivers run it on. If the drivers do not agree, that is a problem on the loop (ADR 0009).
_Avoid_: runner node, environment (the loop runs an environment, but it is not one).

**Loop Body (回路体)**: every module on a value path from the `input` of a loop to its `action`. The system derives the body from the wires. Only networks, readouts and bit wires can be in the body, and they run once per step. Static values wired into the body from outside are not part of it. Examples are the `weights` of a network and the `actions` of a readout. The tools that the tool layers of a network call are also not part of it.
_Avoid_: the loop box's members (the box is a view of the body).

**Loop Box (回路框)**: a composite marked as the view of a loop (`groups.<id>.loop: <loop module>`). The loop node has no card. The frame draws the run of the loop around the body (ADR 0011 §4). When the box is collapsed, it shows a summary of the body in one line.

`Start ← loop` is on top, with the `loop` handle on the left border. `scenario` is on the left border below it. `init → State → input` goes down the left column, with the `input` handle. `action` is on the right, with its handle. `step` and the end condition are below.

The members of the box must be equal to the loop module plus the body. A mismatch is a problem of the loop, not a second definition.
_Avoid_: treating the box as the source of truth for the body.

**Training Module (训练模块)**: a prefab drawn expanded as one frame (ADR 0011). The left column shows the slots of the prefab on top, then the **sections**. The sections show their items natively, not as cards. The items are the trainers and their partitions, the datasets, the environment, the objective, the metrics and the candidates. Other items are the evaluator, the execution and the views that they feed. The environment is the code module wired into the `scenario` of the loop, with the params and random that feed only it.

On the right, a recessed sub-canvas holds only per-step computation: the loop box (its run drawn around the body: ADR 0011 §4). Wires between a section and the sub-canvas end at handles on the left edge of the sub-canvas. Each builtin task template declares slots and instantiates as a training module. The number of trainers in a prefab does not decide whether it is a training module.
_Avoid_: environment / learning sub-composites.

**Whole-loop Training (整回路训练)**: training one network inside a loop while every other network of the loop runs frozen on its accepted weights. On each step, the executor first evaluates the values that the input of the trained network depends on. Then the trainer supplies the readout result of that network: a sampled slot, the slot of the teacher or the target bits. Then the executor completes the step up to the action of the loop. Only the trained network gets gradients.
_Avoid_: training a network in isolation from the loop it runs in.

**Environment (环境)**: in the RL sense, the thing that a loop acts in. It contains the programs of the scenario module, plus its step budget, actions, types and the episode kind of the drivers. A bundle pins these items together as its `env` section, and `envHash` names them. It is not a module.
_Avoid_: environment node, environment module, environment handle.

**Runner (运行器)**: the episode protocol that all code that runs a scenario shares. `reset(start)` sets `state = init ? init(start) : start`. `input()` returns the input bits for the current state. `step(action)` calls the `step` of the scenario, ends the episode on `done` or truncates it on the budget, and returns the Transition. The protocol has one implementation in JS (`runner.js`) and one in Python (`bundle_env.py`). The loop executor calls it once per step.

**Lockstep Run (锁步运行)**: running a batch of Start records through a loop together, with one lane per episode. On each step, the runner of each live lane gives its input bits. The loop executor evaluates each lane up to the trained network. Then the trainer decides, in one batch, all lanes that need a decision, and each lane completes its step. A lane whose episode ended takes no more steps.

The target objective reads the state before the step. The reward reads the Transition of the step. Training, validation and evaluation all run episodes this way, in JS and in Python. Validation and evaluation run greedily.
_Avoid_: batch (a lane is one episode, not a training sample).

**Scenario Module (场景模块)**: the code module whose `module` output is wired into the `scenario` port of a loop (`scene.module → loop.scenario`). It exports the roles that the runner calls. `init(start)` is optional. `input(state[, table]) → bits[1..256]` and `step(state, action[, table]) → { state, done, success }` are required. It also exports the required `export const budget = …` and, as an option, `export const actions = [...]`. The `actions` export is wired separately to the readout.

A one-question task writes a `step` that returns `done: true`. The scenario parameters are its inputs (`params.params → scene.params`, `rng.rng → scene.rng`). Heavy derived tables are top-level consts that the system computes once per bundle. The `scenario` port of the loop shows the scenario as incomplete when a role is missing. It does the same when an exported function is not a role and is not wired anywhere.
_Avoid_: scenario source held by a runner node, one call wire per role, a class with mutable members (state is always an explicit State record).

**Random (随机数)**: the module that supplies the random numbers of a scenario. It supplies the jump-ahead tables `rng: { mul, add }` of a linear congruential generator with 32 bits. The module computes the tables once from its configuration, and they go into an input of the scenario module. From seed s, the (k+1)-th draw is `add32(imul32(rng.mul[k], u32(s)), rng.add[k])`.
_Avoid_: a code module computing the generator's tables, random constants.

**Start (回合起点)**: the record that one episode starts from. The partitions that the drivers of the loop run it on set its type: `{ seed }`, an enumerated combination `{ index, <axis>: value… }`, or a window `{ start, length }`. `init` receives the Start. Without `init`, the Start is the initial State.
_Avoid_: Episode (that is the summary metrics read).

**Episode (回合)**: one run of a scenario from its Start to termination or truncation. Metrics receive its summary `Episode = { initial, final, steps, success, return }`. `success` comes from the last transition. `return` is the sum of the rewards.

**Termination (任务终止)**: the end of an episode that the scenario decides. Its `step` returns `done: true`, for example when the agent reaches the goal, stops, or answers a one-question task.

**Truncation (回合截断)**: the end of an episode that the step budget causes (`truncated` in the Transition). It is a different event from termination and from the stop of a whole training run.

**State (状态)**: the state record of the scenario at one moment. It is what `init` returns (the Start record when there is no `init`) and what `step` returns as `state`. `input` encodes it into the input bits. Supervised targets read it directly.

**Transition (转移)**: the record that the runner builds from one step: `{ prev: State, action, next: State, done, truncated, success }`. A reward reads it.

In a loop with tool layers, the loop executor adds a `loop` field for each network with tool layers: `loop: { <network title>: { <tool port>: { choice, data, result } } }`. The field records the index of the chosen tool, the `bits[D]` given to it and the `bits[R]` that it returned. The records are the same during training (the sampled decisions of the trained network), evaluation and execution. Network titles in such a loop must be unique. A duplicate is a problem on the loop. Loops without tool layers have no `loop` field.

**Input Bits (输入位)**: the 0/1 bits that the `input` of the scenario returns for the current state. The loop gives them to its body through `loop.input`. The network sees nothing else. So the scenario hides information from the network when it does not encode that information.
_Avoid_: observation.

**Environment Parameters (环境参数)**: parameters that control the initialisation, advancement and termination of a scenario. They are inputs of the scenario module, never of the network.

**Perception Parameters (感知参数)**: parameters of what the `input` of the scenario shows, for example visibility range. They are inputs of the scenario module, never of the network.

**Readout (读出)**: the module that changes network output scores into an action. It does this in one of two ways: it takes the maximum and finds it in a map, or it decodes the scores as bits.

**Invalid Action (无效动作)**: an action slot with the mark `null` in the readout map (it decodes to −1). It uses a step and does not change the state.

**Network (网络)**: the module that changes input bits into integer scores. Its input width is its declared `inputs`. This width must be equal to the width wired into `in`. Its output width comes from the unique readout that consumes `scores`.

Its weights come from one of two sources, never both. The first source is the artifact that its own `artifact` names, for a network that no trainer trains (for example, a tool). The second source is the accepted artifact of the candidates module wired into its `weights` loop input (the earlier runs of the trained network). A network that a trainer trains has no `artifact`. The trained network of the artifact must have the structure and readout of the network.

**Tool Layer (工具层)**: an entry `{ tools: <port>, data? }` in the `layers` of a dense network. It declares a call input that takes any number of tools. `data` sets how many data bits the layer gives to the tools. The default is the input width of the widest network tool. The decision head of the tool layer is on the layer before it. The decision head picks one tool and the data bits that the tool receives.

Only that tool runs. The next layer sees the result of the tool, zero-extended, followed by the layer before. If the tool layer is the last layer, this is the output of the network. A network with a tool layer trains by REINFORCE (ADR 0010).
_Avoid_: mux, router (nothing is routed by a learned bit code), sub-network.

**Tool (工具)**: a function `(bits) → bits` wired into a tool layer. A tool is the export of a code module, or a frozen network of any kind through the `run` of its bits-mode readout. A code tool keeps no state. The state of a network tool belongs to the session of the network that calls it. This state includes the potentials of a LIF tool and the states of its own tools. The state advances only on the steps that choose the tool, and it resets with that session.
_Avoid_: expert.

**Dataset (数据集)**: one table of data that a content hash pins after import.

**Partition (分区)**: the module that divides episodes into the training / validation / test roles. It divides them by seed range, by enumerated combination or by time window. For an enumerated combination, a role takes all, even, odd, a list of indices or `{ mod, rem }`. The kind of the partition sets the type of the Start of the loop that its drivers run. The dataset wired into its `table` is the table that the scenario reads.
_Avoid_: data source.

### Training and results

**Objective (学习目标)**: the function that a trainer calls. It is a reward `fn(Transition) → number` or a supervised target `fn(State[, Table]) → bits[O]`. The trainer calls a supervised target on the state before each step. A supervised target returns a bit mask (cross-entropy) or exact bits (hinge). The training method decides which objective it needs.
_Avoid_: treating reward as mandatory for every kind of training.

**Reward (奖励)**: one kind of objective: a numeric feedback for one Transition.

**Training Method (训练方法)**: one way to use an objective to update a network: REINFORCE, cross-entropy or hinge. Each method needs a specific network engine and readout mode.
_Avoid_: training recipe.

**Training Backend (训练后端)**: the computing environment (browser or Python) that runs training. A change of the training location must not change the execution semantics of the exported model.

**Trainer (训练器)**: the driver that trains the network wired into its `structure` on the loop wired into its `loop` (whole-loop training). It uses the episodes of its `training` partition and calls its objective. It selects by its optional metric on `validation` and produces training runs.

**Training Run (训练运行)**: one training on one bundle, together with its record and candidates.

**Bundle (训练快照)**: the immutable `neurom-bundle` copy of all that a trainer, evaluator or execution collected along its inputs. `env` holds the programs of the scenario with their bound values, budget, actions, types, episode kind and tables. `loop` holds the nodes of the body, with the accepted model of each frozen network. The model of the trained network stays open. The last part belongs to the driver: objective, selection, metrics, partitions and recipe.

Runs, reports, executions and artifacts pin the bundle. A running driver also pins the rows of the tables that it names. Later canvas edits do not affect these pinned items. A result whose pinned bundle is different from the bundle that the canvas describes now is **stale (过期)**.
_Avoid_: draft, task version.

**Candidate (候选)**: a model artifact that a training run produced and that is not accepted yet. It is compatible with a loop when three items agree with the current trainer of the loop. These items are the `env` of its bundle, the structure of the trained network and its readout.

**Model Artifact (模型产物)**: the frozen bundle, the model parameters of the trained network, provenance and evaluation, identified by content hash. You can evaluate it, share it or use it to create several instances. It is not runtime memory.

**Accept (接受)**: choosing one artifact in a candidates module as the current weights. Accepting does not deploy and does not send transactions.

**Evaluator (评估器)**: the driver that runs the whole loop greedily over one partition, with each network on its accepted weights. It computes metrics and produces a report.

**Report (报告)**: the output of an evaluator. It contains metrics, the partition fingerprint, the artifact that each network ran and the results. The results can be grouped by an enumerated axis. A report describes the bundle that the evaluation pinned, so a report can be stale.

**Execution (执行实例)**: the driver that steps episodes of the whole loop with each network on its accepted weights. It owns its own clock, potentials and history. The history includes the per-step values of each body module and which modules ran.

**View (视图)**: the module that shows an execution or a report. It owns no execution state.

**View Script (视图脚本)**: JavaScript that a view carries instead of a built-in renderer. It is a Vue component that takes `ctx`, or a `render(ctx, el)` function. It runs in a sandboxed frame, isolated from the workbench and the network. It receives the values wired to the view, plus the values of its training module by title. It draws them in any way. It only draws: nothing that it computes goes to a bundle, a trainer or the graph.
_Avoid_: code module (that is the restricted, IR-compiled file), calling the whole script a component or widget.

**Deployment (链上部署)**: the module that deploys one artifact as a module contract and verifies it. One deployment creates one independent instance.

**Engine Version (引擎版本)**: one immutable on-chain contract that computes one execution engine. An engine id has one or more versions, and the official factory names the latest version. A module contract runs on the version that it was deployed with, for its full life. The engine version holds no weights and no state of its own.
_Avoid_: engine contract (one engine id has several), upgrading an engine, VM (that is the execution engine's semantics, not a contract), calling it the factory.

**Module Contract (模块合约)**: the on-chain instance that one deployment creates for one artifact. It holds its identity (which includes its engine version), its weight chunks and the state of its sessions. It computes when it gives these to its engine version. The engine version cannot write anything.
_Avoid_: model contract, calling the engine version "the module".

**Weight Chunk (权重块)**: a contract whose code is only part of the weights of an artifact. Anyone can read it, and nobody changes it. The weights of an artifact go across one or more chunks.
_Avoid_: weight storage (weights are never in storage), data contract.

**Official Factory (官方 Factory)**: the one module factory that the workbench deploys to and trusts on a chain. A module is genuine only when the official factory created it. The workbench refuses modules from all other factories, also when their code and weights are identical.
_Avoid_: checking a module's code hash to tell genuine from fake, a user-entered factory address.

**Protocol Role (协议角色)**: a power over the protocol contracts that an account holds. ADMIN grants roles, adds engine versions and names the latest version. UPGRADER upgrades the official factory. The owner of a module does not get a protocol role because it is the owner.
_Avoid_: owner (a module's owner is only its payee), registrar.

**Mining Game (挖矿游戏)**: the application contract that is the only caller of mining modules. It plays the mining scenario on chain, bit for bit the same as the template (ADR 0018).
_Avoid_: environment, loop (those are the workbench's).

**Record (纪录)**: the best score that any module reached in the mining game. The first module that reaches the score holds the record. Another module takes the record only when it beats the record by δ.
_Avoid_: high score, leaderboard entry.

**Canary (暗桩)**: inputs that the scenario never produces, with answers that the author chose and committed to before deployment. The author uses a canary as evidence that a module copies the weights of the author.
_Avoid_: watermark (a watermark in general may sit on reachable inputs), fingerprint (that is behaviour).

### Templates and composites

**Template (模板)**: a data file that records a set of modules, their configuration, wires and exposed ports. A template has three levels: single module, composite and canvas.
_Avoid_: task version, scenario template, experiment template.

**Composite (组合)**: a unit on the canvas that wraps a set of modules or other composites. When a composite is collapsed, it shows only its exposed ports. When it is expanded, you edit its members in place. Composites can nest. The executable graph is always flat. A composite can have the mark of a loop box.
_Avoid_: subgraph, group, display group.

**Instantiate (实例化)**: copying a template onto the canvas as a composite. The instance records only its origin. It does not follow template updates.

**Exposed Port (暴露端口)**: a member port that stays visible and wirable while the composite is collapsed.
_Avoid_: boundary port.

**Pack / Unpack (打包 / 解包)**: wrapping the selected modules into a composite (pack), or dissolving a composite and moving its members back to the enclosing level (unpack). These operations are not related to collapse and expand.
_Avoid_: group / ungroup, expand (when unpack is meant).

**Prefab (预制模块)**: a composite instantiated as a whole from a template that declares **slots (槽位)**. Its group carries the record `prefab`, which contains the slots and the **expected wires**. A slot is a declared port of a member that the task fills (场景 on `loop.scenario`, 目标 on `trainer.objective` …). The task fills it with the stub modules that its 「+」 adds. The system reads from the wires what fills the slot.

An expected wire is a template wire outside the slots. The workbench lists a missing expected wire with 「恢复」. The record is presentation only, and runs read only the wires.
_Avoid_: packed group (a prefab is never made by packing), confusing a prefab slot with a readout map slot or a frame's outer port slot.

**Template Library (模板库)**: the place where the workbench lists, instantiates, forks, imports and exports builtin and user templates.
_Avoid_: task library, version library.

### Canvas

**Node (节点)**: an object on the canvas with a header, a port band and content. Modules and composites are both nodes.
_Avoid_: panel component, card.

**Frame (外框)**: the boundary of a node. Its width and height are the only size of the node. The content fills the frame. When the content does not fit, it scrolls inside the frame and never goes across the border.
_Avoid_: content's own size, text-box resize grip.

**Field (字段)**: one member of an output with a record type. You can wire it on its own. Its name is its full path from the port, for example `params.steps`.
_Avoid_: sub-port, property port.

**Arrange (整理)**: the layout that places modules column by column, from upstream to downstream along their wires. When there are many columns, it wraps them into rows. `loop` and `structure` handles count as wires from the driver to the loop. Thus drivers stand before the loop box, and a scenario outside a training module is directly below its loop. Inside a training module, Arrange changes only the sub-canvas, and the sections keep their column split. Arrange changes positions only, never connections or computation.
_Avoid_: auto-layout algorithm, typesetting.

**Reroute Point (中转点)**: a point on a wire that makes its path tidy. It changes only the drawing, never the connection or the computation.
_Avoid_: pass-through output, Reroute node.
