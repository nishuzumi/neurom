// chain.js — wallet / network access for the module bridge (module-chain.js) with ethers v6.
import { BrowserProvider, JsonRpcProvider } from 'ethers';
import { t } from './i18n.js';

/** Supported networks. `explorer` is null where no block explorer exists (local dev node). `factory` is the official
 *  ModuleFactory of the network (its proxy, ADR 0016). The workbench deploys only to this factory, verifies only against
 *  it and reuses tools only from it. `factory` is null until the factory is deployed there. 31337: the proxy that
 *  contracts/script/Deploy.s.sol creates on a fresh `anvil --network monad` from the default account 0 (its nonce 2).
 *  module-chain.test.js fails when the two addresses differ. */
export const CHAINS = {
  143:   { name: 'Monad Mainnet', rpc: 'https://rpc.monad.xyz',         hex: '0x8f',   explorer: 'https://monadscan.com',         factory: null },
  10143: { name: 'Monad Testnet', rpc: 'https://testnet-rpc.monad.xyz', hex: '0x279f', explorer: 'https://testnet.monadscan.com', factory: null },
  31337: { name: 'Local dev · unlocked Anvil account', rpc: 'http://127.0.0.1:18545', hex: '0x7a69', explorer: null, local: true, factory: '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0' },
};
/** Chain a fresh deployment record starts on: the local dev node. */
export const DEFAULT_CHAIN_ID = 31337;

const explorerLink = (chainId, path) => { const c = CHAINS[chainId]; return c && c.explorer ? `${c.explorer}/${path}` : null; };
/** Explorer link for a transaction, or null when the chain has no explorer. */
export const explorerTx = (chainId, txHash) => explorerLink(chainId, `tx/${txHash}`);
/** Explorer link for an address (a contract or account), or null when the chain has no explorer. */
export const explorerAddress = (chainId, address) => explorerLink(chainId, `address/${address}`);

/** Throws unless `provider` reports the expected chain id. */
async function assertChain(provider, chainId) {
  const got = Number((await provider.getNetwork()).chainId);
  if (got !== Number(chainId)) throw new Error(t('网络不匹配：期望 {name}（{chainId}），但提供者当前在 {got}', { name: CHAINS[chainId]?.name || chainId, chainId, got }));
}

/**
 * Public chains use the injected wallet. Explicitly selecting Local dev uses only
 * the unlocked development account on localhost, never the user's wallet.
 * Returns { provider, signer, address, chainId }.
 */
export async function connect(chainId) {
  const c = CHAINS[chainId];
  if (!c) throw new Error(t('不支持的链 id：{chainId}', { chainId }));
  let provider;
  if (c.local) {
    provider = new JsonRpcProvider(c.rpc);
  } else if (window.ethereum) {
    try { await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: c.hex }] }); }
    catch (e) {
      if (e.code !== 4902) throw e;
      const add = { chainId: c.hex, chainName: c.name, rpcUrls: [c.rpc], nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 } };
      if (c.explorer) add.blockExplorerUrls = [c.explorer];
      await window.ethereum.request({ method: 'wallet_addEthereumChain', params: [add] });
    }
    provider = new BrowserProvider(window.ethereum);
  } else {
    throw new Error(t('没有检测到钱包（window.ethereum）。{name} 需要钱包签名。', { name: c.name }));
  }
  await assertChain(provider, chainId);
  let signer;
  try { signer = await provider.getSigner(); }
  catch (e) { throw new Error(c.local ? t('本地节点 {rpc} 没有解锁账户：{error}', { rpc: c.rpc, error: e.shortMessage || e.message }) : t('钱包未授权账户：{error}', { error: e.shortMessage || e.message })); }
  return { provider, signer, address: await signer.getAddress(), chainId: Number(chainId) };
}
