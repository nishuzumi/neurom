// chain.js — the network registry and the one connection function of every page (ADR 0028). The Deployment module,
// the chain node and the ladder page connect through `connect` / `readConnection` with ethers v6.
import { BrowserProvider, JsonRpcProvider } from 'ethers';
import { t } from './i18n.js';
import { describeChainError } from './chain-error.js';
import deployments from '../site/data/deployments.json' with { type: 'json' };

/** The workbench and ladder share the official Factory registry.
 * Local development uses the same RPC and Factory overrides as the ladder page. */
const env = import.meta.env ?? {};
const devChainId = Number(env.VITE_LADDER_CHAIN_ID ?? 31337);
const registry = Object.fromEntries(Object.entries(deployments).filter(([id]) => /^\d+$/.test(id)).map(([id, network]) => [Number(id), network]));
/** The port of an RPC URL (the default of its scheme when the URL names none). */
const portOf = rpc => { const u = new URL(rpc); return Number(u.port || (u.protocol === 'https:' ? 443 : 80)); };
/**
 * Chain id → `{ name, rpc, explorer, local, factory, ladder, hex }`. A fork entry (`forkOf` in the JSON) takes the
 * `factory` and `ladder` of the entry it forks and carries `fork: { of, port }`. The JSON holds no address twice.
 */
export const CHAINS = Object.fromEntries(Object.entries(registry).map(([id, network]) => {
  const chainId = Number(id), dev = chainId === devChainId;
  const forked = network.forkOf ? registry[Number(network.forkOf)] : null;
  const factory = forked ? forked.factory : network.factory, ladder = forked ? forked.ladder : network.ladder;
  const c = {
    ...network,
    hex: `0x${chainId.toString(16)}`,
    rpc: dev ? env.VITE_LADDER_RPC || network.rpc : network.rpc,
    factory: dev ? env.VITE_LADDER_FACTORY || factory : factory,
    ladder,
  };
  if (forked) c.fork = { of: Number(network.forkOf), port: portOf(network.rpc) };
  return [chainId, c];
}));
/** The hosted workbench on the ladder site (`frontend/build.mjs --hosted`, ADR 0027). It trains in the browser only. */
export const STUDIO_HOSTED = env.VITE_STUDIO_HOSTED === '1';
/** Chain a fresh deployment record starts on: the ladder chain in the hosted workbench, else the local dev node. */
export const DEFAULT_CHAIN_ID = STUDIO_HOSTED ? devChainId : 31337;
/** The unlocked account of the local dev node that Local dev signs with: an index of anvil's accounts (default 0) or an
 *  address. The ladder dev chain sets VITE_DEV_ACCOUNT so that the studio deploys from the account of its first ladder page. */
const DEV_ACCOUNT = /^0x[0-9a-fA-F]{40}$/.test(String(env.VITE_DEV_ACCOUNT ?? '')) ? env.VITE_DEV_ACCOUNT : Number(env.VITE_DEV_ACCOUNT ?? 0);

/** The `anvil` command that starts the local fork `chainId` of the registry, or null when the entry is not a fork. */
export function forkCommand(chainId) {
  const c = CHAINS[chainId];
  if (!c?.fork) return null;
  return `anvil --network monad --fork-url ${CHAINS[c.fork.of].rpc} --chain-id ${Number(chainId)} --port ${c.fork.port}`;
}

/** The Privy App of the page (ADR 0027), or null. With it, public chains sign with the Privy embedded wallet, the same
 *  wallet the ladder uses. Without it, public chains use the injected wallet (window.ethereum). */
export const PRIVY_APP_ID = env.VITE_PRIVY_APP_ID || null;
/** The public networks that the embedded wallet serves, in the shape of wallet/privy.js. */
export const PRIVY_NETWORKS = Object.entries(CHAINS).filter(([, c]) => !c.local)
  .map(([id, c]) => ({ chainId: Number(id), name: c.name, rpc: c.rpc, explorer: c.explorer ?? null, local: false }));
/** The network the embedded wallet starts on: the ladder chain when it is public, else the first public network. */
export const PRIVY_CHAIN_ID = CHAINS[devChainId] && !CHAINS[devChainId].local ? devChainId : PRIVY_NETWORKS[0]?.chainId ?? null;
/** Why the Privy App cannot serve this page, else null. Login talks to Privy over HTTP(S), so the single-file
 *  distribution opened from file:// cannot log in. Training does not need login. */
export function privyProblem() {
  if (!PRIVY_APP_ID) return null;
  if (!/^https?:$/.test(globalThis.location?.protocol ?? '')) return t('Privy 登录需要通过 HTTP(S) 打开的页面。从 file:// 打开的工作台不能登录，也不能部署到公共网络。');
  if (!PRIVY_NETWORKS.length) return t('没有公共网络可以登录。');
  return null;
}

