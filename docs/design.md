# 模块系统设计

**中文** · [English](design.en.md)

本文说明工作台的构成：模块种类、线、回路、模板、快照、IR、训练器和链上桥接。术语见 [CONTEXT.md](../CONTEXT.md)。主要决定的理由见 [docs/adr](adr/)。

## 1. 概览

画布上的一切都是模块。任何一组模块都能存成模板。一个任务就是一个**训练模块**，例如挖矿、记忆地图、四位算术和组合器。训练模块是一个组合模板，展开后画成一个框。框的内容如下：

- 左栏：训练器和它的附属模块，按段落排列。附属模块是分区、目标、指标、候选、评估器、执行实例和视图。
- 左栏的附属模块也包括环境。环境是接到回路 `scenario` 的场景模块，以及只给它输入的参数和随机数。这个框里的训练器、评估器和执行实例共用环境。
- 右边：一块下凹的子画布，只放每一步的计算。子画布里是**回路**和工具层调用的冻结网络（ADR 0009、0011、0010）。回路就是回路框，里面是网络、读出和位线。

场景模块是一个代码模块。它写三个角色：`init`（可选）、`input` 和 `step`。它还写 `budget`（每回合最多几步）和可选的 `actions`。整个文件接到回路的 `scenario`。每一步，回路把 `input` 返回的输入位从 `loop.input` 送进回路体。回路体算出的动作回到 `loop.action`，然后回路把动作交给场景的 `step`。

训练器、评估器和执行实例都不直接接场景。它们经 `loop` 句柄驱动回路，并各自带来分区。分区决定回合从哪里开始。奖励、监督目标和指标是另外的代码模块。其他模块给代码模块输入，代码模块返回输出。如果输出不符合接收端的要求，就报错。

训练器训练回路里的一个网络。其余网络用各自已接受的权重冻结运行。这叫整回路训练。网络还能把别的模块当工具。网络 `layers` 里的**工具层**每一步从接进来的工具里选一个。它还决定交给这个工具的数据位，然后只运行这一个工具（ADR 0010）。

工具是代码函数，或者是冻结网络经位读出的 `run`。冻结网络可以是任何一种：FF、LIF，或自己也带工具层的网络（ADR 0010 §3）。网络工具的状态属于调用它的会话。这个状态包括 LIF 工具的电位和它自己的工具的状态。它放在调用者自己的状态之后，先按工具层排，再按连线顺序排，逐层嵌套。工具的状态只在工具层选中它的那一步前进，并随会话重置。

工具最多嵌套 3 层（`MAX_TOOL_DEPTH`），所以一步的 gas 有上界。嵌套超过 3 层时，画布上报网络的问题，链上 Factory 拒绝。组合器的策略网络就是一个工具层，它从冻结的 ADD4 / SUB4 / MUL4 中选一个运行。

如果现有的模块种类够用，加一个新任务就是加一份模板。这不改任何 JS / Python / Vue 代码。数据集与时间窗分区供按表格驱动的任务使用。

## 2. 三个概念

三个概念如下：

- **模块种类**：用代码实现，每种只写一次。模块种类声明自己的端口、端口类型和配置项（`frontend/core/kinds/`）。第 3 节列出全部种类。
- **模板**：一个数据文件。它包含一组模块、它们的配置和连线，以及对外暴露的端口。模板有三级：
  - 单模块模板：一个模块加配置。
  - 组合模板：多个模块加连线，例如六个内置训练模块（挖矿、记忆地图、三个四位算术、组合器）。
  - 画布模板：整张画布。
- **线**：分为值线和调用线两种，见第 4 节。

模板只能选用和配置模块种类，不能重新定义它们。网络引擎要和 Solidity 逐位一致。训练器需要梯度、QAT 和 BPTT。所以这两类只能写成代码。

## 3. 模块清单

端口类型 = IR 类型 + 句柄。IR 类型有 `number`、`boolean`、`string`、`vector[n]`、`array[n] of T`、`record{…}` 和 `table`。其中 `bits[n]` 是值限定为 0/1 的 `vector[n]`。句柄是不透明标签：`module`、`partition`、`structure`、`weights`、`run`、`artifact`、`report`、`execution`、`deployment`、`text`、`loop`。调用端口带签名 `fn(A…) → B`。

record 类型的输出是一个整体对象端口。它的字段按路径寻址，例如 `params.steps` 和 `scene.cfg.bonus`，深度不限。值线可以直接从字段拉出，线的类型就是该字段的类型。画布上字段默认折叠，点 `+` 以树状展开。折叠时，只有连了线的字段以完整路径显示。

### 定义类

| 模块 | 输入 | 输出 | 作用 |
|---|---|---|---|
| **文字** `text` | — | `text` | 说明、注释 |
| **参数** `params` | 每个声明的函数输入一个调用端口 `fn(params) → record`。默认只有 `options`，可在声明里增删 | `params: record`（整体对象，字段可按路径连出） | 声明带类型、范围和默认值的字段，以及函数输入，并自动生成表单。范围和选项可以写成引用其他字段的约束表达式，例如 `max: grid - 1`。值越界时，参数模块报问题，并阻止打包（ADR 0007）。函数输入只计算派生值，例如由字段推出的查找表。结果按键合并。如果两个函数返回同一个键，就报错（ADR 0006） |
| **代码** `code` | `inputs` 里每个名字一个必需的值输入 | 每个 `export function` 一个调用输出，每个 `export const` 一个值输出。另有 `module`（整个文件，句柄 `module`） | 一个受限 JavaScript 文件（只有顶层 const 和 function），编译成 IR。文件里不写类型，类型由调用方决定（ADR 0012）。导出即端口。导出函数的角色由它接到哪里决定（见下面的“代码模块”，ADR 0005） |

### 数据类

| 模块 | 输入 | 输出 | 作用 |
|---|---|---|---|
| **数据集** `dataset` | — | `table` | 导入 CSV / JSON。校验列名、矩形形状和有限数，并记录内容哈希。数据按内容 id（`ds-` + 哈希）存进 IndexedDB。一个 id 的行写下后不变，重新导入得到新 id。载入工作区（启动、打开文件）时，工作台回收一部分行。回收的行满足两个条件。第一，没有模块、运行、产物或数据集记录引用它们。第二，它们写入已超过 10 分钟。这个时限的原因：别的标签页可能刚导入这些行，还没保存 |
| **分区** `partition` | `table`（时间窗必需，其他可选） | `training / validation / test: partition` | 三种切法：种子区间 `{ seed, count }`、枚举组合和时间窗（长度 / 步长 / 隔离带）。枚举组合是按轴取值的笛卡尔积。每个角色取 `all`、`even`、`odd`、下标列表，或 `{ mod: N, rem: [r…] }`。`{ mod: N, rem: [r…] }` 保留枚举下标除以 N 的余数在 `rem` 里的回合，N 为 1..1000。分区的回合种类决定回路的 `Start`。接到 `table` 的数据集就是场景读的数据表 |

### 回路、网络与读出

