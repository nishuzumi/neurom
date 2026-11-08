// wallet/privy.js — one Privy session for the workbench and the ladder (both Vue).
// The session is a framework-neutral controller around the Privy React SDK (ADR 0027). A host gives it an empty
// element with `mount(element)`. The session renders the `PrivyProvider` there and reads the SDK hooks through one
// bridge component. The host reads `snapshot()` and `subscribe(listener)`, or `useSyncExternalStore(subscribe, snapshot)`.
//
// The wallet is always the Privy embedded EVM wallet. An external wallet that the user connects is never used.
// `connect(chainId)` switches the embedded wallet to that chain and returns `{ provider, signer, address, request, chainId }`.
// The signer is an ethers Signer over the EIP-1193 provider of the embedded wallet. `request` is the raw EIP-1193
// `request` of that provider. No private key leaves Privy.
//
// Invalidation: every logout, account change and unmount starts a new generation. Work that was started in an older
// generation does not publish its result. `connect` then rejects.
import { createElement, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { PrivyProvider, useLogin, usePrivy, useWallets } from '@privy-io/react-auth';
import { defineChain } from 'viem';
import { BrowserProvider } from 'ethers';
import { t } from '../i18n.js';
import { describeChainError } from '../chain-error.js';

/** The viem chain object of one network, for the Privy `supportedChains` list. */
function viemChain(network) {
  return defineChain({
    id: network.chainId,
    name: network.name,
    nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
    rpcUrls: { default: { http: [network.rpc] } },
    ...(network.explorer ? { blockExplorers: { default: { name: 'Explorer', url: network.explorer } } } : {}),
    testnet: network.chainId !== 143,
  });
}

/** The embedded EVM wallet of the user: `walletClientType === 'privy'`, lowest HD index first. null when absent.
 *  Both pages select with this function, so they always sign with the same address. */
function embeddedWallet(wallets) {
  const embedded = wallets.filter(w => w.type === 'ethereum' && w.walletClientType === 'privy');
  embedded.sort((a, b) => (a.walletIndex ?? Infinity) - (b.walletIndex ?? Infinity));
  return embedded[0] ?? null;
}

/**
 * Creates the session. `networks` is a list of `{ chainId, name, rpc, explorer?, local? }`. `chainId` is the chain
 * the embedded wallet starts on, and the chain of the signer in the snapshot after login.
 * @returns {{ snapshot(): object, subscribe(listener): () => void, mount(element): () => void,
 *   login(): Promise<void>, logout(): Promise<void>, connect(chainId): Promise<object> }}
 */
export function createPrivySession({ appId, networks, chainId }) {
  if (!appId) throw new Error(t('缺少 Privy 应用 id'));
  const chains = networks.map(viemChain);
  const home = chains.find(c => c.id === Number(chainId));
  if (!home) throw new Error(t('不支持的链 id：{chainId}', { chainId }));

  const listeners = new Set();
  const watchers = new Set();
  let snapshot = Object.freeze({ kind: 'privy', ready: false, authenticated: false, address: null, signer: null, error: null });
  /** The latest SDK state from the bridge: `{ ready, authenticated, wallet, login, logout }`. */
  let sdk = null;
  /** The signer the session last built: `{ chainId, address, provider, signer, request }`. */
  let current = null;
  let generation = 0;
  let pending = null;
  /** The address the session already built the home-chain signer for, so one failure does not retry on every render. */
  let autoFor = null;
  /** True from the start of `logout()` until the SDK finishes. Connect rejects and auto acquire waits meanwhile. */
  let loggingOut = false;
  let queue = Promise.resolve();
  let root = null;

  function publish(patch) {
    const next = { ...snapshot, ...patch };
    if (Object.keys(next).every(k => Object.is(next[k], snapshot[k]))) return;
    snapshot = Object.freeze(next);
    for (const listener of listeners) listener(snapshot);
    for (const watcher of watchers) watcher();
  }

  /** Starts a new generation: in-flight work publishes nothing, and the pending login rejects. */
  function invalidate(reason) {
    generation += 1;
    current = null;
    autoFor = null;
    if (pending) { pending.reject(new Error(reason)); pending = null; }
    for (const watcher of watchers) watcher();
  }

  /** Resolves when `predicate()` is true. Rejects when the generation changes or the SDK failed to initialize. */
  function waitFor(predicate, gen) {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (gen !== generation) { watchers.delete(check); reject(new Error(t('登录状态已变化，请重试'))); return true; }
        if (sdk?.error) { watchers.delete(check); reject(snapshot.error); return true; }
        if (predicate()) { watchers.delete(check); resolve(); return true; }
        return false;
      };
      if (!check()) watchers.add(check);
    });
  }

  /** Reads the raw chain of the embedded wallet: `[eip1193, chainId]`. */
  async function rawChain(wallet) {
    const eip1193 = await wallet.getEthereumProvider();
    return [eip1193, Number(await eip1193.request({ method: 'eth_chainId' }))];
  }

  /** Checks the raw chain of the embedded wallet, switches it to `chainId` when needed, and builds the signer.
   *  A cached signer is returned only when the raw chain already matches. Serialized: one at a time. */
  function acquire(chainId, gen) {
    const stale = () => gen !== generation || loggingOut;
    const run = async () => {
      if (stale()) throw new Error(t('登录状态已变化，请重试'));
      const wallet = sdk.wallet;
      const chain = chains.find(c => c.id === chainId);
      let [eip1193, got] = await rawChain(wallet);
      if (stale()) throw new Error(t('登录状态已变化，请重试'));
      if (got === chainId && current && current.chainId === chainId && current.address === wallet.address) return current;
      if (got !== chainId) {
        try { await wallet.switchChain(chainId); }
        catch (e) { throw new Error(t('嵌入式钱包切换到 {name}（{chainId}）失败：{error}', { name: chain.name, chainId, error: describeChainError(e) })); }
        [eip1193, got] = await rawChain(wallet);
        if (stale()) throw new Error(t('登录状态已变化，请重试'));
        if (got !== chainId) throw new Error(t('网络不匹配：期望 {name}（{chainId}），但提供者当前在 {got}', { name: chain.name, chainId, got }));
      }
      const provider = new BrowserProvider(eip1193, chainId);
      const signer = await provider.getSigner(wallet.address);
      if (stale()) throw new Error(t('登录状态已变化，请重试'));
      current = { chainId, address: wallet.address, provider, signer, request: eip1193.request.bind(eip1193) };
      publish({ address: wallet.address, signer, error: null });
      return current;
    };
    const result = queue.then(run);
    queue = result.then(() => undefined, () => undefined);
    return result;
  }

  /** Called by the bridge on every SDK state change. */
  function update(next) {
    const prev = sdk;
    sdk = next;
    const address = next.wallet?.address ?? null;
    const loggedOut = prev?.authenticated && !next.authenticated;
    const changed = Boolean(prev?.wallet) && prev.wallet.address !== address;
    if (loggedOut || changed) invalidate(t('登录状态已变化，请重试'));
    const initError = next.error ? new Error(t('Privy 初始化失败：{error}', { error: describeChainError(next.error) })) : null;
    const live = next.authenticated && !loggingOut;
    const same = live && current && current.address === address;
    publish({
      ready: next.ready && next.walletsReady,
      authenticated: next.authenticated,
      address: live ? address : null,
      signer: same ? current.signer : null,
      error: initError ?? (loggedOut || changed ? null : snapshot.error),
    });
    if (live && next.wallet && autoFor !== address) {
      autoFor = address;
      const gen = generation;
      acquire(home.id, gen).catch(e => { if (gen === generation) publish({ error: e }); });
    }
    if (pending && live && next.wallet) { pending.resolve(); pending = null; }
  }

  function Bridge() {
    const privy = usePrivy();
    const { wallets, ready: walletsReady } = useWallets();
    const { login } = useLogin({
      onError: code => {
        if (code === 'exited_auth_flow') { if (pending) { pending.reject(new Error(t('登录已取消'))); pending = null; } return; }
        const error = new Error(t('登录失败：{error}', { error: code }));
        if (pending) { pending.reject(error); pending = null; }
        publish({ error });
      },
    });
    const wallet = embeddedWallet(wallets);
    useEffect(() => {
      update({ ready: privy.ready, walletsReady, authenticated: privy.authenticated, error: privy.error, wallet, login, logout: privy.logout });
    }, [privy.ready, walletsReady, privy.authenticated, privy.error, wallet, login, privy.logout]);
    return null;
  }

  const session = {
    snapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot);
      return () => listeners.delete(listener);
    },
    /** Renders the Privy provider into `element`. Returns the cleanup. One mount at a time. */
    mount(element) {
      if (root) throw new Error(t('Privy 会话已经挂载'));
      root = createRoot(element);
      root.render(createElement(PrivyProvider, {
        appId,
        config: {
          embeddedWallets: { showWalletUIs: false, ethereum: { createOnLogin: 'all-users' } },
          supportedChains: chains,
          defaultChain: home,
        },
      }, createElement(Bridge)));
      return () => {
        if (!root) return;
        root.unmount();
        root = null;
        sdk = null;
        invalidate(t('Privy 会话已卸载'));
        publish({ ready: false, authenticated: false, address: null, signer: null, error: null });
      };
    },
    /** Opens the Privy login modal. Resolves after login when the embedded wallet is present. Rejects on cancel. */
    login() {
      if (!root || !sdk) return Promise.reject(new Error(t('Privy 会话尚未挂载')));
      if (snapshot.authenticated && sdk.wallet) return Promise.resolve();
      if (pending) return pending.promise;
      let resolve, reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      pending = { promise, resolve, reject };
      sdk.login();
      return promise;
    },
    /** Logs out. The signer and address are cleared at once, before the SDK finishes. */
    async logout() {
      if (!sdk || loggingOut) return;
      loggingOut = true;
      invalidate(t('已退出登录'));
      publish({ address: null, signer: null, error: null });
      try { await sdk.logout(); }
      catch (e) {
        // The SDK still holds the user. The cleared signer stays cleared until the host calls connect again.
        autoFor = sdk?.wallet?.address ?? null;
        publish({ error: new Error(t('退出登录失败：{error}', { error: describeChainError(e) })) });
        throw e;
      } finally { loggingOut = false; }
    },
    /** The provider, signer, address and raw `request` of the embedded wallet on `chainId`. Opens login when the user is logged out. */
    async connect(chainId) {
      chainId = Number(chainId);
      if (!chains.some(c => c.id === chainId)) throw new Error(t('不支持的链 id：{chainId}', { chainId }));
      if (!root) throw new Error(t('Privy 会话尚未挂载'));
      if (loggingOut) throw new Error(t('正在退出登录，请稍后重试'));
      const gen = generation;
      await waitFor(() => sdk && snapshot.ready, gen);
      if (!snapshot.authenticated) {
        session.login().catch(() => {});
        throw new Error(t('请先登录 Privy，然后重试'));
      }
      await waitFor(() => sdk.wallet, gen);
      const { provider, signer, address, request } = await acquire(chainId, gen);
      return { provider, signer, address, request, chainId };
    },
  };
  return session;
}
