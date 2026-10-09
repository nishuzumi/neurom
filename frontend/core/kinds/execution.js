// core/kinds/execution.js — an execution instance. It steps episodes of the loop wired into `loop` (kinds/loop.js) with
// every network's accepted weights, over the episodes of the partition in `partition`. It holds clock, potentials and
// the per-step values of every body module for views (sessions/execution.js).
import { registerKind } from '../registry.js';
import { valueIn, valueOut } from './common.js';
import { handle } from '../types.js';
import { driverLoopIn, driverLoopProblems } from './loop.js';
import { driverRefs, driverRefDoc, partitionProblem } from './trainer.js';

registerKind({
  kind: 'execution',
  label: '执行实例',
  config: { defaults: {}, schema: {} },
  ports() {
    return {
      inputs: [driverLoopIn(), valueIn('partition', null, { required: true })],
      outputs: [valueOut('execution', handle('execution'))],
    };
  },
  docs: { ref: driverRefDoc },
  infer(node, inTypes, ctx) {
    ctx.setRefs(node.id, driverRefs(node, ctx));
    return { execution: handle('execution') };
  },
  problems(node, ctx) {
    const out = driverLoopProblems(node, ctx);
    const partition = partitionProblem(ctx.inType(node.id, 'partition'), 'partition');
    if (partition) out.push({ port: 'partition', message: partition });
    return out;
  },
});
