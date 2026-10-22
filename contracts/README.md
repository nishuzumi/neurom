# contracts

**中文** · [English](README.en.md)

本项目用 Foundry ≥ 1.8.0。`foundry.toml` 已设 `network = "monad"`（Monad 定价、MIP-8 分页存储、128 KB 代码上限）。一个满的权重块是 112 KiB，超过以太坊 EIP-170 的上限 24,576 字节。所以权重块只能部署在放宽了代码上限的链上，例如 Monad（或 `anvil --network monad`）。`optimizer_runs` 设得很高。原因是引擎每一步都运行，而模块是克隆，代码大小只付一次。

| 文件 | 内容 |
|---|---|
| `src/modules/` | 结构见下文（ADR 0014、0016、0017）。包含 `Roles`、`FactoryProxy`、`ModuleFactory`。包含引擎 `DensePolicyEngine` / `ThresholdLayersEngine`，两个引擎共用 `EngineBase`。包含模块实现 `NeuromModule` 和它的克隆 `ModuleClone`。包含接口 `INeuromModule` / `IEngine`。 |
| `test/Modules.t.sol` | 46 个回归测试，覆盖下面这些内容。整数语义：手工模型、任意 I→H→O 宽度、多层 FF / LIF、FF / LIF 的工具层和末层工具层。这些测试都与 JS 整数执行器对照。权重在 int8 范围内的模型，weightBits 8 与 16 各跑一遍。阈值层的分数与激活。每个区域的移位 k 按 Σ·2^k + b 缩放。LIF 各层用自己的阈值。int8 的 −128 / 127 / 负权重与 40 行的内存路径。这几项是手算，或在测试内对照。跨两个权重块的网络。宽度超过 256 的网络（ADR 0021）：动作大于 255 的 FF 1020 → 300 → 300，以及阈值层 300 → 280 → 270。两种权重宽度各跑一遍，与测试内的参考循环对照。第 4 到 7 层在第二个布局词里。Σx 超过 65537 的 int16 求和分批计算。check 拒绝 65536 的宽度。一个 gas 检查确认只调用被选中的工具。网络工具：LIF 工具的电位在调用方会话的状态里。这些电位只在工具被选中时变化，随会话 reset 清零，在会话之间和调用者之间隔离。LIF 选择器自己的状态在前，工具的状态在后。自己带工具层的网络作工具时，它的工具的状态嵌套在内。选 LIF 工具与选 FF 工具的一步 gas，以及每多一层嵌套的 gas。权重块按内容寻址，已有的权重块跳过。一笔交易创建缺的权重块和模块，要么全成，要么全不成。同一块用两次时只发一次。Factory 拒绝没有最新版本的引擎 id、不在该引擎 id 版本列表里的版本和不存在的权重块。Factory 也拒绝坏形状（含 bits / shift / threshold）、不符的权重字节数和非官方工具。Factory 还拒绝嵌套超过 3 层的工具（`depth`）和连同工具超过 256 的状态（`state`）。引擎不能写状态。引擎版本只增不改，只属于一个引擎 id。最新版本必须是已添加的版本。最新版本变了以后，模块仍用自己的版本。部署时可以指定较早的版本。只有 ADMIN 能授予 / 撤销角色和管理版本。只有 UPGRADER 能升级 Factory。ADMIN 可以给自己 UPGRADER。Factory 升级后，`count`、`isModule`、`depthOf`、权重块、按产物的索引和模块实现都还在。所有模块的决策不变。initialize 只能跑一次。owner 是部署者，两步转让，没有别的权力。只有 Factory 创建的克隆是模块。实例 / 调用者 / 会话之间隔离。Monad 规则下两种权重宽度的部署 gas 与 step gas。 |
| `scripts/export_abi.py` | 从 Solidity 生成 `frontend/abi/*.json`（ModuleFactory、NeuromModule、Roles）。支持 `--check` 与 `--out`。 |
| `script/Deploy.s.sol` | 部署 Roles，广播账户持有 ADMIN 和 UPGRADER。部署 ModuleFactory 实现和它的 FactoryProxy，在同一笔交易里初始化。再给每个引擎 id 部署一个版本，添加这个版本并设为最新。返回所有地址。 |
| `script/EngineVersion.s.sol` | `add()`：把一个已部署的引擎版本添加进某个引擎 id（新的或已有的）的版本列表，并设为最新。`setLatest()`：把已添加的版本重新设为最新（见“添加引擎版本”）。 |
| `script/HandOverRoles.s.sol` | `grant()` / `revoke()`：把两种协议角色从广播账户交给多签（见“角色与交接”）。 |
| `scripts/engine-version-check.mjs` | 添加引擎版本前的逐位核对（见“添加引擎版本”）。固定输入集在 `scripts/engine-cases.mjs`。测试是 `scripts/engine-version-check.test.mjs`（`npm test`，候选版本在 `test/VersionCandidates.sol`）。 |
| `scripts/list-roles.mjs` | 只读。列出某个网络上持有 ADMIN 和 UPGRADER 的账户（见“角色与交接”）。测试是 `scripts/list-roles.test.mjs`（`npm test`）。 |

