# 给用户与 AI 的模块训练指南

**中文** · [English](ai-module-training.en.md)

训练的输入是一份**训练快照（bundle，`neurom-bundle`）**。训练器沿着自己的输入收集下面的内容，组成一份规范 JSON：

- 环境 `env`：训练器驱动的回路接了场景模块。`env` 包括这个场景模块编译出的每段程序，以及这些程序读到的输入和常量的值。`env` 还包括场景导出的步数预算 `budget` 和动作表、驱动分区的回合种类和数据表。
- 回路 `loop`：回路体的每个节点。冻结网络带着已接受的整数模型，被训练网络的模型留空。
- 分区、学习目标、选模指标和配方。

快照里没有单独的参数。参数只以程序绑定的静态值出现。浏览器 Worker、Python Workspace 和离线 CLI 使用同一份快照。场景内容是快照里的程序，不是训练器代码。系统概述见 [design.md](design.md)，术语见 [CONTEXT](../CONTEXT.md)。

执行器和训练方法仍有限制：不支持任意 PyTorch 结构、任意上传脚本或自动部署。

## 1. 先选对训练方法

训练器训练 `loop.trained` 指向的那一个网络。这个网络的读出是回路体里使用它 `scores` 的那个读出。回路里的其他网络用已接受的权重冻结运行（整回路训练，见第 3 节）。

| 方法 | 被训练网络与读出 | 学习目标签名 | 产出模型格式 |
|---|---|---|---|
| `reinforce` | `dense-policy`（FF / LIF），`argmax` 读出（最后一层是工具层时用 `bits` 读出）。带工具层的网络只能用这个方法训练 | 奖励 `fn(Transition) → number` | `dense-policy` |
| `cross-entropy` | `dense-policy`，`argmax` 读出 | 目标 `fn(State[, Table]) → bits[O]`（掩码，每一步之前对当前状态调用） | `dense-policy` |
| `hinge` | `threshold-layers`，`bits` 读出 | 目标 `fn(State[, Table]) → bits[O]`（精确位） | `threshold-layers` |

学习目标和选模指标使用下面的类型：

- `Transition = { prev: State, action, next: State, done, truncated, success }`。
- 回路里有带工具层的网络时，`Transition` 再加一个字段 `loop: { <网络标题>: { <工具端口>: { choice: number, data: bits[D], result: bits[R] } } }`（ADR 0010 §10）。这个字段给出每个工具层这一步选的工具、交给工具的数据位和工具返回的结果位。训练时，这些值是被训练网络采样出的决定。评估和执行时，这些值是执行器的决定。在这样的回路里，网络标题必须唯一。
- 选模指标是 `fn(Episode) → number`，其中 `Episode = { initial, final, steps, success, return }`。
- `Table` 是整张数据表。只有驱动分区接了数据集时才有 `Table`。

FF / LIF 决定模型结构与状态语义，不决定用监督学习还是强化学习。内置模板使用下面的方法：

- 挖矿：REINFORCE。
- 记忆地图：交叉熵（教师是最短路）。
- ADD4 / SUB4 / MUL4：hinge。
- 组合器：REINFORCE，训练组合器策略网络的工具层（工具 ADD4 / SUB4 / MUL4 冻结）。

如果方法要求（`frontend/core/kinds/trainer.js METHODS`）不满足，训练器在画布上显示问题，Python 服务在排队前拒绝这次运行。

模型格式：

- `dense-policy`：`{ format, kind: 'feedforward'|'lif', inputs, outputs, weightBits, ticks, leak_shift, reset, layers: [{ hidden, W, b, scale, k, threshold? } | { tools, K, D, R, Wc, bc, scale_c, k_c, Wd, bd, scale_d, k_d }, …], output?: { W, b, scale, k } }`。这个格式没有任务字段。字段规则如下：
  - 区域：每个区域带自己的 `scale` 和 `k`。区域是普通层、工具层的选择头和数据头、输出层。
  - 码：`W` 是 `weightBits`（8 或 16）位的码，`b` 是 int16，`k` 在 0..20。`scale` 是每个实数单位的码数，只作记录。
  - 阈值：只有 LIF 普通层带 `threshold`（1..2^31 − 1）。FF 普通层在值 ≥ 1 时发放，没有这个键。FF 模型的 ticks 是 1，leak_shift 和 reset 是 0。
  - 工具层：工具层条目（ADR 0010）是它前一层上的决策头，有 K 个选择 logit 和 D 个数据位 logit。决策头对应接进端口 `tools` 的工具，R 是这些工具最宽的结果。如果最后一层是工具层，模型没有 `output`（outputs = R）。
  - 权重数据：权重数据按层的顺序排列。先是每个普通层的 `W | b` 和每个工具层的 `Wc | bc | Wd | bd`，最后是输出层的 `W | b`。
