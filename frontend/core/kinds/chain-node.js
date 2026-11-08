// core/kinds/chain-node.js — the chain node (ADR 0028): one connection to a chain of the network registry
// (chain.js CHAINS), for script modules. Its one output `node` is a call port. A script module wires it into a
// function input and gets `ctx.chain.<name>`, a viem client (editor/renderers/script-module-runtime.js). The page
// sends each request of that client as one call (core/script-calls.js) and allows only the methods below. `write`
// opens the write methods, and only a local node can have it: a public chain needs a signature and real MON.
import { registerKind } from '../registry.js';
import { fnOut } from './common.js';
import { CHAINS } from '../../chain.js';
import { t } from '../../i18n.js';

/** the methods every chain node allows: reads of the chain */
export const READ_METHODS = Object.freeze([
  'eth_chainId', 'eth_blockNumber', 'eth_call', 'eth_getCode', 'eth_getStorageAt', 'eth_getBalance', 'eth_getLogs',
  'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_getBlockByNumber', 'eth_estimateGas', 'eth_gasPrice',
  'eth_feeHistory', 'eth_maxPriorityFeePerGas', 'net_version', 'eth_accounts',
]);
/** the methods a chain node with `write` allows too: transactions from an unlocked account and the Anvil controls */
export const WRITE_METHODS = Object.freeze([
  'eth_sendTransaction', 'evm_snapshot', 'evm_revert', 'evm_mine', 'anvil_mine', 'anvil_setStorageAt', 'anvil_setCode',
  'anvil_impersonateAccount', 'anvil_stopImpersonatingAccount', 'anvil_setBalance',
]);

/** Why the chain node refuses `method` (`write`: the node allows writes), else null. */
export function chainMethodProblem(method, write) {
  if (READ_METHODS.includes(method) || (write && WRITE_METHODS.includes(method))) return null;
  return t('链节点不允许 {method}', { method: String(method) });
}

/** The chain a new chain node starts on: the first fork entry of the registry, else its first entry. */
export function defaultChainId() {
  const ids = Object.keys(CHAINS).map(Number);
  return ids.find(id => CHAINS[id].fork) ?? ids[0];
}

/** Why `config` cannot write, else null: only a local node takes writes. */
export function writeProblem(config) {
  const c = CHAINS[config.chainId];
  if (!c) return t('网络注册表里没有链 id {chainId}', { chainId: config.chainId });
  if (config.write && !c.local) return t('{name} 不是本地节点，链节点不能在它上面写入', { name: c.name });
  return null;
}

/** What the sandbox knows of the node's chain (ADR 0028, data only): `{ chainId, name, local, write, factory, ladder }`. */
export function chainNetwork(config) {
  const c = CHAINS[config.chainId];
  return { chainId: Number(config.chainId), name: c?.name ?? String(config.chainId), local: !!c?.local, write: !!config.write && !!c?.local, factory: c?.factory ?? null, ladder: c?.ladder ?? null };
}

registerKind({
  kind: 'chain',
  label: '链节点',
  config: {
    defaults: { get chainId() { return defaultChainId(); }, write: false },
    schema: {
      chainId: { type: 'int', min: 1, label: '网络' },
      write: { type: 'enum', values: [false, true], label: '允许写入' },
    },
  },
  ports() {
    return { inputs: [], outputs: [{ ...fnOut('node'), doc: t('连接：接到脚本模块的函数输入，脚本里用 ctx.chain.名字（viem 客户端）') }] };
  },
  infer() { return {}; },
  problems(node) {
    const problem = writeProblem(node.config);
    return problem ? [{ message: problem }] : [];
  },
  /** `node`: a request `{ method, params }` of a script module. It has no IR type, so only a script module can call it. */
  callee(node, port, ctx) {
    if (port !== 'node') return null;
    return {
      width: null,
      call(argTypes, { caller }) {
        const fail = message => ({ result: null, error: new Error(message), paramTypes: argTypes, carries: null });
        if (ctx.node(caller)?.kind !== 'script') return fail(t('链节点只能接脚本模块的函数输入'));
        const problem = writeProblem(node.config);
        if (problem) return fail(problem);
        return { result: null, error: null, paramTypes: argTypes, carries: { kind: 'chain', nodeId: node.id, chainId: Number(node.config.chainId), write: !!node.config.write } };
      },
    };
  },
});
