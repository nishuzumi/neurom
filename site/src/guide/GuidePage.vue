<script setup>
// guide/GuidePage.vue — the participation guide of the site (`/guide/`, ADR 0027): train a tank network from zero,
// practise, deploy it, register it and challenge. The page has the top bar and the look of the other pages of the site
// (SiteBar.vue, styles.css), and its links come from site.js.
// One file holds the Chinese and the English text as `lang` pairs (AGENTS.md: the two languages change together). The
// root carries the locale of the site in `data-lang`, and styles.css hides the other language. So the long text of
// the guide does not go through t() and en.json, and site/src/i18n.test.js does not scan this file.
// The rules of the season (the size of the board, the range, δ, the timeout and the cooldown) come from the ladder
// contract over a read-only provider, as on the ladder page (App.vue, Rules.vue). The guide has no wallet. Until the
// read succeeds, or when the chain is not reachable, each number shows `…`.
import { computed, shallowRef } from 'vue';
import { locale, t } from '../i18n.js';
import { repoDoc, site } from '../site.js';
import { pageConfig } from '../config.js';
import { readConnection } from '../../../frontend/chain.js';
import { createLadderClient } from '../chain/client.js';
import { formatInt } from '../ladder/format.js';
import SiteBar from '../components/SiteBar.vue';

/** The workbench with the tank battle template on the canvas. */
const tankStudio = `${site.studio}?preset=tank-battle`;

/** The configuration of the ladder contract (client.js `config()`), or null before the read and when the read fails. */
const config = shallowRef(null);
const page = pageConfig();
if (page.ladder) {
  const { provider } = readConnection(page.chainId);
  createLadderClient({ provider, ladder: page.ladder }).config().then(c => { config.value = c; }, () => {});
}
/** `config[key]` as text, or `…` without a configuration. */
const v = key => (config.value ? formatInt(config.value[key]) : '…');
const boardSize = computed(() => v('boardSize'));
/** The rank of a new entry off a full board. */
const offBoardRank = computed(() => (config.value ? formatInt(config.value.boardSize + 1) : '…'));
const range = computed(() => v('range'));
const timeoutBlocks = computed(() => v('timeoutBlocks'));
const cooldownBlocks = computed(() => v('cooldownBlocks'));
/** δ in percent, and the share of the defender's weight size the challenger must stay under on equal wins. */
const delta = computed(() => (config.value ? config.value.deltaBps / 100 : null));
const deltaText = computed(() => (delta.value === null ? '…' : `${delta.value}%`));
const keepText = computed(() => (delta.value === null ? '…' : `${100 - delta.value}%`));
</script>