- `threshold-layers`：`{ format, inputs, outputs, weightBits, layers: [{ W, th, scale, k }] }`。`W` 是 `weightBits` 位的码，`th` 是 int16。
- 整数语义：每个区域计算 z = (Σ W·x) · 2^k + f · b。f 是偏置系数：LIF 层之后是 ticks，其他情况是 1。阈值层计算 (Σ W·h) · 2^k − th。没有网络级的 `scale` / `threshold`。存入和导入产物时，系统都按产物的网络校验产物，`weightBits` 必须和网络配置一致。

宽度由快照决定：

- `inputs` 是被训练网络在 `loop.nodes` 里的结构宽度。它等于接到网络 `in` 的位宽，例如场景 `input` 返回的位宽 I，或位线切出的宽度。
- `outputs` 来自网络的读出。

链上引擎 `DensePolicyEngine` 按宽度参数化。部署前，系统检查宽度在 1..65535 之内，并检查每层最多 65535。权重不限大小，按需要分成多个权重块。

## 2. 拿到一份快照

- **从画布**：把训练器的后端设为 `python`，然后点击训练。画布把快照提交给同源 Workspace。服务在 `~/.cache/neurom-workspace/runs/<id>/bundle.json` 保留一份不可变副本，`GET /api/runs/<id>` 也返回这份副本。
- **从产物**：任何 `neurom-module` 产物的 `bundle` 字段就是训练这个产物的快照。在候选模块导出产物 JSON，或读取 `frontend/templates/artifacts/*.json` 里的内置产物。内置产物只有四位算术 ADD4 / SUB4 / MUL4 和组合器策略。它们的快照是当前模板训练器的快照，`generate.mjs` 重训这些产物。挖矿和记忆地图没有内置产物，从模板构建它们的快照（见下一条）。
- **从模板**：在 Node 里用 `instantiateInto`（`frontend/core/template.js`）实例化一份模板。然后调用 `buildBundle(graph, trainerId, { artifacts })`（`frontend/core/bundle.js`）。`artifacts(id) → artifact | null` 查找冻结网络已接受的产物。测试就是这样做的。

快照的结构：

```
format: 'neurom-bundle'
env:        { programs: { init?, input, step }, budget, actions, start: 'seed'|'enumerate'|'window',
              types: { Start, State, Transition, I, table? }, tables? }
loop:       { I, action: Ref, nodes: { <id>: 回路节点 }, trained: <网络 id> }
objective:  { kind: 'reward'|'target', program, bound, boundTypes, exact: false }
selection:  { program, bound, boundTypes, exact: false } | null
partitions: { training, validation? }
recipe:     { method, epochs, lr, seed, replicas, … }
```

`Ref = { node, port }`。回路的输入位是 `{ node: '$input', port: 'bits' }`。回路节点有三种：

- `network { structure, in, model, artifactId, tools?, title? }`：只有被训练网络的 `model` 是 `null`。带工具层的网络在 `tools` 里按端口列出它的工具，顺序是连线顺序。`title` 是这个网络在 `Transition.loop` 里的键。
- `readout { readout, scores }`。
- `bits { parts, in }`。

每段程序是 `{ program, bound, boundTypes, exact }`：IR 程序，加上它读到的文件级名字的静态值和类型。

快照的哈希是 `bundleHash = sha256(规范 JSON)`。`env` 单独的哈希是环境身份（`envHash`）。`env.types.Transition` 是场景的转移。奖励收到的类型是这个转移再加上 `loop` 字段，`loop` 字段由 `loop` 段推出（`core/loop.js transitionTypeOf`）。候选模块接受一份产物需要下面的条件：

- 产物的 `bundle.env` 和当前训练器快照的 `env` 相同。
- 被训练网络的结构相同。
- 被训练网络的读出规格相同。

## 3. 整回路训练

三种方法都在整条回路上运行。每一步按下面的顺序进行：

1. 运行器给出输入位。
2. 回路执行器按需求值，并运行冻结网络，直到需要被训练网络。
3. 执行器把被训练网络的输入位交给训练器（拦截）。
4. 训练器给出这个网络读出的结果。
5. 执行器把这一步算到回路的动作。
6. 运行器调用 `step`。

各方法和相关规则：