```sh
forge test --network monad -vv          # -vv 打印 gas 测量
forge script script/Deploy.s.sol --rpc-url monad_testnet --private-key $PK --broadcast
python3 contracts/scripts/export_abi.py            # 仓库根目录
python3 contracts/scripts/export_abi.py --check
```

`export_abi.py` 的路径不依赖启动目录。它使用 PATH 中的 `forge`。可以用 `--forge` 或 `FORGE` 指定版本。它要求 Foundry ≥ 1.8.0，这个版本支持项目配置。

本地联调用两个终端，第二个终端在 `contracts/` 下：

```sh
anvil --network monad --port 18545
forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:18545 --unlocked --sender 0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266 --broadcast
```

地址来自部署输出。如果在新启动的 anvil 上用默认账户 0 部署，FactoryProxy（官方 Factory）的地址就是 `frontend/chain.js` 里 31337 的 `factory` 地址。工作台直接用这个地址，不用填。部署到测试网 / 主网后，把地址写进 `CHAINS` 里对应网络的 `factory`。本地开发用上述 Anvil 测试账户。

注意：不要把解锁的节点暴露到公网。否则任何人都能用解锁的账户发交易。

## 结构（ADR 0014、ADR 0016、ADR 0017）

- **权重块**：一种合约，代码只有一个 STOP 字节，后面接至多 114,688 字节（112 KiB）的权重。
  - 112 KiB 是能在 Monad 上一笔交易创建的最大块：创建的 gas 估算 + 10% 仍在单笔交易的 30M 以内。
  - `ModuleFactory.createChunk(data)` 用 CREATE2 创建权重块。salt = `keccak256(data)`，init code 是固定的 `CHUNK_INIT`。`CHUNK_INIT` 回调 Factory 的 `chunkData()` 取回内容。
  - 所以地址只由 Factory 和内容哈希决定。任何人都能用 `chunkAddress(id)` 算出地址。
  - 相同内容只创建一次。已存在的块直接返回，不报错。
- **角色** `Roles`：协议的权力，不可升级。
  - ADMIN 授予和撤销两种角色（`grantRole` / `revokeRole`，事件 `RoleGranted` / `RoleRevoked`），并管理引擎版本。
  - UPGRADER 升级 Factory。
  - 部署者起初持有两种角色。Roles 没有提名-接受。交接就是授予新持有者、核对（`hasRole`）、撤销旧持有者（见“角色与交接”）。
  - 撤销最后一个 ADMIN 不可挽回。
  - 模块的 owner 不是角色。
- **Factory 代理** `FactoryProxy`：官方 Factory 的地址。
  - 它是一个 EIP-1967 代理，实现地址在 EIP-1967 槽位。它把所有调用 DELEGATECALL 给 `ModuleFactory` 实现。所以 Factory 的状态在代理里，升级后还在。
  - 只有 Roles 的 UPGRADER 能调用 `upgradeToAndCall(implementation, data)`。这个 Roles 在构造时固定（immutable），任何实现都碰不到它。
  - 新实现必须报告同一个 `roles()`。升级发出 `Upgraded(implementation)`。代理不封印。
  - 构造函数 DELEGATECALL 一次 Factory 的 `initialize()`。`initialize()` 创建模块实现，所以 `NeuromModule.factory` 是代理。
