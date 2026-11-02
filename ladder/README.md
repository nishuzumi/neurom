# 坦克擂台页面（`ladder/`）

这个目录是坦克大战擂台赛的网页和名字服务（ADR 0026、ADR 0027）。它是仓库根目录的一个 npm workspace，也是 Vercel 项目的根目录。页面用 React、Vite 和 Privy 的 React SDK。页面直接导入 `../frontend/` 里的工作台模块，不复制代码。

## 目录

- `src/`：页面。`src/chain/` 是不含界面的 ladder 客户端。`src/i18n.js` 和 `src/i18n/en.json` 是页面自己的英文词条。
- `api/`：Vercel 函数。`api/names.js` 只把环境变量接到 `server/` 的模块上。
- `server/`：名字服务的逻辑（`names.js`）、HTTP 层（`names-http.js`）、数据库（`db.js`、`schema.sql`）。
- `data/`：会变的数据。`banned-words.json` 是违禁词，`step-gas.json` 是实测的每步 gas，`deployments.json` 是每条链的 RPC、官方 Factory 和擂台合约地址。

## 本地运行

一条命令起整套本地环境：

```
ANVIL=~/.foundry/bin/anvil FORGE=~/.foundry/bin/forge node ladder/scripts/dev-chain.mjs
```

脚本做这些事：

1. 编译合约，起一个新的 `anvil --network monad`，部署协议合约和擂台合约（`frontend/ladder.fixture.js`）。
2. 用 anvil 账号 0 和 2 注册几个出战模型。默认用 `ladder/data/artifacts/` 里训练好的“中”和“大”。如果本机 `.scratch/jolt/` 里有别的模型产物，也一起注册。`--artifacts a.json,b.json` 指定别的文件。`--no-seed` 不注册，擂台从空的开始。
3. 打几场挑战，直到结算。`--no-play` 跳过这一步。
4. 在进程内用 PGlite 起名字服务，挂在页面的 `/api/names`，并给已注册的出战模型起好名字。
5. 给每个登录账号起一个 Vite 开发服务器，通过 `VITE_LADDER_RPC`、`VITE_LADDER_FACTORY` 和 `VITE_LADDER_ADDRESS` 指向这个 anvil。第一个服务器用 `--port`（默认 5174），后面的依次加 1。

每个页面上点“登录”，用的是 anvil 默认助记词里的一个账号（`VITE_DEV_ACCOUNT`）。默认只有一个页面，用账号 1。它一开始没有出战模型，所以注册、挑战和起名字的整个流程都能在浏览器里走一遍。这些账号的私钥是公开的，只用于本地开发。

要试多个用户时，用 `--accounts` 列出账号序号（0 到 9）。每个账号一个页面，端口不同，所以登录状态各自独立。所有页面用同一条链和同一个名字服务。例如：

```bash
npm run dev:chain -w ladder -- --accounts 1,3,4,5,6,7 --no-seed
```

这样起 6 个页面，端口是 5174 到 5179，擂台是空的。

只起页面时，运行 `npm run dev -w ladder`。这时页面按 `data/deployments.json` 的 `31337` 连接 `http://127.0.0.1:18545`，名字服务不可用。

## 环境变量

页面（Vite，构建时读入）：

- `VITE_PRIVY_APP_ID`：Privy 应用 id。有它时，页面用 Privy 的嵌入式钱包登录（`showWalletUIs: false`，一场挑战的交易不逐笔弹窗）。没有它时，页面在本地链（31337）上用 anvil 默认助记词的账号，界面上标着“本地开发”。这只用于本地开发。
- `VITE_LADDER_CHAIN_ID`：页面所在的链，`data/deployments.json` 的一个键。默认是文件里第一条有擂台地址的正式链，没有时是 31337。
- `VITE_LADDER_RPC`、`VITE_LADDER_FACTORY`、`VITE_LADDER_ADDRESS`：可选。覆盖 `deployments.json` 里的 RPC、官方 Factory 和擂台合约地址。开发脚本用它们指向临时的 anvil。
- `VITE_DEV_ACCOUNT`：本地开发账号在助记词里的序号，默认 1。

合约的配置（δ、范围、冷却、超时、上限、赛季结束块）都从合约读，不写在页面里。

名字服务（Vercel 函数）：

