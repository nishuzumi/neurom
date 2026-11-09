// wallet/wallet.js — Vue adapter for the shared Privy session and the local dev account.
// Public pages use the same embedded EVM wallet as the workbench. Local pages use only the unlocked anvil accounts of
// the local node, through the one connection function of frontend/chain.js (ADR 0028).
// The wallet is a shallowReactive object `{ kind, ready, address, signer, provider, error, login(), logout(), label }`.
// `signer` is an ethers Signer that the ladder client sends transactions with. `provider` is the read provider of the
// page (the connection of the chain RPC). The root provides the wallet. The views read it with `useWallet()`.
import { inject, markRaw, onScopeDispose, provide, shallowReactive, shallowRef, watch } from 'vue';
import { connect } from '../../../frontend/chain.js';
import { createPrivySession } from '../../../frontend/wallet/privy.js';
import { t } from '../i18n.js';

const WALLET = Symbol('wallet');
/** The wallet that the root provided. */
export const useWallet = () => inject(WALLET);

const DEV_LOGIN_KEY = 'ladder.dev.login';

/** Local chains use Anvil. Public chains use the configured Privy app. Called once, by the root. `host` is a ref of
 *  the element the Privy session renders into. */
export function provideWallet(config, provider, host) {
  const wallet = config.local ? devWallet(config, provider) : config.privyAppId ? privyWallet(config, provider, host) : noneWallet(provider);
  provide(WALLET, wallet);
  return wallet;
}

function noneWallet(provider) {
  return shallowReactive({ kind: 'none', ready: true, address: null, signer: null, provider: markRaw(provider), error: null, login: () => {}, logout: () => {}, get label() { return t('这条链上没有配置登录方式'); } });
}

function privyWallet(config, provider, host) {
  const session = createPrivySession({ appId: config.privyAppId, networks: [config], chainId: config.chainId });
  let snapshot = session.snapshot();
  let actionError = null;
  const wallet = shallowReactive({
    ...snapshot, provider: markRaw(provider), label: 'Privy',
    login: () => act(session.login), logout: () => act(session.logout),
  });
  const publish = () => Object.assign(wallet, snapshot, { signer: snapshot.signer && markRaw(snapshot.signer), error: actionError ?? snapshot.error });
  const act = async operation => {
    actionError = null;
    publish();
    try { await operation(); } catch (error) { actionError = error; publish(); }
  };
  onScopeDispose(session.subscribe(s => { snapshot = s; publish(); }));
  // the session renders the Privy provider into the host element once the root mounted it
  let unmount = null;
  watch(host, el => { unmount?.(); unmount = el ? session.mount(el) : null; }, { immediate: true });
  onScopeDispose(() => unmount?.());
  return wallet;
}

/** The local dev wallet: the unlocked anvil account `config.devAccount` of the local node. Its accounts are public:
 *  local development only. The login flag lives in localStorage. While it is set, the wallet holds the signer of the
 *  write connection. */
function devWallet(config, provider) {
  const authenticated = shallowRef(localStorage.getItem(DEV_LOGIN_KEY) === '1');
  const wallet = shallowReactive({
    kind: 'dev',
    ready: true,
    provider: markRaw(provider),
    address: null,
    signer: null,
    error: null,
    login: () => { localStorage.setItem(DEV_LOGIN_KEY, '1'); authenticated.value = true; },
    logout: () => { localStorage.removeItem(DEV_LOGIN_KEY); authenticated.value = false; },
    get label() { return t('本地开发账号 #{index}', { index: config.devAccount }); },
  });
  watch(authenticated, async (on, _, onCleanup) => {
    let live = true;
    onCleanup(() => { live = false; });
    Object.assign(wallet, { address: null, signer: null, error: null });
    if (!on) return;
    try {
      const c = await connect(config.chainId, { write: true, devAccount: config.devAccount });
      if (live) Object.assign(wallet, { address: c.account, signer: markRaw(c.signer) });
    } catch (error) { if (live) wallet.error = error; }
  }, { immediate: true });
  return wallet;
}

/** The balance of `address()` in wei, read again on every change of `tick()` (the block counter of the ladder data).
 *  A shallowRef: null while unknown. */
export function useBalance(provider, address, tick) {
  const balance = shallowRef(null);
  watch([address, tick], ([a], _, onCleanup) => {
    if (!a) { balance.value = null; return; }
    let on = true;
    onCleanup(() => { on = false; });
    provider.getBalance(a).then(b => { if (on) balance.value = b; }, () => {});
  }, { immediate: true });
  return balance;
}
