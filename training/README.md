# training

**中文** · [English](README.en.md)

依赖：`requirements.txt`（numpy）和 `requirements-torch.txt`（PyTorch，快照训练器使用）。

工作台的 Python 侧有四个文件：

- `ir.py`：程序。
- `bundle_env.py`：环境运行器。
- `bundle_loop.py`：回路执行器。
- `bundle_train.py`：训练器。

`workspace.py` 把这四个文件作为同源服务对外提供。这四个文件只消费**训练快照**（`neurom-bundle`），不含任何场景代码。场景是快照里的程序，回路是快照里的节点表。面向用户与 AI 的用法见 [模块训练指南](../docs/ai-module-training.md)。设计见 [ADR 0009](../docs/adr/0009-loops-and-training-modules.md)。

## 快照协议

| 文件 | 做什么 |
|---|---|
| `ir.py` | `neurom-program` 的 Python 实现：`check(program, param_types, exact)`、`compile(program, param_types, exact)` → `run(args, batch, mask)`。`compile` 为每个通过检查的程序生成一个 numpy 函数。它在一个只含这个程序的辅助函数的命名空间里 exec 这个函数。所有值按 lane 批量：number / boolean → `ndarray[B]`，vector → `[B, w]`，record → dict，table → 共享列 + 每 lane 的上下界。惰性的 `select / and / or` 在掩码下求值。精确层的结果与 JS 逐位一致（`test_ir.py` 用 `frontend/ir/fixtures/programs.json` 做差分） |
| `bundle_env.py` | `frontend/core/runner.js` 的孪生：`create_env(env_bundle, tables=None)` → `reset(starts)` / `input()` / `step(actions)` / `done` / `t` / `state` / `full_table()`。场景协议是 `init? / input / step / budget`。`step` 返回批量的 `Transition = {prev, action, next, done, truncated, success}`（`truncated = !done && t+1 ≥ budget`）。表视图：`input` 读行 ≤ cursor，`step` 读行 ≤ cursor+1，目标读整表。运行器给已结束的 lane 加掩码 |
| `bundle_loop.py` | `frontend/core/loop.js` 的孪生：`create_loop(loop_bundle, models)` → `reset(B)` / `step(bits, mask, intercept)` → `{action, values, ran, tools}` / `states()`。它按每个 lane 的需求驱动。冻结网络运行整数执行器（`dense_step` / `layers_scores`）。每个区域 z = (Σ W·x)·2^k + f·b，k 是这个区域自己的移位。FF 在 z ≥ 1 时发放，每个 LIF 普通层按自己的阈值发放。稠密层列表与工具层的行为与 `frontend/runtime/dense-policy.js` 一致。这包括：LIF 分段、贪心决策头、只运行被选中的工具。网络工具经它的位读出运行，程序工具经 `ir.py` 运行。任何冻结网络都可以是工具：FF、LIF、自带工具层的网络（ADR 0014）。网络的状态是它自己的 LIF 电位，后面先按工具层顺序、再按连线顺序接上各工具的状态。网络工具的状态递归地按同样的方式排布。代码工具没有状态。网络工具的状态只在它被选中的 lane 与步上推进。`reset` 随会话把这个状态清零。`states()` 给出每个网络的完整状态（`ToolCaller`）。`intercept` 把被训练的网络交给训练器。训练器给出的槽必须是 0..O−1 的整数。给出的位必须恰好 O 位，按非零规整为 0/1，与 `loop.js` 相同。回路有工具层时，`transition(tr, out)` 加上 `loop.<标题>.<端口>`（ADR 0010 §10）。`run_episodes(env, lx, starts, reward, intercept, on_step)` 是唯一的贪心回合运行器 |
| `bundle_train.py` | 三种方法在整个回路上训练 `loop.trained`。`reinforce`：dense，奖励目标 `fn(Transition)`，argmax 读出。最后一层是工具层时，`reinforce` 用 bits 读出。只有 `reinforce` 能训练工具层：采样的选择和数据位进入同一个策略梯度。每个 lane 从自己的工具状态调用工具。工具状态在每轮回合开始时清零，只在选中这个工具的步上推进。校准从静息状态调用工具。`cross-entropy`：dense，目标掩码 `fn(State[, table])`，argmax 读出。`hinge`：threshold 层，精确目标位，bits 读出。`hinge` 把训练分区的每个回合只展开一次，不看 episodesPerEpoch / replicas，与浏览器一致。验证全对时，`hinge` 提前停止。稠密网络是层列表（任意多个普通层、工具层）。其余网络冻结。训练器按结构的 `weightBits`（8 \| 16，ADR 0015）做 torch QAT。参数是实数单位的影子。`quantize_region` 在每次前向时量化每个区域。区域是：普通层、工具层的选择头与数据头、输出层、阈值层。每个区域有自己的 scale s = Q / max\|W\| 和移位 k。偏置以 s·2^k 取 int16。LIF 层的阈值是它自己单位下的实数 1.0。FF / LIF 用 STE + 三角代理梯度 + BPTT。阈值层用 boxcar STE。验证与选模用贪心的整数回路。结果是 `{model, evaluation, provenance}`。CLI：`--run-dir DIR` 读 `bundle.json`（+ `tables.json`、`run.json`），打印 JSON 行进度，写 `result.json` |
| `workspace.py` | 同源服务：`GET /api/session`、`POST /api/runs`、`GET /api/runs[/:id]`、`GET /api/runs/:id/events`（SSE）、`DELETE /api/runs/:id`、`POST /api/artifacts`。`POST /api/runs` 在服务端校验快照。环境读数据集时，请求必须带上数据表的行 `tables`。服务把这些行随运行保存。同一 id、不同哈希时返回 409。每个运行有一个私有目录，子进程是 `bundle_train.py`，默认并发 2。边界：loopback、Host / Origin、令牌 |
| `bench_bundle_train.py` | `BUNDLE.json --epochs N [--profile]`：测量训练器每轮的耗时（不含验证），可以附 cProfile |
| `bench_ir.py` | IR 微基准（生成函数的 lanes / s） |
| `fixtures/bundle-env.mjs` | 只用 JS 生成两份文件：运行器 / 回路执行器的对拍语料 `fixtures/bundle-env.json`，以及 `fixtures/bundles.json`（训练快照）。对拍语料包括脚本回合、贪心回路轨迹和锁步运行器里的回合。在锁步运行器的回合里，脚本决定被训练网络的输出。语料还包括两边都必须拒绝的用例、分区、两种准确率规则下的验证。`fixtures/parity.mjs` 记录每个用例，`fixtures/bundle-env.test.mjs` 在 JS 里重跑用例。要重新生成，运行 `node training/fixtures/bundle-env.mjs` |
| `fixtures/replays.mjs` | 生成 `fixtures/replays.json`：Python 训练出的模型（带着训练它的快照）在浏览器执行器里的重放。这个脚本要运行 Python 训练器：`NEUROM_PYTHON`，默认用下面的 venv |

