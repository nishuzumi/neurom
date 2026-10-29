// components/TopBar.jsx — the top bar: the site name and the section links on the left, the login button on the
// right. After the login the button becomes the wallet chip: address, balance and the way out.
import { setLocale, t, useLocale } from '../i18n.js';
import { href } from '../router.js';
import { useBalance, useWallet } from '../wallet/wallet.jsx';
import { useLadder } from '../ladder/use-ladder.jsx';
import { formatMon, shortAddress } from '../ladder/format.js';

export function TopBar({ route }) {
  const locale = useLocale();
  const wallet = useWallet();
  const { tick } = useLadder();
  const balance = useBalance(wallet.provider, wallet.address, tick);
  const main = route.view === 'main';
  return (
    <header className="topbar">
      <div className="wrap">
        <a className="brand" href={href.main()}>NEUROM<span className="sub">{t('坦克擂台')}</span></a>
        <nav className="topnav" aria-label={t('页面导航')}>
          <a href={href.main('ladder')} className={main && route.section === 'ladder' ? 'on' : ''}>{t('擂台榜')}</a>
          <a href={href.main('rules')} className={main && route.section === 'rules' ? 'on' : ''}>{t('规则')}</a>
          <a href={href.main('recent')} className={main && route.section === 'recent' ? 'on' : ''}>{t('最近的挑战')}</a>
          {wallet.address && <a href={href.entries()} className={route.view === 'entries' ? 'on' : ''}>{t('我的出战模型')}</a>}
        </nav>
        <div className="topbar-right">
          {wallet.address ? (
            <div className="wallet-chip">
              {wallet.kind === 'dev' && <span className="dev" title={t('anvil 默认助记词的账号，只用于本地开发')}>{t('本地开发')}</span>}
              <a className="mono" href={href.entries()} title={wallet.address}>{shortAddress(wallet.address)}</a>
              <span className="mono muted">{formatMon(balance)}</span>
              <button type="button" className="btn-link" onClick={wallet.logout}>{t('退出')}</button>
            </div>
          ) : (
            <button type="button" className="btn btn-primary" disabled={!wallet.ready || wallet.kind === 'none'} onClick={wallet.login} title={wallet.kind === 'dev' ? wallet.label : ''}>
              {t('登录')}
            </button>
          )}
          <button type="button" className="lang-toggle" title="中文 / English" aria-label="Language: 中文 / English" onClick={() => setLocale(locale === 'zh' ? 'en' : 'zh')}>{/* i18n-ignore */}
            {locale === 'zh' ? 'EN' : '中'}{/* i18n-ignore */}
          </button>
        </div>
      </div>
    </header>
  );
}
