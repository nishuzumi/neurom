// components/LadderTable.jsx — [2] the ladder, as the OKC leaderboard: rank, name (or short address), the weight size
// with a bar against the maximum (rank 1 in the accent colour), the record, the owner. After the login, the rows the
// selected entry can challenge show a 挑战 button. Status pills (HashSmash) say 挑战中 or 冷却到第 N 块.
// The challenge dialog shows the estimated cost and refuses to send when the balance is too low.
import { useEffect, useMemo, useState } from 'react';
import { t } from '../i18n.js';
import { href, go } from '../router.js';
import { useLadder } from '../ladder/use-ladder.jsx';
import { useChallenge } from '../ladder/use-challenge.jsx';
import { useBalance, useWallet } from '../wallet/wallet.jsx';
import { describeError, ladderErrorMessage } from '../ladder/errors.js';
import { addressKey, formatGas, formatInt, formatMon, nameOf, rankLabel, shortAddress } from '../ladder/format.js';

export function LadderTable() {
  const { entries, names, config, client, tick, block } = useLadder();
  const wallet = useWallet();
  const challenge = useChallenge();
  const mine = useMemo(() => entries.filter(e => addressKey(e.owner) === addressKey(wallet.address)), [entries, wallet.address]);
  const [challengerModule, setChallengerModule] = useState(null);
  const challenger = mine.find(e => addressKey(e.module) === addressKey(challengerModule)) ?? mine[mine.length - 1] ?? null;
  const [targets, setTargets] = useState({});
  const [dialog, setDialog] = useState(null);

  useEffect(() => {
    if (!challenger) { setTargets({}); return undefined; }
    let on = true;
    client.targets(challenger.module).then(list => { if (on) setTargets(Object.fromEntries(list.map(x => [addressKey(x.module), x]))); }, () => {});
    return () => { on = false; };
  }, [client, challenger?.module, tick]);

  const max = config ? Number(config.maxWeightBytes) : 0;
  return (
    <>
      <div className="section-head">
        <div><span className="label">{t('擂台榜')} / 02</span><h2>{t('擂台榜')}</h2></div>
        <div className="section-tools">
          {wallet.address && mine.length > 1 && (
            <label className="row">{t('用哪个出战模型挑战')}
              <select value={challenger?.module ?? ''} onChange={e => setChallengerModule(e.target.value)}>
                {mine.map(e => <option key={e.module} value={e.module}>#{rankLabel(e.rank)} {nameOf(names, e.module)}</option>)}
              </select>
            </label>
          )}
          {wallet.address && mine.length === 1 && <span className="muted">{t('挑战者：{name}（第 {rank} 名）', { name: nameOf(names, challenger.module), rank: challenger.rank })}</span>}
          {wallet.address && mine.length === 0 && <a href={href.entries()} className="btn btn-small">{t('注册出战模型')}</a>}
          <span className="muted mono">{t('权重字节数上限 {max}', { max: formatInt(max) })}</span>
        </div>
      </div>
      {entries.length === 0 ? <div className="empty">{t('还没有出战模型')}</div> : (
        <table className="table">
          <colgroup><col style={{ width: 48 }} /><col style={{ width: '22%' }} /><col /><col style={{ width: 90 }} /><col style={{ width: 120 }} /><col style={{ width: 150 }} /></colgroup>
          <thead><tr>
            <th>#</th><th>{t('名字')}</th><th>{t('权重字节数')}</th><th className="num">{t('战绩')}</th><th>{t('拥有者')}</th><th>{t('状态')}</th>
          </tr></thead>
          <tbody>
            {entries.map(e => {
              const isMine = addressKey(e.owner) === addressKey(wallet.address);
              const target = targets[addressKey(e.module)] ?? null;
              const canChallenge = challenger && target && !target.reason && !challenge.busy && e.module !== challenger.module;
              return (
                <tr key={e.module} className={isMine ? 'mine' : ''}>
                  <td className="rank">{rankLabel(e.rank)}</td>
                  <td title={e.module}><span className="mono">{nameOf(names, e.module)}</span></td>
                  <td>
                    <div className="bar">
                      <span className="v">{formatInt(e.weightBytes)}</span>
                      <div className="track"><div className={`fill${e.rank === 1 ? ' top' : ''}`} style={{ width: `${max ? Math.min(100, (100 * e.weightBytes) / max) : 0}%` }} /></div>
                    </div>
                  </td>
                  <td className="num mono">{e.wins} : {e.losses}</td>
                  <td className="mono" title={e.owner}>{isMine ? t('我') : shortAddress(e.owner)}</td>
                  <td>
                    {e.activeChallenge && Number(e.activeChallenge) !== 0 ? <a className="pill live" href={href.challenge(e.activeChallenge)}>{t('挑战中')} #{String(e.activeChallenge)}</a>
                      : target?.reason === 'Cooldown' ? <span className="pill warn" title={ladderErrorMessage('Cooldown', { config, cooldownUntil: Number(target.cooldownUntil), block })}>{t('冷却到第 {block} 块', { block: formatInt(target.cooldownUntil) })}</span>
                      : target?.reason && target.reason !== 'OutOfRange' ? <span className="pill" title={ladderErrorMessage(target.reason, { config }) ?? target.reason}>{ladderErrorMessage(target.reason, { config }) ?? target.reason}</span>
                      : canChallenge ? <button type="button" className="btn btn-primary btn-small" onClick={() => setDialog(e)}>{t('挑战')}</button>
                      : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <div className="footnote">
        <span>{t('条形是权重字节数和上限的比。第 1 名的条是强调色。')}</span>
        <span>{t('登录以后，比你的出战模型高 1 到 {range} 名、不在冷却中、没有在挑战中的行显示“挑战”按钮。', { range: config?.range ?? '—' })}</span>
      </div>
      {dialog && challenger && <ChallengeDialog challenger={challenger} defender={dialog} onClose={() => setDialog(null)} />}
    </>
  );
}

function ChallengeDialog({ challenger, defender, onClose }) {
  const { client, names, config, block, tick } = useLadder();
  const wallet = useWallet();
  const challenge = useChallenge();
  const balance = useBalance(wallet.provider, wallet.address, tick);
  const [estimate, setEstimate] = useState(null);
  const [error, setError] = useState(null);
  const [sending, setSending] = useState(false);
  useEffect(() => {
    let on = true;
    client.estimate(challenger.module, defender.module).then(e => { if (on) setEstimate(e); }, e => { if (on) setError(e); });
    return () => { on = false; };
  }, [client, challenger.module, defender.module]);
  const short = estimate && balance !== null && balance < BigInt(estimate.costTypicalWei);
  const shortWorst = estimate && balance !== null && balance < BigInt(estimate.costWorstWei);
  const start = async () => {
    setSending(true); setError(null);
    try {
      const p = challenge.start(challenger.module, defender.module);
      onClose();
      go(href.challenge('new'));
      await p;
    } catch (e) { setError(e); setSending(false); }
  };
  return (
    <div className="modal-back" role="dialog" aria-modal="true" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <div><span className="label">{t('发起挑战')}</span><h3 style={{ marginTop: 6 }}>{nameOf(names, challenger.module)} → {nameOf(names, defender.module)}</h3></div>
        <dl className="kv">
          <dt>{t('挑战者')}</dt><dd>#{rankLabel(challenger.rank)} · {formatInt(challenger.weightBytes)} B · {shortAddress(challenger.module)}</dd>
          <dt>{t('擂主')}</dt><dd>#{rankLabel(defender.rank)} · {formatInt(defender.weightBytes)} B · {shortAddress(defender.module)}</dd>
          <dt>{t('平局时')}</dt><dd>{tieText(challenger, defender, config)}</dd>
          <dt>{t('预计费用（典型）')}</dt><dd>{estimate ? `${formatMon(estimate.costTypicalWei)} · ${formatGas(estimate.gasTypical)} gas` : '…'}</dd>
          <dt>{t('预计费用（最坏）')}</dt><dd>{estimate ? `${formatMon(estimate.costWorstWei)} · ${formatGas(estimate.gasWorst)} gas · ${t('{n} 笔交易', { n: estimate.txWorst })}` : '…'}</dd>
          <dt>{t('钱包余额')}</dt><dd>{formatMon(balance)}</dd>
          <dt>{t('超时')}</dt><dd>{config ? t('从第 {start} 块起 {n} 块内要打完', { start: formatInt(block), n: formatInt(config.timeoutBlocks) }) : '…'}</dd>
        </dl>
        {short && <div className="msg bad">{t('余额不够付典型的一场挑战，先给钱包充值')}</div>}
        {!short && shortWorst && <div className="msg warn">{t('余额够典型的一场，但是不够最坏的一场（600 步）')}</div>}
        {error && <div className="msg bad">{describeError(error, { config, block })}</div>}
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>{t('页面会自动发出这场挑战的全部交易，不再弹窗确认。关掉页面以后，在超时以前回来还能接着打。')}</p>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>{t('取消')}</button>
          <button type="button" className="btn btn-primary" disabled={!estimate || short || sending || challenge.busy} onClick={start}>{t('开打')}</button>
        </div>
      </div>
    </div>
  );
}

/** Who wins a tie on episodes between `c` and `d` under δ. */
function tieText(c, d, config) {
  if (!config) return '…';
  const delta = Number(config.deltaBps) / 10000;
  const limit = Math.floor(Number(d.weightBytes) * (1 - delta));
  return Number(c.weightBytes) <= limit
    ? t('挑战者赢（{c} ≤ {limit}，比擂主小 δ = {delta}% 以上）', { c: formatInt(c.weightBytes), limit: formatInt(limit), delta: delta * 100 })
    : t('擂主守擂（挑战者要 ≤ {limit} 字节才能靠 δ = {delta}% 赢）', { limit: formatInt(limit), delta: delta * 100 });
}
