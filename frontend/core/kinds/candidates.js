// core/kinds/candidates.js — collects the candidates of one or more runs. The user previews, accepts, imports and
// exports artifacts here. `accepted` names the artifact whose weights flow out of `weights` / `artifact`.
import { registerKind } from '../registry.js';
import { valueIn, valueOut } from './common.js';
import { handle } from '../types.js';
import { HASH_PATTERN } from '../canonical.js';
import { t } from '../../i18n.js';

registerKind({
  kind: 'candidates',
  label: '候选',
  config: { defaults: { accepted: null }, schema: { accepted: { type: 'string', pattern: HASH_PATTERN, optional: true } } },
  ports() {
    return { inputs: [valueIn('run', handle('run'), { many: true })], outputs: [valueOut('weights', handle('weights')), valueOut('artifact', handle('artifact'))] };
  },
  infer() { return { weights: handle('weights'), artifact: handle('artifact') }; },
  problems(node, ctx) {
    return !node.config.accepted && (ctx.consumers(node.id, 'weights').length || ctx.consumers(node.id, 'artifact').length) ? [{ port: 'artifact', incomplete: true, message: t('尚未接受任何候选') }] : [];
  },
});