const explorerLink = (chainId, path) => { const c = CHAINS[chainId]; return c && c.explorer ? `${c.explorer}/${path}` : null; };
/** Explorer link for a transaction, or null when the chain has no explorer. */
export const explorerTx = (chainId, txHash) => explorerLink(chainId, `tx/${txHash}`);
/** Explorer link for an address (a contract or account), or null when the chain has no explorer. */
export const explorerAddress = (chainId, address) => explorerLink(chainId, `address/${address}`);

/**
 * The read provider of a page over RPC `rpc`: a JsonRpcProvider that trusts `chainId` (no network request). The
 * polling interval follows the one-second blocks of Monad. `cacheTimeout: -1` turns off the request cache of ethers
 * (250 ms by default), so a nonce or a receipt read right after a transaction is fresh. Public RPC gateways restrict
 * batches, so each request goes alone.
 */
export function readProvider(rpc, chainId) {
  return new JsonRpcProvider(rpc, Number(chainId), { staticNetwork: true, pollingInterval: 1500, cacheTimeout: -1, batchMaxCount: 1 });
}
/** @typedef {(req: { method: string, params?: unknown[] }) => Promise<unknown>} Request  EIP-1193 `request` */
/** The EIP-1193 `request` of an ethers JSON-RPC provider.
 *  @type {(provider: import('ethers').JsonRpcApiProvider) => Request} */
const requestOf = provider => ({ method, params = [] }) => provider.send(method, params);

/** Throws unless the node behind `provider` reports the expected chain id. Asks the node: a static network answers nothing. */
async function assertChain(provider, chainId) {
  const got = Number(await provider.send('eth_chainId', []));
  if (got !== Number(chainId)) throw new Error(t('网络不匹配：期望 {name}（{chainId}），但提供者当前在 {got}', { name: CHAINS[chainId]?.name || chainId, chainId, got }));
}

/**
 * A read-only connection to `chainId` over its RPC, at once: `{ chainId, account: null, request, provider, signer: null }`.
 * `request({ method, params })` is EIP-1193. `provider` is an ethers Provider over the same transport.
 */
export function readConnection(chainId) {
  const c = CHAINS[chainId];
  if (!c) throw new Error(t('不支持的链 id：{chainId}', { chainId }));
  const provider = readProvider(c.rpc, chainId);
  return { chainId: Number(chainId), account: null, request: requestOf(provider), provider, signer: null };
}

/**
 * The connection of `chainId` (ADR 0028): `{ chainId, account, request, provider, signer }`. `request` is EIP-1193.
 * `provider` is an ethers Provider over the same transport. `signer` is an ethers Signer, or null when `write` is false.
 * Adapters:
 *   - `write` false: the RPC of the registry, read only, on any chain (`readConnection`).
 *   - a local node: the unlocked account `devAccount` (an index or an address), never the user's wallet.
 *   - a public chain with a Privy App: the Privy embedded wallet (`privy` is the controller of wallet/privy.js that the
 *     page mounted). Without a Privy App: the injected wallet (window.ethereum).
 * Nothing here caches a signer: every call sees the current account.
 */
export async function connect(chainId, { write = false, privy = null, devAccount = DEV_ACCOUNT } = {}) {
  const c = CHAINS[chainId];
  if (!c) throw new Error(t('不支持的链 id：{chainId}', { chainId }));
  chainId = Number(chainId);
  if (!write) {
    const read = readConnection(chainId);
    await assertChain(read.provider, chainId);
    return read;
  }
  let provider, signer, request;
  if (c.local) {
    provider = readProvider(c.rpc, chainId);
    await assertChain(provider, chainId);
    try { signer = await provider.getSigner(devAccount); }
    catch (e) { throw new Error(t('本地节点 {rpc} 没有解锁账户：{error}', { rpc: c.rpc, error: describeChainError(e) })); }
    request = requestOf(provider);
  } else if (PRIVY_APP_ID) {
    const why = privyProblem(); if (why) throw new Error(why);
    if (!privy) throw new Error(t('工作台没有挂载 Privy 钱包。刷新页面，然后重试。'));
    const w = await privy.connect(chainId);
    await assertChain(w.provider, chainId);
    return { chainId, account: w.address, request: w.request, provider: w.provider, signer: w.signer };
  } else if (window.ethereum) {
    try { await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: c.hex }] }); }
    catch (e) {
      if (e.code !== 4902) throw e;
      const add = { chainId: c.hex, chainName: c.name, rpcUrls: [c.rpc], nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 } };
      if (c.explorer) add.blockExplorerUrls = [c.explorer];
      await window.ethereum.request({ method: 'wallet_addEthereumChain', params: [add] });
    }
    provider = new BrowserProvider(window.ethereum);
    await assertChain(provider, chainId);
    try { signer = await provider.getSigner(); }
    catch (e) { throw new Error(t('钱包未授权账户：{error}', { error: describeChainError(e) })); }
    request = /** @type {Request} */ (({ method, params = [] }) => window.ethereum.request({ method, params }));
  } else {
    throw new Error(t('没有检测到钱包（window.ethereum）。{name} 需要钱包签名。', { name: c.name }));
  }
  return { chainId, account: await signer.getAddress(), request, provider, signer };
}
