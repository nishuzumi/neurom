// ladder/format.js — the text forms of the numbers and addresses of the page.
import { formatEther } from 'ethers';
import { t } from '../i18n.js';

/** `0x1234…abcd`. */
export const shortAddress = a => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
/** The lower-case address, the key of the name map. */
export const addressKey = a => String(a ?? '').toLowerCase();
/** The display name of a module: its name, else its short address. */
export const nameOf = (names, module) => names?.[addressKey(module)] ?? shortAddress(module);
/** `01`, `02`… as OKC prints ranks. Rank 0 (off the board) is `—`. */
export const rankLabel = rank => (Number(rank) > 0 ? String(rank).padStart(2, '0') : '—');
/** `#01`… in a sentence. Rank 0 is 榜外. */
export const rankTag = rank => (Number(rank) > 0 ? `#${rankLabel(rank)}` : t('榜外'));
/** `216,864`. */
export const formatInt = n => Number(n).toLocaleString('en-US');
/** `12.3M`, `420k` or the integer. */
export function formatGas(n) {
  const v = Number(n);
  if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e8 ? 0 : 1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)}k`;
  return String(v);
}
/** `12.34 MON` from wei. */
export function formatMon(wei, digits = 2) {
  if (wei === null || wei === undefined) return '—';
  const v = Number(formatEther(wei));
  const places = v !== 0 && v < 1 ? digits + 2 : digits;
  return `${v.toLocaleString('en-US', { maximumFractionDigits: places, minimumFractionDigits: Math.min(places, 2) })} MON`;
}
/** `3 : 2`. */
export const score = (a, b) => `${a} : ${b}`;
/** The local time of a unix timestamp (seconds), or `—`. */
export const formatTime = ts => (ts ? new Date(ts * 1000).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '—');
