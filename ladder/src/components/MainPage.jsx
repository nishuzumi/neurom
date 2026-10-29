// components/MainPage.jsx — the long main page: hero (two columns), data strip, the sticky numbered nav and the
// sections [1] 开始, [2] 擂台榜, [3] 规则, [4] 最近的挑战.
import { Fragment, useEffect, useState } from 'react';
import { t } from '../i18n.js';
import { href } from '../router.js';
import { useLadder } from '../ladder/use-ladder.jsx';
import { useBalance, useWallet } from '../wallet/wallet.jsx';
import { addressKey, formatInt, formatMon, nameOf, shortAddress } from '../ladder/format.js';
import { ReplayPlayer } from '../replay/ReplayPlayer.jsx';
import { LadderTable } from './LadderTable.jsx';
import { Rules } from './Rules.jsx';
import { RecentChallenges } from './RecentChallenges.jsx';

const SECTIONS = [['start', '开始'], ['ladder', '擂台榜'], ['rules', '规则'], ['recent', '最近的挑战']];

export function MainPage({ config, route }) {
  const [current, setCurrent] = useState('start');
  // the section in view marks the nav
  useEffect(() => {
    const els = SECTIONS.map(([id]) => document.getElementById(id)).filter(Boolean);
    const io = new IntersectionObserver(entries => {
      const seen = entries.filter(e => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (seen[0]) setCurrent(seen[0].target.id);
    }, { rootMargin: '-30% 0px -60% 0px' });
    els.forEach(el => io.observe(el));
    return () => io.disconnect();
  }, []);
  useEffect(() => { if (route.section) document.getElementById(route.section)?.scrollIntoView({ behavior: 'smooth' }); }, [route.section]);

  return (
    <>
      <Hero config={config} />
      <DataStrip />
      <div className="body"><div className="wrap">
        <nav className="sidenav" aria-label={t('章节导航')}>
          {SECTIONS.map(([id, zh], i) => <a key={id} href={href.main(id)} className={current === id ? 'on' : ''}><span className="n">[{i + 1}]</span>{t(zh)}</a>)}
        </nav>
        <div className="sections">
          <section id="start" className="section">
            <div className="section-head"><div><span className="label">{t('开始')} / 01</span><h2>{t('怎样参赛')}</h2></div></div>
            <Guide config={config} />
          </section>
          <section id="ladder" className="section"><LadderTable config={config} /></section>
          <section id="rules" className="section"><Rules /></section>
          <section id="recent" className="section"><RecentChallenges config={config} /></section>
        </div>
      </div></div>
    </>
  );
}

function Hero({ config }) {
  const { recent, client, names, tick } = useLadder();
  const wallet = useWallet();
  const featured = recent.find(c => c.status === 1) ?? recent[0] ?? null;
  const [replay, setReplay] = useState(null);
  useEffect(() => {
    if (!featured) { setReplay(null); return undefined; }
    let on = true;
    client.replay(featured.id).then(r => { if (on) setReplay(r); }, () => {});
    return () => { on = false; };
  }, [client, featured?.id, featured?.status === 1 ? tick : 0]);
  return (
    <section className="hero"><div className="wrap">
      <div className="hero-left">
        <span className="label">NEUROM / {t('坦克大战擂台赛')}</span>
        <h1>{t('坦克擂台')}</h1>
        <p className="lead">{t('把工作台里训练的坦克网络注册成出战模型，挑战排在你上面的出战模型。裁判是链上合约，每一场都能回放和复现。')}</p>
        <Steps />
        <div className="hero-actions">
          {wallet.address ? <a className="btn btn-primary" href={href.entries()}>{t('注册出战模型')}</a> : <button type="button" className="btn btn-primary" disabled={!wallet.ready || wallet.kind === 'none'} onClick={wallet.login}>{t('登录并注册出战模型')}</button>}
          <a className="btn" href={href.main('rules')}>{t('看规则')}</a>
        </div>
      </div>
      <div className="hero-right">
        <ReplayPlayer replay={replay} challenger={featured?.challenger} defender={featured?.defender} names={names} autoplay compact />
        <div className="hero-caption">
          {featured ? (
            <>
              <span>{featured.status === 1 ? t('正在进行') : t('最近一场')} · #{featured.id} · {nameOf(names, featured.challenger)} vs {nameOf(names, featured.defender)}</span>
              <a href={href.replay(featured.id)}>{t('回放')} →</a>
            </>
          ) : <span>{config.ladder ? t('还没有挑战') : ''}</span>}
        </div>
      </div>
    </div></section>
  );
}

function Steps() {
  const steps = [
    ['训练', '在工作台里用模板“坦克大战”训练网络，看胜率和平局率。'],
    ['导出模型产物', '在候选模块里导出接受的候选，得到一个 JSON 文件。'],
    ['注册出战模型', '登录以后导入这个文件，部署到官方 Factory，然后注册。新出战模型从最后一名开始。'],
  ];
  return (
    <div className="guide">
      {steps.map(([title, desc], i) => (
        <div className="guide-step" key={title}>
          <span className="n">0{i + 1}</span>{/* i18n-ignore */}
          <div><div className="title">{t(title)}</div><div className="desc">{t(desc)}</div></div>
        </div>
      ))}
    </div>
  );
}

/** [1] 开始: what the player needs before the first challenge: the network, the wallet and its balance, an entry. */
function Guide({ config }) {
  const wallet = useWallet();
  const { entries, tick, config: ladderConfig } = useLadder();
  const balance = useBalance(wallet.provider, wallet.address, tick);
  const mine = entries.filter(e => addressKey(e.owner) === addressKey(wallet.address));
  const items = [
    [t('网络'), config.name, true],
    [t('钱包'), wallet.address ? `${shortAddress(wallet.address)} · ${formatMon(balance)}` : t('还没有登录'), !!wallet.address],
    [t('出战模型'), mine.length ? t('{n} 个', { n: mine.length }) : t('还没有'), mine.length > 0],
    [t('赛季结束块'), ladderConfig ? formatInt(ladderConfig.endBlock) : '…', true],
  ];
  return (
    <div className="card stack">
      <dl className="kv">
        {items.map(([k, v, ok]) => <Fragment key={k}><dt>{k}</dt><dd><span className={`pill${ok ? ' ok' : ''}`}>{v}</span></dd></Fragment>)}
      </dl>
      <div className="row">
        {wallet.address ? <a className="btn btn-primary" href={href.entries()}>{mine.length ? t('我的出战模型') : t('注册出战模型')}</a> : <button type="button" className="btn btn-primary" disabled={!wallet.ready || wallet.kind === 'none'} onClick={wallet.login}>{t('登录')}</button>}
        <a className="btn" href={href.main('ladder')}>{t('看榜单')}</a>
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>
        {config.local ? t('这是本地开发链：登录用的是 anvil 默认助记词的账号，任何人都知道它的私钥。') : t('挑战的 gas 由你的钱包付，先给钱包充值 MON。')}
      </p>
    </div>
  );
}

function DataStrip() {
  const { entries, recent, config, block, names } = useLadder();
  const finished = recent.filter(c => c.status >= 2).length;
  const top = entries[0] ?? null;
  const left = config ? Math.max(0, Number(config.endBlock) - block) : null;
  return (
    <section className="strip"><div className="wrap">
      <div className="stat"><span className="big">{formatInt(entries.length)}</span><div className="small">{t('出战模型')}</div></div>
      <div className="stat"><span className="big plain">{formatInt(finished)}</span><div className="small">{t('已结束的挑战（最近 {n} 场里）', { n: recent.length })}</div></div>
      <div className="stat"><span className="big" title={top?.module ?? ''}>{top ? nameOf(names, top.module) : '—'}</span><div className="small">{t('当前第 1 名')}</div></div>
      <div className="stat"><span className="big plain">{left === null ? '—' : formatInt(left)}</span><div className="small">{t('赛季剩余块数（到第 {end} 块）', { end: config ? formatInt(config.endBlock) : '—' })}</div></div>
    </div></section>
  );
}