| 模块 | 输入 | 输出 | 作用 |
|---|---|---|---|
| **回路** `loop` | 调用 `scenario`（场景模块的 `module`，必需）。值 `action: number`（必需，声明 `loop`：下一步生效） | `input: bits[I]`（本步输入位）、`loop`（句柄，驱动它的模块接这里） | 回合运行器每一步的边界（ADR 0009）。回路体是从 `input` 到 `action` 的值路径上的全部模块，由连线推出。回路体只能有网络、读出和位线。回路体外的静态值可以接进来，例如网络的 `weights` 和读出的 `actions`。`Start` 是驱动它的各分区的回合种类。如果这些种类不一致，就在 `loop` 端口上报问题。如果 `action` 不在从 `input` 出发的路径上，就报“回路未闭合” |
| **网络** `network` | 值 `in: bits[I]`、`weights`（声明 `loop`）。每个工具层一个调用端口，以层的 `tools` 命名，可接多个 `(bits) → bits` 工具 | `scores: vector[O]`、`structure` | 整数网络。引擎是 `dense-policy`（FF / LIF）或 `threshold-layers`（阈值层列表）。`dense-policy` 的层列表 `layers` 有普通层 `{ hidden }` 与工具层 `{ tools, data? }`（ADR 0010），输出层隐含。I 是手写的配置 `inputs`（1..256），接到 `in` 的位宽必须等于 I。O 取自消费 `scores` 的读出，这样的读出必须恰好一个。`weights` 声明 `loop`，所以 `net.structure → 训练器 → 候选 → net.weights` 是正常的环。配置 `weightBits` 是权重宽度：8（默认）或 16（ADR 0015）。训练器选每层的 scale，配置里没有 scale。配置 `artifact`（可选，内容哈希）：没有训练器训练的网络用它自己选定运行的产物（ADR 0010 §8）。如果网络有 `artifact`，同时又有 `weights` 连线或训练器，就报问题 |
| **读出** `readout` | 值 `scores: vector[O]`、`actions`（可选） | `action: number`、`bits: bits[O]`。`bits` 模式另有调用输出 `run`：先做它的网络前向，再按位读出，可作工具 | `argmax` 模式带映射表，`null` 表示显式的无效动作 −1。`bits` 模式带宽度和 `lsb-int` 解码 |
| **位线** `bits` | 每个 `parts` 端口一个 `bits[n]` 输入 | `bits`（拼接） | 切片与拼接位向量（`parts: [{port, offset, width}]`），总宽 ≤ 256 |
| **随机数** `random` | — | `rng: { mul: number[draws], add: number[draws] }` | 32 位线性同余生成器的跳跃表。生成器是 s' = (乘数 · s + 增量) mod 2^32。配置是 `multiplier / increment / draws`，默认 1664525 / 1013904223 / 512。从种子 s 出发的第 k+1 个输出是 `add32(imul32(rng.mul[k], u32(s)), rng.add[k])`。跳跃表按配置算一次。它作为静态值接到场景模块的一个输入（`rng.rng → scene.rng`，场景模块的 `inputs` 里有 `rng`） |

网络只看到回路的输入位，也就是场景 `input` 返回的东西。场景参数（场景模块的输入）不进入网络。

### 驱动与结果

| 模块 | 输入 | 输出 | 作用 |
|---|---|---|---|
| **训练器** `trainer` | 值：`loop`（回路句柄，必需）、`structure`（要训练的网络，必需，必须在回路体里）、`training`（必需）/ `validation: partition`。调用：`objective`（必需）、`metric`（可选的选模指标） | `run` | 在整条回路上训练 `structure` 指向的网络。回路里其他网络用已接受的权重冻结运行。被训练网络的读出是回路体里消费它 `scores` 的那个读出。有三种方法。REINFORCE：奖励 `fn(Transition) → number`，dense + argmax，最后一层是工具层时用 bits 读出。带工具层的网络只能用 REINFORCE。交叉熵：目标 `fn(State[, Table]) → bits[O]` 返回掩码，dense + argmax。hinge：目标返回精确的 `bits[O]`，threshold + bits 读出。后端是 `browser`（Worker）或 `python`（Workspace） |
| **候选** `candidates` | 值 `run`（可接多个） | `weights`（当前接受的）、`artifact` | 列出运行产生的产物。可以预览、接受、导出和导入产物。兼容性见第 6 节 |
| **评估器** `evaluator` | 值：`loop`（必需）、`partition`（必需）。调用：`metrics: fn(Episode) → number`（多个）、`objective`（可选的奖励，用来算 `return`） | `report` | 每个网络用已接受的权重。评估器按分区的回合贪心地运行整条回路，并计算各指标。它可以按枚举分区的一条轴分组，例如按延迟画保留曲线 |
| **执行实例** `execution` | 值：`loop`（必需）、`partition`（必需） | `execution` | 每个网络用已接受的权重，执行实例逐步运行整条回路。它自己持有时钟、电位和历史。历史的每一步记录三项：回路体每个模块的值、这一步运行了哪些模块，以及每个工具层的 `{ choice, data, result }`。`{ choice, data, result }` 是调用了哪个工具、交给它的数据位和它的结果 |

### 展示与链上

| 模块 | 输入 | 输出 | 作用 |
|---|---|---|---|
| **视图** `view` | 值 `execution` 或 `report` | — | 渲染器有两类。第一类是 `grid / series / table / kv`，配置状态路径和标记，例如 `state.map` + 玩家 / 基地坐标与格子颜色。第二类是 `script`：视图脚本（ADR 0013）。视图脚本在断网的沙箱 iframe 里自己画，用 Vue 组件（`props: ['ctx']`）或 `render(ctx, el)`。`ctx` 包含所接的运行数据（历史滑条选中的那一步）。它还包含所在训练模块全部成员的静态值（`ctx.modules[标题][端口]`） |
| **链上部署** `deployment` | 值 `artifact` | `deployment` | 通过 ModuleFactory 部署一份产物，然后核对、读状态、reset，并用交易逐步运行。本地镜像使用产物快照里的同一环境和整数执行器 |

### 代码模块

代码模块的配置是 `{ inputs, source }`。`source` 是一个受限 JavaScript 文件，只有顶层 `const` 和 `function`。文件里不写类型，类型由调用方决定（ADR 0012）。`ir.parseModule` 编译这个文件（ADR 0005）。

代码模块的要点如下：

- **导出即端口**：每个 `export function name(…)` 是一个调用输出 `name`，调用方按这个函数自己的参数传参。每个 `export const name = …` 是一个值输出 `name`，由输入静态地求值一次。未导出的函数是辅助函数，在调用处内联，不能递归。未导出的常量是普通常量。另有一个输出 `module`：整个文件，交给按角色调用其中若干函数的模块（回路的 `scenario`）。不能再导出名为 `module` 的函数或常量。
- **输入**：`inputs` 里每个名字是一个必需的值输入端口。它也是文件级名字，文件里处处可读。它作为静态值绑定进读它的每个函数和常量。奖励的系数和场景的参数都这样读进来，例如 `weights.params → reward.weights`，源码里写 `weights.value`。
- **端口不依赖编译**：源码能编译时，注册表从源码推出 `exports`（`[{ name, kind: function | const }]`），并存进配置。源码暂时编译不过时，注册表沿用上一次的列表，所以端口和连线不会消失。`exports` 从不手写。
- **注释**：`export function` 前的 JSDoc 说明这个函数。JSDoc 包括摘要、`@param name`、`@param name.field` 和 `@returns`，它的文字随端口传播。标签里的 `{Type}` 不起作用，类型只来自调用处和连线。记录字面量里键前的 `/** … */` 描述这个字段。
- **模块标题**：模块标题只是标签，函数名写在源码里。如果模块只导出一个函数（调用线）或一个常量（值线），模板连线可以省略源端口：`reward→trainer.objective`。否则写 `模块.导出名`。
- **角色契约**（ADR 0012）：一个模块种类按协议调用一个导出时，它声明以下内容：
  - 参数个数和类型。
  - 默认参数名（用于生成骨架和说明）。
  - 调用时机。
  - 返回含义。
  - 一段能编译的函数体。

  实现自己取参数名，参数个数和类型是协议。编辑器给每个角色一个竖向 tab，只显示这个函数。函数头除参数名外锁定，并用灰字标出类型。行尾的 ? 打开说明窗，里面有调用方、参数及字段、返回和真实例子。

### 代码模块的角色

一个导出函数的角色取决于它接到哪个端口。接收端口规定函数签名。只有驱动回路的分区接了数据集时，才出现 `Table`。