- **引擎版本**：计算一个引擎 id 的不可变合约，没有代理。
  - `Deploy.s.sol` 给每个 id 部署一个版本：`DensePolicyEngine`（`dense-policy`）与 `ThresholdLayersEngine`（`threshold-layers`）。
  - 同一 id 的所有版本逐位算得一样。改数值就是新 id。
  - Factory 用下面这些函数列出版本：
    - `addVersion(engineId, version)`：只有 ADMIN 能调用。版本不能改，也不能删。一个地址只能是一个 id 的版本。事件是 `VersionAdded`。
    - `setLatest(engineId, version)`：只有 ADMIN 能调用。`version` 必须是该 id 已添加的版本。事件是 `LatestSet`。
    - `versionsOf`、`latestOf`、`engineIdOf`：读取版本信息。
  - 模块用 STATICCALL 调用 `run(kind, inputs, outputs, shape, chunks, tools, state, input)`。引擎自己用 EXTCODECOPY 读权重块，返回 scores、action、counts、voltages。引擎写不了任何东西。
- **模块合约**：Factory 的 `NeuromModule` 实现的一个克隆（`ModuleClone`）。
  - 克隆是 55 字节代码，后面接模块的身份：引擎版本、engineId、artifactId、taskId、kind、宽度、形状、权重块地址、工具。
  - 克隆把调用数据加上身份 DELEGATECALL 给实现，并原样返回结果。
  - 身份在代码里，不能改。读身份不访问存储。
  - 模块终身直接调用自己的引擎版本。谁也改不了这个版本，owner 和协议都不能。
  - 模块自己的存储里有各 (actor, session) 的状态和 `owner()`。`owner()` 起初是部署者。
  - 只有 `nominateOwner` 提名、`acceptOwnership` 接受之后，owner 才转让。owner 没有别的权力。
  - 模块不存钱。付钱的合约（挖矿游戏）读 `owner()`，然后付钱给 owner。
- **Factory** `ModuleFactory.deploy({ engineId, version, kind, inputs, outputs, shape, tools, chunks, artifactId, taskId }, data)`：在一笔交易里部署一个模块。
  - 如果 `version` 是 address(0)，Factory 用 `engineId` 的最新版本。否则 `version` 必须是 `engineId` 列出的版本之一。
  - 交易的顺序：先检查全部条件，再创建 `data` 带来的权重块，最后创建模块。
  - `data[k]` 是第 k 块的内容，它的哈希必须等于 `chunks[k]`。块已存在时，Factory 跳过它。`data[k]` 为空表示块已存在，或者前面的位置已经发了同一块。
  - 模块建不成时，整笔交易回滚，不留下任何块。
  - `checkDeploy(spec, data)` 是只读的同一套检查。它以同样的理由拒绝，什么都不创建。
  - Factory 拒绝下面这些情况（括号里是拒绝理由）：
    - 没有最新版本的引擎 id（`engine`）。
    - 不在 `engineId` 版本列表里的 `version`（`version`）。
    - 创建之后仍不存在的权重块（`chunk`）。Factory 按内容哈希重算地址。
    - 引擎拒绝的形状，例如 `layers` / `hidden` / `ticks`。
    - 权重块总字节数与形状不符（`weights`）。
    - 不是本 Factory 模块的工具（`tool`）。
    - 工具嵌套深于 `MAX_TOOL_DEPTH` = 3（`depth`）。
    - 装不进模块克隆的身份（`args`）。
  - 嵌套上限的原因：一步只递归运行每个工具层选中的工具。每个网络至多 8 个工具层，所以一步至多 Σ_{i=1..d} 8^i 次工具调用。d = 3 时为 584 次，d = 4 时为 4,680 次。每多一层，至少多一次进模块和引擎的调用。在 Monad 规则下，一次热调用约 24k gas。只算这一项，3 层约 14M，在单笔 30M 以内，4 层约 112M。
  - Factory 记录下面这些内容：
    - `isModule`。
    - 每个模块的嵌套深度 `depthOf(module)`：没有工具时为 0，否则为 1 + 其工具的最大深度。
    - 按产物的索引 `modulesOf(artifactId)`。部署工具时，桥接据此复用模块。artifactId 只是部署者的声明，所以复用前要核对。
    - `ModuleDeployed` 事件，事件带引擎版本。
  - 权重块和模块只能经 Factory 创建。`createChunk` 只有两种用途：一笔交易放不下时先建一部分块，以及续传。
  - 登记不代表训练质量认证。

一份模型可以创建多个模块。权重固定，LIF 电位（连同其工具的状态）属于各个模块。

`descriptor()` 包含下面这些字段：

- `engineId`。
- `artifactId`：`neurom-module` 产物的内容哈希。
- `taskId`：产物里训练快照 `env` 的 sha256，即 envHash。
- 端口和状态宽度。
- `factory`：代理。
- `engine`：模块的引擎版本。