```sh
python3 -m venv ~/.cache/neurom-venv
~/.cache/neurom-venv/bin/python -m pip install -r training/requirements.txt -r training/requirements-torch.txt
~/.cache/neurom-venv/bin/python training/workspace.py --port 18766       # 同源打开 http://127.0.0.1:18766/
~/.cache/neurom-venv/bin/python training/bundle_train.py --run-dir DIR   # 离线训练一份快照
```

结果形状（JS 与 Python 相同）：

- `model` 是被训练网络的模型，格式是下面两种之一：
  - `dense-policy`（FF / LIF）：`weightBits`，每个区域的码 `W`、int16 的 `b`、`scale`、`k`。LIF 普通层各带自己的 `threshold`。没有网络级的 `scale` / `threshold`。
  - `threshold-layers`：`weightBits`，每层的 `W`、int16 的 `th`、`scale`、`k`。
- `evaluation = { metricName, metric, selectedEpoch, curves, validation, quantization, … }`。验证来自整数回路的贪心运行。`quantization` 描述选中的模型：按权重数据（weight blob）里的顺序，每个区域一项 `{ region, scale, k, clippedWeights, clippedBiases[, threshold] }`。
- `provenance = { method, backend: 'python', seed, epochs, bundleHash, recipe, startedAt, durationMs, … }`。

`validate_bundle` 在训练前拒绝有下面任一问题的快照：

- 格式不对。
- 不满足方法要求（对照被训练网络及其读出）。
- 缺少冻结网络的权重。
- 程序类型不符。

结构必须有 `weightBits` 8 或 16。

`validate_model` 检查导出模型与被训练网络的结构一致：

- 码在 `weightBits` 范围内。
- 偏置与阈值层的 `th` 是 int16。
- k 在 0..20。
- `weightBits` 相同。

这些要求与 `frontend/module-chain.js` 部署时的要求相同。

两个后端不承诺训练出相同的权重。同一份整数模型的执行语义必须一致。

## 测试

```sh
~/.cache/neurom-venv/bin/python -m unittest discover -s training -p 'test_*.py'
```

- `test_ir.py`：与 JS 生成的 fixture 差分。
- `test_bundle_env.py` 检查这些内容：
  - 重放的对拍语料逐 lane 与 JS 运行器、回路执行器和锁步运行器一致。每个网络的状态也一致。用例覆盖：
    - 多步截断。
    - 表视图。
    - 冻结的上游网络。
    - 两层 FF / LIF。
    - 在中间 / 最前 / 最后的工具层。
    - 代码工具与网络工具。
    - LIF 网络工具与嵌套网络工具。
  - `Session.run_steps` 的结果一致：
    - 交给被训练网络的输入位与目标位。
    - 给出槽 / 分数 / 位 / 工具层记录后的动作。
    - 带 `loop` 的转移与奖励。
  - 两边拒绝同样的拦截结果与快照。
  - LIF 工具的电位按 lane 保留，只在被选中的步上推进，`reset` 把它清零。
  - 嵌套工具能运行，它的工具状态排在调用者的状态里。LIF 选择网络的状态是自己的电位，后面接工具的状态。
  - `quantize_region` 在每个 `quantizations` 用例上与 JS 量化器完全一致。
- `test_bundle_train.py` 检查这些内容：
  - 三种方法各学会一个 fixture 任务。
  - 两层网络能用每种稠密方法训练。
  - REINFORCE 能经工具层训练：
    - 门任务。
    - 读 `transition.loop` 的奖励。
    - 嵌套网络工具。
    - 两步回合上的 LIF 网络工具。
    - 内置组合器达到验证 1。
  - 在 weightBits 8 与 16 下，稠密与 hinge 训练器的前向就是整数步。这包括 LIF 电压。有 LIF 工具时，也包括每个 lane 的工具状态。
  - `quantize_region` 与手算值一致：.5 向上取整、k、偏置截断、阈值层的偏置范围、LIF 阈值。
  - 策略能在一个小回路上训练。这个小回路读两个冻结网络的输出。
  - 两种准确率规则下的验证与浏览器一致。Python 训练的工具层模型也与浏览器一致。
  - hinge 把种子分区的每个回合只展开一次。
  - 导出模型能独立复现验证指标。`evaluation.quantization` 列出每个区域，没有截断的权重。
  - 取消与拒绝正确。
- `test_workspace.py`：用真实子进程测试提交 / SSE / 取消 / 导入 / 边界。读数据表的快照带着它的行提交、训练，并在重启后读回。
