// ui/wallet.js — the wallet corner of the header (index.html `#wallet`) over the shared Privy controller
// (wallet/privy.js). It shows the login button, the address of the embedded wallet, the logout button and the last
// error of the controller in words. The workbench mounts the controller and owns the sessions. This module only
// renders the snapshot of the controller and forwards the two clicks. Without a controller (no Privy App, or a page
// that Privy cannot serve), it shows the reason or stays hidden.
import { onLocaleChange, t } from '../i18n.js';
import { describeChainError } from '../chain-error.js';

const short = address => `${address.slice(0, 6)}…${address.slice(-4)}`;

/**
 * Render into the header elements `{ root, login, logout, address, error }`.
 * `privy` is the controller, or null. `problem()` gives the translated reason when there is no controller, else null
 * (the corner stays hidden).
 * Returns the function that stops rendering.
 */
export function mountWalletHeader(privy, { root, login, logout, address, error }, problem = () => null) {
  let snap = privy ? privy.snapshot() : null;
  /** the error of the last click, until the next snapshot */
  let clicked = null;
  function render() {
    const why = privy ? null : problem();
    root.hidden = !privy && !why;
    if (!privy) {
      login.hidden = false; login.disabled = true; login.title = why ?? '';
      logout.hidden = true; address.hidden = true; address.textContent = '';
      error.hidden = !why; error.textContent = why ?? ''; error.title = why ?? '';
      return;
    }
    login.hidden = snap.authenticated; login.disabled = !snap.ready;
    login.title = snap.ready ? t('用 Privy 登录。部署模块用登录后的嵌入式钱包签名。') : t('钱包正在初始化…');
    logout.hidden = !snap.authenticated; logout.title = t('退出登录。链上会话作废。训练不受影响。');
    address.hidden = !snap.address; address.textContent = snap.address ? short(snap.address) : ''; address.title = snap.address ?? '';
    const text = describeChainError(clicked ?? snap.error);
    error.hidden = !text; error.textContent = text ? t('钱包错误：{error}', { error: text }) : ''; error.title = error.textContent;
  }
  const offLocale = onLocaleChange(render);
  if (!privy) { render(); return offLocale; }
  const act = fn => { clicked = null; Promise.resolve().then(fn).catch(e => { clicked = e; render(); }); };
  login.onclick = () => act(() => privy.login());
  logout.onclick = () => act(() => privy.logout());
  const unsubscribe = privy.subscribe(next => { snap = next; clicked = null; render(); });
  return () => { unsubscribe(); offLocale(); login.onclick = null; logout.onclick = null; };
}
