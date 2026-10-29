// components/Rules.jsx — [3] the rules in 4 columns as OKC's "How Kernels Are Judged": a small diagram over a
// paragraph. Mirror pair, 6 episodes, the tie on weight size and δ, the rank insertion. Every number comes from the
// contract configuration. The footnote states the known limits.
import { t } from '../i18n.js';
import { useLadder } from '../ladder/use-ladder.jsx';
import { formatInt } from '../ladder/format.js';

const INK = 'rgb(24, 24, 27)', ACCENT = 'oklch(0.511 0.262 276.966)', LINE = 'rgb(209, 213, 219)', MUTED = 'rgb(113, 113, 122)', RED = '#f0684d';

export function Rules() {
  const { config } = useLadder();
  const delta = config ? Number(config.deltaBps) / 100 : null;
  const range = config?.range ?? null;
  const v = x => (x === null || x === undefined ? '…' : x);
  return (
    <>
      <div className="section-head"><div><span className="label">{t('规则')} / 03</span><h2>{t('怎样判胜')}</h2></div></div>
      <div className="rules">
        <div className="rule">
          <MirrorPair />
          <h3>{t('镜像对')}</h3>
          <p>{t('两局用同一个种子，两方交换阵营。地图转 180° 不变，所以一个照抄动作的副本在一个镜像对里赢不了原版。')}</p>
        </div>
        <div className="rule">
          <SixEpisodes />
          <h3>{t('6 局判胜')}</h3>
          <p>{t('一场挑战是 3 个镜像对，共 6 局。挑战者赢的局数多于擂主，挑战成功。一局打满 100 步时，命多的一方赢。')}</p>
        </div>
        <div className="rule">
          <TieDelta delta={delta} />
          <h3>{t('平局看权重字节数')}</h3>
          <p>{t('两方赢的局数相等时，挑战者的权重字节数不大于擂主的 (1 − δ) 倍才算赢。δ = {delta}%。其他情况都是守擂成功。', { delta: v(delta) })}</p>
        </div>
        <div className="rule">
          <Insertion range={range} />
          <h3>{t('名次插入')}</h3>
          <p>{t('只能挑战比自己高 1 到 {range} 名的擂主。挑战成功时，挑战者占擂主的名次，擂主和中间的出战模型各降 1 名。', { range: v(range) })}</p>
        </div>
      </div>
      <ul className="config-list">
        <li><span>{t('权重字节数上限')}</span><span className="v">{config ? formatInt(config.maxWeightBytes) : '…'}</span></li>
        <li><span>δ</span><span className="v">{config ? `${delta}%` : '…'}</span></li>
        <li><span>{t('挑战范围')}</span><span className="v">{config ? t('高 1 到 {range} 名', { range }) : '…'}</span></li>
        <li><span>{t('超时')}</span><span className="v">{config ? t('{n} 块', { n: formatInt(config.timeoutBlocks) }) : '…'}</span></li>
        <li><span>{t('冷却')}</span><span className="v">{config ? t('{n} 块', { n: formatInt(config.cooldownBlocks) }) : '…'}</span></li>
        <li><span>{t('发起交易的最低 gas')}</span><span className="v">{config ? formatInt(config.minStartGas) : '…'}</span></li>
        <li><span>{t('每笔交易的预留 gas')}</span><span className="v">{config ? formatInt(config.reserveGas) : '…'}</span></li>
        <li><span>{t('赛季结束块')}</span><span className="v">{config ? formatInt(config.endBlock) : '…'}</span></li>
      </ul>
      <div className="footnote">
        <span>{t('种子来自第一笔交易所在块的 PREVRANDAO 和挑战编号。只有没有代码的普通账号能发起挑战，发起交易的 gas limit 不能低于门槛，所以挑战者不能先看种子再决定打不打。')}</span>
        <span>{t('已知的限制：打乱权重块顺序的副本权重不同，可以注册，并且可以排到原版的下一名。它在镜像对里赢不了原版。')}</span>
        <span>{t('已知的限制：前提是挑战者控制不了验证者，也收买不了验证者。出块的验证者能提前知道自己那一块的 PREVRANDAO。')}</span>
        <span>{t('任何人都能用种子、事件里的动作和模板的场景复现一场挑战的每一步。回放就是这样算出来的。')}</span>
      </div>
    </>
  );
}

