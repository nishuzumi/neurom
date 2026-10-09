// core/kinds/dataset.js — an imported CSV/JSON table. The rows live in the workspace's dataset store (IndexedDB in the
// browser) under `datasetId`. The node only declares columns and the content hash. Thus a bundle can name the table it
// depends on (`tables:[{id, hash, columns}]`), and the runner can look the data up by id.
import { registerKind } from '../registry.js';
import { valueOut } from './common.js';
import { table } from '../types.js';
import { HASH_PATTERN } from '../canonical.js';
import { t } from '../../i18n.js';

registerKind({
  kind: 'dataset',
  label: '数据集',
  config: {
    defaults: { datasetId: null, name: '', columns: [], rows: 0, hash: null },
    schema: {
      datasetId: { type: 'string', optional: true }, name: { type: 'string', max: 200 },
      columns: { type: 'list', of: { type: 'string', pattern: '^[A-Za-z_][\\w]*$' } }, rows: { type: 'int', min: 0 },
      hash: { type: 'string', pattern: HASH_PATTERN, optional: true },
    },
  },
  ports(node) { return { inputs: [], outputs: [valueOut('table', table(node.config.columns))] }; },
  infer(node) { return { table: table(node.config.columns) }; },
  problems(node) {
    const out = [];
    if (new Set(node.config.columns).size !== node.config.columns.length) out.push({ message: t('数据集列名重复') });
    if (!node.config.columns.length) out.push({ message: t('数据集尚未导入（没有列）') });
    if (node.config.datasetId && !node.config.hash) out.push({ message: t('数据集缺少内容哈希') });
    return out;
  },
});
