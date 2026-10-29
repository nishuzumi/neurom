// components/ChallengeView.jsx — the view 挑战进行中: the 6 episodes as cells, the current step, the transaction
// pipeline (in flight, confirmed), then the result and the rank change. The chain state comes from `challengeInfo`
// and `replay` (the episodes so far) on every block, the pipeline from the running challenge of the page.
import { useEffect, useState } from 'react';
import { t } from '../i18n.js';
import { href } from '../router.js';
import { useLadder } from '../ladder/use-ladder.jsx';
import { useChallenge } from '../ladder/use-challenge.jsx';
import { useWallet } from '../wallet/wallet.jsx';
import { describeError } from '../ladder/errors.js';
import { addressKey, formatInt, nameOf, rankLabel, score } from '../ladder/format.js';
import { ReplayPlayer, episodeResult } from '../replay/ReplayPlayer.jsx';
import { StatusPill } from './RecentChallenges.jsx';

export function ChallengeView({ id }) {
  const { client, names, tick, entries, config, block } = useLadder();
  const challenge = useChallenge();
  const wallet = useWallet();
  const run = challenge.run;
  const numeric = id !== 'new' && id !== null ? Number(id) : run?.id ?? null;
  const [info, setInfo] = useState(null);
  const [replay, setReplay] = useState(null);
  const [error, setError] = useState(null);
  const [rankBefore, setRankBefore] = useState(null);

  useEffect(() => {
    if (numeric === null) return undefined;
    let on = true;
    (async () => {
      try {
        const i = await client.challengeInfo(numeric);
        const r = await client.replay(numeric);
        if (on) { setInfo(i); setReplay(r); setError(null); }
      } catch (e) { if (on) setError(e); }
    })();
    return () => { on = false; };
  }, [client, numeric, tick]);

  // the rank of the challenger when the view first sees the challenge: the change shows against it
  const challengerEntry = info ? entries.find(e => addressKey(e.module) === addressKey(info.challenger)) : null;
  const defenderEntry = info ? entries.find(e => addressKey(e.module) === addressKey(info.defender)) : null;
  useEffect(() => { if (challengerEntry && rankBefore === null && Number(info?.status) === 1) setRankBefore(challengerEntry.rank); }, [challengerEntry, info?.status, rankBefore]);

  const ours = run && (run.id === numeric || numeric === null);
  const running = ours && (run.phase === 'starting' || run.phase === 'playing');
  const progress = ours ? run.progress : null;
  // the route `#/challenge/new` becomes the id as soon as the start receipt names it
  useEffect(() => { if (id === 'new' && run?.id !== null && run?.id !== undefined) history.replaceState(null, '', href.challenge(run.id)); }, [id, run?.id]);
  const status = Number(info?.status ?? 0);
  const mineChallenger = challengerEntry && addressKey(challengerEntry.owner) === addressKey(wallet.address);
  const episodes = replay?.episodes ?? [];
  const challengerSideOf = ep => (ep.side0?.toLowerCase() === info?.challenger?.toLowerCase() ? 0 : 1);
  const expired = info && status === 1 && config && block > Number(info.startBlock) + Number(config.timeoutBlocks);

  return (
    <div className="view"><div className="wrap">
      <div className="view-head">
        <div>
          <span className="label">{t('挑战')} {numeric !== null ? `#${numeric}` : ''}</span>
          <h2>{info ? `${nameOf(names, info.challenger)} → ${nameOf(names, info.defender)}` : run ? `${nameOf(names, run.challenger)} → ${nameOf(names, run.defender)}` : t('挑战')}</h2>
        </div>
        <div className="row">
          {info && <StatusPill status={status} />}
          <a href={href.main('ladder')} className="btn">{t('回到擂台榜')}</a>
        </div>
      </div>

      {run?.phase === 'failed' && (run.id === numeric || numeric === null) && <div className="msg bad">{describeError(run.error, { config, block })}</div>}
      {error && <div className="msg bad">{describeError(error, { config, block })}</div>}
      {run?.phase === 'starting' && numeric === null && <div className="msg">{t('正在发出第一笔交易，这笔交易就开打…')}</div>}

      {info && (
        <>
          <div className="episodes">
            {Array.from({ length: 6 }, (_, i) => {
              const ep = episodes[i];
              const done = ep && ep.end >= 0;
              const now = status === 1 && Number(info.episode) === i;
              const won = done && ep.end === challengerSideOf(ep);
              const lost = done && ep.end !== 2 && !won;
              return (
                <div key={i} className={`episode${won ? ' won' : ''}${lost ? ' lost' : ''}${now ? ' now' : ''}`}>
                  <span className="n">{t('第 {n} 局', { n: i + 1 })}</span>
                  <span className="r">{done ? episodeResult(ep, challengerSideOf(ep)) : now ? t('第 {t} 步', { t: Number(info.step) }) : '—'}</span>
                  {ep && <span className="muted mono" style={{ fontSize: 11 }}>{t('{n} 步', { n: ep.actions.length })}</span>}
                </div>
              );
            })}
          </div>

          <div className="card">
            <div className="pipeline">
              <div><span className="big accent">{score(info.challengerWins, info.defenderWins)}</span>{t('比分（挑战者 : 擂主）')}</div>
              <div><span className="big">{Number(info.episode) + (status === 1 ? 1 : 0) > 6 ? 6 : status === 1 ? Number(info.episode) + 1 : 6}/6</span>{t('局')}</div>
              <div><span className="big">{Number(info.step)}</span>{t('当前步')}</div>
              <div><span className="big">{running ? progress?.inFlight ?? '…' : progress ? 0 : '—'}</span>{t('在途交易')}</div>
              <div><span className="big">{progress ? progress.confirmed : '—'}</span>{t('已确认交易')}</div>
              <div><span className="big">{formatInt(info.startBlock)}</span>{t('发起块')}</div>
              {config && <div><span className="big">{formatInt(Number(info.startBlock) + Number(config.timeoutBlocks))}</span>{t('超时块')}</div>}
            </div>
            {status === 1 && !running && (
              <div className="row" style={{ marginTop: 14 }}>
                <span className="muted">{t('页面没有在推进这场挑战。')}</span>
                {wallet.signer && !challenge.busy && !expired && <button type="button" className="btn btn-primary btn-small" onClick={() => challenge.resume(numeric, info.challenger, info.defender).catch(() => {})}>{mineChallenger ? t('继续打') : t('帮忙推进')}</button>}
                {expired && <span className="pill bad">{t('已超时：任何人都可以结算为守擂成功')}</span>}
              </div>
            )}
            {status === 1 && running && <div className="muted" style={{ marginTop: 14, fontSize: 13 }}>{t('页面正在自动发交易。同一个账户最多 3 笔在途，收到回执以后再发下一笔。')}</div>}
          </div>

          {status >= 2 && (
            <div className="card featured stack">
              <div className="result">{status === 2 ? t('挑战成功') : status === 4 ? t('超时，守擂成功') : t('守擂成功')}</div>
              <dl className="kv">
                <dt>{t('比分')}</dt><dd>{score(info.challengerWins, info.defenderWins)}</dd>
                <dt>{t('挑战者的名次')}</dt><dd>{rankBefore !== null && challengerEntry ? `#${rankLabel(rankBefore)} → #${rankLabel(challengerEntry.rank)}` : challengerEntry ? `#${rankLabel(challengerEntry.rank)}` : '—'}</dd>
                <dt>{t('擂主的名次')}</dt><dd>{defenderEntry ? `#${rankLabel(defenderEntry.rank)}` : '—'}</dd>
                {status === 3 && config && <><dt>{t('冷却')}</dt><dd>{t('到第 {block} 块以前不能再挑战这个擂主', { block: formatInt(Number(info.startBlock) + Number(config.cooldownBlocks)) })}</dd></>}
              </dl>
              <div className="row"><a className="btn btn-primary" href={href.replay(numeric)}>{t('回放')}</a><a className="btn" href={href.main('ladder')}>{t('看榜单')}</a></div>
            </div>
          )}

          {episodes.length > 0 && <ReplayPlayer replay={replay} challenger={info.challenger} defender={info.defender} names={names} autoplay={status === 1} compact={status === 1} />}
        </>
      )}
    </div></div>
  );
}