- **REINFORCE**：
  - 读出：对 softmax(scores / (ticks · gain)) 采样一个读出槽，并记下这个槽的 log 概率。gain 是输出层的 gain（见下面“量化”）。
  - 奖励：奖励按每步的 `Transition` 结算，回报算到回合终点。基线是每步的 EMA 基线，只在运行了该网络的 lane 上计算。LIF 在回合内做 BPTT。
  - 工具层（ADR 0010 §6）：训练时，从 K 个选择 logit 的 softmax 采样选择，每个数据位按自己的 sigmoid 采样。只有选中的工具运行。每个工具决策和读出槽的 log 概率进入同一个策略梯度。如果最后一层是工具层，动作就是工具结果，只有工具决策有 log 概率。`entropy` 覆盖全部决策。
  - 梯度：梯度经过工具层之前的普通层流进决策头。在工具层之后的层里，梯度从动作流到 `结果 ‖ 前一层`。结果是常数，“前一层”的位直通回那一层的脉冲计数。工具本身不传梯度。LIF 在每一段内做 BPTT，和执行时的分段一致。
  - 初始化：决策头的初始化和其他层相同（均匀 ±√(3/fanIn)，偏置 0，不校准）。
  - 回放：前向和 `runtime/dense-policy.js` 逐位相同，所以导出的模型按训练时的贪心决策回放。
- **交叉熵**：每一步之前，计算掩码 `target(state[, table])`。有标签的步（掩码至少有一位）以 1 − exploration 的概率给出一个随机的正确槽，其他情况给出均匀随机的槽。无标签的步不计损失。
- **hinge**：
  - 教师强制：训练分区的每个回合以教师强制运行一遍。读出直接给出目标位。episodesPerEpoch / replicas 不适用，JS 与 Python 相同。
  - 数据行：每个要求被训练网络的步成为一行，X = 网络的输入位，Y = 目标位。
  - 损失：然后计算全批 hinge 损失。隐藏层直通估计的宽度是 `surrogateWidth`。平均梯度按全局范数裁剪到 `gradClip`，0 表示不裁剪。
  - 停止：验证分区全对时，训练提前停止。
- **量化**（ADR 0015，JS `frontend/training/quantize.js`、Python `bundle_train.quantize_region`，两边相同）：
  - 配置：网络配置 `weightBits` 选 8（默认）或 16。配置里没有 `scale`。
  - 浮点影子：参数是实数单位的浮点影子。每次前向都重新量化每个区域。
  - scale 和 k：scale s = Q / max|w|（Q = 127 或 32767），取整时 .5 向上。偏置是 int16，单位是 1/(s·2^k)。k 是 0..20 里让偏置放得下的最大值。LIF 还要求阈值不超过 int32。LIF 普通层的阈值 = round(s·2^k)，也就是实数 1.0。
  - 梯度：训练前向用 `W`·2^k 和 `b`，和整数执行逐位相同。STE 梯度乘 gain = s·2^k。交叉熵的 logit 也是 scores / (ticks · gain)。hinge 的 z 用实数单位。
  - 截断：按构造，权重不会截断。如果偏置比该层最大的权重还大（k = 0 也放不下），偏置会截断，系统记录截断的个数。
- **验证**：训练器把候选的整数模型放进回路，其他网络仍用各自已接受的模型。然后训练器用评估器的那个贪心整数运行器运行验证分区（JS `frontend/core/loop.js runEpisodes`，Python `training/bundle_loop.py run_episodes`）。没有选模指标时，奖励目标按验证平均回报选模，监督目标按有标签步上贪心读出的准确率选模。

## 4. 离线训练：`bundle_train.py`

```sh
python3 -m venv ~/.cache/neurom-venv
~/.cache/neurom-venv/bin/python -m pip install -r training/requirements-torch.txt
mkdir run-1 && cp bundle.json run-1/
echo '{"bundleHash": "0x…"}' > run-1/run.json          # 可选；写进 provenance.bundleHash
~/.cache/neurom-venv/bin/python training/bundle_train.py --run-dir run-1
```

CLI 读取下面的文件：

- `DIR/bundle.json`。
- `DIR/tables.json`（可选）：`{datasetId: {列: [数]}}`。环境读数据集时必须有这个文件。
- `DIR/run.json`（可选）：提供 `bundleHash`。

CLI 把 `{"type":"progress", …}` JSON 行写到 stdout。训练结束时，CLI 写入 `DIR/result.json`：

```json
{ "model": { … }, "evaluation": { "metricName": "validationMeanReturn", "metric": 2.9, "selectedEpoch": 240, "curves": { "loss": [], "metric": [] }, "validation": { … }, "quantization": [{ "region": "layers[0]", "scale": 52.1, "k": 9, "clippedWeights": 0, "clippedBiases": 0 }, …] }, "provenance": { "method": "reinforce", "backend": "python", "seed": 1, "epochs": 300, "bundleHash": "0x…", "recipe": { … }, "startedAt": "…", "durationMs": 1234 } }
```