| 角色 | 接到 | 签名 |
|---|---|---|
| 选项 | 参数的函数输入（默认 `options`） | `fn(params) → record`（派生值） |
| 奖励 | 训练器.`objective`（REINFORCE）、评估器.`objective` | `fn(Transition) → number`。系数从代码模块的输入读 |
| 监督目标 | 训练器.`objective`（交叉熵 / hinge） | `fn(State[, Table]) → bits[O]`：在每一步之前对当前状态调用。`Table` 是整张表 |
| 选模指标 | 训练器.`metric` | `fn(Episode) → number` |
| 评估指标 | 评估器.`metrics` | `fn(Episode) → number` |
| 场景 | 回路.`scenario`（接整个文件 `module`） | 导出 `init?` / `input` / `step` 和常量 `budget` / `actions?`，见下节 |

导出常量直接当值用。例如，场景模块的 `export const actions = […]` 接到读出的 `actions`。

### 场景模块

没有“环境”模块。场景模块是接到回路 `scenario` 的代码模块（`scene.module → loop.scenario`）。运行器按同一个协议调用它导出的角色（ADR 0009，`frontend/core/kinds/scenario.js`）：

| 导出 | | 运行器的调用 | 返回 |
|---|---|---|---|
| `init(start)` | 可选 | 每回合一次 | `State`。不写 `init` 时，`State` 就是 `Start` 记录本身 |
| `input(state[, table])` | 必需 | 每一步之前 | `bits[1..256]`：回路的输入位 |
| `step(state, action[, table])` | 必需 | 每一步 | `{ state: State, done: boolean, success: boolean }`，恰好这三个字段 |
| `budget` | 必需常量 | | 正整数：每回合最多几步 |
| `actions` | 可选常量 | | 字符串数组：动作名，另用 `scene.actions → readout.actions` 接给读出 |

场景模块的要点如下：

- 一题一答的任务让 `step` 返回 `done: true`，并写 `budget = 1`（四个算术模板和组合器）。
- **未完成**：缺少 `input`、`step` 或 `budget` 时，场景记为“未完成”。如果导出了一个函数，运行器不调用它，它也没有接到别处，场景也记为“未完成”。这种函数多半是拼错的角色。“未完成”报在回路的 `scenario` 端口上。连线照常可接，但在补齐之前，快照、训练和评估拒绝运行。回路还没有驱动模块时，`Start` 未知，角色也记为未完成（“先把回路接到训练器、评估器或执行实例”）。
- **错误**：`step` 多返回了字段、`actions` 不是字符串数组、`budget` 不是数字，这些都是错误。参数名随意，参数个数固定。
- **场景参数**是场景模块的输入（`params.params → scene.params`、`sense.params → scene.sense`、`rng.rng → scene.rng`）。场景在文件级读取它们（`params.grid`）。派生表写成顶层常量，每个快照只算一次，例如网格几何和随机数表。运行器看不到参数。
- **网络看到什么**完全由 `input` 决定。要对网络隐藏信息，就不在 `input` 里编码它。例如，记忆地图隐藏后的目标和挖矿视野方块外的格子都不编码。`input` 里可以调用未导出的辅助函数。例如，记忆地图先算一个中间记录，再编码成位。挖矿用 `cellOf` 把视野格换成地图格。
- 函数前的 `/** … */` 描述它的返回值。`State` 的说明就是 `init` 的注释。没有 `init` 时，`State` 的说明是分区回合记录的说明。

运行器有 JS 版 `frontend/core/runner.js` 和 Python 版 `training/bundle_env.py`，两者行为相同：

```
reset(start):  state = init ? init(start) : start;  t = 0
input():       bits = input(state, rows ≤ cursor)
step(action):  r = step(state, action, rows ≤ cursor + 1)
               truncated = !r.done && t + 1 ≥ budget;  done = r.done || truncated
               Transition = { prev: state, action, next: r.state, done, truncated, success: r.success }
               state = r.state;  t++
```

运行器的要点如下：

- 时间窗回合的 `cursor = start.start + t`，其他回合的 `cursor = t`。只有驱动分区接了数据集时，运行器才把数据表视图作为最后一个参数传入。`input` 看到 `cursor` 及以前的行。`step` 多看一行，也就是本步的结果。监督目标看整张表。回合结束后再调用 `step` 是错误。
- `Start` 是驱动分区的回合记录：种子分区是 `{ seed }`，枚举分区是 `{ index, <轴>: 值… }`，时间窗分区是 `{ start, length }`。回路的所有驱动（训练器的 `training / validation`、评估器和执行实例的 `partition`）必须是同一种回合，并接同一张表。
- `Transition = { prev: State, action: number, next: State, done, truncated, success }`。`success` 是 `step` 返回的值。`truncated` 表示回合因为 `budget` 而结束。如果回路里有带工具层的网络，回路执行器再加 `loop: { <网络标题>: { <工具端口>: { choice, data, result } } }`（ADR 0010 §10）。这样的回路里，网络标题必须唯一。
- `Episode = { initial: State, final: State, steps, success, return }`。`success` 取最后一个转移的值。`return` 是奖励之和。评估器没接 `objective` 时，`return` 为 0。
- 每个角色编译成自己的程序。程序的参数先是运行器传的参数，后面是函数读到的文件级名字（输入、顶层常量）。这些名字的值作为静态值随程序存进快照。`init` 的返回类型决定 `State` 的类型。`step` 返回的 `state` 必须是同一个类型。

## 4. 两种线

| 线 | 含义 | 例子 | 规则 |
|---|---|---|---|
| **值线** | 把输出值交给输入。接收方求值时读取它 | 参数 → 代码（包括场景模块）、随机数.rng → 场景模块、回路.input → 网络.in、网络.scores → 读出、读出.action → 回路.action、回路.loop → 训练器 / 评估器 / 执行实例.loop、分区 → 驱动、候选.weights → 网络.weights | 必须无环。只有闭合到回路输入的环例外。回路输入是声明了 `loop` 的端口，它的值在下一步才生效（权重则来自更早的一次训练）。回路输入只有回路的 `action` 和网络的 `weights` |
| **调用线** | 把一个函数（或整个代码文件）交给接收方。接收方想调用几次都可以 | 场景.module → 回路.scenario、奖励代码 → 训练器.objective、指标代码 → 评估器.metrics | 连线时按签名检查：参数类型或返回类型不符就拒绝。运行时检查返回值。不允许递归调用 |

值线和调用线分别检查环。`params → options.params` 与 `options → params.options` 可以同时存在，因为后者是函数边界，不是求值环。画布上值线画成实线，调用线画成带 ƒ 的虚线。

## 5. 模板

下面是组合器模板（`arithmetic-combiner.yaml`）的节选：

