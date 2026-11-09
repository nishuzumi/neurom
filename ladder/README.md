# 网站和坦克擂台页面（`ladder/`）

这个目录是 NEUROM 网站：首页、坦克大战擂台赛的网页、参与指南和名字服务（ADR 0026、ADR 0027）。它是仓库根目录的一个 npm workspace，也是 Vercel 项目的根目录。网站有四个页面，都在同一个 origin：首页 `/`，擂台 `/ladder/`，工作台 `/studio/`，参与指南 `/guide/`。本地开发和线上用同样的路径。页面和工作台一样用 Vue 3 和 Vite。登录用 `frontend/wallet/privy.js` 里的 Privy 会话，它把 Privy 的 React SDK 挂到页面给它的一个元素上。页面直接导入 `../frontend/` 里的工作台模块，不复制代码。

## 目录

- `index.html` 和 `src/home/`：首页。`ladder/index.html` 和 `src/`：擂台页面。`guide/index.html` 和 `src/guide/main.js`：参与指南。它是一个中英双语的静态页面，告诉参赛者怎样从零训练、部署、注册和挑战。三个页面是同一个 Vite 构建的三个入口（`vite.config.js`）。`src/chain/` 是不含界面的 ladder 客户端。它读擂台合约，也读官方 Factory 的存档（`deploymentsOf`：一个账号部署过的模块和它们的英文 ID）。`src/components/SiteBar.vue` 是首页和擂台共用的站点顶栏。`src/i18n.js` 和 `src/i18n/en.json` 是页面自己的英文词条。
- `api/`：Vercel 函数。`api/names.js` 只把环境变量接到 `server/` 的模块上。
- `server/`：名字服务的逻辑（`names.js`）、HTTP 层（`names-http.js`）、数据库（`db.js`、`schema.sql`）。
- `data/`：会变的数据。`banned-words.json` 是违禁词，`step-gas.json` 是实测的每步 gas，`deployments.json` 是每条链的 RPC、官方 Factory 和擂台合约地址。

## 本地运行

一条命令起整套本地环境：

```
ANVIL=~/.foundry/bin/anvil FORGE=~/.foundry/bin/forge node ladder/scripts/dev-chain.mjs
```

脚本做这些事：

1. 编译合约，起一个新的 `anvil --network monad`，部署协议合约和擂台合约（`frontend/ladder.fixture.js`）。`--board-size 3` 把榜部署成 3 名，所以默认的出战模型就把榜占满，页面显示榜外的出战模型。
2. 用 anvil 账号 0 和 2 注册几个出战模型。默认用 `ladder/data/artifacts/` 里训练好的“中”和“大”。如果本机 `.scratch/jolt/` 里有别的模型产物，也一起注册。`--artifacts a.json,b.json` 指定别的文件。`--no-seed` 不注册，擂台从空的开始。
3. 打几场挑战，直到结算。`--no-play` 跳过这一步。
4. 在进程内用 PGlite 起名字服务，挂在页面的 `/api/names`，并给已注册的出战模型起好名字。
5. 给每个登录账号起一个 Vite 开发服务器，通过 `VITE_LADDER_RPC`、`VITE_LADDER_FACTORY` 和 `VITE_LADDER_ADDRESS` 指向这个 anvil。第一个服务器用 `--port`（默认 5174），后面的依次加 1。每个服务器在 `/` 提供首页，在 `/ladder/` 提供擂台。
6. 每个服务器在 `/studio/` 提供工作台（`frontend/`），和线上一样。工作台用同一条链、同一个官方 Factory 和这个服务器的登录账号。在它里面训练，给候选起一个英文 ID，部署，然后在擂台页面从这个账号部署过的模块里选一个注册，整条流程都在本地走通。工作台的 Python 工作区走根目录 `vite.config.ts` 的代理。

每个页面上点“登录”，用的是 anvil 默认助记词里的一个账号（`VITE_DEV_ACCOUNT`）。默认只有一个页面，用账号 1。它一开始没有出战模型，所以部署、注册、挑战和起名字的整个流程都能在本地走一遍。这些账号的私钥是公开的，只用于本地开发。

`--fork` 不部署新合约，而是起一条 Monad 测试网的本地分叉（ADR 0028）：`data/deployments.json` 里的分叉条目，用它的链 id 和端口，和 `frontend/chain.js` 的 `forkCommand` 是同一条命令。分叉保留真实链的榜、官方 Factory 和擂台合约，所以不注册、不打挑战。页面和工作台用这个分叉条目，模板里的链节点也连到同一个节点。