`evaluation.quantization` 给选中模型的每个区域一项，顺序是权重数据的顺序：`{ region, scale, k, threshold?, clippedWeights, clippedBiases }`。`region` 的形式是 `layers[0]`、`layers[1].choice`、`layers[1].data`、`output`。只有 LIF 普通层带 `threshold`。浏览器训练器的面板显示同样的内容，例如“int8 每层截断（权重/偏置） layers[0] k 9 · 0/0 …”。截断数不是 0 表示有偏置放不下。导出的模型和训练时一样运行，但建议检查这些偏置。

库形式：

- `training/bundle_train.py`：`train_bundle(bundle, on_progress, tables, bundle_hash)` 是同一个入口。`validate_bundle(bundle, tables)` 在训练前检查格式、方法要求和每段程序的类型。`validate_model(model, network)` 检查导出的整数模型和快照里的网络结构一致。
- `training/bundle_env.py`：`frontend/core/runner.js` 的孪生。`create_env(bundle['env'], tables)` → `reset(starts)` / `input()` / `step(actions)`，按 lane 批量运行。`step` 返回批量的 `Transition`，环境掩码已结束的 lane。
- `training/bundle_loop.py`：`frontend/core/loop.js` 的孪生。`create_loop(bundle['loop'], models)` → `reset(B)` / `step(bits, mask, intercept)` → `{ action, values, ran, tools }`。`intercept = (网络 id, fn)`，`fn(x, lanes)` 返回 `{'scores'}`、`{'slot'}` 或 `{'bits'}`。`run_episodes(env, lx, starts, reward, intercept, on_step)` 是唯一的贪心回合运行器。

可以用这三个模块做自己的训练器或评估。

种子、每轮回合数、副本数、学习率和其他配方字段都在 `bundle.recipe` 里。要改配方，就改快照，快照的哈希也随之改变。不要在训练脚本里另加参数。

## 5. Workspace：网页与 AI 共用的接口

```sh
~/.cache/neurom-venv/bin/python training/workspace.py --host 127.0.0.1 --port 18766
```

打开 `http://127.0.0.1:18766/`。页面连接同源的 `/api`。服务有下面的限制：

- 只允许 loopback。
- 任何 `Origin` 必须是服务自己的来源。
- 改状态的请求要带 `X-Workspace-Token`。服务启动时打印这个 token，也把它写在 `~/.cache/neurom-workspace/session-token`（权限 0600）。

| HTTP | 请求 / 结果 |
|---|---|
| `GET /api/session` | `{ token, capabilities: { methods, engines }, limits }` |
| `POST /api/runs` | `{ run: { id, bundle, bundleHash[, tables] } }` → `{ run }`。服务端先校验快照，再排队。环境读数据集时，`tables` 必须带上每张表的行（`{datasetId: {列: [数]}}`，随运行存为 `tables.json`），缺少时返回 400。同 id 不同哈希返回 409，同哈希返回已有的运行 |
| `GET /api/runs` | `{ runs: [ … ] }`（不含结果，带 `hasResult` 标记） |
| `GET /api/runs/:id` | 运行记录。运行完成时，记录包含 `result: { model, evaluation, provenance }` |
| `GET /api/runs/:id/events?token=…` | SSE：`progress` / `status` / `complete` |
| `DELETE /api/runs/:id` | 取消运行，终止训练进程组 |
| `POST /api/artifacts` | `{ bundleHash, bundle, model, evaluation, provenance }` → 校验，然后存为一条已完成的导入运行 |

运行状态是 `queued | running | completed | failed | cancelled`。子进程就是第 4 节的 `bundle_train.py --run-dir`，每个运行有一个私有目录。默认最多同时运行两个，其余的排队。服务重启时，服务把还没结束的运行标为失败，不会把它们当作成功。

从 AI 提交一份快照只需要 Python 标准库。输入是候选模块导出的产物 JSON，这个 JSON 带着训练它的快照和哈希：

```sh
python - artifact.json <<'PY'
import json, sys, urllib.request, uuid
base = 'http://127.0.0.1:18766'
artifact = json.load(open(sys.argv[1]))
token = json.load(urllib.request.urlopen(base + '/api/session'))['token']
def post(path, body):
    req = urllib.request.Request(base + path, data=json.dumps(body).encode(), method='POST',
        headers={'Content-Type': 'application/json', 'X-Workspace-Token': token})
    return json.load(urllib.request.urlopen(req))
run = post('/api/runs', {'run': {'id': uuid.uuid4().hex, 'bundle': artifact['bundle'], 'bundleHash': artifact['provenance']['bundleHash']}})
print(run['run']['id'], run['run']['status'])
PY
```

