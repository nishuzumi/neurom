// components/RecentChallenges.jsx — [4] the recent challenges, as the HashSmash result table: challenger, defender,
// score, a result pill, gas, time and the replay link.
import { useEffect, useState } from 'react';
import { t } from '../i18n.js';
import { href } from '../router.js';
import { useLadder } from '../ladder/use-ladder.jsx';
import { useWallet } from '../wallet/wallet.jsx';
import { formatGas, formatInt, formatTime, nameOf, score } from '../ladder/format.js';

/** The pill of a challenge status. */
export function StatusPill({ status }) {
  switch (Number(status)) {
    case 1: return <span className="pill live">{t('进行中')}</span>;
    case 2: return <span className="pill ok">{t('挑战成功')}</span>;
    case 3: return <span className="pill">{t('守擂成功')}</span>;
    case 4: return <span className="pill bad">{t('超时，守擂成功')}</span>;
    default: return <span className="pill">—</span>;
  }
}

const times = new Map();
/** The timestamps of the start blocks of `items`, read once per block. */
function useBlockTimes(provider, items) {
  const [, bump] = useState(0);
  useEffect(() => {
    let on = true;
    const missing = items.map(c => Number(c.startBlock)).filter(b => b && !times.has(b));
    if (!missing.length) return undefined;
    Promise.all(missing.map(b => provider.getBlock(b).then(blk => { if (blk) times.set(b, blk.timestamp); }, () => {}))).then(() => { if (on) bump(n => n + 1); });
    return () => { on = false; };
  }, [provider, items]);
  return b => times.get(Number(b)) ?? null;
}

export function RecentChallenges() {
  const { recent, names } = useLadder();
  const wallet = useWallet();
  const timeOf = useBlockTimes(wallet.provider, recent);
  return (
    <>
      <div className="section-head"><div><span className="label">{t('最近的挑战')} / 04</span><h2>{t('最近的挑战')}</h2></div></div>
      {recent.length === 0 ? <div className="empty">{t('还没有挑战')}</div> : (
        <table className="table">
          <colgroup><col style={{ width: 56 }} /><col /><col /><col style={{ width: 70 }} /><col style={{ width: 130 }} /><col style={{ width: 80 }} /><col style={{ width: 170 }} /><col style={{ width: 70 }} /></colgroup>
          <thead><tr>
            <th>#</th><th>{t('挑战者')}</th><th>{t('擂主')}</th><th className="num">{t('比分')}</th><th>{t('结果')}</th><th className="num">gas</th><th>{t('时间')}</th><th />
          </tr></thead>
          <tbody>
            {recent.map(c => (
              <tr key={c.id}>
                <td className="rank">{c.id}</td>
                <td className="mono" title={c.challenger}>{nameOf(names, c.challenger)}</td>
                <td className="mono" title={c.defender}>{nameOf(names, c.defender)}</td>
                <td className="num mono">{score(c.challengerWins, c.defenderWins)}</td>
                <td><StatusPill status={c.status} /></td>
                <td className="num mono" title={formatInt(c.gasUsed ?? 0)}>{c.gasUsed ? formatGas(c.gasUsed) : '—'}</td>
                <td className="mono" title={t('第 {block} 块', { block: formatInt(c.startBlock) })}>{formatTime(timeOf(c.startBlock))}</td>
                <td><a href={c.status === 1 ? href.challenge(c.id) : href.replay(c.id)}>{c.status === 1 ? t('进度') : t('回放')}</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="footnote">
        <span>{t('比分是挑战者赢的局数 : 擂主赢的局数。gas 是这场挑战全部交易用掉的 gas。')}</span>
      </div>
    </>
  );
}