```yaml
format: neurom-template
id: arithmetic-combiner
revision: 1
name: 组合器 · 工具层调用 3 个网络
kind: composite                       # module | composite | canvas
preset: { label: 组合器 · 内置 ADD4 / SUB4 / MUL4 与策略产物已接受 }   # 调色板里的示例
modules:
  questions:
    kind: partition
    config:
      kind: enumerate
      enumerate:
        axes: { op: ['*', '+', '-'], a: [0, 1, …, 15], b: [0, 1, …, 15] }
        roles: { training: { mod: 5, rem: [2, 3, 4] }, validation: { mod: 5, rem: [1] }, test: { mod: 5, rem: [0] } }
  scene:
    kind: code
    title: 算术题
    config:
      source: |-                        # 代码模块：顶层 const + function，导出即端口（ADR 0005）
        export const budget = 1;
        export function init(start) { return { op: start.op, a: start.a, b: start.b, action: -1 }; }
        export function input(state) { return concat(oneHot(state.op === '*' ? 0 : state.op === '+' ? 1 : 2, 3), bits(state.a, 4), bits(state.b, 4)); }
        function want(q) { … }                                                    // 未导出：辅助函数
        export function step(state, action) { return { state: { ...state, action }, done: true, success: action === want(state) }; }
  reward:    { kind: code, config: { source: 'export function reward(transition) { return transition.success ? 1 : 0; }' } }
  exact:     { kind: code, config: { source: 'export function exact(episode) { return episode.success ? 1 : 0; }' } }
  loop:      { kind: loop, title: 回路 }
  policy:    { kind: network, config: { engine: dense-policy, kind: feedforward, inputs: 11, layers: [{ tools: tools, data: 8 }], … } }   # 唯一的一层是工具层
  policyOut: { kind: readout, config: { mode: bits, width: 8, decode: lsb-int } }   # 工具层在最后：它的结果位就是输出
  add4:      { kind: network, config: { engine: threshold-layers, inputs: 8, layers: [12], …, artifact: '0xc024…6bd6' } }   # 冻结：自己选定内置 ADD4 产物
  add4Readout: { kind: readout, config: { mode: bits, width: 5, decode: lsb-int } }   # 它的 run 是一个工具
  # sub4 / sub4Readout（[16]，5 位）、mul4 / mul4Readout（[112]，8 位）同理
  trainer:   { kind: trainer, config: { method: reinforce, epochs: 100, lr: 0.1, entropy: 0.03, replicas: 8, seed: 1, evalEvery: 10 } }
  cands:     { kind: candidates, config: { accepted: '0x29d8…c458' } }        # 内置策略产物
  evaluator: { kind: evaluator, config: { groupBy: op } }
  execution: { kind: execution }
wires:
  value:
    - questions.training→trainer.training
    - questions.test→evaluator.partition
    - loop.loop→trainer.loop                    # 驱动经 loop 句柄运行回路
    - loop.loop→evaluator.loop
    - loop.input→policy.in                      # 回路体：input → … → action
    - policy.scores→policyOut.scores
    - policyOut.action→loop.action              # 回路输入：下一步生效
    - add4.scores→add4Readout.scores
    - policy.structure→trainer.structure
    - trainer.run→cands.run
    - cands.weights→policy.weights              # 回路输入：来自更早的一次训练
    - …
  call:
    - scene.module→loop.scenario
    - add4Readout.run→policy.tools              # 工具按连线顺序编号：ADD4、SUB4、MUL4
    - sub4Readout.run→policy.tools
    - mul4Readout.run→policy.tools
    - reward→trainer.objective
    - …
groups:                               # 模板本身是训练模块；它里面的分组
  box:    { title: 回路, loop: loop, members: [loop, policy, policyOut], expose: [loop.loop, loop.scenario, policy.structure, policy.tools, policy.weights] }
expose: [cands.artifact]
slots:                                # 预制模块的槽位：成员的一个声明端口，加上它的 + 新建的模块
  - { id: scenario, title: 场景, port: loop.scenario, create: [{ kind: code, title: 场景, ports: { module: scenario } }] }
  - { id: objective, title: 目标, port: trainer.objective, create: [{ kind: code, title: 奖励 }] }
  - …                                 # 训练集、验证集、指标、评估、执行
```

模板的要点如下：

- **训练模块的分组**：每个内置模板本身就是训练模块。实例化出的组合以模板名为标题。它直接包含分区、数据集、目标 / 奖励及其参数、指标、训练器、候选、评估器、报告视图、执行实例和地图视图。它也直接包含场景模块，以及场景模块的参数和随机数。它还包含嵌套分组 `box`，也就是回路框（`loop: <回路模块>`），成员恰好是回路模块加回路体。冻结网络用自己的 `artifact`，没有候选模块。工具层调用的网络和它们的读出不属于回路体，留在框外。

  展开时，前一类成员画成左栏的段落。场景作为环境段落，紧接在数据之后。嵌套分组放在右边的子画布里（ADR 0011）。
- **槽位**：`slots` 让实例成为预制模块（[CONTEXT](../CONTEXT.md) 的 Prefab，ADR 0011）。代码新建项不写 `config` 时，点 + 会按槽位端口的约定生成桩代码（`core/prefab.js stubSource`）。调用端口的桩代码按它的签名生成。回路 `scenario` 的桩代码按场景角色生成，`input` 返回的位数等于读回路输入的网络声明的位数。
- **示例**：`preset` 把模板列进调色板的示例。`label` 是按钮文字。`accept` 给候选模块指定它接受的内置产物。模板自己钉住的 `accepted` 照常导入。
- **连线顺序**：规范形式按字母顺序排列连线。只有接进同一个调用端口的调用线保持书写顺序，因为工具层按这个顺序给工具编号。
- **回路框**：分组的 `loop` 字段把这个分组标成某个回路的框。回路框只是视图：回路体由连线推出。如果框的成员与回路体不一致，回路报问题（ADR 0003、0009）。
- **分组**：模板内的嵌套分组随实例建出，建出时折叠。未列入分组的成员留在顶层。分组里可以再有分组。“存为模板”记录选区内的嵌套分组，连同 `loop` 标记。分组 id 有自己的命名空间：分组 `box` 里也可以有名为 `box` 的模块，成员名优先解析为模块。
- **实例化**：实例化把模板里的模块复制到画布上，分配新 id，并展开成扁平的模块图。然后它把这些模块包进一个组合。这个组合只露出 `expose` 端口。`instantiateInto` 建出的组合是折叠的。工作台放置带槽位的模板时（调色板、模板库、示例），把组合和嵌套分组都展开。所以槽位立即可见（ADR 0011）。执行、快照和部署看到的始终是扁平图（ADR 0003）。

  组合可以嵌套：画布上的组合（包括模板实例）可以再打包进另一个组合，层数不限。模板文件可以声明嵌套分组，但不引用其他模板（ADR 0003）。
- **实例和模板不联动**：实例是一份副本，只记录来源 `模板 id@revision`。之后修改模板不影响已有实例。
- **校验**：解析模板时，解析器把模板实例化到一张临时图里。解析器按连线规则检查每条线。完成后的实例除了“未完成”之外，不能有任何问题。例如，回路让 `Transition` 定型后，如果奖励函数的返回类型不符，解析器也拒绝这个模板。
- **存储格式**：YAML 只用于编写和导入导出。内部存储一律用规范 JSON，配置以填满默认值的形式保存，所以一份模板钉住确切行为。代码模块的 `exports` 由源码推导。导出 YAML 时省略 `exports`，解析时重新推导。
- **模板库**：模板库按单模块、组合、画布三级列出内置模板和用户模板。它可以实例化、分叉、导入 / 导出 YAML、把选区存成模板，还能查看画布上哪些组合来自哪个 `id@revision`。内置模板是 `frontend/templates/*.yaml`。文件放进目录即生效，不用注册。

## 6. 快照、产物与程序

