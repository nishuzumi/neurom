// ladder/errors.js — the text of every refusal the page can meet: the custom errors of TankLadder
// (contract-interface.md), the error codes of the name service (site/README.md) and the errors of the chain bridge.
// `describeError(error, context)` gives one sentence for the user. The context carries the numbers the sentence
// needs (the configuration, the weight size of the module), so the page never prints a limit from code.
import { decodeLadderError } from '../chain/client.js';
import { describeChainError } from '../../../frontend/chain-error.js';
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
    case 'ForwardFailed': return t('出战模型的 forward 调用失败');
    case 'BadConfig': return t('合约配置无效');
    default: return null;
  }
}

/** The message of each name-service error code (server/names.js ERROR_CODES), from the `details` of the response. */
const NAME_ERRORS = {
  name_length: d => t('名字要 {min} 到 {max} 个字符', { min: d.min ?? 3, max: d.max ?? 24 }),
  name_chars: () => t('名字只能用英文字母、数字、空格、_ 和 -'),
  name_banned: () => t('名字含违禁词'),
  name_taken: () => t('这个名字已经有人用了（不区分大小写）'),
  name_set: () => t('这个出战模型已经有名字了，名字设置以后不能改'),
  not_entered: () => t('这个模块不是出战模型'),
  not_owner: () => t('只有注册这个出战模型的账号能起名字'),
  bad_signature: () => t('签名无效'),
  invalid_module: () => t('模块地址无效'),
  bad_json: () => t('名字服务收到的请求不是有效的 JSON'),
  bad_request: () => t('名字服务收到的请求格式不对'),
  method_not_allowed: () => t('名字服务不支持这种请求方法'),
  unauthorized: () => t('没有权限'),
  body_too_large: () => t('请求太大'),
  misconfigured: () => t('名字服务没有配置好'),
  internal: () => t('名字服务出错了'),
};

/** The codes that have a message. errors.test.js checks the list against the codes of the server. */
export const NAME_ERROR_CODES = Object.freeze(Object.keys(NAME_ERRORS));

/** The message of a name-service error code. An unknown code shows the code itself. */
export function nameErrorMessage(code, details = {}) {
  return NAME_ERRORS[code]?.(details) ?? t('名字服务拒绝了请求：{code}', { code });
}

/** One sentence for any error the page catches. `ctx` as ladderErrorMessage. The custom errors of the contract and
 *  the codes of the name service come first; every other wallet / RPC error goes through the shared formatter of the
 *  workbench (frontend/chain-error.js), which digs the concrete cause out of nested provider errors. */
export function describeError(error, ctx = {}) {
  if (!error) return '';
  const custom = decodeLadderError(error);
  if (custom) {
    const details = custom === 'TooLarge' && error.ladderArgs
      ? { ...ctx, weightBytes: error.ladderArgs.weightBytes, config: { ...ctx.config, maxWeightBytes: error.ladderArgs.maxWeightBytes } }
      : ctx;
    return ladderErrorMessage(custom, details) ?? t('合约拒绝了操作：{name}', { name: custom });
  }
  if (error.nameCode) return nameErrorMessage(error.nameCode, error.details);
  return describeChainError(error);
}
