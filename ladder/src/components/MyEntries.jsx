// components/MyEntries.jsx — the view 我的出战模型: import a model artifact, deploy and register it, name it.
// Every entry of the account is listed with its rank, a running challenge to continue and the name form.
import { useEffect, useMemo, useState } from 'react';
import { t } from '../i18n.js';
import { href } from '../router.js';
import { useLadder } from '../ladder/use-ladder.jsx';
import { useChallenge } from '../ladder/use-challenge.jsx';
import { useWallet } from '../wallet/wallet.jsx';
import { describeError, ladderErrorMessage, nameErrorMessage } from '../ladder/errors.js';
import { inspectArtifact, registrationProblem } from '../ladder/artifact.js';
import { BANNED_WORDS, setName, validateName } from '../ladder/names.js';
import { addressKey, formatInt, nameOf, rankLabel, shortAddress } from '../ladder/format.js';

export function MyEntries({ config }) {
  const wallet = useWallet();
  const { entries, names, loaded } = useLadder();
  const mine = useMemo(() => entries.filter(e => addressKey(e.owner) === addressKey(wallet.address)), [entries, wallet.address]);
  return (
    <div className="view"><div className="wrap">
      <div className="view-head">
        <div><span className="label">{t('我的出战模型')}</span><h2>{t('我的出战模型')}</h2></div>
        <a href={href.main('ladder')} className="btn">{t('回到擂台榜')}</a>
      </div>
      {!wallet.address ? (
        <div className="card stack">
          <p style={{ margin: 0 }}>{t('先登录，然后注册出战模型。')}</p>
          <div><button type="button" className="btn btn-primary" disabled={!wallet.ready || wallet.kind === 'none'} onClick={wallet.login}>{t('登录')}</button></div>
          {wallet.kind === 'dev' && <p className="muted" style={{ margin: 0, fontSize: 13 }}>{t('本地开发：登录用 anvil 默认助记词的账号 #{index}。', { index: config.devAccount })}</p>}
        </div>
      ) : (
        <div className="two">
          <RegisterCard config={config} />
          <div className="stack">
            <h3>{t('已注册的出战模型')}</h3>
            {loaded && mine.length === 0 && <div className="empty">{t('这个账号还没有出战模型')}</div>}
            <div className="entry-list">
              {mine.map(e => <EntryCard key={e.module} entry={e} name={names[addressKey(e.module)] ?? null} config={config} />)}
            </div>
            <RememberedChallenge mine={mine} />
          </div>
        </div>
      )}
    </div></div>
  );
}

function RegisterCard({ config }) {
  const { client, config: ladderConfig, refresh } = useLadder();
  const [text, setText] = useState('');
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);

  // the pasted or chosen text → the checked artifact
  useEffect(() => {
    if (!text.trim()) { setSummary(null); setError(null); return undefined; }
    let on = true;
    inspectArtifact(text).then(s => { if (on) { setSummary(s); setError(null); } }, e => { if (on) { setSummary(null); setError(e); } });
    return () => { on = false; };
  }, [text]);
  const problem = summary ? registrationProblem(summary, ladderConfig) : null;

  const pick = async e => {
    const file = e.target.files?.[0];
    if (file) setText(await file.text());
  };
  const register = async () => {
    setBusy(true); setStatus([]); setDone(null); setError(null);
    try {
      const result = await client.register(summary.artifact, { onStatus: s => setStatus(list => [...list, typeof s === 'string' ? s : s?.message ?? JSON.stringify(s)]) });
      setDone(result);
      setText('');
      refresh();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <div className="card featured stack">
      <div><span className="label">{t('注册')}</span><h3 style={{ marginTop: 6 }}>{t('导入模型产物')}</h3></div>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>{t('从工作台的候选模块导出的 JSON 文件。页面先核对它的内容 id，然后通过官方 Factory 部署，再注册。')}</p>
      <div className="field">
        <label htmlFor="artifact-file">{t('选择文件')}</label>
        <input id="artifact-file" type="file" accept="application/json,.json" onChange={pick} disabled={busy} />
      </div>
      <div className="field">
        <label htmlFor="artifact-text">{t('或者粘贴 JSON')}</label>
        <textarea id="artifact-text" value={text} onChange={e => setText(e.target.value)} disabled={busy} spellCheck={false} />
      </div>
      {summary && (
        <dl className="kv">
          <dt>{t('内容 id')}</dt><dd>{summary.id}</dd>
          <dt>{t('引擎')}</dt><dd>{summary.engine}</dd>
          <dt>{t('输入 / 输出')}</dt><dd>{summary.inputs} / {summary.outputs}</dd>
          <dt>{t('权重字节数')}</dt><dd>{formatInt(summary.weightBytes)}{ladderConfig ? ` / ${formatInt(ladderConfig.maxWeightBytes)}` : ''}</dd>
          <dt>{t('工具层')}</dt><dd>{summary.tools}</dd>
        </dl>
      )}
      {problem && <div className="msg bad">{ladderErrorMessage(problem, { config: ladderConfig, weightBytes: summary?.weightBytes })}</div>}
      {error && <div className="msg bad">{describeError(error, { config: ladderConfig, weightBytes: summary?.weightBytes })}</div>}
      {status.length > 0 && <div className="msg mono" style={{ fontSize: 12 }}>{status.map((s, i) => <div key={i}>{s}</div>)}</div>}
      {done && <div className="msg ok">{t('已注册：{module}，第 {rank} 名', { module: shortAddress(done.module), rank: done.rank })}</div>}
      <div className="row">
        <button type="button" className="btn btn-primary" disabled={!summary || !!problem || busy || !client} onClick={register}>{busy ? t('部署中…') : t('部署并注册')}</button>
        {config.local && <span className="muted" style={{ fontSize: 12 }}>{t('本地链：gas 由 anvil 账号付')}</span>}
      </div>
    </div>
  );
}

