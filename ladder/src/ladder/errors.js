// ladder/errors.js — the text of every refusal the page can meet: the custom errors of TankLadder
// (contract-interface.md), the error codes of the name service (ladder/README.md) and the errors of the chain bridge.
// `describeError(error, context)` gives one sentence for the user. The context carries the numbers the sentence
// needs (the configuration, the weight size of the artifact), so the page never prints a limit from code.
import { decodeLadderError } from '../chain/client.js';
import { t } from '../i18n.js';
import { formatInt } from './format.js';

/** The message of a TankLadder custom error `name`, with `ctx` = { config, weightBytes, cooldownUntil, block }. */
export function ladderErrorMessage(name, ctx = {}) {
  const c = ctx.config ?? {};
  switch (name) {
    case 'NotOfficialModule': return t('这个模块不是官方 Factory 部署的，擂台只接受官方 Factory 的模块');
    case 'WrongShape': return t('模型的输入必须是 572 位，输出必须是 9 个分数');
    case 'TooLarge': return t('权重字节数 {size} 超过上限 {max}', { size: ctx.weightBytes !== undefined ? formatInt(ctx.weightBytes) : '?', max: c.maxWeightBytes !== undefined ? formatInt(c.maxWeightBytes) : '?' });
    case 'DuplicateWeights': return t('已经有一个出战模型的权重和它完全相同，副本不能占名次');
    case 'HasTools': return t('带工具层的网络不能参赛');
    case 'AlreadyEntered': return t('这个模块已经是出战模型');
    case 'NotEntered': return t('这个模块不是出战模型');
    case 'NotEoa': return t('只有没有代码的普通账号（EOA）能发起挑战');
    case 'LowGas': return t('发起交易的 gas limit 至少要 {gas}', { gas: c.minStartGas !== undefined ? formatInt(c.minStartGas) : '?' });
    case 'OutOfRange': return t('只能挑战比自己高 1 到 {range} 名的出战模型', { range: c.range ?? '?' });
    case 'Busy': return t('这个出战模型正在挑战中，一次只能发起一场');
    case 'Cooldown': return ctx.cooldownUntil ? t('冷却中：到第 {block} 块以前不能再挑战这个擂主（还要等 {left} 块）', { block: formatInt(ctx.cooldownUntil), left: formatInt(Math.max(0, ctx.cooldownUntil - (ctx.block ?? 0))) }) : t('冷却中：这一对挑战者和擂主还不能再打');
    case 'SeasonOver': return t('赛季已经结束，不再接受新的挑战');
    case 'NotOwner': return t('只有注册这个出战模型的账号能用它发起挑战');
    case 'NotExpired': return t('这场挑战还没有超时');
    case 'Expired': return t('这场挑战已经超时，算擂主守擂成功');
    case 'NotPlaying': return t('这场挑战已经结束');
    case 'BadRank': return t('名次不存在');
    case 'ForwardFailed': return t('出战模型的 forward 调用失败');
    case 'BadConfig': return t('合约配置无效');
    default: return null;
  }
}

/** The message of a name-service error code. */
export function nameErrorMessage(code, details = {}) {
  switch (code) {
    case 'name_length': return t('名字要 {min} 到 {max} 个字符', { min: details.min ?? 3, max: details.max ?? 24 });
    case 'name_chars': return t('名字只能用英文字母、数字、空格、_ 和 -');
    case 'name_banned': return t('名字含违禁词');
    case 'name_taken': return t('这个名字已经有人用了（不区分大小写）');
    case 'name_set': return t('这个出战模型已经有名字了，名字设置以后不能改');
    case 'not_entered': return t('这个模块不是出战模型');
    case 'not_owner': return t('只有注册这个出战模型的账号能起名字');
    case 'bad_signature': return t('签名无效');
    case 'invalid_module': return t('模块地址无效');
    case 'unauthorized': return t('没有权限');
    case 'body_too_large': return t('请求太大');
    case 'misconfigured': return t('名字服务没有配置好');
    case 'internal': return t('名字服务出错了');
    default: return t('名字服务拒绝了请求：{code}', { code });
  }
}

/** One sentence for any error the page catches. `ctx` as ladderErrorMessage. */
export function describeError(error, ctx = {}) {
  if (!error) return '';
  const custom = decodeLadderError(error);
  if (custom) return ladderErrorMessage(custom, ctx) ?? t('合约拒绝了操作：{name}', { name: custom });
  if (error.nameCode) return nameErrorMessage(error.nameCode, error.details);
  if (error.code === 'INSUFFICIENT_FUNDS') return t('余额不够付 gas');
  if (error.code === 'ACTION_REJECTED') return t('签名被拒绝');
  return error.shortMessage || error.message || String(error);
}