`shape()`、`chunks()`、`tools()` 读其余的身份。只有 Factory 的 `isModule` 能证明一个地址由 Factory 创建。原因是别人克隆同一实现时，描述符里也会写同一个 `factory`。

## 引擎

权重按列存储（`EngineBase`，ADR 0014 / 0015）。每个仿射映射占一个区域，宽度 w 等于模块的 weightBits（8 或 16）。区域的布局如下：

- 前 `cols` 列是权重。第 i 列是所有行（神经元）对输入 i 的权重，每个权重是大端补码的 w 位整数。
- 每个 32 字节的词放 256 / w 个权重。第 j 行是第 j 个元素，元素 0 在最高字节。每列补零到整词。
- 最后一列是偏置，**总是 int16**，每词 16 个。

`rows` 行、`cols` 列的区域占 `cols · ⌈rows · w / 256⌉ · 32 + ⌈rows / 16⌉ · 32` 字节。w = 16 时，这个值是 `(cols + 1) · ⌈rows / 16⌉ · 32`。每个区域有自己的移位 k（0..20）：`z[j] = (Σ_i W[j,i]·x[i]) · 2^k + f·b[j]`。

一步里的计算如下：

- 每个为 1（或放电次数非 0）的输入，把它那一列整列加到 32 位 lane 上。
- int16：每个词拆成偶 / 奇两组 lane，lane 里存权重 + 32768。
- int8：每个词按行号模 4 拆成四组 lane，lane 里存权重 + 128。
- 算完后减去偏移，再左移 k。
- 不超过 32 行时，lane 留在栈上（int8 一个词，int16 一或两个词）。行数更多时，lane 走内存。
- lane 的值在 int16 时至多是 65535 · Σx，在 int8 时至多是 255 · Σx。所以 int16 在 Σx ≤ 65537 时、int8 在 Σx ≤ 16,843,009 时，lane 不超过 2^32。Σx 是一个映射读到的输入之和。
- int16 的 Σx 只在工具层之后（`结果 ‖ 前一层`）才可能更大。这时引擎把输入分成 Σx ≤ 65537 的几批，再把各批的和相加。只有第一批加偏置。int8 不用分批，因为没有形状接近它的上限。

数值与 `frontend/runtime/` 的整数执行器逐位相同。

`dense-policy`（`DensePolicyEngine`）的形状有四个词：

- `shape[0]`、`shape[1]`：层描述符，每层 64 位。第 l 层在 `shape[l / 4]` 的 [64·(l % 4), 64·(l % 4) + 64) 位。
  - [0, 16) 是 hidden − 1 或 K − 1，[16, 32) 是 D − 1，[32, 48) 是 R − 1，第 48 位是工具层标志。
  - 第 49..63 位为 0。普通层的 [16, 48) 为 0。最后一层以上的位为 0。
- `shape[2]`：
  - [0, 8) 是层数，[8, 16) 是 ticks，[16, 24) 是 leakShift。
  - [24, 32) 是 weightBits（8 或 16），[32, 48) 是 reset（int16）。
  - 第 l 层有两个移位。普通层 / 选择区域的移位在 [48 + 10l, 53 + 10l)。
  - 第 l 层数据区域的移位在 [53 + 10l, 58 + 10l)，普通层为 0。
  - 输出区域的移位在 [128, 133)。最后一层是工具层时，这个移位为 0。
  - 每个 k ≤ 20。最后一层以上的位和从第 133 位起的位全为 0。
- `shape[3]`：每层 32 位，是普通层的阈值。FF 的阈值恰为 1，LIF 的阈值为 1..2^31 − 1。工具层和最后一层以上的位为 0。

check() 另有三种拒绝：

- "bits"：weightBits 不是 8 / 16。
- "shift"：k > 20，或者没有区域的位置有 k。
- "threshold"：阈值不符合上述规则。

层与状态的限制：

- 网络有 1..8 层。普通层的 hidden 为 1..65535。
- 工具层的 K / D / R 为 1..65535。最后一层是工具层时，outputs = R。
- 状态合计 ≤ 256（`state`）。状态包括 LIF 普通层的神经元和所有工具的状态宽度。

权重的区域：

- 每个普通层一个区域，有 hidden 行。
- 每个工具层两个区域：K 个选择行和 D 个数据行。数据行只计算被选中的工具读的那几行。
- 最后一层不是工具层时，再接输出层的区域。

