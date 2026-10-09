// core/kinds/deployment.js — deploys one artifact on chain, verifies it and steps it there. `deployments` remembers
// the contract address per chain id so a redeploy is not needed after a reload.
import { registerKind } from '../registry.js';
import { valueIn, valueOut } from './common.js';
import { handle } from '../types.js';
import { HASH_PATTERN } from '../canonical.js';

registerKind({
  kind: 'deployment',
  label: '链上部署',
  config: {
    defaults: { deployments: {} },
    schema: { deployments: { type: 'map', of: { type: 'object', fields: { address: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' }, artifactId: { type: 'string', pattern: HASH_PATTERN }, txHash: { type: 'string', pattern: '^0x[0-9a-fA-F]{64}$', optional: true } } } } },
  },
  ports() { return { inputs: [valueIn('artifact', handle('artifact'), { required: true })], outputs: [valueOut('deployment', handle('deployment'))] }; },
  infer() { return { deployment: handle('deployment') }; },
  problems() { return []; },
});
