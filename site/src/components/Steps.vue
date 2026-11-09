<script setup>
// components/Steps.vue — the three steps of the hero: train, deploy, register.
import { t } from '../i18n.js';

const steps = [
  ['训练', '在工作台里用模板“坦克大战”训练网络，看胜率和平局率，接受一个候选。'],
  ['部署', '在工作台的部署模块里，给候选起一个英文 ID，用你的账号通过官方 Factory 部署到这条链上。'],
  ['注册出战模型', '登录以后，从这个账号部署过的模块里选一个，注册。页面不再部署，只发注册交易。榜单没有满时，新出战模型排在最后一名。榜单满了以后，它在榜外。'],
];
</script>

<template>
  <div class="guide">
    <div v-for="([title, desc], i) in steps" :key="title" class="guide-step">
      <span class="n">0{{ i + 1 }}</span>
      <div><div class="title">{{ t(title) }}</div><div class="desc">{{ t(desc) }}</div></div>
    </div>
  </div>
</template>
