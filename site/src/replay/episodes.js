// replay/episodes.js — the facts of one episode of a replay that the player and the challenge view both show.
import { t } from '../i18n.js';
import { addressKey } from '../ladder/format.js';

/** The end of an episode as text, from the side of the challenger. */
export function episodeResult(ep, challengerSide) {
  if (ep.end === 2) return t('平局');
  if (ep.end < 0) return t('未打完');
  return ep.end === challengerSide ? t('挑战者赢') : t('擂主赢');
}

/** The side (0 or 1) of the challenger `challenger` in episode `ep`. */
export const challengerSideOf = (ep, challenger) => (addressKey(ep.side0) === addressKey(challenger) ? 0 : 1);