- **快照（`neurom-bundle`，`frontend/core/bundle.js`）**：点击训练 / 评估 / 执行时，驱动模块调用 `buildBundle(graph, id, { res, artifacts })`。这个函数沿着驱动模块的输入，把用到的模块全部收集成一份规范 JSON。这份 JSON 交给 Worker、Python 或会话。驱动模块固定（`sessions/pinned.js`）当时的快照和它的数据表行，并按快照里的内容哈希核对这些行。训练运行、评估报告和执行实例都描述自己固定的那份快照。所以训练开始后再编辑画布，不影响正在运行的训练。

  如果画布描述的快照变了，报告和执行实例标为过期，但不丢弃，也不重算。只发布最近一次请求的异步结果。浏览器训练与 Python 训练拿到同样的数据表行。

  ```
  env:   { programs: { init?, input, step }, budget, actions, start: 'seed'|'enumerate'|'window',
           types: { Start, State, Transition, I, table? }, tables? }
  loop:  { I, action: Ref, nodes: { <id>: 回路节点 }, trained: <网络 id> | null }
  训练器   objective: { kind: 'reward'|'target', program, bound, boundTypes }, selection, partitions: { training, validation? }, recipe
  评估器   partitions: { test }, metrics: [{ name, program, … }], objective?, groupBy?
  执行实例 partitions: { test }
  ```

  - `env` 是强化学习意义上的“环境”。它包含场景模块每个角色编译出的程序。它还包含程序读到的文件级名字（输入、顶层常量）的值和类型。每个常量只算一次。`env` 还包含 `budget`、`actions`（没导出时为 `null`）、驱动分区的回合种类 `start`、类型和数据表 `[{ id, hash, columns }]`。快照里没有参数：参数只作为程序绑定的静态值出现。
  - `loop` 是回路体。`Ref = { node, port }`，回路的输入位是 `{ node: '$input', port: 'bits' }`。回路节点有三种：`network { structure, in, model, artifactId }`、`readout { readout, scores }` 和 `bits { parts, in: { <端口>: Ref } }`。带工具层的网络另有 `tools: { <端口>: [工具…] }`，按连线顺序排列。工具自己的模块不属于回路体。

    冻结网络工具带它的结构、模型、产物 id `artifactId` 和位读出。如果冻结网络工具自己有工具层，它还带自己的 `tools`。这些工具必须是它的产物训练时用的工具，否则打包失败。代码工具带程序。

    `model` 是网络已接受产物的整数模型。这个产物是网络自己的 `artifact`。没有 `artifact` 时，它是接到网络 `weights` 的候选里已接受的那份（`core/loop.js acceptedArtifactId`）。产物里被训练网络的结构与读出必须等于这个网络的结构与读出，否则打包失败（“网络 … 的产物不兼容”）。只有 `trained` 指向的网络的 `model` 是 `null`。

    训练器快照里，其他每个网络都要有已接受的权重。评估器和执行实例的快照里（`trained: null`），每个网络都要有已接受的权重。否则打包失败（“网络 … 没有已接受的权重”）。回路体的逐步输入只能来自回路的 `input` 或回路体本身。
  - 链上部署不构建自己的 `env / loop`。它部署一份产物，使用产物自带的快照。
- **哈希**：`bundleHash = sha256(规范快照)`。`envHash = sha256(规范 env)` 只看 `env`，所以目标不同、回路体不同的驱动可以共用一个环境。链上 `taskId` 就是这个哈希。
- **产物（`neurom-module`）**：`{ bundle, model, provenance, evaluation, id }`。`id` 是其余部分规范 JSON 的 SHA-256。`bundle` 是训练它的训练器快照。`model` 是被训练网络（`bundle.loop.trained`）的整数模型：`dense-policy`（FF / LIF）或 `threshold-layers`。模型的宽度和 `weightBits` 与快照里的网络结构一致。产物存入和导入时，都按它的网络校验。
- **候选的兼容性**（`sessions/candidates.js compatibility`）：产物要满足两个条件才能被接受。第一，产物的 `bundle.env` 与候选所在回路的当前训练器快照的 `env` 深度相等。第二，被训练网络的结构和它的读出规格都相等。奖励、选模指标和回路里的其他网络不影响这项检查。
- **程序**：代码模块的每个导出函数和每个顶层常量都编译成 IR（`neurom-program`）。JS 侧和 Python 侧按同一套规则执行 IR。JS 侧（`frontend/ir/`）把程序编译成闭包。Python 侧（`training/ir.py`）给每个程序生成一个 numpy 函数，按 lane 批量运行并带掩码。共享 fixture `frontend/ir/fixtures/programs.json` 钉住两侧的结果。浏览器训练、Python 训练和浏览器里的链上逐步核对，三处结果一致。

  用户代码不经过求值，只作为 IR 执行。
- **IR 运算**：IR 有以下运算：
  - 算术与比较。
  - 记录（`record / get / set`）。
  - 定长数组（`array / index / update / range`）。
  - 有上界的 `map / fold / scan`（不允许无界循环和递归）。
  - 32 位无符号运算（`u32 / imul32 / add32 / sub32 / xor32 / and32 / or32 / shl32 / shr32`）。
  - 确定性随机数 `rand(key, counter)`。
  - 字符串常量。
  - `sqrt / ln / exp`。
  - 离散化 `bucket / thermometer`。
  - 数据表访问 `tableAt / tableWindow`。
  - 归约，例如 `minOf / argminFirst`。

  上限：每个程序 ≤ 4096 个节点，静态最坏代价 ≤ 2,000,000 次节点求值。
- **数值分层**：环境程序按精确层检查，拒绝 `ln / exp`，所以两端逐位一致。奖励、目标和指标是近似层，可以用 `ln / exp`，对照时允许误差。

## 7. 回路执行器

所有运行场景的部分都经同一个回路执行器运行回路。回路执行器是 `frontend/core/loop.js`。Python 孪生是 `training/bundle_loop.py`，它按 lane 批量运行，语义相同。要点如下：

- **`loopSection(graph, res, loopId, { trained, artifacts })`** 构建快照的 `loop` 部分。如果回路或回路体有问题，它抛出 `BundleError`。
- **`createLoop(loop, { models })`** → `{ reset(), step(bits) → { action, values, ran, tools }, states() }`。每个网络都运行自己的模型。`models` 按网络 id 覆盖模型，例如验证和评估时给被训练网络换上候选模型。
- **按需求值**：执行器从 `action` 出发倒推，每一步每个节点至多求一次值。工具层只运行它选中的工具。`ran` 是这一步运行过的节点。`values` 是每个求过的输出（`'<节点>.<端口>'` → 位、数字或分数）。`tools` 是每个工具层这一步的 `{ choice, data, result }`。执行实例和视图显示这些值。

  网络跨步保留自己的执行器状态。状态先是网络自己的 LIF 电位，然后是它每个网络工具的状态。工具的状态先按工具层排，再按连线顺序排，逐层嵌套（`toolCaller` 的 `width`）。工具的状态只在工具层选中它时前进。`states()` 给出每个网络的整份状态，`reset()` 把状态全部清零。REINFORCE 训练时，每个 lane 也各有一份工具状态，回合开始时随电位清零。
- **锁步运行器**：`createLockstep(bundle, { models, tables }).run(episodes, { decide, onStep, trace })` 把一批 Start 一起运行到结束，每个回合一个 lane（Python 孪生 `bundle_train.py Session.run_steps`）。它独占所有驱动共用的逐步协议。协议规则如下：
  - env 与回路一起重置。
  - 回合结束的 lane 不走步。
  - 目标函数在走这一步之前的状态上读取，并且只在被训练网络作决定的 lane 上读取。
  - 奖励读带 `loop` 的转移。

  `decide(x, lanes, y)` 是被拦截的被训练网络。每一步，所有要求它的 lane 一次交给训练器。`x` 是这些 lane 的输入位。`y` 是目标位，没有目标函数时为 null。训练器为每个 lane 返回以下一种结果，可带 `tools`（它的工具层记录）：
  - `{ scores }`：照常由它的读出解码。
  - `{ slot }`：argmax 读出选中的槽，必须是 0..O−1 的整数。
  - `{ bits }`：bits 读出的位，必须恰好 O 位，按是否非零规整为 0/1。

  如果一步里没有 lane 要求被训练网络，就不调用 `decide`。没有 `decide` 时，被训练网络运行自己的模型。以下情况是错误：一步里同一个被拦截网络被要求两次，或者一个网络接了两个读出。
- **整回路训练**：每一步，训练器运行回路，并拦截其中的被训练网络。执行器先算出被训练网络的 `in` 所依赖的一切，包括冻结网络。训练器拿到这些输入位后，给出读出结果。然后执行器把这一步算到回路的动作。读出结果取决于方法：
  - REINFORCE：按 softmax(scores / (ticks · gain)) 采样的槽（gain 见下一条）。
  - 交叉熵：教师掩码给出的槽。有标签的步以 1 − exploration 的概率取一个随机的正确槽。
  - hinge：目标位。

  只有被训练网络有梯度。如果回路在一步里没有要求被训练网络，这一步不产生决策。hinge 先用教师强制把每个训练回合运行一遍。每个要求了被训练网络的步成为一行 (X, Y)。