工具可以是同一 Factory 的任何模块：FF、LIF 或自己带工具层的网络。条件是 inputs ≤ D 且 outputs ≤ R。

模块的状态（宽度 W = `stateWidth`）按下面的顺序排列：

- 先是模块自己的电位。LIF 是各普通层的电位，按层顺序。FF 没有电位。
- 再按层、按连线顺序接每个工具的状态。网络工具的状态就是它自己的状态，按同样的布局递归。无状态的工具占 0 位。

工具的状态属于调用方的会话：

- 工具的状态在调用方模块的 (actor, session) 状态里。工具模块自己的存储不用。
- 工具的状态只在工具被选中的那一步前进，没被选中时不动。
- 调用方的会话 reset 时，工具的状态一起清零。
- 不同会话、不同调用者不共享工具的状态。

下文中 `I[j] = (Σ_i W[j,i]·x[i]) · 2^k + b[j]`。

- FF（kind 0）：普通层把 `a[j] = (I[j] >= 1)` 交给下一层。FF 没有状态。
- LIF（kind 1）：工具层把网络切成段。每段跑满 `ticks`。
  - 每个 tick，各层计算 `V[j] = V[j] - (V[j] >> leakShift) + I[j]`（算术右移）。如果 `V[j] >= threshold_l`（该层自己的阈值），该层计一次放电，并把 `V[j]` 置为 `reset`。
  - 段首层的 I 由段输入算一次。后续层的 I 由上一层在同一 tick 的放电算出。
  - 所有普通层的电位跨调用保留。只有 reset 清零电位。
- 工具层（贪心）：
  - 工具层在前一层上算 K 个选择 logit 与 D 个数据 logit。FF 读前一层的激活。LIF 读前一层在段内的放电次数，并把偏置 × ticks。
  - 如果段内工具层前面没有普通层，工具层读段输入位，偏置不放大。
  - 选择取第一个最大值。数据位 = logit > 0。
  - **只调用被选中的工具**：`forwardFrom(它的状态切片, 数据位的前 inputs 位)`。工具返回的下一状态写回该切片。
  - 如果下一状态的长度不对，回滚理由是 "tool"。如果工具自己的电位超出 int32，回滚理由是 "volt"。
  - 结果位 k = (score_k ≥ 0)，零扩展到 R 位。
  - 下一层读 `结果 ‖ 前一层`。FF 的前一层部分是它的激活 / 所读的位。LIF 的前一层部分是本段每个神经元是否至少放电一次 / 段输入。
- 输出：`scores[a] = (Σ_j W[a,j]·x[j]) · 2^k + m·b[a]`。FF 的 m = 1，LIF 的 m = ticks。x 是最后一层的激活 / 放电次数。
  - 最后一层是工具层时，R 个结果位就是输出，score 为 +1 / −1。
  - 动作（uint16）取第一个最大值。counts 是各普通层的激活 / 放电次数，按层顺序拼接。

`threshold-layers`（`ThresholdLayersEngine`）的形状有两个词：

- `shape[0]`：`width_l` 从第 16·l 位起。l = 0 是输入，l = L 是输出，1 ≤ L ≤ 8，每层宽度为 1..65535。
- `shape[1]`：[0, 8) 是 weightBits（8 或 16）。第 l 个映射（产生 width_{l+1} 的映射）的移位 k 在 [8 + 5l, 13 + 5l)，k ≤ 20。最后一个映射以上的位为 0。

每层一个区域，`th` 放在 int16 偏置列里。激活为 `Σ W·x · 2^k − th ≥ 0`。最后一层的 `Σ W·x · 2^k − th` 就是 scores。

模块提供下面这些函数：

- `forward`：从静息状态执行。
- `peek`：在现有会话上只读预测。
- `step`：执行并写状态。
- `reset`：清零会话的状态。
- `peekAs` / `stateOf`：查询任一 actor 的状态。

写入的 actor 总是 msg.sender，所以谁也不能伪造别人的状态。状态按 actor / session 隔离。int32 电位每 8 个打包进一个 storage word。无状态的模块（FF 且没有带状态的工具）返回空状态。

`forwardFrom(state, inputBits)` 从给定的打包状态执行一次。打包状态是 ⌈stateWidth / 8⌉ 个词，长度不对时回滚理由是 "state"。它不读也不写存储，voltages 就是下一状态。选择器的引擎用它运行工具，工具的状态在调用方的会话里。