- `DATABASE_URL`：Neon Postgres 的连接串。Vercel Marketplace 接入 Neon 以后会自动设置。
- `ADMIN_TOKEN`：管理员清除名字的 bearer token。不设置时，`DELETE` 一律拒绝。
- `LADDER_CHAIN_ID`：服务所在的链，对应 `data/deployments.json` 的一个键。
- `LADDER_RPC_URL`：可选。覆盖 `deployments.json` 里的 RPC。
- `LADDER_ADDRESS`：可选。覆盖 `deployments.json` 里的擂台合约地址。

## 页面

主页是一个长页面：顶栏、首屏两栏（左边是标题、说明、三步指引和按钮，右边是深色面板，播放最近一场挑战）、数据条、左侧粘性编号导航，然后是 4 节：开始、擂台榜、规则、最近的挑战。布局参考 Open Kernel Challenge 和 HashSmash，视觉风格参考 mojo.devnads.com。

另外 3 个视图按 URL 的 hash 切换：

- `#/entries` 我的出战模型：导入模型产物（文件或粘贴 JSON），页面先核对内容 id，然后部署并注册。注册以后可以起名字。
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
4. Build Command 是 `npm run build`，Output Directory 是 `dist`。
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
5. 赛季结束块。脚本实测 10 秒的出块速度，按天数算出建议值，人可以改。结束块写死在构造函数里，之后改不了。
6. 擂台合约：`contracts/script/DeployLadder.s.sol`，配置用规格的默认值；要改就在运行脚本前导出 `LADDER_*` 变量（见该脚本的注释）。
7. 把 Factory 和擂台地址写进 `data/deployments.json` 对应链的条目（只改这两行），之后要提交这个文件。
8. 链上核对（下一节）。
9. Vercel 项目：Root Directory `ladder`，打开 “Include source files outside of the Root Directory in the Build Step”。
10. Neon：从 Vercel Marketplace 安装，把数据库连到项目的 Production 和 Preview 环境，`DATABASE_URL` 自动注入。名字服务第一次被调用时自己建表。
11. Privy 应用：启用 Ethereum 嵌入式钱包，打开 “Disable confirmation modals”（一场挑战最多 20 笔交易连发），Allowed origins 填 Vercel 的域名。页面代码里也设了 `showWalletUIs: false` 和登录时建钱包。
12. Vercel 环境变量：`VITE_PRIVY_APP_ID`、`VITE_LADDER_CHAIN_ID`、`LADDER_CHAIN_ID`、`LADDER_RPC_URL`、`LADDER_ADDRESS`、`ADMIN_TOKEN`（脚本生成）。测试网写 Production 和 Preview，主网只覆盖 Production。然后重新部署。
13. 在上线的页面上走一遍：登录、注册、挑战、起名字。确认整场挑战没有弹出任何确认框。
14. （主网）比赛说明里写清已知限制：按 gas 上限收费、挑战者必须是无代码的 EOA、结束块、δ 和范围、冷却、超时。

## 链上核对（`scripts/verify-chain.mjs`）

原型阶段只在 anvil 上验证过的几件事，在真实网络上再验一次：

- 一个 EIP-7702 委托账号带代码（脚本打印代码长度：23 字节，`0xef0100` 加目标地址）。
- `challenge` 用 `NotEoa` 拒绝这个账号，而普通 EOA 过得了这一关（拒绝它的是别的原因）。
- 两个出战模型之间的一场挑战能从合约一路打到结算。脚本用 Factory 部署两份 中 网络的孪生体（最后一个权重字节是填充，加盐让每次运行都是新条目），注册，发起挑战（gas 上限 3000 万），`advance` 到结算。孪生体每局都平，所以这是 中-中 的最坏情况：600 步、5 笔交易。
- 每步 gas 和 `data/step-gas.json` 的 `mid-mid` 数字比较，偏差超过 30% 算失败，因为页面用这些数字估费用。

```
ANVIL=… FORGE=… node ladder/scripts/verify-chain.mjs --anvil                       # 自测：新起的 anvil --network monad
DEPLOYER_PRIVATE_KEY=0x… node ladder/scripts/verify-chain.mjs --rpc https://testnet-rpc.monad.xyz [--ladder 0x…]
```

`--ladder` 默认取 `data/deployments.json` 里这条链的地址。脚本打印每笔交易的 gas、部署账号实际付的钱，最后每项 PASS/FAIL；有失败时退出码是 1。真实网络上一次运行大约 20 MON（基础费 100 gwei 时）。