- **量化（ADR 0015）**：网络配置 `weightBits` 选择权重宽度：8（默认）或 16。配置里没有 `scale`，也没有 `threshold`。训练器的参数是实数单位的浮点影子。每次前向，训练器都把每个区域重新量化。区域是普通层、工具层的选择头 / 数据头、输出层和每个阈值层。量化规则如下：
  - scale s = Q / max|w|（Q = 127 或 32767），取整时 .5 向上。
  - 偏置是 int16，单位是 1/(s·2^k)。k 取 0..20 里让偏置放得下的最大值。LIF 还要求阈值不超过 int32。
  - LIF 普通层的阈值 = round(s·2^k)，即实数 1.0。
  - 导出的是码 `W` 和 `b`。训练前向用 `W`·2^k 和 `b`，结果和整数执行逐位相同。
  - STE 梯度乘 gain = s·2^k。REINFORCE 和交叉熵的 logit 是 scores / (ticks · gain)，gain 取输出层的值。hinge 的 z 用实数单位。
  - 按构造，权重不会截断。如果偏置比该层最大权重还大（k = 0 也放不下），偏置会截断并计数。

  结果的 `evaluation.quantization` 按权重块顺序给每个区域一项 `{ region, scale, k, threshold?, clippedWeights, clippedBiases }`。训练器面板显示一行“int8 每层截断（权重/偏置） layers[0] k 9 · 0/0 …”。
- **一个贪心运行器**：`runEpisodes(bundle, { models, episodes, tables, onStep, trace })` → `[{ start, success, steps, return, initial, final, trace? }]` 是不带 `decide` 的一次锁步运行。它在整数引擎上贪心地运行回合。一次贪心运行至多同时运行 16 个回合，一波接一波复用同一组 lane。所以 lane 数（每个 lane 一份 env 和回路执行器）不随回合数增长。

  评估器会话和训练中的验证都用这个运行器。所以导出的模型在它的回路里，按它将来运行的样子被度量。没有 `metric` 时，奖励目标按验证平均回报选模，监督目标按有标签步的贪心读出准确率选模。
- **执行实例**（`sessions/execution.js`）按步调用同一个执行器。历史里每步记下输入位、`values`、`ran`、动作、转移和电位。用户可以手动给动作。

## 8. 链上

- 链上结构（ADR 0014、ADR 0016、ADR 0017）有以下部分：
  - **权重块**：一个合约，代码只有一个 STOP 字节加至多 114,688 字节（112 KiB）的权重。`ModuleFactory.createChunk` 用 CREATE2 创建权重块（salt = 内容的 keccak256）。所以地址由内容算出，相同内容只创建一次。
  - **引擎版本**：不可变合约，每个合约计算一个引擎 id（版本 1：`DensePolicyEngine`、`ThresholdLayersEngine`）。同一 id 的各版本逐位一样。模块用 STATICCALL 调用引擎版本，引擎版本写不了任何东西。
  - **Factory**：Factory 在一个 `FactoryProxy` 后面。状态在代理里，只有 UPGRADER 能升级 Factory。Factory 记录每个引擎 id 的版本列表和最新版本。列表只增不改，由 ADMIN 管理。
  - **角色**：角色在不可升级的 `Roles` 合约里。
  - **模块合约**：Factory 的 `NeuromModule` 实现的一个小克隆。模块合约的身份在它的代码里：终身不变的引擎版本、id、形状、权重块与工具地址。它的存储里有各 (actor, session) 的状态和 `owner()`。`owner()` 是部署者，可以两步转让，没有别的权力。
- 权重按列存：每层一个区域，宽度 w = `weightBits`。第 i 列是该层所有神经元对输入 i 的 w 位权重。每词放 256 / w 个权重，即 32 个 int8 或 16 个 int16。每列补零到整词。最后一列是偏置（阈值层是 th），总是 int16，每词 16 个。

  `rows` 行、`cols` 列的区域占 cols · ⌈rows · w / 256⌉ · 32 + ⌈rows / 16⌉ · 32 字节。工具层是两个区域：K 个选择行和 D 个数据行。每个区域有自己的移位 k（0..20）：z = (Σ W·x) · 2^k + f · b。FF 在 z ≥ 1 时发放。LIF 普通层按自己的阈值发放。阈值层算 (Σ W·h) · 2^k − th。

  形状：dense 用三个词，阈值层用两个词。dense 的三个词依次存放以下内容：
  - 各层布局。
  - 层数、ticks、leakShift、weightBits、reset 和每个区域的 k。
  - 每个普通层的阈值（FF 恰为 1）。

  阈值层的第一个词是各层宽度，第二个词是 weightBits 和每层的 k。位段见 `contracts/README.md`。

  引擎对每个为 1 的输入把整列相加，数值与 `integerStep` / `layersStep` 逐位相同。每步只调用选中的工具。引擎把这个工具那一段状态交给它的 `forwardFrom(state, data)`，再把它返回的下一状态写回。模块的 `stateWidth` = 自己的 LIF 电位 + 各工具的状态，至多 256 个 int32。工具模块自己的存储不动。

  `ModuleFactory.deploy(spec, data)` 在一笔交易里先检查，再建 `data` 带来的缺的权重块，最后建模块。结果要么全部成功，要么全部不成功。`checkDeploy` 是同一套只读检查。`deploy` 拒绝以下内容：
  - 没有最新版本的引擎 id，或不在列表里的指定版本。
  - 建块之后仍不存在的权重块（按内容哈希重算地址）。
  - 引擎拒绝的形状。
  - 字节数不符的权重。
  - 不是本 Factory 模块的工具。
  - 嵌套超过 `MAX_TOOL_DEPTH` = 3 层的工具（`depth`，`depthOf` 记录每个模块的深度）。

  `modulesOf(artifactId)` 列出登记了某产物的模块。
- 部署按产物进行：一份产物是一个网络。带工具层的网络（ADR 0010 §11，ADR 0014）先部署工具。每个网络工具是它自己的模块，可以是 FF、LIF 或自己带工具层的网络。自己带工具层的网络工具先部署它自己的工具。如果 Factory 里已有同一产物的模块（`modulesOf`），并且这个模块核对通过，就复用它。然后部署带这些工具地址的选择器。

  代码工具不能部署（`代码工具不能部署`）。每个模块和它链上还没有的权重块在一笔交易里一起部署。如果 gas 估算（+ 10%）放不下单笔上限（Monad 30M），先用 `createChunk` 建缺的块，每块一笔交易。一直建到模块和剩下的块放得进最后一笔为止。链上已有的块从不重发。

  部署前检查（`core/kinds/network.js deploymentProblem`）包括：
  - 输入宽度和输出宽度都在 1..256。
  - dense 有 1..8 层。普通层的 hidden 和工具层的 K / D / R 都在 1..256。
  - 每个会话的状态（LIF 普通层神经元加各工具的状态）合计 ≤ 256。
  - 工具嵌套 ≤ 3 层。
  - 每个网络工具本身可部署。
  - threshold 层数 + 1 ≤ 8。
  - 权重大小不限，需要几块就分几块（`denseWeightBytes` / `thresholdWeightBytes` 是链上的字节数）。
  - 模型的 `W` 在 `weightBits` 的范围内，偏置和 `th` 是 int16（模型校验保证这一点）。

  一个满的权重块是 112 KiB，超过 EIP-170 的 24 KB，所以它依赖 Monad 的 128 KB 代码上限。