`step` 发出 `Stepped` 事件。事件的摘要包含 scores、action、counts、voltages，所以可以按收据的区块号核对状态。

网页桥接 `frontend/module-chain.js` 按下面的方式部署：

- 桥接验证产物，把权重编码成按列的权重块。
- 桥接把链上还没有的权重块和模块一起用 `deploy` 在一笔交易里创建。
- 如果 gas 估算（+ 10%）超过单笔交易上限（Monad 30M），桥接先创建缺的块：
  - 每块用一笔 `createChunk` 交易。
  - 一直创建到模块和剩下的块放得进最后一笔交易为止。
- 如果单独一块都放不下，桥接明确报错。
- 发交易前，桥接先用 `checkDeploy` 问 Factory 是否接受。被拒绝的模块不花任何交易。所以估算失败只剩一种原因：gas 不够。
- 桥接从不重发已有的块，所以中断后再部署时，从缺的块继续。
- 有工具层的网络先部署工具。每个网络工具是它自己的模块。如果 Factory 里已有同一产物的模块，并且核对通过，桥接复用这个模块。
- 部署默认用最新引擎版本。调用方也可以指定一个版本（`version`）。新部署的工具用它自己 id 的最新版本。
- 代码工具不能部署。

核对覆盖选择器和它的每个工具，所以需要工具的产物。核对的项目：

- `isModule`。
- 描述符。
- 引擎合约是 Factory 为模块的引擎 id 列出的版本。桥接也报告它是第几个版本、是否最新。
- 形状。
- 权重块地址，由产物内容重算。

交易后，桥接验证 Stepped 摘要与收据所在区块的状态。链上格式 / task 标识不证明任意位绑定的业务语义。应用仍须定义正确的观测与动作解释。

## 添加引擎版本

引擎版本不可变（ADR 0017）。更便宜或修好的引擎是同一 id 的新版本。同一 id 的所有版本必须逐位算得一样。ADMIN 添加新版本之前，先和该 id 在链上的最新版本逐位核对：

1. 部署候选：`forge create src/modules/<文件>.sol:<合约> --rpc-url <url> --private-key $PK --broadcast`。
2. 在仓库根目录运行核对（需要 `anvil`）：

   ```sh
   node contracts/scripts/engine-version-check.mjs --rpc-url <url> --factory <ModuleFactory 代理> --engine dense-policy --candidate <候选地址>
   ```

   脚本在本地启动一个 `anvil --fork-url <url>`。这是目标网络最新区块的分叉。目标可以是本地 Anvil 或任何 RPC。脚本用完后关闭分叉。

   在分叉上，脚本经桥接部署固定输入集里用到这个引擎的所有用例。经工具用到引擎的用例也算。然后脚本从同一状态出发，把每个用例跑两遍：

   - 第一遍：把最新版本的代码放到该 id 每个版本的地址上。
   - 第二遍：把这些地址上的代码换成候选的代码。

   换代码用 `anvil_setCode`，只在分叉上。所以桥接从网络上复用的工具（包括用较早版本的模块）也是先跑最新版本，再跑候选。脚本比较每个决策的 scores、action、counts 和下一状态。只有一边 revert 也算差异。

3. 读脚本的输出和退出码：

   - 退出码 0：0 个差异。脚本按顺序打印 ADMIN 要发的两笔交易：发给 Factory 的 `addVersion(engineId, 候选)` 和 `setLatest(engineId, 候选)`。脚本也打印对应的 `cast send`。
   - 退出码 1：有差异。脚本打印第一个不同的输入：用例、第几个输入或会话的第几步、输入位、哪几项不同、两边的值。脚本也打印每个用例的差异数，不打印交易。
   - 退出码 2：核对不了。原因是下面之一：
     - 引擎 id 没有最新版本。
     - 候选地址没有代码。
     - 候选已经是一个版本。
     - 没有用例用到这个引擎。

   脚本从不向目标网络发送任何东西。

4. 如果核对有 0 个差异，ADMIN 发送这两笔交易，或运行下面的脚本。

   之后的新部署用新版本。已部署的模块仍用各自的版本。

固定输入集（`scripts/engine-cases.mjs`）包括所有内置产物和下面这些生成的网络：

- FF 与 LIF。
- 单层与多层。
- 引擎的各条按列路径：栈上的 ≤ 16 / ≤ 32 行、内存里的更多行、不齐整的行数。
- 跨几块的权重。
- FF 与 LIF 的工具层：接在普通层后，或在段首。
- 多层阈值网络。