<template>
<div class="guide-page" :data-lang="locale()">
  <SiteBar page="guide" :sub="t('参与指南')">
    <template #nav>
      <a href="#train"><span lang="zh">训练</span><span lang="en">Train</span></a>
      <a href="#practice"><span lang="zh">模拟挑战</span><span lang="en">Practice</span></a>
      <a href="#deploy"><span lang="zh">部署</span><span lang="en">Deploy</span></a>
      <a href="#challenge"><span lang="zh">挑战</span><span lang="en">Challenge</span></a>
      <a href="#faq"><span lang="zh">常见问题</span><span lang="en">FAQ</span></a>
    </template>
  </SiteBar>

  <main id="top">
    <div class="guide-hero">
      <div class="wrap">
        <div class="label"><span lang="zh">坦克擂台赛 · Monad 测试网</span><span lang="en">Tank ladder · Monad testnet</span></div>
        <h1 style="margin-top: 14px"><span lang="zh">从零训练一个坦克网络，<br>然后上链挑战擂主</span><span lang="en">Train a tank network from zero,<br>then challenge the ladder on chain</span></h1>
        <p lang="zh">你在浏览器里训练网络，不用写代码，也不用安装软件。训练好的网络部署成链上模块，注册成出战模型，然后挑战排在你上面的擂主。判胜负的是链上的擂台合约，每一场都能回放和复现。</p>
        <p lang="en">You train the network in the browser. You do not write code or install software. You deploy the trained network as an on-chain module, register it as an entry, and challenge the defenders above you. The ladder contract on chain decides each challenge. You can replay and reproduce every challenge.</p>
        <div class="actions">
          <a class="btn btn-primary" :href="tankStudio"><span lang="zh">打开工作台</span><span lang="en">Open the workbench</span></a>
          <a class="btn" :href="site.ladder"><span lang="zh">看榜单</span><span lang="en">See the board</span></a>
        </div>
        <div class="guide-facts">
          <div class="guide-fact"><span class="label"><span lang="zh">训练时间</span><span lang="en">Training time</span></span><b><span lang="zh">40–50 分钟</span><span lang="en">40–50 min</span></b><span class="muted"><span lang="zh">完整的两个阶段，浏览器</span><span lang="en">both stages, in the browser</span></span></div>
          <div class="guide-fact"><span class="label"><span lang="zh">网络大小</span><span lang="en">Network size</span></span><b class="mono">39,840 B</b><span class="muted"><span lang="zh">中；大是 216,864 B</span><span lang="en">中 (mid). 大 (big) is 216,864 B</span></span></div>
          <div class="guide-fact"><span class="label"><span lang="zh">一场挑战</span><span lang="en">One challenge</span></span><b><span lang="zh">6 局</span><span lang="en">6 episodes</span></b><span class="muted"><span lang="zh">3 对镜像局，每局最多 100 步</span><span lang="en">3 mirror pairs, 100 steps at most</span></span></div>
          <div class="guide-fact"><span class="label"><span lang="zh">榜单</span><span lang="en">Board</span></span><b><span lang="zh">{{ boardSize }} 个名次</span><span lang="en">{{ boardSize }} ranks</span></b><span class="muted"><span lang="zh">可以挑战高 1–{{ range }} 名的擂主</span><span lang="en">challenge 1–{{ range }} ranks above</span></span></div>
        </div>
        <ol class="flow">
          <li><span lang="zh">打开工作台</span><span lang="en">Open the workbench</span></li>
          <li><span lang="zh">训练</span><span lang="en">Train</span></li>
          <li><span lang="zh">接受候选</span><span lang="en">Accept a candidate</span></li>
          <li class="opt"><span lang="zh">模拟挑战（可选）</span><span lang="en">Practice (optional)</span></li>
          <li><span lang="zh">登录和充值</span><span lang="en">Log in and fund</span></li>
          <li><span lang="zh">部署到测试网</span><span lang="en">Deploy to testnet</span></li>
          <li><span lang="zh">注册</span><span lang="en">Register</span></li>
          <li><span lang="zh">挑战和回放</span><span lang="en">Challenge and replay</span></li>
        </ol>
      </div>
    </div>

    <!-- 0 -->
    <section class="step" id="prepare">
      <div class="wrap">
        <div class="step-head"><span class="step-num">00</span><h2><span lang="zh">准备</span><span lang="en">Before you start</span></h2></div>
        <div class="cols">
          <div>
            <p style="margin-top: 0" lang="zh">所有步骤都在这个网站上做。只有可选的模拟挑战要在你的电脑上运行一个本地节点。网站有两个页面：</p>
            <p style="margin-top: 0" lang="en">You do all the steps on this site. Only the optional practice challenge runs a local node on your computer. The site has two pages:</p>
            <table>
              <tr><th><span lang="zh">页面</span><span lang="en">Page</span></th><th><span lang="zh">在这里做</span><span lang="en">What you do there</span></th></tr>
              <tr><td class="num"><a :href="tankStudio">/studio/</a></td><td><span lang="zh">工作台：训练、接受候选、模拟挑战、部署（第 01 到 06 步）。</span><span lang="en">The workbench: train, accept a candidate, practise, deploy (steps 01 to 06).</span></td></tr>
              <tr><td class="num"><a :href="site.ladder">/ladder/</a></td><td><span lang="zh">擂台：注册出战模型、挑战、回放（第 07 和 08 步）。</span><span lang="en">The ladder: register an entry, challenge, replay (steps 07 and 08).</span></td></tr>
            </table>
            <p lang="zh">两个页面在同一个网站上，所以登录一次就够了。</p>
            <p lang="en">The two pages are on the same site, so one login is enough.</p>
          </div>
          <div class="card">
            <h3><span lang="zh">你需要</span><span lang="en">You need</span></h3>
            <ul>
              <li lang="zh">Chrome 浏览器。我们用 Chrome 测试。</li>
              <li lang="en">The Chrome browser. We test with Chrome.</li>
              <li lang="zh">一个邮箱，用来登录。登录后 Privy 自动给你一个钱包。</li>
              <li lang="en">An email address for the login. After the login, Privy gives you a wallet.</li>
              <li lang="zh">测试网 MON，付部署和挑战的 gas。从 <a href="https://faucet.monad.xyz" rel="noopener">Monad 水龙头</a>领取。</li>
              <li lang="en">Testnet MON to pay the gas of the deployment and the challenges. Get it from the <a href="https://faucet.monad.xyz" rel="noopener">Monad faucet</a>.</li>
              <li lang="zh">可选：<a href="https://book.getfoundry.sh/getting-started/installation" rel="noopener">Foundry</a>，模拟挑战要用。</li>
              <li lang="en">Optional: <a href="https://book.getfoundry.sh/getting-started/installation" rel="noopener">Foundry</a>, for practice challenges.</li>
            </ul>
          </div>
        </div>
      </div>
    </section>

    <!-- 1 -->
    <section class="step" id="open">
      <div class="wrap">
        <div class="step-head"><span class="step-num">01</span><h2><span lang="zh">打开工作台</span><span lang="en">Open the workbench</span></h2></div>
        <div class="cols">
          <ol class="do">
            <li lang="zh">打开 <a :href="tankStudio"><code>/studio/?preset=tank-battle</code></a>。</li>
            <li lang="en">Open <a :href="tankStudio"><code>/studio/?preset=tank-battle</code></a>.</li>
            <li lang="zh">画布上出现「坦克大战」模板。按 <span class="ui">F</span> 看全图。</li>
            <li lang="en">The 「坦克大战」 (tank battle) template opens on the canvas. Press <span class="ui">F</span> to see all of it.</li>
          </ol>
          <div class="card">
            <h3><span lang="zh">模板里有什么</span><span lang="en">What the template holds</span></h3>
            <ul>
              <li lang="zh">左边：规则参数、场景和指标。</li>
              <li lang="en">Left: the rule parameters, the scene and the metrics.</li>
              <li lang="zh">中间：4 个训练模块。阶段 1 和阶段 2 各有「中」和「大」。</li>
              <li lang="en">Middle: 4 training modules. Stage 1 and stage 2 each have 「中」 (mid) and 「大」 (big).</li>
              <li lang="zh">右边：4 个「链上部署」、「坦克对战」和「链节点（本地 fork）」。</li>
              <li lang="en">Right: 4 「链上部署」 (deployment) modules, 「坦克对战」 (tank battle) and 「链节点（本地 fork）」 (chain node, local fork).</li>
            </ul>
          </div>
        </div>
      </div>
    </section>

    <!-- 2 -->
    <section class="step" id="train">
      <div class="wrap">
        <div class="step-head"><span class="step-num">02</span><h2><span lang="zh">训练</span><span lang="en">Train</span></h2></div>
        <div class="cols">
          <div>
            <ol class="do">
              <li lang="zh">选择「中」或「大」。右边的表比较两者。</li>
              <li lang="en">Select 「中」 (mid) or 「大」 (big). The table at the right compares them.</li>
              <li lang="zh">找到「训练器（中，阶段 2）」或「训练器（大，阶段 2）」。</li>
              <li lang="en">Find 「训练器（中，阶段 2）」 or 「训练器（大，阶段 2）」 (the stage 2 trainer).</li>
              <li lang="zh">点它标题栏右边的 <span class="ui">▷</span>（运行到这里）。</li>
              <li lang="en">Click <span class="ui">▷</span> (run up to here) at the right of its title bar.</li>
              <li lang="zh">等待训练完成。训练器显示进度和曲线。</li>
              <li lang="en">Wait until the training is complete. The trainer shows the progress and the curves.</li>
            </ol>
            <p lang="zh">▷ 先训练阶段 1：网络模仿场景里的教师。然后它评估阶段 1。评估通过（和教师一致的比例 ≥ 0.65）以后，它训练阶段 2：网络从阶段 1 的权重开始，用强化学习和机器人对战。</p>
            <p lang="en">▷ first trains stage 1: the network imitates the teacher of the scene. Then it evaluates stage 1. When the evaluation passes (agreement with the teacher ≥ 0.65), it trains stage 2: the network starts from the stage 1 weights and plays the bot with reinforcement learning.</p>
            <div class="note" lang="zh">训练在你的浏览器里运行，所以训练时不要关这个标签页。要先试一遍整个流程，可以在训练器里把 <code>epochs</code> 改小，例如阶段 1 改成 500，阶段 2 改成 400。这样大约 7 分钟，但是网络会弱一些。</div>
            <div class="note" lang="en">The training runs in your browser, so do not close the tab during the training. To try the full flow first, set a smaller <code>epochs</code> in the trainers, for example 500 for stage 1 and 400 for stage 2. This takes about 7 minutes, but the network is weaker.</div>
          </div>
          <div>
            <table>
              <tr><th></th><th><span lang="zh">中</span><span lang="en">中 (mid)</span></th><th><span lang="zh">大</span><span lang="en">大 (big)</span></th></tr>
              <tr><td><span lang="zh">结构</span><span lang="en">Structure</span></td><td class="num">572→32→32→9</td><td class="num">572→128×3→9</td></tr>
              <tr><td><span lang="zh">链上权重</span><span lang="en">On-chain weights</span></td><td class="num">39,840 B</td><td class="num">216,864 B</td></tr>
              <tr><td><span lang="zh">阶段 1</span><span lang="en">Stage 1</span></td><td class="num"><span lang="zh">约 34 分钟</span><span lang="en">about 34 min</span></td><td class="num"><span lang="zh">约 19 分钟</span><span lang="en">about 19 min</span></td></tr>
              <tr><td><span lang="zh">阶段 2</span><span lang="en">Stage 2</span></td><td class="num"><span lang="zh">约 15 分钟</span><span lang="en">about 15 min</span></td><td class="num"><span lang="zh">约 21 分钟</span><span lang="en">about 21 min</span></td></tr>
              <tr><td><span lang="zh">挑战的 gas</span><span lang="en">Gas of a challenge</span></td><td><span lang="zh">低</span><span lang="en">lower</span></td><td><span lang="zh">高</span><span lang="en">higher</span></td></tr>
            </table>
            <p class="muted" style="font-size: 13px" lang="zh">时间来自浏览器里的实际训练记录。时间随电脑不同而变化。平局时权重小的挑战者有利（见第 08 步），所以「中」不一定吃亏。</p>
            <p class="muted" style="font-size: 13px" lang="en">The times come from real training runs in the browser. They change with the computer. On equal wins, a smaller challenger has the advantage (see step 08), so 「中」 is not always weaker on the ladder.</p>
          </div>
        </div>
      </div>
    </section>

    <!-- 3 -->
    <section class="step" id="accept">
      <div class="wrap">
        <div class="step-head"><span class="step-num">03</span><h2><span lang="zh">接受候选</span><span lang="en">Accept a candidate</span></h2></div>
        <div class="cols">
          <ol class="do">
            <li lang="zh">在「候选（大，阶段 2）」（或「中」）里，找到这次训练的新一行。</li>
            <li lang="en">In 「候选（大，阶段 2）」 (or 「中」), find the new row of this training.</li>
            <li lang="zh">点 <span class="ui">接受</span>。部署模块和对战都用已接受的候选。</li>
            <li lang="en">Click <span class="ui">接受</span> (accept). The deployment module and the battle use the accepted candidate.</li>
            <li lang="zh">可选：在「评估器」里点 <span class="ui">评估</span>，「评估报告」显示胜率和其他指标。</li>
            <li lang="en">Optional: click <span class="ui">评估</span> (evaluate) in the evaluator. 「评估报告」 (the report) shows the win rate and the other metrics.</li>
          </ol>
          <div class="card">
            <h3><span lang="zh">先看一局</span><span lang="en">Watch a battle first</span></h3>
            <p style="margin: 0" lang="zh">「坦克对战」的红方是已接受的「中，阶段 2」。「对战设置」选蓝方：0 是已接受的「大，阶段 2」，1 到 3 是这一档的机器人。点 <span class="ui">运行</span> 或 <span class="ui">单步</span> 看它们怎么走。只训练了「大」时，看评估报告更直接。</p>
            <p style="margin: 0" lang="en">The red side of 「坦克对战」 (tank battle) is the accepted 「中，阶段 2」 (mid, stage 2). 「对战设置」 (battle settings) selects the blue side: 0 is the accepted 「大，阶段 2」 (big, stage 2), 1 to 3 is the bot of that level. Click <span class="ui">运行</span> (run) or <span class="ui">单步</span> (step) to watch them. If you trained only 「大」, the evaluation report tells you more.</p>
          </div>
        </div>
      </div>
    </section>

    <!-- 4 -->
    <section class="step" id="practice">
      <div class="wrap">
        <div class="step-head"><span class="step-num">04</span><h2><span lang="zh">模拟挑战</span><span lang="en">Practice challenge</span></h2><span class="tag"><span lang="zh">可选</span><span lang="en">optional</span></span></div>
        <div class="cols">
          <div>
            <p style="margin-top: 0" lang="zh">模拟挑战在你电脑上的测试网 fork 里，用真实的擂台合约打你选的擂主。每个种子打完以后，fork 回到原来的状态。它不花 MON，也不改真实的名次。网页通过 <code>127.0.0.1:18645</code> 连接这个 fork。</p>
            <p style="margin-top: 0" lang="en">A practice challenge plays the defender of your choice on a fork of the testnet on your computer, with the real ladder contract. After each seed, the fork goes back to its earlier state. It spends no MON and changes no real rank. The web page connects to the fork through <code>127.0.0.1:18645</code>.</p>
            <ol class="do">
              <li lang="zh">安装 Foundry。</li>
              <li lang="en">Install Foundry.</li>
              <li lang="zh">运行下面的命令，然后不要关这个终端：</li>
              <li lang="en">Run this command, and keep the terminal open:</li>
            </ol>