- 桥接接受 `neurom-module` 产物。`taskId = envHash(artifact.bundle)`，`artifactId` 就是产物 id。本地镜像运行产物快照的 `env`。如果产物的回路只是“输入 → 这个网络 → 读出 → 动作”，它的读出驱动本地镜像。否则需要显式给输入位。有工具层时，本地镜像也调用工具。

  部署默认用最新的引擎版本，调用方也可以指定一个版本。核对的范围是选择器和它的每个工具。核对检查以下内容：
  - `isModule`。
  - 描述符。
  - 引擎是 Factory 为它的引擎 id 列出的版本。
  - 形状。
  - 权重块地址（由产物内容重算）。

  核对工具时，工具的产物必须在工作区里。

  gas 数据见 `contracts/README.md` 的 Gas 表（`testGasOfMiningNetworks`）。默认挖矿网络 FF 185→32→7（int8）一笔部署（权重块 + 模块）用 1,996,410 gas。一局 63 步用 3,258,388 gas（int16：3,295,015 / 3,286,572）。在本地 Anvil 上，组合器测试分区的 154 题在链上与浏览器里逐位一致（`module-chain.test.js`）。
- 有状态和嵌套的工具（ADR 0014）：有两种情况。第一种是 LIF 选择器带 LIF 工具。第二种是选择器的工具自己带工具层。两种情况都在本地 Anvil 上经桥接与浏览器逐位一致。状态也一致，跨 reset 和不同会话也一致（`module-chain.test.js`）。工具模块自己的存储不动。核对还比较模块的 `stateWidth`。

  在 Monad 规则下（`Modules.t.sol` testGasOfNetworkTools，2 位小选择器），选 LIF 工具的一步用 47,013 gas。选 FF 工具的一步用 41,058 gas。每多嵌套一层，实测多用 22.5k–23.6k，这是一次工具调用的开销。按每层约 24k 估算，8 个工具层逐层嵌套 3 层，最多 584 次调用，约 14M。嵌套 4 层约要 112M，一笔交易放不下。这就是上限 3 的由来。
- 部署计划（`planDeployment`，只读）分两步。第一步，按 CREATE2 地址查出这份产物需要的权重块里，链上已有几个。需要的权重块也包括要先部署的工具的块。第二步，按与部署相同的规则，从 gas 估算排出要发送的交易。只有模块缺的块都放得进估算时，才知道模块自身的 gas，否则显示为待定。部署在每笔交易前重新估算，所以在边界上，预测可能差一笔。

  部署模块在以下时刻刷新部署计划：“连接”、“部署计划”、部署前，以及部署中每笔交易上链后。部署模块逐笔列出已上链的交易和还要发送的交易。如果部署中途失败或页面关闭，可以再点部署。这时桥接先在链上查一遍，只发送还缺的。已有的块不重发，已部署且核对通过的工具模块复用。
- 链上推理、只读预览和 step 都用同一项对照。在同一输入上，链上的决策必须与本地整数执行器的决策逐项相同。对照的项是 scores、counts 和 voltages。counts 在 dense 中是每个普通层的放电数，在阈值层中是每个隐藏层的激活，按层拼接，与合约相同。只读调用只报告不一致。如果 step 交易不一致，会话作废（`STATE_MISMATCH`），本地回合不前进。

  部署会话在本地 Anvil 上经同一套 `module-chain.js` 跑通部署、推理、预览、reset 与 step（`core/sessions/deployment.test.js`，缺 Foundry 时跳过）。

## 9. 代码怎么分层

| 层 | 位置 | 内容 |
|---|---|---|
| IR | `frontend/ir/`、`training/ir.py` | 解析（JS 子集 → IR）、类型检查与代价、编译成闭包（JS）/ 生成批量 numpy 函数（Python） |
| 核心 | `frontend/core/` | 端口类型、模块种类注册表、模块图（节点 / 线 / 组，组可标为回路框）、类型推导与问题、快照（`bundle.js`）、运行器（`runner.js`）、回路执行器与贪心运行器（`loop.js`）、读出、模板、工作区、规范 JSON 与哈希 |
| 会话 | `frontend/core/sessions/` | 训练器、候选、评估器、执行实例、链上部署、数据集、驱动的固定快照（`pinned.js`）、整数执行器封装（`executor.js`）、Python Workspace 客户端。界面只通过会话和 `graph` 修改状态 |
| 整数引擎 | `frontend/runtime/` | `dense-policy.js`（FF / LIF）与 `threshold-layers.js`，回路执行器和链上镜像共用 |
| 浏览器训练 | `frontend/training/` | `run.js`（调度、回合来源、选模、经 `runEpisodes` 的验证）、`reinforce.js`、`cross-entropy.js`、`hinge.js`（三者经 `createLockstep` 的 `decide` 展开回合）、`train.js`（按 `METHODS` 校验后分派）、`dense-core.js`（QAT / STE / BPTT）、`quantize.js`（每个区域的 scale、k、阈值和截断计数）。在 Worker 里运行，没有场景代码 |
| Python 训练 | `training/bundle_env.py`、`training/bundle_loop.py`、`training/bundle_train.py`、`training/workspace.py` | 运行器孪生（`create_env`，按 lane 批量）。回路执行器孪生（`create_loop`、`run_episodes`、整数执行器）。三种方法（经锁步运行器孪生 `Session.run_steps`）与 CLI。同源 Workspace 服务 |
| 模板与产物 | `frontend/templates/` | 内置 YAML、内置产物（`artifacts/`）及其生成脚本与测试 |
| 画布 | `frontend/editor/`、`frontend/graph_app.js`、`frontend/ui/template-library.js` | 一个宿主节点组件 + 每种模块一个内容组件、组合节点（回路框）、两种线、模板库抽屉、调色板、持久化 |
| 链上 | `frontend/module-chain.js`、`contracts/src/modules/` | 部署（权重块 + 模块）、核对、step。Roles、Factory 与它的代理（含引擎版本列表）、两个引擎、模块实现 |

## 10. 内置模板与产物

| 模板 | 方法 | 回路体 | 内置产物（评估器分区上的确切分数） |
|---|---|---|---|
| `mining-task` 挖矿任务 | REINFORCE | 185 → 32 → 7 FF 网络 → argmax 读出 | 没有内置产物。模板配方：种子 1，600 轮，浏览器 JS 训练器 |
| `memory-map-task` 记忆地图 | 交叉熵（最短路教师） | 55 → 32 → 7 LIF 网络 → argmax 读出 | 没有内置产物。模板配方：3000 轮 |
| `arithmetic-add4 / sub4 / mul4` 四位加 / 减 / 乘 | hinge | 8 → [12] / [16] / [112] → 5 / 5 / 8 阈值网络 → bits 读出 | `arithmetic-add4 / sub4 / mul4`：exact 与 bitAccuracy 都是 1（256 组全对） |
| `arithmetic-combiner` 组合器 | REINFORCE（只训练策略） | 策略网络只有一个工具层。决策头读 11 个输入位，选 ADD4 / SUB4 / MUL4 之一（冻结网络经位读出的 `run`）。然后它交出 8 个数据位 → 结果位 → bits 读出（8 位） | `arithmetic-combiner-policy`：exact 1 |

- 有六个任务模板（另有空白的 `training-module`）和四份内置产物（ADD4 / SUB4 / MUL4 与组合器策略，`frontend/templates/artifacts/*.json`）。挖矿和记忆地图不带内置产物。原因是：训练出的模型是用户的结果，每个人的训练都不同，所以任务模板只带规则。

  `artifacts.test.js` 对这四份产物各检查两点：
  - 产物的 `bundle.env` 与当前模板新实例的评估器快照 `env` 相等。
  - 模板自己的评估器在它接的分区上得到上表的确切分数。评估时，回路里每个网络用它接受的产物。分区对四位算术是全部 256 组，对组合器是测试分区。

  对组合器，测试还检查以下几点：
  - 按连线顺序，工具是 ADD4、SUB4、MUL4。
  - 在 154 道测试题里，工具层对每个 `+` 选 ADD4，对每个 `-` 选 SUB4，对每个 `*` 选 MUL4。
  - 交出的数据位正是 a‖b。
  - 每道题都答对。

  分数是确切的：它们只依赖模板程序、IR、运行器、回路执行器和整数引擎。这几处的任何漂移都是行为变化。
