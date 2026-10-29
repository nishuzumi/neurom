// App.jsx — the root of the ladder page: the providers (wallet, ladder data, the running challenge), the top bar and
// the view of the route. The main page is one long page (ui-reference.md): hero, data strip, then the numbered
// sections. The other views are my entries, a challenge in progress and a replay.
import { Component, useMemo } from 'react';
import { pageConfig } from './config.js';
import { useRoute } from './router.js';
import { t, useLocale } from './i18n.js';
import { WalletProvider, useReadProvider, useWallet } from './wallet/wallet.jsx';
import { LadderProvider, useLadder } from './ladder/use-ladder.jsx';
import { ChallengeProvider } from './ladder/use-challenge.jsx';
import { TopBar } from './components/TopBar.jsx';
import { MainPage } from './components/MainPage.jsx';
import { MyEntries } from './components/MyEntries.jsx';
import { ChallengeView } from './components/ChallengeView.jsx';
import { ReplayPage } from './components/ReplayPage.jsx';

export function App() {
  useLocale();
  const config = useMemo(() => pageConfig(), []);
  const provider = useReadProvider(config);
  return (
    <ErrorBoundary>
      <WalletProvider config={config} provider={provider}>
        <Wired config={config} provider={provider} />
      </WalletProvider>
    </ErrorBoundary>
  );
}

/** A render error shows its message instead of a blank page. */
class ErrorBoundary extends Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (!this.state.error) return this.props.children;
    return <div className="wrap"><div className="msg bad" style={{ marginTop: 40 }}>{t('页面出错了：{message}', { message: this.state.error.message })} <button type="button" className="btn-link" onClick={() => location.reload()}>{t('重新加载')}</button></div></div>;
  }
}

function Wired({ config, provider }) {
  const wallet = useWallet();
  return (
    <LadderProvider config={config} provider={provider} signer={wallet.signer}>
      <ChallengeProvider signer={wallet.signer}>
        <Shell config={config} />
      </ChallengeProvider>
    </LadderProvider>
  );
}

function Shell({ config }) {
  const route = useRoute();
  const { error, loaded } = useLadder();
  return (
    <>
      <TopBar config={config} route={route} />
      {!config.ladder && <div className="wrap"><div className="msg warn" style={{ marginTop: 20 }}>{t('这条链（{name}）上还没有部署擂台合约', { name: config.name })}</div></div>}
      {error && <div className="wrap"><div className="msg bad" style={{ marginTop: 20 }}>{t('读不到链上数据：{message}', { message: error.shortMessage || error.message })}</div></div>}
      {route.view === 'main' && <MainPage config={config} route={route} />}
      {route.view === 'entries' && <MyEntries config={config} />}
      {route.view === 'challenge' && <ChallengeView config={config} id={route.id} />}
      {route.view === 'replay' && <ReplayPage config={config} id={route.id} />}
      <footer className="footer"><div className="wrap">
        <span>NEUROM · {t('坦克擂台')}</span>
        <span className="mono">{config.name} · {t('合约')} {config.ladder ?? '—'}</span>
        {!loaded && <span>{t('读取中…')}</span>}
      </div></footer>
    </>
  );
}
