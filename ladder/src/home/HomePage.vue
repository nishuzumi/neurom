<script setup>
// home/HomePage.vue — the home page of the site (`/`): what NEUROM is, the flow from the canvas to the tank ladder, the
// features, the Monad measurements and the links to the workbench, the ladder and the documents. The text comes
// from README.md and README.en.md. The page has the look of the ladder page (styles.css) and the same top bar.
import { computed } from 'vue';
import { locale, t } from '../i18n.js';
import { repoDoc, site } from '../site.js';
import SiteBar from '../components/SiteBar.vue';
import studioZh from '../assets/studio-zh.png';
import studioEn from '../assets/studio-en.png';

/** The screenshot of the workbench in the language of the page. */
const studioShot = computed(() => (locale() === 'en' ? studioEn : studioZh));
/** A repo document in the language of the page: `docs/x.md` or `docs/x.en.md`. */
const doc = path => repoDoc(locale() === 'en' ? path.replace(/\.md$/, '.en.md') : path);

const FLOW = [
  ['搭建任务', '在画布上用模块搭建任务：参数、场景、奖励、网络、训练器和链上部署。模块之间用线连接。'],
  ['训练', '在浏览器里训练网络，或者交给本机的 Python 训练。每次训练生成候选，你接受一个候选。'],
  ['部署到 Monad', '链上部署模块把接受的网络部署成 Monad 上的模块合约。每发一笔 step 交易，合约就在链上算出网络的下一步。'],
  ['上擂台', '把训练好的坦克网络注册成出战模型，挑战排在你上面的出战模型。裁判是链上合约，每一场都能回放。'],
];

const FEATURES = [
  ['用模块搭建任务', '场景、奖励和指标是代码模块，用 JavaScript 写。代码模块导出的函数和常量就是它的端口。连线有类型检查。一个任务保存成一份 YAML 模板。'],
  ['训练网络', '有三种训练方法：REINFORCE、交叉熵和 hinge。训练器在整条回路上训练一个网络。训练时就用 int8 或 int16 整数权重计算，评估和上链用的就是这些权重。'],
  ['运行和检查', '执行实例逐步运行整条回路。地图视图画出玩家的位置和走过的路。评估器在验证分区和测试分区上运行网络，然后按分组列出结果。'],
  ['工具层', '网络可以有工具层。工具层每一步从几个训练好的网络里选一个，并决定交给它哪些数据位。只有选中的网络运行。'],
  ['部署到链上', '每一步，工作台都把链上结果和本地结果对比。LIF 网络的电位保存在合约里。新的权重部署成新的合约。'],
];

/** README: the mining network FF 185→32→7 (int8), gas of each transaction (gasUsed of the receipt). */
const GAS_TX = [
  ['部署（权重块 + 模块，一笔交易）', '1,910,812', '1,982,588', '+3.8%'],
  ['一笔 step 交易（63 笔的中位数）', '75,674', '95,571', '+26.3%'],
  ['63 笔 step 交易合计', '4,775,707', '6,029,218', '+26.2%'],
  ['一笔 step 交易实际扣费的 gas', '75,663', '106,008', '+40.1%'],
];

/** README: 63 steps in one transaction, 5 networks with synthetic weights. */
const GAS_SIZE = [
  ['185→32→7 int8', '3.36M', '3.56M', '−5.6%'],
  ['185→128→128→7 int8', '17.6M', '21.4M', '−17.7%'],
  ['185→256→256→7 int8', '41.6M', '56.4M', '−26.2%'],
  ['185→256→256→7 int16', '51.9M', '74.4M', '−30.2%'],
  ['185→256×4→7 int8', '92.1M', '147.8M', '−37.6%'],
];

/** The author line of the README. The X handle is a link, so the line is HTML (v-html). */
const AUTHOR = '作者：Box（X：<a href="https://x.com/boxmrchen" rel="noopener">@boxmrchen</a>）· DevRel From Monad Foundation';
</script>