function EntryCard({ entry, name, config }) {
  const { refreshName, config: ladderConfig } = useLadder();
  const wallet = useWallet();
  const challenge = useChallenge();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const local = draft ? validateName(draft, BANNED_WORDS) : null;
  const active = entry.activeChallenge && Number(entry.activeChallenge) !== 0 ? Number(entry.activeChallenge) : null;
  const submit = async e => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await setName({ signer: wallet.signer, chainId: config.chainId, module: entry.module, name: draft });
      setDraft('');
      refreshName(entry.module);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <div className="card entry">
      <div className="rank">{rankLabel(entry.rank)}</div>
      <div className="stack" style={{ gap: 6 }}>
        <div className="name">{name ?? shortAddress(entry.module)}</div>
        <div className="meta">{entry.module}</div>
        <div className="meta">{t('权重字节数 {n}', { n: formatInt(entry.weightBytes) })} · {t('战绩')} {entry.wins} : {entry.losses}</div>
        {name === null && (
          <form className="row" onSubmit={submit}>
            <input type="text" value={draft} onChange={e => setDraft(e.target.value)} placeholder={t('起一个英文名字（3 到 24 个字符）')} aria-label={t('名字')} disabled={busy} style={{ flex: '1 1 160px' }} />
            <button type="submit" className="btn btn-small" disabled={!draft || !!local || busy}>{busy ? t('签名中…') : t('设置名字')}</button>
            {local && <span className="msg bad" style={{ padding: '4px 8px' }}>{nameErrorMessage(local)}</span>}
            {error && <span className="msg bad" style={{ padding: '4px 8px' }}>{describeError(error, { config: ladderConfig })}</span>}
          </form>
        )}
        {name !== null && <div className="meta">{t('名字设置以后不能改。')}</div>}
      </div>
      <div className="entry-actions">
        {active && <a className="pill live" href={href.challenge(active)}>{t('挑战中')} #{active}</a>}
        {active && !challenge.busy && <button type="button" className="btn btn-small" onClick={() => challenge.resume(active, entry.module, null).catch(() => {})}>{t('继续打')}</button>}
        {!active && <a className="btn btn-small" href={href.main('ladder')}>{t('去挑战')}</a>}
      </div>
    </div>
  );
}

/** The challenge that localStorage remembers from a closed page, when it still runs. */
function RememberedChallenge({ mine }) {
  const challenge = useChallenge();
  const id = challenge.remembered();
  const entry = mine.find(e => Number(e.activeChallenge) === id);
  if (!id || !entry || challenge.busy) return null;
  return (
    <div className="msg warn row">
      <span>{t('上次关掉页面时，{name} 的挑战 #{id} 还没打完。', { name: nameOf({}, entry.module), id })}</span>
      <button type="button" className="btn btn-small" onClick={() => challenge.resume(id, entry.module, null).catch(() => {})}>{t('继续打')}</button>
    </div>
  );
}
