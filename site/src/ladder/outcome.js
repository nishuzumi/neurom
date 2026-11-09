// ladder/outcome.js — the result of a challenge as the viewer sees it. The contract status says who won (2 the
// challenger, 3 the defender, 4 the defender by timeout); the wallet that owns the challenger entry reads it as
// 挑战成功/失败, the wallet that owns the defender entry as 守擂成功/失败, anyone else as 挑战者赢了/擂主赢了.
import { t } from '../i18n.js';
import { addressKey } from './format.js';
import { entryOf } from './use-ladder.js';

/** The side of `address` in the challenge `{ challenger, defender }` (module addresses), by the owners of the
 *  ladder `entries`: `'challenger'`, `'defender'` or `null` (a spectator, or not logged in). */
export function viewerSide(challenge, entries, address) {
  const me = addressKey(address);
  if (!me || !challenge) return null;
  const ownerOf = module => addressKey(entryOf(entries, module)?.owner);
  if (ownerOf(challenge.challenger) === me) return 'challenger';
  if (ownerOf(challenge.defender) === me) return 'defender';
  return null;
}

/** The text and the pill tone (`ok`, `bad`, `live` or `''`) of `status` for the viewer on `side`.
 *  `{ text, tone }`; `text` is null for an unknown status. */
export function outcomeOf(status, side) {
  switch (Number(status)) {
    case 1: return { text: t('进行中'), tone: 'live' };
    case 2:
      if (side === 'challenger') return { text: t('挑战成功'), tone: 'ok' };
      if (side === 'defender') return { text: t('守擂失败'), tone: 'bad' };
      return { text: t('挑战者赢了'), tone: 'ok' };
    case 3:
      if (side === 'challenger') return { text: t('挑战失败'), tone: 'bad' };
      if (side === 'defender') return { text: t('守擂成功'), tone: 'ok' };
      return { text: t('擂主赢了'), tone: '' };
    case 4:
      if (side === 'challenger') return { text: t('超时，挑战失败'), tone: 'bad' };
      if (side === 'defender') return { text: t('超时，守擂成功'), tone: 'ok' };
      return { text: t('超时，擂主赢了'), tone: 'bad' };
    default: return { text: null, tone: '' };
  }
}
