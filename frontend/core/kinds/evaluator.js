// core/kinds/evaluator.js — runs the loop wired into `loop` (kinds/loop.js) over a partition, with the greedy integer
// executor and every network's accepted weights. It computes metrics `fn(Episode) → number` (many). `Episode =
// { initial: State, final: State, steps, success, return }`. `return` sums the optional `objective` reward, else 0.
import { registerKind } from '../registry.js';
import { valueIn, valueOut, callIn } from './common.js';
import { handle } from '../types.js';
import { driverLoopIn, driverLoopProblems } from './loop.js';
import { driverRefs, driverRefDoc, partitionProblem, callProblems, METRIC_SIGNATURE, REWARD_SIGNATURE } from './trainer.js';
import { t } from '../../i18n.js';

registerKind({
  kind: 'evaluator',
  label: '评估器',
  config: { defaults: { groupBy: null }, schema: { groupBy: { type: 'string', optional: true } } },
  ports() {
    return {
      inputs: [
        driverLoopIn(), valueIn('partition', null, { required: true }),
        callIn('metrics', METRIC_SIGNATURE, { many: true, when: '每个回合结束时调用一次。报告给出它在分区上的平均值' }), callIn('objective', REWARD_SIGNATURE, { when: '每走一步调用一次。回合的 return 是这些结果的和' }),
      ],
      outputs: [valueOut('report', handle('report'))],
    };
  },
  docs: { ref: driverRefDoc },
  infer(node, inTypes, ctx) {
    ctx.setRefs(node.id, driverRefs(node, ctx));
    return { report: handle('report') };
  },
  problems(node, ctx) {
    const out = driverLoopProblems(node, ctx);
    const T = ctx.inType(node.id, 'partition'), partition = partitionProblem(T, 'partition');
    if (partition) out.push({ port: 'partition', message: partition });
    out.push(...callProblems(node, ctx, 'metrics', METRIC_SIGNATURE), ...callProblems(node, ctx, 'objective', REWARD_SIGNATURE));
    const tag = T?.type === 'handle' ? T.episode : null;
    if (node.config.groupBy && tag && !(tag.kind === 'enumerate' && node.config.groupBy in tag.axes)) out.push({ message: t('分组轴 {axis} 不是分区枚举回合的轴', { axis: node.config.groupBy }) });
    return out;
  },
});