每个生成网络按模型格式的每种权重宽度各生成一份。权重宽度来自 `frontend/runtime/dense-policy.js` 的 `WEIGHT_BITS`：int8 和 int16。生成的规则：

- 权重在该宽度的整个码值范围里抽取，两端的码值都有。
- 偏置和阈值在整个 int16 范围里抽取。
- 每个区域有自己的 scale 与移位 k：int8 为 7–9，int16 为 0–1。所以两种宽度都有 k > 0。
- LIF 每层的阈值 = scale·2^k（1.0 实数单位，与训练器一致）。

加一种宽度时不改这里。把它加进 `WEIGHT_BITS`，输入集就跟着生成。

输入不超过 8 位的网络跑全部输入。更宽的网络跑 32 个不同密度的输入。LIF 用例是一个会话里连续 16 步，每步比较下一状态。`dense-policy` 的核对有 19 个用例、480 个决策。

### 用脚本添加版本

```sh
cd contracts
ENGINE=<引擎 id> VERSION=<新版本的地址> FACTORY=<ModuleFactory 代理> forge script script/EngineVersion.s.sol --sig 'add()' --rpc-url <url> --private-key $PK --broadcast
ENGINE=<引擎 id> VERSION=<已添加的版本> FACTORY=<ModuleFactory 代理> forge script script/EngineVersion.s.sol --sig 'setLatest()' --rpc-url <url> --private-key $PK --broadcast
```

`add()` 把 `VERSION` 加进 `keccak256(ENGINE)` 的版本列表，并设为最新。`setLatest()` 把该 id 已添加的一个版本重新设为最新。例如最新版本有问题时，用它退回上一个版本。广播账户必须持有 ADMIN。新引擎 id 不需要升级 Factory。

脚本在发送前拒绝两种地址：

- `add()` 拒绝已经是某个 id 的版本的地址。
- `setLatest()` 拒绝不是 `ENGINE` 的版本的地址。

Factory 本身也拒绝这两种地址，因为版本不能改，也不能删。

工作台的桥接只认识 `frontend/core/kinds/network.js` 的 `ENGINES`。如果要从工作台用新引擎 id 部署，先在那里接上它的执行器和编码。

## 角色与交接

`Deploy.s.sol` 的广播账户起初持有两种协议角色（ADR 0016）。上主网前，把两种角色都交给多签。Roles 没有提名-接受，所以交接的顺序是：授予、核对、撤销。

注意：确认多签能用之前，绝不撤销部署者的角色。撤销最后一个 ADMIN 后不可挽回。

只读查询谁持有什么角色（在仓库根目录运行）：

```sh
node contracts/scripts/list-roles.mjs --rpc-url <url> --factory <ModuleFactory 代理> --from-block <Roles 部署所在区块>
```

它读 Factory 的 `roles()`。然后它从 Roles 的 `RoleGranted` 事件收集账户，因为 Roles 不存持有者列表。最后它在最新区块上用 `hasRole` 逐个确认。输出中每个持有者一行，没人持有的角色显示 `(none)`。

它用 `eth_getLogs` 读事件，每段 `--block-range` 个区块（默认 1000，这是常见的 RPC 上限）。`--from-block`（默认 0）让它不扫描 Roles 部署之前的链。区块号在 `broadcast/Deploy.s.sol/<chain id>/run-latest.json` 的收据里。

在 `contracts/` 下用部署者的私钥交接。`MULTISIG` 是多签在该网络上的地址。

1. 授予：运行 `FACTORY=<ModuleFactory 代理> MULTISIG=<地址> forge script script/HandOverRoles.s.sol --sig 'grant()' --rpc-url <url> --private-key $PK --broadcast`。

   多签得到 ADMIN 和 UPGRADER。

2. 核对：运行 `list-roles.mjs`。两种角色下都应有部署者和多签这两个账户。
3. 让多签证明它能以 ADMIN 身份操作：从多签向 Roles 发一笔 `grantRole(ADMIN, 多签)`。

   用 `cast calldata 'grantRole(bytes32,address)' $(cast keccak neurom.role.admin) <多签>` 生成 calldata。多签已持有这个角色，所以这笔交易什么都不改变。只有 ADMIN 能发成功。

4. 撤销：运行同一条命令，把 `--sig` 换成 `--sig 'revoke()'`。

   脚本先撤销部署者的 UPGRADER，再撤销它的 ADMIN。如果 `MULTISIG` 不是另一个持有两种角色的账户，脚本在发送前就拒绝。

