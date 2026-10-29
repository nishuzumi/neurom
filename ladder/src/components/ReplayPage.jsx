// components/ReplayPage.jsx — the view 回放: the dark panel with the board, the segmented tabs of the 6 episodes
// and the step slider (ReplayPlayer), with the facts of the challenge beside it.
import { useEffect, useState } from 'react';
import { t } from '../i18n.js';
import { href } from '../router.js';
import { useLadder } from '../ladder/use-ladder.jsx';
import { describeError } from '../ladder/errors.js';
import { formatInt, nameOf, score, shortAddress } from '../ladder/format.js';
import { ReplayPlayer } from '../replay/ReplayPlayer.jsx';
import { StatusPill } from './RecentChallenges.jsx';

export function ReplayPage({ id }) {
  const { client, names, config, block } = useLadder();
  const numeric = Number(id);
  const [info, setInfo] = useState(null);
  const [replay, setReplay] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let on = true;
    (async () => {
      try {
        const [i, r] = await Promise.all([client.challengeInfo(numeric), client.replay(numeric)]);
        if (on) { setInfo(i); setReplay(r); }
      } catch (e) { if (on) setError(e); }
    })();
    return () => { on = false; };
  }, [client, numeric]);
  return (
    <div className="view"><div className="wrap">
      <div className="view-head">
        <div>
          <span className="label">{t('回放')} #{id}</span>
          <h2>{info ? `${nameOf(names, info.challenger)} vs ${nameOf(names, info.defender)}` : t('回放')}</h2>
        </div>
        <div className="row">
          {info && <StatusPill status={info.status} />}
          {info && Number(info.status) === 1 && <a className="btn btn-small" href={href.challenge(numeric)}>{t('进度')}</a>}
          <a href={href.main('recent')} className="btn">{t('最近的挑战')}</a>
        </div>
      </div>
      {error && <div className="msg bad">{describeError(error, { config, block })}</div>}
      {info && (
        <dl className="kv card">
          <dt>{t('挑战者')}</dt><dd>{nameOf(names, info.challenger)} · {shortAddress(info.challenger)}</dd>
          <dt>{t('擂主')}</dt><dd>{nameOf(names, info.defender)} · {shortAddress(info.defender)}</dd>
          <dt>{t('比分')}</dt><dd>{score(info.challengerWins, info.defenderWins)}</dd>
          <dt>{t('种子')}</dt><dd>{info.seed}</dd>
          <dt>{t('发起块')}</dt><dd>{formatInt(info.startBlock)}</dd>
        </dl>
      )}
      {replay && <ReplayPlayer replay={replay} challenger={info?.challenger} defender={info?.defender} names={names} />}
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>{t('回放由种子、事件里的动作和模板的场景重建，页面不读任何权重。')}</p>
    </div></div>
  );
}
