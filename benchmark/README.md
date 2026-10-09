# benchmark

中文 · [English](README.en.md)

这里的脚本测量模块合约在 Monad 规则和以太坊规则下的 gas。根目录 README 的「Monad 网络实测」一节就来自这些脚本。

## 准备

- Node.js ≥ 22.12，并且在仓库根目录运行过 `npm ci`。
- Foundry ≥ 1.8.0（`forge`、`anvil`）。
- `monad-parity.mjs` 要访问 Monad 测试网的 RPC。它只发 `eth_call`，不发交易，也不需要账户里有钱。

所有命令都在仓库根目录运行。

## 脚本

| 脚本 | 测什么 | 用时 |
|---|---|---|
| `monad-parity.mjs` | `anvil --network monad` 和 Monad 测试网的 gas 是否一致 | 约 40 秒 |
| `mining.mjs` | 训练出来的挖矿网络：部署、63 笔 step 交易、一笔 step 的实际扣费 | 约 80 秒 |
| `network-size.mjs` | 5 个从小到大的网络：单步，以及一笔交易跑 63 步 | 约 3 分钟 |

其他文件：

- `mining-network.mjs`：前两个脚本共用的部分。它训练 `mining-task`（模板默认设置，种子 1），并在本地走完测试回合 0。
- `MonadParity.sol`：核对用的探针合约。
- `NetworkSize.s.sol`：`network-size.mjs` 调用的 forge 脚本。

### monad-parity.mjs

```sh
node benchmark/monad-parity.mjs                      # 默认 https://testnet-rpc.monad.xyz
node benchmark/monad-parity.mjs <测试网 RPC 地址>
```

探针合约只在构造函数里运行。脚本把同一份 initcode 用 `eth_call` 分别发给三个节点：Monad 测试网、`anvil --network monad` 和 `anvil --network ethereum`。每项数字是探针里 `gasleft()` 的差。只要有一项和测试网不同，脚本就以退出码 1 结束。

2026-10-10 的结果：

| 测量项 | Monad 测试网 | anvil --network monad | anvil --network ethereum |
|---|---|---|---|
| EXTCODESIZE，冷账户 | 10,117 | 10,117 | 2,617 |
| EXTCODESIZE，热账户 | 117 | 117 | 117 |
| SLOAD，一页里的第一个槽 | 8,116 | 8,116 | 2,116 |
| SLOAD，同一页 | 117 | 117 | 2,117 |
| SLOAD，另一页 | 8,117 | 8,117 | 2,117 |
| SSTORE 0 → 1，新的一页 | 27,908 | 27,908 | 22,108 |
| SSTORE 0 → 1，同一页 | 17,108 | 17,108 | 22,108 |
| 内存扩展 1 MiB | 16,393 | 16,393 | 2,387,217 |
| 部署协议合约 | 9,790,509 | 9,790,509 | 9,749,413 |
| createChunk（权重） | 1,542,481 | 1,542,481 | 1,538,288 |
| deploy（模块） | 262,016 | 262,016 | 237,695 |
| forward | 48,949 | 48,949 | 51,529 |
| step | 51,293 | 51,293 | 53,884 |
| forward × 63 | 2,964,912 | 2,964,912 | 3,127,452 |

14 项全部一致。以太坊一列在冷访问、存储页和内存上都不同，说明这些测量项能分辨两种规则。

`eth_call` 不扣费，所以这个脚本不核对「按 gasLimit 扣费」这一条。`mining.mjs` 用余额核对了这一条。

### mining.mjs

```sh
node benchmark/mining.mjs
```

1. 训练挖矿网络，在本地走完测试回合 0。
2. 分别启动 `anvil --network monad` 和 `anvil --network ethereum`，按 `frontend/anvil.fixture.js` 的顺序部署协议合约。
3. 用 `frontend/module-chain.js` 的 `deployModule` 部署网络，再用 `stepModule` 发 63 笔 step 交易。
4. 每一步都把链上分数和本地分数对比。不一致时，脚本报错退出。
5. 读收据里的 gasUsed。第 2 笔 step 交易前后，对比发送账户的余额，得出实际扣费。

### network-size.mjs

```sh
node benchmark/network-size.mjs                      # 默认 5 个网络
node benchmark/network-size.mjs 64@8 256,256@16      # 隐藏层宽度@权重位数
```

每个网络、每种规则都启动一个新的 Anvil，然后运行 `NetworkSize.s.sol`：

1. 部署协议合约。
2. 生成合成权重（±100），按块切开。Monad 每块最多 114,688 字节。以太坊每块最多 24,575 字节，这是 EIP-170 的代码上限。
3. 每块发一笔 `createChunk` 交易，再发一笔 `deploy` 交易。
4. 用 `_miningInput(0..7)` 发 8 笔 step 交易，取 gasUsed 的中位数。
5. 再发一笔交易，在一个合约里连续调用 63 次 `forward`。

注意：

- Anvil 的区块上限设成了 1,000,000,000 gas。Monad 一笔交易最多 30M gas，所以超过 30M 的一局在 Monad 上要拆成几笔交易。
- 8 层的网络（185→256×7→7）跑不出来：脚本在链上拼接权重时内存不够。