<pre>anvil --network monad --fork-url https://testnet-rpc.monad.xyz --chain-id 1014300 --port 18645</pre>
            <ol class="do" start="3">
              <li lang="zh">如果 Chrome 问是否允许这个网站访问本地网络，点「允许」。</li>
              <li lang="en">If Chrome asks to let this site access your local network, click "Allow".</li>
              <li lang="zh">确认「链节点（本地 fork）」显示「已连接」。</li>
              <li lang="en">Make sure that 「链节点（本地 fork）」 (chain node) shows 「已连接」 (connected).</li>
              <li lang="zh">在「链上部署」里，网络选 <span class="ui">Local fork of Monad Testnet</span>，填模块 ID，然后点 <span class="ui">连接</span> 和 <span class="ui">部署当前产物</span>。</li>
              <li lang="en">In 「链上部署」 (deployment), select the network <span class="ui">Local fork of Monad Testnet</span>, enter a module ID, then click <span class="ui">连接</span> (connect) and <span class="ui">部署当前产物</span> (deploy).</li>
              <li lang="zh">在「坦克对战」里点 <span class="ui">重置</span>，挑战者列表才会出现你的网络。</li>
              <li lang="en">In 「坦克对战」, click <span class="ui">重置</span> (reset), so that the challenger list shows your network.</li>
              <li lang="zh">在「模拟挑战」里选挑战者、擂主和种子数，然后点 <span class="ui">运行</span>。</li>
              <li lang="en">In 「模拟挑战」 (practice challenge), select the challenger, the defender and the number of seeds, then click <span class="ui">运行</span> (run).</li>
              <li lang="zh">在结果表里点一局的「胜」或「负」，回放这一局。</li>
              <li lang="en">In the result table, click 「胜」 or 「负」 of an episode to replay it.</li>
            </ol>
          </div>
          <div class="card">
            <h3><span lang="zh">要知道的事</span><span lang="en">Good to know</span></h3>
            <ul>
              <li lang="zh">真实挑战的种子由挑战那一块的 PREVRANDAO 决定，事先算不出来。模拟给出的是一组种子上的胜率。</li>
              <li lang="en">The seed of a real challenge comes from the PREVRANDAO of its block, so nobody can know it before. A practice challenge gives the win rate over a set of seeds.</li>
              <li lang="zh">部署到 fork 时，签名的是 anvil 的默认账户，不是你的钱包。</li>
              <li lang="en">A deployment to the fork signs with the default anvil account, not with your wallet.</li>
              <li lang="zh">模拟时，挑战者可以选榜上任何一个擂主。真实挑战只能挑战高 1 到 {{ range }} 名的擂主。</li>
              <li lang="en">In a practice challenge, the challenger can select any defender. A real challenge can go only 1 to {{ range }} ranks up.</li>
              <li lang="zh">重启 fork 以后，部署过的网络会丢失。再部署一次就行，不花 MON。</li>
              <li lang="en">A restart of the fork loses the deployed network. Deploy it again. This costs no MON.</li>
            </ul>
          </div>
        </div>
      </div>
    </section>

    <!-- 5 -->
    <section class="step" id="login">
      <div class="wrap">
        <div class="step-head"><span class="step-num">05</span><h2><span lang="zh">登录和充值</span><span lang="en">Log in and fund the wallet</span></h2></div>
        <div class="cols">
          <ol class="do">
            <li lang="zh">点工作台顶栏的 <span class="ui">登录</span>，用邮箱登录。</li>
            <li lang="en">Click <span class="ui">登录</span> (log in) in the top bar of the workbench, and log in with your email.</li>
            <li lang="zh">记下顶栏显示的钱包地址。</li>
            <li lang="en">Note the wallet address in the top bar.</li>
            <li lang="zh">从 <a href="https://faucet.monad.xyz" rel="noopener">Monad 水龙头</a>给这个地址领 MON。</li>
            <li lang="en">Get MON for this address from the <a href="https://faucet.monad.xyz" rel="noopener">Monad faucet</a>.</li>
          </ol>
          <div class="card">
            <p style="margin: 0" lang="zh">部署和注册要用同一个账号，因为擂台页只列出当前账号部署的模块。</p>
            <p style="margin: 0" lang="en">Deploy and register with the same account, because the ladder page lists only the modules of the current account.</p>
          </div>
        </div>
      </div>
    </section>

    <!-- 6 -->
    <section class="step" id="deploy">
      <div class="wrap">
        <div class="step-head"><span class="step-num">06</span><h2><span lang="zh">部署到测试网</span><span lang="en">Deploy to the testnet</span></h2></div>
        <div class="cols">
          <ol class="do">
            <li lang="zh">找到和你的候选同一阶段、同一结构的「链上部署」，例如「链上部署（大，阶段 2）」。</li>
            <li lang="en">Find the 「链上部署」 (deployment) module of the same stage and structure as your candidate, for example 「链上部署（大，阶段 2）」.</li>
            <li lang="zh">网络保持默认的擂台链 <span class="ui">Monad Testnet (10143)</span>。</li>
            <li lang="en">Keep the default network, the chain of the ladder: <span class="ui">Monad Testnet (10143)</span>.</li>
            <li lang="zh">在「模块 ID」里填一个名字，例如 <code>my-tank-v1</code>。</li>
            <li lang="en">Enter a name in 「模块 ID」 (module ID), for example <code>my-tank-v1</code>.</li>
            <li lang="zh">点 <span class="ui">连接</span>。可以先点 <span class="ui">部署计划</span>，看要发几笔交易。</li>
            <li lang="en">Click <span class="ui">连接</span> (connect). You can click <span class="ui">部署计划</span> (deployment plan) first to see the transactions.</li>
            <li lang="zh">点 <span class="ui">部署当前产物</span>，然后等交易完成。</li>
            <li lang="en">Click <span class="ui">部署当前产物</span> (deploy), then wait until the transactions are complete.</li>
          </ol>
          <div class="card">
            <h3><span lang="zh">模块 ID 的规则</span><span lang="en">Module ID rules</span></h3>
            <ul>
              <li lang="zh">3 到 64 个字符，第一个是小写字母。</li>
              <li lang="en">3 to 64 characters. The first is a lowercase letter.</li>
              <li lang="zh">其余字符只用小写字母、数字、<code>-</code> 和 <code>_</code>。</li>
              <li lang="en">The other characters are lowercase letters, digits, <code>-</code> and <code>_</code> only.</li>
              <li lang="zh">同一个账号里不能重复。部署以后不能改。</li>
              <li lang="en">It must be unique for your account. You cannot change it after the deployment.</li>
            </ul>
            <p class="muted" style="margin: 10px 0 0; font-size: 13px" lang="zh">工作台通过官方 Factory 部署。Factory 记下模块地址、部署账号和模块 ID。Monad 按 gas 上限收费，不按实际用量。</p>
            <p class="muted" style="margin: 10px 0 0; font-size: 13px" lang="en">The workbench deploys through the official Factory. The Factory records the module address, the deploying account and the module ID. Monad charges the gas limit, not the gas used.</p>
          </div>
        </div>
      </div>
    </section>

    <!-- 7 -->
    <section class="step" id="register">
      <div class="wrap">
        <div class="step-head"><span class="step-num">07</span><h2><span lang="zh">注册</span><span lang="en">Register</span></h2></div>
        <div class="cols">
          <ol class="do">
            <li lang="zh">打开擂台页 <a :href="site.ladder"><code>/ladder/</code></a>。</li>
            <li lang="en">Open the ladder page <a :href="site.ladder"><code>/ladder/</code></a>.</li>
            <li lang="zh">确认登录的是部署时的同一个账号。</li>
            <li lang="en">Make sure that you are logged in with the account of the deployment.</li>
            <li lang="zh">在「你部署的模块」里选你的模块。</li>
            <li lang="en">In 「你部署的模块」 (your deployed modules), select your module.</li>
            <li lang="zh">点 <span class="ui">注册</span>，然后等交易完成。</li>
            <li lang="en">Click <span class="ui">注册</span> (register), then wait until the transaction is complete.</li>
          </ol>
          <div class="card">
            <ul>
              <li lang="zh">榜单有 {{ boardSize }} 个名次。没满时，新出战模型排在最后一名。</li>
              <li lang="en">The board has {{ boardSize }} ranks. When it is not full, a new entry takes the last rank.</li>
              <li lang="zh">榜单满了以后，新出战模型在榜外，当作第 {{ offBoardRank }} 名发起挑战。</li>
              <li lang="en">When the board is full, a new entry is off the board, and it challenges as rank {{ offBoardRank }}.</li>
              <li lang="zh">合约拒绝和已注册出战模型权重完全相同的模块。</li>
              <li lang="en">The contract refuses a module with the same weights as a registered entry.</li>
            </ul>
          </div>
        </div>
      </div>
    </section>

    <!-- 8 -->
    <section class="step" id="challenge">
      <div class="wrap">
        <div class="step-head"><span class="step-num">08</span><h2><span lang="zh">挑战和回放</span><span lang="en">Challenge and replay</span></h2></div>
        <div class="cols">
          <div>
            <ol class="do">
              <li lang="zh">在擂台页点 <span class="ui">去挑战</span>，选一个比你高 1 到 {{ range }} 名的擂主。</li>
              <li lang="en">On the ladder page, click <span class="ui">去挑战</span> (go challenge), and select a defender 1 to {{ range }} ranks above you.</li>
              <li lang="zh">看对话框里的「预计费用」，确认余额够用。</li>
              <li lang="en">Read 「预计费用」 (the estimated cost) in the dialog, and make sure that your balance is enough.</li>
              <li lang="zh">点 <span class="ui">发起挑战</span>。一场挑战要发几笔交易，页面会一笔一笔地发。</li>
              <li lang="en">Click <span class="ui">发起挑战</span> (start the challenge). A challenge takes several transactions, and the page sends them one by one.</li>
              <li lang="zh">打完以后点 <span class="ui">回放</span>，看每一局。</li>
              <li lang="en">After the challenge, click <span class="ui">回放</span> (replay) to watch each episode.</li>
            </ol>
            <div class="caution" lang="zh">注意：如果你在挑战没打完时关掉页面，下次打开页面会提示继续。挑战超过 {{ timeoutBlocks }} 个区块还没打完，就判守擂成功。</div>
            <div class="caution" lang="en">CAUTION: If you close the page before the challenge ends, the page asks you to continue it the next time. A challenge that does not end within {{ timeoutBlocks }} blocks is a defense.</div>
          </div>
          <div class="card">
            <h3><span lang="zh">规则</span><span lang="en">Rules</span></h3>
            <ul>
              <li lang="zh">一场挑战是 3 对镜像局，共 6 局。镜像局里两边交换位置。</li>
              <li lang="en">A challenge is 3 mirror pairs, 6 episodes in total. The two sides change places in each pair.</li>
              <li lang="zh">挑战者赢的局多于擂主，挑战成功。</li>
              <li lang="en">The challenger wins when it wins more episodes than the defender.</li>
              <li lang="zh">赢的局数相等时（包括 0:0），挑战者的权重不大于擂主的 {{ keepText }}（δ = {{ deltaText }}）才算赢，否则守擂成功。</li>
              <li lang="en">On equal wins (0:0 too), the challenger wins only when its weights are at most {{ keepText }} of the defender's (δ = {{ deltaText }}). Else it is a defense.</li>
              <li lang="zh">挑战成功时，挑战者占擂主的名次，擂主和中间的出战模型各降 1 名。</li>
              <li lang="en">When the challenger wins, it takes the defender's rank. The defender and the entries between them each go down 1 rank.</li>
              <li lang="zh">同一对挑战者和擂主，{{ cooldownBlocks }} 个区块里只能挑战一次。</li>
              <li lang="en">The same challenger can challenge the same defender once in {{ cooldownBlocks }} blocks.</li>
            </ul>
          </div>
        </div>
      </div>
    </section>

    <!-- FAQ -->
    <section class="step" id="faq">
      <div class="wrap">
        <div class="step-head"><span class="step-num">??</span><h2><span lang="zh">常见问题</span><span lang="en">FAQ</span></h2></div>
        <table>
          <tr><th><span lang="zh">现象</span><span lang="en">Problem</span></th><th><span lang="zh">原因和处理</span><span lang="en">Cause and fix</span></th></tr>
          <tr>
            <td><span lang="zh">训练很慢</span><span lang="en">The training is slow</span></td>
            <td><span lang="zh">时间主要花在模拟对局上，不在网络大小。网站上的工作台只在浏览器里训练。调试时把 <code>epochs</code> 改小。</span><span lang="en">Most of the time goes to the simulated episodes, not to the network size. The workbench of the site trains only in the browser. For a trial, set a smaller <code>epochs</code>.</span></td>
          </tr>
          <tr>
            <td><span lang="zh">「开始训练」是灰的</span><span lang="en">「开始训练」 is disabled</span></td>
            <td><span lang="zh">阶段 2 要从阶段 1 已接受的权重开始。用 ▷（运行到这里），它会先训练阶段 1。</span><span lang="en">Stage 2 starts from the accepted stage 1 weights. Use ▷ (run up to here). It trains stage 1 first.</span></td>
          </tr>
          <tr>
            <td><span lang="zh">部署或挑战提示余额不足</span><span lang="en">A deployment or a challenge says the balance is too low</span></td>
            <td><span lang="zh">从 <a href="https://faucet.monad.xyz" rel="noopener">Monad 水龙头</a>领更多 MON。Monad 按 gas 上限收费，不按实际用量，所以余额要比实际花费多。</span><span lang="en">Get more MON from the <a href="https://faucet.monad.xyz" rel="noopener">Monad faucet</a>. Monad charges the gas limit, not the gas used, so the balance must be more than the real cost.</span></td>
          </tr>
          <tr>
            <td><span lang="zh">模拟挑战显示「链节点无法访问」</span><span lang="en">The practice says the chain node is not reachable</span></td>
            <td><span lang="zh">fork 没有运行，或者 Chrome 没有允许这个网站访问本地网络。运行第 04 步的 anvil 命令。在地址栏左边的网站设置里允许本地网络访问。然后在「坦克对战」里点「重置」。</span><span lang="en">The fork is not running, or Chrome does not let this site access the local network. Run the anvil command of step 04. Allow local network access in the site settings at the left of the address bar. Then click 「重置」 (reset) in 「坦克对战」.</span></td>
          </tr>
          <tr>
            <td><span lang="zh">挑战者列表是空的</span><span lang="en">The challenger list is empty</span></td>
            <td><span lang="zh">fork 上还没有你部署的网络，或者部署以后没有点「重置」。</span><span lang="en">Your network is not deployed on the fork yet, or you did not click 「重置」 after the deployment.</span></td>
          </tr>
          <tr>
            <td><span lang="zh">注册时提示权重相同</span><span lang="en">The registration says the weights are the same</span></td>
            <td><span lang="zh">榜上已经有一份完全相同的权重。重新训练，或者换一个候选。</span><span lang="en">The board already has the same weights. Train again, or use a different candidate.</span></td>
          </tr>
        </table>
      </div>
    </section>
  </main>

  <footer>
    <div class="wrap">
      <span lang="zh">更多细节见 <a :href="repoDoc('docs/user-guide.md')" rel="noopener">使用指南</a>、<a :href="repoDoc('site/README.md')" rel="noopener">网站 README</a> 和 ADR 0026、0028。</span>
      <span lang="en">For more detail, see the <a :href="repoDoc('docs/user-guide.en.md')" rel="noopener">user guide</a>, the <a :href="repoDoc('site/README.en.md')" rel="noopener">site README</a> and ADR 0026 and 0028.</span>
    </div>
  </footer>
</div>
</template>