`bundleHash` 由客户端给出（`0x` + 64 位十六进制）。服务只用它检查同一个 id 的重复提交是否一致，不重新计算它。如果你修改了快照，自己重新计算哈希（规则见第 6 节）。

页面只跟进自己提交的运行。刷新后，页面重新连接仍在运行的 Python 运行。AI 直接向服务提交的运行和 `POST /api/artifacts` 的结果留在服务端，页面不会自动发现它们。要把结果交回画布，用第 6 节的方式。

## 6. 把结果交回画布

候选模块的“导入”接受 `neurom-module` 产物：

```json
{ "format": "neurom-module", "bundle": { … }, "model": { … }, "provenance": { … }, "evaluation": { … }, "id": "0x…" }
```

`bundle` 是训练这个产物的训练器快照。`model` 是 `bundle.loop.trained` 指向的网络的整数模型。`id` 是其余五个字段的规范 JSON 的 SHA-256。规范 JSON 的规则：

- 键按字典序排列。
- 没有空白。
- 数字按 JavaScript 的 `JSON.stringify` 格式（整数不带 `.0`）。

页面导入时重新计算并核对 `id`。如果不符，页面拒绝这个产物，不会静默接受。在 Python 里生成 `id` 时，先把整数值的浮点数转成 `int`，然后用 `json.dumps(obj, sort_keys=True, separators=(',', ':'), ensure_ascii=False)`。

导入的产物按快照兼容性判断。兼容需要下面的条件：

- `bundle.env` 必须和候选模块所在回路的环境相同。
- 被训练网络的结构和读出规格必须和接它的训练器一致。

不兼容的产物也列出，但标为不兼容，不能接受。接受后，权重流向网络。在回路里，评估器、执行实例和别的训练器（作为冻结网络）使用这个网络。链上部署也能选这份产物。

## 7. AI 不得破坏的语义

1. 不要为了提高分数修改快照里的环境程序（和它们绑定的值）、步数预算、回路体、冻结网络的模型、读出或分区。`env` 进入 `envHash`，整份快照进入 `bundleHash`。所以修改后就是另一个环境或另一次训练，产物接不进原来的回路。
2. 网络只看到场景 `input` 返回的输入位。`input` 不编码隐藏信息（隐藏的目标、视野外的格子），所以网络看不到这些信息。不要把隐藏信息放进 `input`，也不要修改 `input` 让网络看到更多。
3. 只有 `recipe` 是训练侧的自由度，例如种子、轮数、学习率、探索率、副本数。
4. 只训练 `loop.trained`。回路里的其他网络按快照里的模型冻结运行，不要顺带更新这些网络。
5. 把浮点训练分数和导出的整数执行分数分开。`evaluation.validation` 必须来自整数回路执行器的真实结果（贪心读出，冻结网络用各自的模型）。`bundle_train.py` 的验证就是这样计算的。
6. LIF 在一个回合内跨决策保留状态，在回合开始时清零。一步里没有运行的网络保持电位。不要在每个动作前清零，明确的消融对照除外。
7. 对同一份产物，Python、JS 和链上必须得到相同的整数结果。如果没有验证某一侧，明确写“未验证”。
8. 不要声称不同后端训练出逐字节相同的权重。记录实际环境和复现的边界。
9. 保留真实日志和失败结果。如果训练不足、方法不支持或依赖缺失，报告原因。不要用查表冒充学到的模型。
10. 产物 JSON 里不放可执行脚本。快照里的程序是 IR，不是脚本。

## 8. 交给 AI 的任务书模板

```text
目标：在快照 [bundleHash] 上训练回路里的网络 [loop.trained]（[FF/LIF/threshold]）。
快照来源：[导出的产物 / Workspace 运行 id / 模板 id@revision + 训练器 id]；禁止修改 env、loop、partitions、objective。
方法：[reinforce / cross-entropy / hinge]，配方字段 [seed, epochs, lr, …]。
训练预算：[轮次、设备、资源限制]。
评估协议：验证分区上的整回路整数执行（贪心读出，冻结网络用快照里的模型）；报告 metricName / metric / selectedEpoch。
工作目录：[新目录，禁止覆盖已有产物]。
交付：neurom-module 产物 JSON（id 正确）、完整命令与环境、进度日志、整数评估结果、未验证项。
限制：不得改快照刷分；不得生成假权重 / 假结果；不自动部署或发交易。
```