- **组合器**：分区是 `op ∈ {*, +, −}` × a × b 的 768 道题。分区按枚举下标 mod 5 分成训练（余 2、3、4）、验证（余 1）和测试（余 0）。`input = oneHot(op, 3) ‖ a[4] ‖ b[4]`（11 位）。策略网络是 `layers: [{ tools: tools, data: 8 }]`。工具层的决策头直接读这 11 位，选一个冻结的算术网络，并决定交给它的 8 个数据位。这个网络的结果位（零扩展到 8 位）读成整数，就是答案。

  奖励只看答案对不对（`transition.success`）。决策头直接读输入。如果在决策头前加一层隐藏层，这层要把 8 个操作数位原样带过去。

  配方：REINFORCE，100 轮，lr 0.1，entropy 0.03，replicas 8，seed 1，evalEvery 10。验证 exact 在第 70 轮到 1，测试 154 题全对。
- **挖矿**（规则见 ADR 0018）：16×16 网格，63 步，背包容量 3。空地 / 土 / 煤 / 金的概率是 0.67 / 0.2 / 0.1 / 0.03。价值是土 1、煤 2、金 10，在基地结算，目标价值 1。环境参数 `deliverEnds`（交付后结束回合）默认关闭。关闭时，交付清空背包，回合继续到步数上限，所以可以多次往返。感知参数只有 `radius`（方形视野半径，1..4，默认 4）。

  `input` 共 185 位，内容如下：
  - 9×9 方形视野里每格的煤和金各一位（81 + 81 位）。土和空地读 0。半径外或地图外的格读作空地。
  - 基地的相对 x / y 偏移（各 5 位，+15）。
  - 背包里的土 / 煤 / 金（各 2 位，到 3 饱和）。
  - 背包已满（1 位）。
  - 剩余步数（6 位）。

  `input` 不给最近目标的方向或距离。默认网络是 FF 185 → 32 → 7（`dense-policy`，int8 权重）。奖励是结算价值的增量。成功 = 至少交付一次（目标价值 1）。
- **记忆地图**：默认网络是 LIF 55 → 32 → 7，`weightBits: 16`。模板配方是交叉熵，3000 轮。测试分区是 35 个目标 × 延迟 0/1/2/4/8/16 = 210 回合。每次训练、每个种子的结果都不同。
- 模板或权重格式改动后，运行 `node frontend/templates/artifacts/generate.mjs`。这个脚本用 JS 训练器训练四份内置产物，每份都在各自模板新实例的训练器快照上训练。种子固定，所以每次得到同一份产物。训练组合器策略时，脚本把冻结网络的 `artifact` 设为刚训出的 ADD4 / SUB4 / MUL4。四份都是 int8：ADD4 / SUB4 / MUL4 的验证在第 400 / 507 / 1341 轮到 1，组合器策略在第 70 轮到 1。四份都没有截断。

  然后把打印出的 id 抄进 `arithmetic-combiner.yaml`，这个文件钉住这些 id（工具网络的 `artifact`、策略候选的 `accepted`）。如果 id 不一致，`artifacts.test.js` 失败。
- 调色板里的示例（标题“示例”）：六个任务模板各用 `preset` 声明一个示例。挖矿和记忆地图不接受产物，所以放置后网络没有权重，要先训练。ADD4 / SUB4 / MUL4 各接受自己的产物。组合器的三个工具网络选定各自的内置产物，组合器还接受策略产物。

## 11. 正确性与性能

### 正确性检查

| 检查 | 钉住什么 |
|---|---|
| `frontend/ir/fixtures/programs.json`（`ir.test.js`、`training/test_ir.py`） | JS 与 Python 的 IR 结果逐 lane 相等，包括报错归属、有符号零与 u32 边界 |
| `training/fixtures/bundle-env.json`（运行器 / 回路执行器的对拍语料。`bundle-env.mjs` 只用浏览器代码生成它。JS 侧 `training/fixtures/bundle-env.test.mjs` 重跑每个提交的用例。Python 侧 `test_bundle_env.py`、`test_bundle_train.py` 重放同样的用例） | `envs`：脚本回合（没有 `init` 的场景、读整张表目标的时间窗回合），每步的输入位、转移与目标。`loops`：整回路在固定整数模型上的贪心回合（冻结的上游网络喂另一个网络）。它记录每步的输入位、每个求过的值、`ran`、动作、转移和每个网络的电位，以及锁步运行器的汇总。`intercepted`：训练快照在锁步运行器里运行，由脚本决定被训练网络的结果。脚本给出的结果有槽、分数、含非 0/1 值的位、工具层记录、读表目标和在不同步结束的 lane。它记录每步交给被训练网络的输入位与目标位、它的结果、动作、带 `loop` 的转移与奖励。`errors`：两边都必须拒绝的拦截结果与快照。`partitions`：分区条目的回合（含枚举 `{ mod, rem }`）。`validations`：手写候选在两种准确率规则下的贪心验证（hinge：每个作了决定的步。交叉熵：目标有置位的步） |
| `training/fixtures/replays.json`（`replays.mjs` 生成，要运行 Python 训练器。`bundle-env.test.mjs`、`test_bundle_train.py`） | Python 训练出的模型在浏览器执行器里的重放。模型是门任务的三种工具层快照和内置组合器。重放记录验证汇总，以及每步的动作和工具层记录。Python 重放必须得到相同的结果。每条记录带着训练它的快照 |
| `training/fixtures/bundles.json`（`test_bundle_train.py`） | Python 的每种训练方法学会各自的 fixture 快照：计数任务上的 REINFORCE / 交叉熵、两位加法上的 hinge，以及一个策略的 REINFORCE（`frozenGates`）。这个策略读输入位和两个冻结阈值网络（AND / OR）的输出。导出的模型能复现验证指标 |
| `frontend/templates/artifacts/artifacts.test.js` | 第 10 节：四份内置产物（ADD4 / SUB4 / MUL4、组合器策略）的环境与确切分数，以及组合器的工具选择与数据位 |

### 性能

挖矿模板还没有 CPU 剖面。每一步的主要工作如下：

- **挖矿的输入程序**。它每步用 IR 的 `range(81).map` 取出以智能体为中心的 9×9 视野方块（81 格）。然后它把煤和金各编成 81 位，再拼上基地偏移、背包和剩余步数。
- **LIF 训练**在 JS 侧走 `dense-core.js` 的 BPTT 路径，与 IR 无关。

下一步有两项工作：

- 测 JS 与 Python 生成代码在挖矿模板上的剖面。先做这一项。
- 加快 `dense-core.js` 的 BPTT 路径。

## 12. 已知限制

- **回路不上链**：部署按单份产物进行（ADR 0014）。工具层里的代码工具不能部署（ADR 0010 §11）。
- **只有三种损失**：自定义损失需要在 IR 上自动求导（ADR 0009 的“能力 B”）。工作台不提供这个功能。目前没有模板需要三种方法以外的损失。
- **画布规模**：挖矿展开 18 个模块，记忆地图 17 个，ADD4 / SUB4 / MUL4 各 12 个，组合器 18 个。这些模块都在一个训练模块分组里，分组里有“回路”分组。放置时，训练模块和它的“回路”分组展开（预制模块，ADR 0011）。折叠后，只露出候选的产物。展开后，子画布里的成员按连线深度分层排布，左栏的段落不参与整理。工具栏的“整理”按实测尺寸重排。
- **性能**：见第 11 节。调用线不经过画布分派：训练和执行先把快照编译成闭包（浏览器）或生成的批量函数（Python），再运行。耗时在程序执行本身。
