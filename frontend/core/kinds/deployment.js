// core/kinds/deployment.js — deploys one artifact on chain, verifies it and steps it there. `moduleId` is the module id
// the next deployment gives its module (empty until the user enters one). `deployments` remembers the contract
// address, the module id and the deployer per chain id so a redeploy is not needed after a reload.
import { registerKind } from '../registry.js';
import { valueIn } from './common.js';
import { handle } from '../types.js';
import { HASH_PATTERN } from '../canonical.js';
import { t } from '../../i18n.js';

/** ModuleFactory's rule for a module id: 3..64 ASCII bytes, `a`..`z` first, then `a`..`z`, `0`..`9`, `-` or `_`. */
const MODULE_ID_PATTERN = /^[a-z][a-z0-9_-]{2,63}$/;

/** Why `id` is no module id, else null. */
export function moduleIdProblem(id) {
  if (typeof id !== 'string' || !id.length) return t('模块 ID 不能为空：3..64 个字符，小写字母开头，只用小写字母、数字、“-”和“_”');
  if (id.length < 3 || id.length > 64) return t('模块 ID 要有 3..64 个字符，现在是 {length} 个', { length: id.length });
  if (!MODULE_ID_PATTERN.test(id)) return t('模块 ID 只能用小写字母、数字、“-”和“_”，并以小写字母开头：{id}', { id });
  return null;
}

registerKind({
  kind: 'deployment',
  label: '链上部署',
  config: {
    defaults: { moduleId: '', deployments: {} },
    schema: {
      moduleId: { type: 'string', pattern: `^$|${MODULE_ID_PATTERN.source}`, max: 64 },
      deployments: { type: 'map', of: { type: 'object', fields: {
        address: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' }, artifactId: { type: 'string', pattern: HASH_PATTERN }, txHash: { type: 'string', pattern: '^0x[0-9a-fA-F]{64}$', optional: true },
        moduleId: { type: 'string', pattern: MODULE_ID_PATTERN.source, optional: true }, deployer: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$', optional: true },
      } } },
    },
  },
  ports() { return { inputs: [valueIn('artifact', handle('artifact'), { required: true })], outputs: [] }; },
  infer() { return {}; },
  problems() { return []; },
});
