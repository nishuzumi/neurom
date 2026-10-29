// replay/ReplayPlayer.jsx — the replay of one challenge: the dark panel with the board, segmented tabs for the 6
// episodes (HashSmash style), a step slider and play / pause. The states come from scene.js, the drawing from the
// view script of the template in frame.jsx. `replay` is `client.replay(id)`; `names` the name map; `autoplay` runs
// through all episodes without controls (the hero panel).
import { useEffect, useMemo, useRef, useState } from 'react';
import { ScriptFrame } from './frame.jsx';
import { episodeStates, tankScene } from './scene.js';
import { t } from '../i18n.js';
import { nameOf } from '../ladder/format.js';

const STEP_MS = 350;
const EPISODE_PAUSE_MS = 1200;

/** The end of an episode as text, from the side of the challenger. */
export function episodeResult(ep, challengerSide) {
  if (ep.end === 2) return t('平局');
  if (ep.end < 0) return t('未打完');
  return ep.end === challengerSide ? t('挑战者赢') : t('擂主赢');
}

export function ReplayPlayer({ replay, challenger, defender, names, autoplay = false, compact = false }) {
  const scene = useMemo(() => tankScene(), []);
  const episodes = replay?.episodes ?? [];
  const [episode, setEpisode] = useState(0);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(autoplay);
  const [live, setLive] = useState(false);
  const states = useMemo(() => (episodes[episode] ? episodeStates(scene, episodes[episode]) : []), [scene, episodes, episode]);
  const last = Math.max(0, states.length - 1);
  const timer = useRef(0);

  // the player: one step per STEP_MS, then the next episode (autoplay loops)
  useEffect(() => {
    if (!playing) return undefined;
    timer.current = setTimeout(() => {
      if (step < last) { setLive(true); setStep(step + 1); return; }
      if (autoplay || episode < episodes.length - 1) {
        setLive(false);
        setStep(0);
        setEpisode(e => (e + 1) % Math.max(1, episodes.length));
      } else setPlaying(false);
    }, step < last ? STEP_MS : EPISODE_PAUSE_MS);
    return () => clearTimeout(timer.current);
  }, [playing, step, last, episode, episodes.length, autoplay]);

  // a new replay: start again
  useEffect(() => { setEpisode(0); setStep(0); setLive(false); setPlaying(autoplay); }, [replay, autoplay]);

  const state = states[Math.min(step, last)] ?? null;
  const ctx = useMemo(() => (state ? { state, live, history: [] } : null), [state, live]);
  const ep = episodes[episode];
  const challengerSide = ep ? (ep.side0?.toLowerCase() === challenger?.toLowerCase() ? 0 : 1) : 0;
  const sideName = k => nameOf(names, ep?.[k ? 'side1' : 'side0']);
  const jump = (e, s) => { clearTimeout(timer.current); setLive(false); setEpisode(e); setStep(s); };

  if (!replay) return <div className="replay-panel replay-empty">{t('还没有挑战可以回放')}</div>;
  return (
    <div className={`replay-panel${compact ? ' replay-compact' : ''}`}>
      {!compact && (
        <div className="replay-tabs" role="tablist">
          {episodes.map((e, i) => (
            <button key={i} type="button" role="tab" aria-selected={i === episode} className={`seg${i === episode ? ' on' : ''}`} onClick={() => jump(i, 0)}>
              <span className="seg-n">{t('第 {n} 局', { n: i + 1 })}</span>
              <span className="seg-r">{episodeResult(e, e.side0?.toLowerCase() === challenger?.toLowerCase() ? 0 : 1)}</span>
            </button>
          ))}
        </div>
      )}
      <div className="replay-sides mono">
        <span className="side side0">■ {sideName(0)}{challengerSide === 0 ? ` · ${t('挑战者')}` : ` · ${t('擂主')}`}</span>
        <span className="side side1">■ {sideName(1)}{challengerSide === 1 ? ` · ${t('挑战者')}` : ` · ${t('擂主')}`}</span>
        <span className="side-ep">{t('第 {n} 局', { n: episode + 1 })} · {t('第 {t} 步', { t: Math.min(step, last) })} / {last}</span>
      </div>
      <ScriptFrame source={scene.viewScript} ctx={ctx} className="replay-board" />
      {!compact && (
        <div className="replay-controls">
          <button type="button" className="btn btn-dark" onClick={() => { if (playing) setPlaying(false); else { if (step >= last) jump(episode, 0); setPlaying(true); } }}>{playing ? t('暂停') : t('播放')}</button>
          <button type="button" className="btn btn-dark" onClick={() => jump(episode, Math.max(0, step - 1))} disabled={step === 0}>{t('上一步')}</button>
          <button type="button" className="btn btn-dark" onClick={() => jump(episode, Math.min(last, step + 1))} disabled={step >= last}>{t('下一步')}</button>
          <input type="range" min={0} max={last} value={Math.min(step, last)} onChange={e => jump(episode, Number(e.target.value))} aria-label={t('步数')} />
          <span className="mono muted">{ep ? t('种子 {seed}', { seed: ep.seed }) : ''}</span>
        </div>
      )}
      {!compact && <div className="replay-note muted">{t('棋盘里的“我方”是第 0 方，“机器人”是第 1 方。颜色和上面的两方一致。')}</div>}
    </div>
  );
}
