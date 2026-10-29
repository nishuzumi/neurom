// wallet/wallet.jsx — the wallet of the page as one React context. Two implementations give the same value:
//   - Privy (ADR 0027): the embedded wallet with `showWalletUIs: false`, when `VITE_PRIVY_APP_ID` is set.
//   - The local dev signer: an account of the anvil default mnemonic, only on the local chain (31337) without Privy.
//     The UI and the README label it as local development.
// The value: `{ kind, ready, address, signer, login(), logout(), label }`. `signer` is an ethers Signer that the ladder
// client sends transactions with. `provider` is the read provider of the page (a JsonRpcProvider of the chain RPC).
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { BrowserProvider, HDNodeWallet, JsonRpcProvider, Mnemonic } from 'ethers';
import { PrivyProvider, usePrivy, useWallets } from '@privy-io/react-auth';
import { defineChain } from 'viem';
import { t } from '../i18n.js';

const WalletContext = createContext(null);
/** The wallet value of the nearest WalletProvider. */
export const useWallet = () => useContext(WalletContext);

/** The anvil default mnemonic. Its accounts are public: local development only. */
export const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk';
const DEV_LOGIN_KEY = 'ladder.dev.login';

/** The viem chain object of the page chain, for Privy. */
export function viemChain(config) {
  return defineChain({
    id: config.chainId,
    name: config.name,
    nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
    rpcUrls: { default: { http: [config.rpc] } },
    ...(config.explorer ? { blockExplorers: { default: { name: 'Explorer', url: config.explorer } } } : {}),
    testnet: config.chainId !== 143,
  });
}

/** The read provider of the page: one per RPC URL. */
export function useReadProvider(config) {
  return useMemo(() => new JsonRpcProvider(config.rpc, config.chainId, { staticNetwork: true, pollingInterval: 1500 }), [config.rpc, config.chainId]);
}

/** The wallet of the page: Privy when the app id is set, else the local dev signer on the local chain. */
export function WalletProvider({ config, provider, children }) {
  if (config.privyAppId) {
    const chain = viemChain(config);
    return (
      <PrivyProvider
        appId={config.privyAppId}
        config={{
          embeddedWallets: { showWalletUIs: false, ethereum: { createOnLogin: 'users-without-wallets' } },
          supportedChains: [chain],
          defaultChain: chain,
          appearance: { theme: 'light', accentColor: '#5b4ee6' },
        }}>
        <PrivyWallet config={config} provider={provider}>{children}</PrivyWallet>
      </PrivyProvider>
    );
  }
  if (config.local) return <DevWallet config={config} provider={provider}>{children}</DevWallet>;
  return <WalletContext.Provider value={{ kind: 'none', ready: true, address: null, signer: null, login: () => {}, logout: () => {}, label: t('这条链上没有配置登录方式') }}>{children}</WalletContext.Provider>;
}

function PrivyWallet({ config, provider, children }) {
  const { ready, authenticated, login, logout } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const wallet = wallets.find(w => w.walletClientType === 'privy') ?? wallets[0] ?? null;
  const address = wallet?.address ?? null;
  const [signer, setSigner] = useState(null);
  useEffect(() => {
    if (!wallet) { setSigner(null); return undefined; }
    let on = true;
    (async () => {
      try { await wallet.switchChain(config.chainId); } catch { /* the embedded wallet already starts on the default chain */ }
      const eip1193 = await wallet.getEthereumProvider();
      const s = await new BrowserProvider(eip1193, config.chainId).getSigner(wallet.address);
      if (on) setSigner(s);
    })();
    return () => { on = false; };
  }, [address, config.chainId]);
  const value = useMemo(() => ({
    kind: 'privy', ready: ready && walletsReady, authenticated, address, signer: authenticated ? signer : null, provider, login, logout, label: 'Privy',
  }), [ready, walletsReady, authenticated, address, signer, provider, login, logout]);
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

/** The dev signer: account `index` of the anvil mnemonic, connected to `provider`. */
export function devSigner(provider, index) {
  return HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(ANVIL_MNEMONIC), `m/44'/60'/0'/0/${index}`).connect(provider);
}

function DevWallet({ config, provider, children }) {
  const [authenticated, setAuthenticated] = useState(() => localStorage.getItem(DEV_LOGIN_KEY) === '1');
  const signer = useMemo(() => devSigner(provider, config.devAccount), [provider, config.devAccount]);
  const value = useMemo(() => ({
    kind: 'dev',
    ready: true,
    authenticated,
    address: authenticated ? signer.address : null,
    signer: authenticated ? signer : null,
    provider,
    login: () => { localStorage.setItem(DEV_LOGIN_KEY, '1'); setAuthenticated(true); },
    logout: () => { localStorage.removeItem(DEV_LOGIN_KEY); setAuthenticated(false); },
    label: t('本地开发账号 #{index}', { index: config.devAccount }),
  }), [authenticated, signer, provider, config.devAccount]);
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

/** The balance of `address` in wei, refreshed with `tick` (a counter the page bumps per block). null while unknown. */
export function useBalance(provider, address, tick) {
  const [balance, setBalance] = useState(null);
  useEffect(() => {
    if (!address) { setBalance(null); return undefined; }
    let on = true;
    provider.getBalance(address).then(b => { if (on) setBalance(b); }, () => {});
    return () => { on = false; };
  }, [provider, address, tick]);
  return balance;
}
