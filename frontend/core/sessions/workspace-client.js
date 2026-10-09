// core/sessions/workspace-client.js — same-origin client for training/workspace.py:
//   GET  /api/session                 → { token, capabilities:{methods, engines} }
//   POST /api/runs {run:{id,bundle,bundleHash[,tables]}} → { run }   (409: id exists with another bundleHash)
//   GET  /api/runs → { runs } · GET /api/runs/:id → run · DELETE /api/runs/:id · GET /api/runs/:id/events (SSE run
//   snapshots, polling fallback)
//   POST /api/artifacts {bundleHash,bundle,model,evaluation,provenance}
// Run snapshot: { id, status:'queued'|'running'|'completed'|'failed'|'cancelled', progress, error?, result?, bundleHash }.
// `fetch` / `EventSource` are injectable so the client is testable without a server.
import { t } from '../../i18n.js';

const TERMINAL = Object.freeze(['completed', 'failed', 'cancelled']);
const POLL_INTERVAL = 1500;                                         // ms between GET /api/runs/:id when SSE is unavailable
export const isTerminal = run => TERMINAL.includes(run?.status);

export class WorkspaceClientError extends Error {
  constructor(message, status = 0) { super(message); this.name = 'WorkspaceClientError'; this.status = status; }
}

export class WorkspaceClient {
  constructor(base = '', { fetch: fetchImpl = globalThis.fetch?.bind(globalThis), EventSource: ES = globalThis.EventSource } = {}) {
    this.base = base; this.session = null; this.capabilities = null; this._fetch = fetchImpl; this._ES = ES; this.connected = false;
  }
  async connect() {
    const r = await this._fetch(`${this.base}/api/session`, { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new WorkspaceClientError(t('Workspace 会话不可用（HTTP {status}）', { status: r.status }), r.status);
    const j = await r.json();
    this.session = j.token ?? null; this.capabilities = j.capabilities ?? null; this.connected = true;
    return j;
  }
  headers(json = true) {
    const h = { Accept: 'application/json' };
    if (this.session) h['X-Workspace-Token'] = this.session;
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }
  async request(method, path, body) {
    if (!this.connected) throw new WorkspaceClientError(t('先连接 Workspace'));
    const r = await this._fetch(`${this.base}${path}`, { method, headers: this.headers(body !== undefined), body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let j = null; try { j = text ? JSON.parse(text) : null; } catch { j = null; }
    if (!r.ok) throw new WorkspaceClientError(j?.error || `HTTP ${r.status}${text ? t('：') + text.slice(0, 200) : ''}`, r.status);
    return j;
  }
  /** Submit a run. The server rejects a reused id with a different bundle (409). `tables` = the rows the bundle's env
   *  names (`{ datasetId: { column: Float64Array | number[] } }`, a pin's tables) travel as JSON number arrays. */
  submit({ id, bundle, bundleHash, tables = {} }) {
    const run = { id, bundle, bundleHash };
    if (Object.keys(tables).length) run.tables = Object.fromEntries(Object.entries(tables).map(([tid, cols]) => [tid, Object.fromEntries(Object.entries(cols).map(([c, v]) => [c, Array.from(v)]))]));
    return this.request('POST', '/api/runs', { run }).then(j => j.run);
  }
  list() { return this.request('GET', '/api/runs').then(j => j.runs ?? []); }
  get(id) { return this.request('GET', `/api/runs/${encodeURIComponent(id)}`); }
  cancel(id) { return this.request('DELETE', `/api/runs/${encodeURIComponent(id)}`); }
  /** Store an externally produced result as a completed run. */
  postArtifact({ bundleHash, bundle, model, evaluation, provenance }) { return this.request('POST', '/api/artifacts', { bundleHash, bundle, model, evaluation, provenance }); }

  /**
   * Follow a run to a terminal state: `onUpdate(run)` per snapshot. Returns `{ promise, stop }`. SSE when available,
   * otherwise polling every `interval` ms. `stop()` resolves the promise with null.
   */
  follow(id, onUpdate, { interval = POLL_INTERVAL } = {}) {
    let stopped = false, es = null, timer = null, finish, fail;
    const promise = new Promise((resolve, reject) => {
      const teardown = () => { stopped = true; if (es) es.close(); es = null; clearTimeout(timer); timer = null; };
      finish = run => { if (stopped) return; teardown(); resolve(run); };
      fail = e => { if (stopped) return; teardown(); reject(e); };
      const deliver = run => { if (stopped || !run || run.id !== id) return false; try { onUpdate(run); } catch (e) { fail(e); return true; } if (isTerminal(run)) finish(run); return true; };
      const poll = async () => {
        if (stopped) return;
        try { const run = await this.get(id); if (stopped) return; deliver(run); if (!stopped) timer = setTimeout(poll, interval); }
        catch (e) { fail(e); }
      };
      if (typeof this._ES === 'function') {
        try {
          const token = this.session ? `?token=${encodeURIComponent(this.session)}` : '';
          es = new this._ES(`${this.base}/api/runs/${encodeURIComponent(id)}/events${token}`);
          es.onmessage = ev => { let run = null; try { run = JSON.parse(ev.data); } catch { run = null; } if (!deliver(run) && !stopped && !timer) poll(); };
          es.onerror = () => { if (stopped) return; if (es) es.close(); es = null; if (!timer) poll(); };
          poll();                                                            // first snapshot right away
        } catch { poll(); }
      } else poll();
    });
    return { promise, stop() { finish?.(null); } };
  }
}