要试多个用户时，用 `--accounts` 列出账号序号（0 到 9）。每个账号一个页面，端口不同，所以登录状态各自独立。所有页面用同一条链和同一个名字服务。例如：

```bash
npm run dev:chain -w ladder -- --accounts 1,3,4,5,6,7 --no-seed
```

这样起 6 个页面，端口是 5174 到 5179，擂台是空的。每个端口的 `/ladder/` 都是擂台，`/studio/` 都是工作台。

只起本地链的页面时，运行 `VITE_LADDER_CHAIN_ID=31337 npm run dev -w ladder`。擂台在 `/ladder/`，它连接 `data/deployments.json` 中的本地 RPC，名字服务不可用。工作台在同一个端口的 `/studio/`。不指定链时，页面优先选择已有擂台地址的公共链。

## 测试网赛季

合约部署在 Monad Testnet（Chain ID `10143`）。网页仍在本地运行。

| 项目 | 值 |
|---|---|
| 统一 Factory | [`0xC059cCfbc7A8654e9c96d5da66bc6aE3a3ffffd2`](https://testnet.monadscan.com/address/0xC059cCfbc7A8654e9c96d5da66bc6aE3a3ffffd2) |
| 擂台合约 | [`0xEF5fb216c86bC439Fd6eC48B4531CAf079ad463b`](https://testnet.monadscan.com/address/0xEF5fb216c86bC439Fd6eC48B4531CAf079ad463b) |
| 擂台部署块 | `78216316` |
| 赛季结束块 | `84827030`（`admin` 可以用 `setEndBlock` 调整，链上 `endBlock()` 是当前值） |
| 擂台 `admin` | `0x646D80bc9aEE2c383769CF546768a45f942b54CB` |
| RPC | `https://testnet-rpc.monad.xyz` |

`data/deployments.json` 是工作台和擂台的共同配置。运行：

```bash
VITE_LADDER_CHAIN_ID=10143 npm run dev -w ladder
```

首页在 `/`，擂台在 `/ladder/`，工作台在 `/studio/`。在工作台的部署模块中选择 `Monad Testnet (10143)`。工作台和擂台通过 `frontend/wallet/privy.js` 使用同一个 Privy 用户的嵌入式 EVM 钱包。两边只选择该钱包，不改用外部钱包。两个页面在同一个 origin，所以登录一次就够了，地址也相同，提交页才会列出对应的部署存档。

未配置登录时，擂台仍可读取榜单、规则和回放。不要把部署密钥放入 `VITE_*` 变量。公网网页和名字服务仍需配置 Vercel、Privy 和 Neon。

上一份擂台合约 `0x8671257deEb3A3c296C56530Bf54eCAD9bC78fF2` 通过了 5 项测试网检查。挑战 `#1` 共运行 6 局、230 步，比分为 `3 : 3`。两个模块的权重字节数相同，平局不满足 δ，所以结果是守擂成功。模块存档保留了两份验证模块的英文 ID。验证模块仅用于检查部署和比赛流程。

现在的擂台合约只增加了 `setEndBlock`，比赛规则没有变，所以没有重新运行这 5 项检查。部署以后，`admin` 在链上调用了一次 `setEndBlock`，结束块不变，合约发出了 `EndBlockChanged`。用别的账号调用时，合约回滚 `NotAdmin`。

公共 RPC 限制日志查询范围。客户端每次查询最多 100 个块，并逐个发送 RPC 请求。比赛日志只查到该场挑战的截止块，不扫描后续空块。

## 挑战结果和回放

页面按当前钱包对应的参赛方显示结果。挑战者看到“挑战成功”或“挑战失败”。擂主看到“守擂成功”或“守擂失败”。旁观账号和未登录用户看到获胜方。超时结果会注明“超时”。比分始终按“挑战者 : 擂主”排列。

完整回放播到当前局的最后一步后停止，不自动切换到下一局。点击“最后一步”可以直接查看最新已记录的画面。已结束的局会同时显示终局画面和胜负文字。手动切局、步进或拖动进度条都会暂停播放。

后台刷新同一场挑战不会重置回放进度。挑战页面一次只查询一份进度，慢 RPC 不会因新区块而反复丢弃结果。已结算的挑战不再逐块读取回放。首页只循环播放已分出胜负的单局。页面跳过平局和未打完的单局。首页从最近挑战中选择有合格单局的最新一场。

首页保留原来的局编号。最近挑战都没有合格单局时，首页显示“还没有分出胜负的对局”。完整回放仍保留所有单局。

页面先显示挑战状态，再读取回放。配置与榜单不等待历史 gas 和名字。只有首页读取最近挑战的 gas。每份数据同时只运行一个查询。新区块只排队一次刷新。回放与历史 gas 共用已读取的历史日志。

## 超时结算

打开挑战页面后，挑战者的钱包会自动提交超时结算。页面调用 `expire`，使用节点估算的 gas。每个挑战与账号在本次页面运行中只自动尝试一次。如果签名或提交失败，点击“再试一次结算”。旁观账号只会在点击“结算超时”后付款。关闭页面以后，没有后台服务替用户发交易。


## 钱包和节点错误

`could not coalesce error` 是钱包库的外层错误。这个错误本身不表示余额不足。

训练台和擂台共用 `frontend/chain-error.js`。页面显示嵌套错误中的具体原因和错误码。页面只在错误明确指出余额不足时显示“钱包余额不足”。页面单独显示拒绝签名。没有具体原因时，页面说明钱包或节点未给出原因。擂台优先解释合约的自定义错误。


## 环境变量

页面（Vite，构建时读入）：
两个 Vite 配置都读取仓库根目录的 `.env.local`，不读取 `ladder/.env.local`。两边共用 `VITE_PRIVY_APP_ID` 和链配置。Privy 按 origin 保存登录状态。线上和本机的擂台开发服务器都在 `/studio/` 提供工作台，和擂台在同一个 origin，所以登录一次就够了。用根目录 `npm run dev` 单独起的工作台在另一个 origin，要另外登录。不要把 App Secret 或钱包私钥放进 `VITE_*`。


- `VITE_PRIVY_APP_ID`：两个页面共用的 Privy 应用 id。公共链用 Privy 嵌入式钱包登录和签名。没有配置时，擂台只读。Local dev（31337）始终使用公开的 Anvil 开发账号，并标明“本地开发”。
- `VITE_LADDER_CHAIN_ID`：页面所在的链，`data/deployments.json` 的一个键。默认是文件里第一条有擂台地址的正式链，没有时是 31337。
- `VITE_LADDER_RPC`、`VITE_LADDER_FACTORY`、`VITE_LADDER_ADDRESS`：可选。覆盖 `deployments.json` 里的 RPC、官方 Factory 和擂台合约地址。开发脚本用它们指向临时的 anvil。
- `VITE_DEV_ACCOUNT`：本地开发账号在助记词里的序号，默认 1。

合约的配置（δ、范围、榜的名次数、冷却、超时、上限、赛季结束块）都从合约读，不写在页面里。

名字服务（Vercel 函数）：

- `DATABASE_URL`：Neon Postgres 的连接串。Vercel Marketplace 接入 Neon 以后会自动设置。
- `ADMIN_TOKEN`：管理员清除名字的 bearer token。不设置时，`DELETE` 一律拒绝。
- `LADDER_CHAIN_ID`：服务所在的链，对应 `data/deployments.json` 的一个键。
- `LADDER_RPC_URL`：可选。覆盖 `deployments.json` 里的 RPC。
- `LADDER_ADDRESS`：可选。覆盖 `deployments.json` 里的擂台合约地址。

## 页面

首页（`/`）介绍 NEUROM：它是什么，从画布到擂台的流程，功能，Monad 网络实测的数字，以及工作台、擂台和文档的链接。首页的文字来自仓库的 README。

擂台（`/ladder/`）的主页是一个长页面：顶栏、首屏两栏（左边是标题、说明、三步指引和按钮，右边是深色面板，播放最近一场挑战）、数据条、左侧粘性编号导航，然后是 4 节：开始、擂台榜、规则、最近的挑战。布局参考 Open Kernel Challenge 和 HashSmash，视觉风格参考 mojo.devnads.com。

三个页面共用一个站点顶栏，顺序相同：字标 `NEUROM` 指向 `/`，然后是坦克擂台赛（`/ladder/`）、工作台（`/studio/`）和 GitHub。擂台的顶栏另外有它自己的章节链接和钱包。

擂台的另外 3 个视图按 URL 的 hash 切换（例如 `/ladder/#/entries`）：

- `#/entries` 我的出战模型：从当前账号部署过的模块里选一个，注册。模块先在工作台的部署模块里起一个英文 ID，通过官方 Factory 部署到这条链上。页面从官方 Factory 的存档里读这个账号部署过的模块（英文 ID、地址、结构、产物），不读事件，也不读浏览器的本地存储。已经在擂台上的模块显示名次，不能再选。工作台部署以后，列表在下一个块自动更新，不用复制地址。页面显示当前链和合约里记的官方 Factory，只发注册交易，不再部署，也不再导入或上传 JSON。合约把出战模型记在发注册交易的账号名下，不看模块是谁部署的。注册以后可以起名字。名字是比赛里的显示名，和模块的英文 ID 是两回事。
- `#/challenge/<id>` 挑战进行中：6 局的格子、当前步数、在途和已确认的交易，结束以后显示结果和名次变化。关掉页面以后回来，可以从“我的出战模型”接着打。
- `#/replay/<id>` 回放：深色面板里的坦克棋盘，分段标签切换 6 局，下面是步数滑条。

回放用 `src/replay/scene.js` 重建：它用模板的场景（`battle` 和 `play`）、种子和事件里的动作算出每一步的状态，再用模板的回放视图脚本在沙箱 iframe 里画出来（`frontend/editor/renderers/script-frame.js`）。页面不复制规则。

页面只通过 `src/chain/client.js` 访问链。合约的自定义错误和名字服务的错误代码在 `src/ladder/errors.js` 里映射成文字。

## 名字服务接口

路径都是 `/api/names`。出错时返回 `{ "error": "<代码>", ... }`，页面把代码映射成文字。

- `GET /api/names?modules=0xa,0xb`：批量读名字。返回 `{ "names": { "0xa": "Name" } }`。地址键是小写。没有名字的地址不出现。一次最多 200 个地址。
- `POST /api/names`，正文 `{ "module", "name", "signature" }`：设置名字。返回 `{ "module", "name", "owner" }`。
- `DELETE /api/names?module=0xa`，头 `Authorization: Bearer <ADMIN_TOKEN>`：管理员清除。返回 `{ "module", "cleared": true|false }`。

错误代码：`invalid_module`、`name_length`、`name_chars`、`name_banned`、`bad_signature`、`bad_json`、`bad_request`（400），`not_entered`、`not_owner`（403），`name_set`、`name_taken`（409），`unauthorized`（401），`method_not_allowed`（405），`body_too_large`（413）。

页面签名的文字由 `server/names.js` 的 `nameMessage({ chainId, module, name })` 生成。格式固定，4 行，用 `\n` 分隔：

```
NEUROM ladder name
chain: <链 id，十进制>
module: <模块地址，小写>
name: <名字，原样>
```

签名用 EIP-191 个人消息（ethers 的 `signer.signMessage(text)`）。服务端恢复签名者，然后用擂台合约的 `entryOwner(module)` 核对。签名者必须是注册这个出战模型的账号。

规则：名字 3 到 24 个字符，只能用英文字母、数字、空格、`_` 和 `-`。不区分大小写，不能重名。设置以后不能改。管理员清除以后可以再设置一次。违禁词检查不区分大小写，并忽略空格、`_` 和 `-`。

## 测试

```
npm test -w ladder
```

数据库用进程内的 PGlite。链上的拥有者检查用本地 anvil 上的真实擂台合约。没有 Foundry 时，链上测试跳过。根目录的 `npm test` 也会运行这些测试。

## 部署到 Vercel

1. 新建 Vercel 项目，Root Directory 填 `ladder`。
2. 打开 “Include source files outside of the Root Directory in the Build Step”。构建要读 `../frontend/` 的模块。
3. Install Command 用默认值。Vercel 在仓库根目录运行 `npm install`，因为根目录的 `package.json` 声明了 workspace。
4. `ladder/vercel.json` 设定了 Build Command `npm run build` 和 Output Directory `dist`。构建先做首页、擂台页面和参与指南，再用 `frontend/build.mjs --hosted` 把工作台做成 `dist/studio/index.html`。网站在 `/` 提供首页，在 `/ladder/` 提供擂台，在 `/studio/` 提供工作台，在 `/guide/` 提供参与指南（ADR 0027）。`/ladder`、`/studio` 和 `/guide` 跳转到带斜杠的地址。线上的工作台只在浏览器里训练，不连 Python 工作区。
5. 在 Marketplace 接入 Neon，然后设置上面的环境变量。

## 部署一个赛季（测试网和主网）

把一个赛季放到 Monad 上要做的事，`scripts/deploy-wizard.sh` 一步一步带着人做。它先在链上部署，再配置 Vercel、Neon 和 Privy，最后在上线的页面上走一遍。每一步只做一件事，捕获的值写进 `ladder/.env.deploy-<network>`（已在 `.gitignore` 里），重新运行时已保存的值是默认值。

```
ladder/scripts/deploy-wizard.sh                     # Monad 测试网（10143）
ladder/scripts/deploy-wizard.sh --network mainnet   # Monad 主网（143）
ladder/scripts/deploy-wizard.sh --dry-run           # 只列出步骤和找到的工具
```

需要 Foundry ≥ 1.8（`FORGE=` 可以指定 forge 的路径）、Node ≥ 22.12 并已 `npm install`。装了 Vercel CLI 时，环境变量从脚本里直接设置；没有时脚本列出名字和值，由人在 Vercel 的设置页填。

步骤：

1. 检查工具和 RPC 报告的链 id。
2. 部署账号的私钥（粘贴或现场生成）。这个账号部署协议以后持有协议的 ADMIN 和 UPGRADER 角色，主网上把它当管理员密钥保管。
3. 给部署账号充值。测试网打开水龙头，主网自己转账。一次完整运行大约要 30 MON：协议约 1630 万 gas，擂台约 300 万 gas，第 8 步的链上核对约 20 MON。Monad 按 gas 上限收费，不按实际用量。
4. 官方 Factory。这条链上已有协议就粘贴 FactoryProxy 的地址，否则脚本运行 `contracts/script/Deploy.s.sol` 部署一套。
5. 赛季结束块。脚本实测 10 秒的出块速度，按天数算出建议值，人可以改。在赛季结束以前，部署账号可以用 `setEndBlock` 调整结束块（见 `contracts/README.md`）。赛季结束以后，结束块不能再改。
6. 擂台合约：`contracts/script/DeployLadder.s.sol`，配置用规格的默认值；要改就在运行脚本前导出 `LADDER_*` 变量（见该脚本的注释）。
7. 把 Factory 和擂台地址写进 `data/deployments.json` 对应链的条目（只改这两行），之后要提交这个文件。
8. 链上核对（下一节）。
9. Vercel 项目：Root Directory `ladder`，打开 “Include source files outside of the Root Directory in the Build Step”。
10. Neon：从 Vercel Marketplace 安装，把数据库连到项目的 Production 和 Preview 环境，`DATABASE_URL` 自动注入。名字服务第一次被调用时自己建表。
11. Privy 应用：在 Authentication → Login methods 中启用邮箱和自动创建 EVM 钱包。在 Authentication → Advanced 中启用 Disable confirmation modals。关闭智能钱包。在 Basics → Domains and clients 中加入网站的 origin。擂台和工作台共用这个 origin。如果也要在本机的工作台登录，再加入本机工作台的 origin。所有页面必须使用同一个 App ID。
12. Vercel 环境变量：`VITE_PRIVY_APP_ID`、`VITE_LADDER_CHAIN_ID`、`LADDER_CHAIN_ID`、`LADDER_RPC_URL`、`LADDER_ADDRESS`、`ADMIN_TOKEN`（脚本生成）。测试网写 Production 和 Preview，主网只覆盖 Production。然后重新部署。
13. 在上线的页面上走一遍：登录、在工作台里起英文 ID 并部署、选模块注册、挑战、起名字。确认整场挑战没有弹出任何确认框。
14. （主网）比赛说明里写清已知限制：按 gas 上限收费、挑战者必须是无代码的 EOA、结束块和谁能调整它、δ 和范围、冷却、超时。

## 链上核对（`scripts/verify-chain.mjs`）

原型阶段只在 anvil 上验证过的几件事，在真实网络上再验一次：

- 一个 EIP-7702 委托账号带代码（脚本打印代码长度：23 字节，`0xef0100` 加目标地址）。
- `challenge` 用 `NotEoa` 拒绝这个账号，而普通 EOA 过得了这一关（拒绝它的是别的原因）。
- 两个出战模型之间的一场挑战能从合约一路打到结算。脚本用 Factory 部署两份 中 网络的副本（39,840 权重字节）。脚本修改最后一个填充字节，使每次运行生成不同的条目。英文 ID 包含盐值和时间。脚本注册两个模块，然后发起挑战，并用 `advance` 推进到结算。每笔比赛交易的 gas 上限为 3000 万。一场挑战最多运行 600 步，交易数随场景种子变化。
- 每步 gas 和 `data/step-gas.json` 的 `mid-mid` 数字比较，偏差超过 30% 算失败，因为页面用这些数字估费用。

```
ANVIL=… FORGE=… node ladder/scripts/verify-chain.mjs --anvil                       # 自测：新起的 anvil --network monad
DEPLOYER_PRIVATE_KEY=0x… node ladder/scripts/verify-chain.mjs --rpc https://testnet-rpc.monad.xyz [--ladder 0x…]
```

`--ladder` 默认取 `data/deployments.json` 里这条链的地址。脚本打印每笔交易的 gas、部署账号实际付的钱，最后每项 PASS/FAIL；有失败时退出码是 1。真实网络上一次运行大约 20 MON（基础费 100 gwei 时）。