<template>
  <SiteBar page="home" />
  <section class="hero home-hero"><div class="wrap">
    <div class="hero-left">
      <span class="label">NEUROM / {{ t('神经网络工作台') }}</span>
      <h1>{{ t('搭建、训练、部署到链上') }}</h1>
      <p class="lead">{{ t('NEUROM 是一个神经网络工作台。你在浏览器的画布上搭建任务，训练一个小型神经网络，再看它一步一步地运行。训练好的网络可以部署到 Monad，成为一个合约。部署以后，网络的每一步推理都在链上完成。') }}</p>
      <p class="lead">{{ t('NEUROM 用整数脉冲神经网络，包括阈值网络和 LIF 网络。浏览器、Python 和 Solidity 按同一套整数规则计算，所以链上算出的结果和画布上的结果一样。') }}</p>
      <div class="hero-actions">
        <a class="btn btn-primary" :href="site.studio">{{ t('打开工作台') }}</a>
        <a class="btn" :href="site.ladder">{{ t('坦克擂台赛') }}</a>
        <a class="btn" :href="site.guide">{{ t('参与指南') }}</a>
        <a class="btn" :href="doc('docs/user-guide.md')" rel="noopener">{{ t('使用指南') }}</a>
      </div>
    </div>
    <div class="hero-right">
      <a class="home-shot" :href="site.studio"><img :src="studioShot" :alt="t('工作台：挖矿任务的画布，左栏是参数和训练器，右边是回路框')"></a>
      <div class="hero-caption"><span>{{ t('工作台') }} · /studio/</span><a :href="site.studio">{{ t('打开') }} →</a></div>
    </div>
  </div></section>

  <div class="home"><div class="wrap">
    <section id="flow" class="section">
      <div class="section-head"><div><span class="label">{{ t('流程') }} / 01</span><h2>{{ t('从画布到擂台') }}</h2></div></div>
      <div class="cards four">
        <div v-for="([title, desc], i) in FLOW" :key="title" class="card-step">
          <span class="n">0{{ i + 1 }}</span>
          <h3>{{ t(title) }}</h3>
          <p>{{ t(desc) }}</p>
        </div>
      </div>
    </section>

    <section id="features" class="section">
      <div class="section-head"><div><span class="label">{{ t('功能') }} / 02</span><h2>{{ t('工作台能做什么') }}</h2></div></div>
      <div class="cards three">
        <div v-for="[title, desc] in FEATURES" :key="title" class="card-step">
          <h3>{{ t(title) }}</h3>
          <p>{{ t(desc) }}</p>
        </div>
      </div>
    </section>

    <section id="monad" class="section">
      <div class="section-head">
        <div><span class="label">Monad / 03</span><h2>{{ t('Monad 网络实测') }}</h2></div>
        <div class="section-tools"><a :href="doc('benchmark/README.md')" rel="noopener">{{ t('核对脚本') }} →</a></div>
      </div>
      <p class="home-text">{{ t('我们把训练出来的挖矿网络（FF 185→32→7，int8 权重）部署到 Monad 网络上，然后用 63 笔 step 交易走完测试回合 0。作为对比，我们在以太坊规则下用同一个网络和同一组输入又跑了一次。') }}</p>
      <div class="facts">
        <div class="stat"><span class="big">63 / 63</span><div class="small">{{ t('链上每一步的结果都和本地一致') }}</div></div>
        <div class="stat"><span class="big plain">14 / 14</span><div class="small">{{ t('anvil --network monad 和 Monad 测试网的 gas 数字相同') }}</div></div>
        <div class="stat"><span class="big plain">0.0106 MON</span><div class="small">{{ t('挖矿网络的一笔 step 交易，按最低基础费 100 MON-gwei 算') }}</div></div>
      </div>
      <div class="gas-tables">
        <div>
          <h3>{{ t('每笔交易的 gas（收据里的 gasUsed）') }}</h3>
          <table class="table gas">
            <thead><tr><th>{{ t('交易') }}</th><th class="num">{{ t('以太坊规则') }}</th><th class="num">{{ t('Monad 规则') }}</th><th class="num">{{ t('差别') }}</th></tr></thead>
            <tbody><tr v-for="[row, eth, monad, diff] in GAS_TX" :key="row"><td>{{ t(row) }}</td><td class="num mono">{{ eth }}</td><td class="num mono">{{ monad }}</td><td class="num mono">{{ diff }}</td></tr></tbody>
          </table>
          <div class="footnote"><span>{{ t('最后一行按实际扣费算：以太坊按 gasUsed，Monad 按 gasLimit。') }}</span></div>
        </div>
        <div>
          <h3>{{ t('一笔交易跑 63 步，5 个大小不同的网络') }}</h3>
          <table class="table gas">
            <thead><tr><th>{{ t('网络') }}</th><th class="num">Monad</th><th class="num">{{ t('以太坊') }}</th><th class="num">{{ t('差别') }}</th></tr></thead>
            <tbody><tr v-for="[row, monad, eth, diff] in GAS_SIZE" :key="row"><td class="mono">{{ row }}</td><td class="num mono">{{ monad }}</td><td class="num mono">{{ eth }}</td><td class="num mono">{{ diff }}</td></tr></tbody>
          </table>
          <div class="footnote"><span>{{ t('以太坊的内存费按平方增长，Monad 按线性增长。以太坊的代码上限是 24 KB，Monad 是 128 KB，所以同一个网络在 Monad 上的权重块更少。') }}</span></div>
        </div>
      </div>
    </section>

    <section id="links" class="section">
      <div class="section-head"><div><span class="label">{{ t('链接') }} / 04</span><h2>{{ t('打开和阅读') }}</h2></div></div>
      <div class="cards four">
        <a class="card-step link" :href="site.studio"><h3>{{ t('工作台') }}</h3><p>{{ t('在浏览器里搭建任务、训练网络和部署到链上。') }}</p><span class="mono muted">/studio/</span></a>
        <a class="card-step link" :href="site.ladder"><h3>{{ t('坦克擂台赛') }}</h3><p>{{ t('注册出战模型，挑战榜上的出战模型，看回放。') }}</p><span class="mono muted">/ladder/</span></a>
        <a class="card-step link" :href="doc('docs/user-guide.md')" rel="noopener"><h3>{{ t('使用指南') }}</h3><p>{{ t('安装、第一次使用、训练、链上部署、内置任务和常见问题。') }}</p><span class="mono muted">GitHub</span></a>
        <a class="card-step link" :href="doc('docs/design.md')" rel="noopener"><h3>{{ t('设计文档') }}</h3><p>{{ t('模块种类、线、模板、快照、IR、回路执行器和链上。') }}</p><span class="mono muted">GitHub</span></a>
      </div>
    </section>
  </div></div>

  <footer class="footer"><div class="wrap">
    <span>NEUROM</span>
    <span v-html="t(AUTHOR)"></span>
    <span><a :href="site.github" rel="noopener">GitHub</a> · MIT</span>
  </div></footer>
</template>