5. 再运行 `list-roles.mjs`。两种角色下都应只有多签。

## Gas

下表由 `forge test --network monad -vv`（`testGasOfMiningNetworks`）测得。测量条件：

- 合成权重 ±100（在 int8 范围内），移位 0，每个输入约 21 个 1。
- 不含交易基础费 21,000。forge 的 isolate 模式（`network = "monad"` 时打开）把每次调用当成一笔交易，所以数字里含 calldata 的费用。
- “部署”是一次 `deploy` 同时创建权重块和模块。“再部署”是同一权重块上的第二个模块。
- “一步”是冷账户下的单独一次调用。测试先把模块账户也设成冷的，所以多付一次冷访问。真实交易里模块是交易的目标，本来就是热的。一局是一次调用里连续 63 次 `forward`。
- 真实 step 交易的收据 gas 见 [benchmark/](../benchmark/README.md)。例如 FF 185→32→7 int8 的一笔 step 交易是 100,287（含基础费）。

| 网络 | weightBits | 部署（权重块 + 模块，一笔） | 再部署（只建模块） | forward | step | 一局 63 步 |
|---|---|---|---|---|---|---|
| FF 185→32→7 | 8 | 2,003,125 | 343,950 | 90,549 | 116,239 | 3,167,972 |
| FF 185→32→7 | 16 | 3,301,729 | 343,976 | 91,406 | 116,731 | 3,202,700 |
| FF 185→64→32→7 | 8 | 3,832,660 | 345,219 | 145,892 | 170,562 | 6,410,525 |
| FF 185→64→32→7 | 16 | 6,917,192 | 345,245 | 151,690 | 176,164 | 6,740,257 |

int8 让权重块小了约一半。计算上，一个 int8 列词按行号模 4 拆成四组 lane，与 int16 两个词的四组 lane 工作量相近。所以在 32 行以内，两种宽度下一局的 gas 差不多。更宽的层用 int8 时读的词少，所以略便宜。

`testDenseFeedforward1020x300x300Int8` / `Int16` 测一个宽网络：FF 1020 → 300 → 300，每个输入有 437 个 1，从另一个合约冷调用一次。一次 forward 在 int8 时是 2,029,018，在 int16 时是 2,472,908。一次 step 是 2,034,713 和 2,478,603。权重在 int8 时是 4 块，在 int16 时是 8 块。每次调用，引擎都把所有权重块复制进内存。

单独一笔 step 要付几次冷账户访问：引擎版本、模块实现、权重块，在 Monad 上每次 10,100。一局在一笔交易里连续多步时，这些访问只付一次。

### Monad 规则和以太坊规则

两种规则的对比用真实交易的收据，见根目录 README 的「Monad 网络实测」一节和 [benchmark/](../benchmark/README.md)。`testGasOfMiningNetworks` 不能用来对比两条链。原因是它在测试合约自己的调用帧里计时，这个帧的内存在测试中越用越多，而以太坊按平方收内存费，所以以太坊的数字偏高。

两条链的差别来自 Monad 的价格规则（[Opcode Pricing](https://docs.monad.xyz/developer-essentials/opcode-pricing)）：

- 冷账户访问在 Monad 上是 10,100，在以太坊上是 2,600。在一页里首次写一个新存储槽，Monad 上是 27,900，以太坊上是 22,100。所以只建模块的“再部署”和单独一步在 Monad 上更贵。
- Monad 的内存扩展是线性的，以太坊是平方的。所以用内存多的调用在 Monad 上更便宜，例如一局 63 步，或者很大的网络（见根目录 README）。

MIP-8 的影响用 `hardfork = "monad:MonadNine"`（MIP-8 之前）对比得出。从 MonadNine 到 MonadTen，部署少 16,400–16,500 gas，再部署少 8,400 gas。forward、step 和一局的 gas 不变。

### 基准测试

根目录 README 的“Monad 网络实测”一节由 [benchmark/](../benchmark/README.md) 里的脚本测得。那里写明了每个脚本的步骤，以及 `anvil --network monad` 和 Monad 测试网的核对结果。

基准测试里的 step 比上表的 step 小。原因有两个：

- 收据的 gasUsed 包含 21,000 的基础费和 calldata。
- 训练出来的挖矿网络平均每个输入只有 14.3 个 1，合成输入约有 21 个。
