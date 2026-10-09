import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceClient, WorkspaceClientError, isTerminal } from './workspace-client.js';

const json = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body), json: async () => body });

test('protocol: token header, submit / get / cancel / artifacts paths, server errors surface with status', async () => {
  const seen = [];
  const fetch = async (url, init = {}) => {
    seen.push([init.method ?? 'GET', url, init.headers, init.body]);
    if (url.endsWith('/api/session')) return json(200, { token: 'tok', capabilities: { methods: ['reinforce'] } });
    if (url.endsWith('/api/runs') && init.method === 'POST') return JSON.parse(init.body).run.id === 'dup' ? json(409, { error: 'id exists with another bundleHash' }) : json(200, { run: { id: 'r1', status: 'queued' } });
    if (url.endsWith('/api/runs/r1')) return json(200, { id: 'r1', status: 'running', progress: { epoch: 1 } });
    if (url.endsWith('/api/artifacts')) return json(200, { run: { id: 'ext', status: 'completed' } });
    return json(404, { error: 'nope' });
  };
  const c = new WorkspaceClient('http://h', { fetch, EventSource: undefined });
  await assert.rejects(c.get('r1'), /先连接/);
  const session = await c.connect();
  assert.deepEqual(session.capabilities, { methods: ['reinforce'] });
  const run = await c.submit({ id: 'r1', bundle: { format: 'neurom-bundle' }, bundleHash: '0x' + '0'.repeat(64) });
  assert.equal(run.status, 'queued');
  assert.equal(seen[1][2]['X-Workspace-Token'], 'tok');
  assert.deepEqual(JSON.parse(seen[1][3]), { run: { id: 'r1', bundle: { format: 'neurom-bundle' }, bundleHash: '0x' + '0'.repeat(64) } });
  await c.submit({ id: 'r2', bundle: { format: 'neurom-bundle' }, bundleHash: '0x' + '0'.repeat(64), tables: { 'ds-1': { close: Float64Array.from([1, 2.5]) } } });
  assert.deepEqual(JSON.parse(seen.at(-1)[3]).run.tables, { 'ds-1': { close: [1, 2.5] } }, 'table columns go as JSON number arrays');
  await c.submit({ id: 'r3', bundle: { format: 'neurom-bundle' }, bundleHash: '0x' + '0'.repeat(64), tables: {} });
  assert.equal('tables' in JSON.parse(seen.at(-1)[3]).run, false, 'a bundle reading no table sends none');
  await assert.rejects(c.submit({ id: 'dup', bundle: {}, bundleHash: '0x' }), e => e instanceof WorkspaceClientError && e.status === 409 && /another bundleHash/.test(e.message));
  assert.equal((await c.get('r1')).progress.epoch, 1);
  await c.postArtifact({ bundleHash: '0x', bundle: {}, model: {}, evaluation: {}, provenance: {} });
  assert.equal(seen.at(-1)[1], 'http://h/api/artifacts');
  await assert.rejects(c.get('missing'), /nope/);
  assert.equal(isTerminal({ status: 'completed' }), true); assert.equal(isTerminal({ status: 'running' }), false);
});

test('follow: SSE snapshots drive updates until terminal; a broken stream falls back to polling; stop() resolves null', async () => {
  const states = [{ id: 'r1', status: 'running', progress: { epoch: 1 } }, { id: 'r1', status: 'completed', result: { model: {} } }];
  let gets = 0;
  const fetch = async url => (url.endsWith('/api/session') ? json(200, {}) : json(200, states[Math.min(gets++, 1)]));
  let instance = null;
  class ES { constructor(url) { this.url = url; instance = this; } close() { this.closed = true; } }
  const c = new WorkspaceClient('', { fetch, EventSource: ES });
  await c.connect();
  const seen = [];
  const h = c.follow('r1', run => seen.push(run.status), { interval: 5 });
  assert.match(instance.url, /\/api\/runs\/r1\/events$/, 'no token → no query');
  instance.onmessage({ data: JSON.stringify({ id: 'other', status: 'running' }) });
  instance.onmessage({ data: JSON.stringify(states[1]) });
  const final = await h.promise;
  assert.equal(final.status, 'completed');
  assert.equal(instance.closed, true);
  assert.ok(seen.includes('completed'));

  // stream error → polling
  gets = 0;
  const c2 = new WorkspaceClient('', { fetch, EventSource: ES });
  await c2.connect();
  const h2 = c2.follow('r1', () => {}, { interval: 5 });
  instance.onerror();
  assert.equal((await h2.promise).status, 'completed');
  assert.ok(gets >= 2, 'polled to the terminal state');

  const c3 = new WorkspaceClient('', { fetch: async url => (url.endsWith('/api/session') ? json(200, {}) : json(200, states[0])), EventSource: undefined });
  await c3.connect();
  const h3 = c3.follow('r1', () => {}, { interval: 5 });
  h3.stop();
  assert.equal(await h3.promise, null);
});