/** Two small boards: the same map, the two colours swap sides. */
function MirrorPair() {
  const board = (x, top, bottom) => (
    <g transform={`translate(${x} 0)`}>
      <rect x="0" y="0" width="60" height="60" fill="#fff" stroke={LINE} />
      {[[20, 20], [40, 20], [20, 40], [40, 40]].map(([a, b]) => <rect key={`${a}${b}`} x={a - 4} y={b - 4} width="8" height="8" fill={LINE} />)}
      <rect x="26" y="4" width="8" height="8" fill={top} />
      <rect x="26" y="48" width="8" height="8" fill={bottom} />
    </g>
  );
  return (
    <svg viewBox="0 0 160 70" role="img" aria-label={t('镜像对')}>
      {board(4, RED, ACCENT)}
      <path d="M70 32 h20 m-5 -5 l5 5 l-5 5" stroke={MUTED} fill="none" strokeWidth="1.5" />
      {board(96, ACCENT, RED)}
      <text x="80" y="68" fontSize="7" fontFamily="monospace" textAnchor="middle" fill={MUTED}>seed i</text>
    </svg>
  );
}

/** Six cells: a few in the accent (the challenger won), one grey (draw), the rest in ink. */
function SixEpisodes() {
  const cells = [ACCENT, INK, ACCENT, ACCENT, LINE, INK];
  return (
    <svg viewBox="0 0 160 70" role="img" aria-label={t('6 局判胜')}>
      {cells.map((c, i) => <rect key={i} x={6 + i * 25} y="12" width="20" height="26" rx="1" fill={c} />)}
      {[0, 1, 2].map(i => <rect key={i} x={5 + i * 50} y="8" width="46" height="34" fill="none" stroke={LINE} strokeDasharray="2 2" />)}
      <text x="8" y="60" fontSize="8" fontFamily="monospace" fill={ACCENT}>3</text>
      <text x="16" y="60" fontSize="8" fontFamily="monospace" fill={MUTED}>&gt;</text>
      <text x="24" y="60" fontSize="8" fontFamily="monospace" fill={INK}>2</text>
      <text x="60" y="60" fontSize="7" fontFamily="monospace" fill={MUTED}>→ {t('挑战成功')}</text>
    </svg>
  );
}

/** Two bars: the defender's weight size, and the challenger's that has to stay under (1 − δ) of it. */
function TieDelta({ delta }) {
  const d = delta === null ? 10 : delta;
  const limit = 140 * (1 - d / 100);
  return (
    <svg viewBox="0 0 160 70" role="img" aria-label={t('平局看权重字节数')}>
      <text x="6" y="14" fontSize="7" fontFamily="monospace" fill={MUTED}>{t('擂主')}</text>
      <rect x="6" y="18" width="140" height="8" fill={INK} />
      <text x="6" y="42" fontSize="7" fontFamily="monospace" fill={MUTED}>{t('挑战者')}</text>
      <rect x="6" y="46" width={limit - 12} height="8" fill={ACCENT} />
      <line x1={6 + limit} y1="16" x2={6 + limit} y2="58" stroke={RED} strokeDasharray="2 2" />
      <text x={6 + limit - 2} y="66" fontSize="7" fontFamily="monospace" textAnchor="end" fill={RED}>(1 − δ) · {t('擂主')}</text>
    </svg>
  );
}

/** A ladder of ranks: the challenger jumps to the defender's rank, the ones between move down. */
function Insertion({ range }) {
  const rows = [1, 2, 3, 4, 5];
  return (
    <svg viewBox="0 0 160 70" role="img" aria-label={t('名次插入')}>
      {rows.map((r, i) => (
        <g key={r} transform={`translate(0 ${4 + i * 13})`}>
          <text x="6" y="9" fontSize="7" fontFamily="monospace" fill={MUTED}>{String(r).padStart(2, '0')}</text>
          <rect x="22" y="2" width="56" height="8" fill={i === 1 ? INK : i === 4 ? ACCENT : LINE} />
        </g>
      ))}
      <path d="M84 62 C 110 62, 110 24, 84 24" stroke={ACCENT} fill="none" strokeWidth="1.5" />
      <path d="M88 20 l-4 4 l4 4" stroke={ACCENT} fill="none" strokeWidth="1.5" />
      <path d="M120 24 v26 m-3 -4 l3 4 l3 -4" stroke={MUTED} fill="none" strokeWidth="1.2" />
      <text x="126" y="40" fontSize="7" fontFamily="monospace" fill={MUTED}>+1</text>
      <text x="126" y="14" fontSize="7" fontFamily="monospace" fill={MUTED}>≤ {range ?? '…'}</text>
    </svg>
  );
}
