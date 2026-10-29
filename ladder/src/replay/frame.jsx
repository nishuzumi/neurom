// replay/frame.jsx — the tank board: the replay view script of the template in its sandboxed frame
// (frontend/editor/renderers/script-frame.js, ADR 0013). The host posts `{ type: 'ctx', ctx }` to the frame, as the
// workbench renderer does. `ctx.state` is the scene state to draw. `ctx.live` makes the script animate from the state
// before (one step), else it jumps. The frame reports its content height, and the host sizes it.
import { useEffect, useMemo, useRef, useState } from 'react';
import vueSource from 'vue/dist/vue.global.prod.js?raw';
import { scriptDocument } from '../../../frontend/editor/renderers/script-frame.js';
import { t } from '../i18n.js';

/** The colours of the dark replay panel, as the variables of the workbench that the view script reads. */
export const DARK_VARS = {
  '--bg': '#111216',
  '--ink': '#e6e8ec',
  '--muted': '#8a8f98',
  '--line': '#2a2d35',
  '--line-strong': '#3a3e48',
  '--bad': '#f0684d',
  '--spike': '#f2bc4a',
  '--inh': '#7c8cff',
  '--brick': '#b4643c',
  '--water': '#3b6fb6',
};

/** The board. `source` is the view script, `ctx` the context to draw, `history` (optional) the states between the
 *  last ctx and this one for the animation. */
export function ScriptFrame({ source, ctx, className }) {
  const frame = useRef(null);
  const [ready, setReady] = useState(false);
  const [height, setHeight] = useState(240);
  const [error, setError] = useState(null);
  const doc = useMemo(() => scriptDocument(source, DARK_VARS, vueSource, 'dark').html, [source]);

  useEffect(() => {
    const onMessage = e => {
      if (e.source !== frame.current?.contentWindow || !e.data) return;
      switch (e.data.type) {
        case 'ready': setReady(true); break;
        case 'size': setHeight(Math.max(60, e.data.h)); break;
        case 'error': setError(e.data.message); break;
        case 'missing': setError(t('视图脚本既没有定义 component，也没有定义 render(ctx, el)')); break;
        default: break;
      }
    };
    addEventListener('message', onMessage);
    return () => removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    if (!ready || !ctx) return;
    frame.current?.contentWindow?.postMessage({ type: 'ctx', ctx }, '*');
  }, [ready, ctx]);

  return (
    <div className={className}>
      <iframe ref={frame} className="replay-frame" sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={doc} style={{ height: `${height}px` }} title={t('坦克棋盘')} />
      {error && <div className="replay-error">{error}</div>}
    </div>
  );
}
