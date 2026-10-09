"""workspace.py: the bundle HTTP protocol end to end against a real child trainer, plus the isolation
guarantees (token, Host/Origin, static root) and restart handling."""
import http.client
import json
import tempfile
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

from bundle_train import write_json
from workspace import Handler, Workspace

FIXTURES = Path(__file__).resolve().parent / 'fixtures'
BUNDLES = json.loads((FIXTURES / 'bundles.json').read_text())
HASH_A, HASH_B = '0x' + 'a' * 64, '0x' + 'b' * 64


def bundle(name, **recipe):
    b = json.loads(json.dumps(BUNDLES[name]))
    b['recipe'].update(recipe)
    return b


def window_table_bundle(**recipe):
    """The cross-entropy counter bundle over the window-table env of bundle-env.json (its scenario and target read the
    `ds-prices` table) → (bundle, the table's rows)."""
    env = next(e for e in json.loads((FIXTURES / 'bundle-env.json').read_text())['envs'] if e['name'] == 'window-table')
    b = bundle('crossEntropy', **recipe)
    b['env'], b['objective'], b['loop']['I'] = env['env'], env['objective'], 5
    b['loop']['nodes'][b['loop']['trained']]['structure']['inputs'] = 5
    b['partitions'] = {'training': {'kind': 'window', 'first': 0, 'rows': 20, 'length': 10, 'stride': 5, 'embargo': 0, 'range': [0, 1]}}
    return b, env['tables']


class WorkspaceServer(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.frontend = self.root / 'frontend'
        self.frontend.mkdir()
        (self.frontend / 'index.html').write_text('<h1>Workspace</h1>')
        self.workspace = Workspace(self.root / 'ws', 1)

        class Bound(Handler):
            def log_message(self, *_): pass

        Bound.ws = self.workspace
        Bound.token = 'local-test-token'
        Bound.frontend = self.frontend.resolve()
        Bound.public_host = '127.0.0.1'
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Bound)
        Bound.port = self.server.server_port
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.workspace.shutdown()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.tmp.cleanup()

    def request(self, method, path, body=None, headers=None, token='local-test-token'):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=10)
        try:
            conn.request(method, path, None if body is None else json.dumps(body),
                         {'Content-Type': 'application/json', 'X-Workspace-Token': token, **(headers or {})})
            response = conn.getresponse()
            return response.status, response.read()
        finally:
            conn.close()

    def wait_terminal(self, run_id, timeout=60):
        deadline = time.time() + timeout
        while time.time() < deadline:
            status, body = self.request('GET', f'/api/runs/{run_id}')
            run = json.loads(body)
            if run['status'] in ('completed', 'failed', 'cancelled'): return run
            time.sleep(0.2)
        self.fail(f'run {run_id} did not finish: {run}')

    # ---- protocol
    def test_session_advertises_capabilities_and_a_run_trains_to_completion(self):
        status, body = self.request('GET', '/api/session')
        self.assertEqual(status, 200)
        session = json.loads(body)
        self.assertEqual(session['token'], 'local-test-token')
        self.assertEqual(sorted(session['capabilities']['methods']), ['cross-entropy', 'hinge', 'reinforce'])
        self.assertIn('dense-policy', session['capabilities']['engines'])

        b = bundle('crossEntropy', epochs=4, evalEvery=2, replicas=1, episodesPerEpoch=8)
        status, body = self.request('POST', '/api/runs', {'run': {'id': 'run-ce-1', 'bundle': b, 'bundleHash': HASH_A}})
        self.assertEqual(status, 201, body)
        run = json.loads(body)['run']
        self.assertEqual((run['id'], run['bundleHash']), ('run-ce-1', HASH_A)); self.assertIn(run['status'], ('queued', 'running'))
        done = self.wait_terminal('run-ce-1')
        self.assertEqual(done['status'], 'completed', done)
        self.assertEqual(done['result']['model']['format'], 'dense-policy')
        self.assertEqual(done['result']['provenance']['bundleHash'], HASH_A)
        self.assertEqual(done['result']['evaluation']['selectedEpoch'] <= 4, True)
        self.assertEqual(done['progress']['epoch'], 4)
        # listing omits the result payload but flags it
        _, body = self.request('GET', '/api/runs')
        listed = json.loads(body)['runs']
        self.assertEqual([r['id'] for r in listed], ['run-ce-1']); self.assertTrue(listed[0]['hasResult']); self.assertNotIn('result', listed[0])
        # SSE replays the terminal snapshot immediately
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=10)
        conn.request('GET', '/api/runs/run-ce-1/events', headers={'X-Workspace-Token': 'local-test-token'})
        resp = conn.getresponse()
        self.assertEqual(resp.getheader('Content-Type'), 'text/event-stream')
        text = resp.read().decode(); conn.close()
        self.assertTrue(text.startswith('event: complete\ndata: '))
        self.assertEqual(json.loads(text.split('data: ', 1)[1].split('\n\n')[0])['status'], 'completed')

    def test_same_id_with_a_different_hash_is_a_conflict_and_same_hash_is_idempotent(self):
        b = bundle('hinge', epochs=2, evalEvery=2, replicas=1)
        status, body = self.request('POST', '/api/runs', {'run': {'id': 'run-h', 'bundle': b, 'bundleHash': HASH_A}})
        self.assertEqual(status, 201, body)
        status, body = self.request('POST', '/api/runs', {'run': {'id': 'run-h', 'bundle': b, 'bundleHash': HASH_B}})
        self.assertEqual(status, 409, body)
        status, body = self.request('POST', '/api/runs', {'run': {'id': 'run-h', 'bundle': b, 'bundleHash': HASH_A}})
        self.assertEqual(status, 201, body); self.assertEqual(json.loads(body)['run']['id'], 'run-h')
        self.assertEqual(len(json.loads(self.request('GET', '/api/runs')[1])['runs']), 1)
        self.wait_terminal('run-h')

    def test_invalid_bundles_are_refused_before_anything_is_queued(self):
        b = bundle('reinforce'); net = b['loop']['nodes'][b['loop']['trained']]['structure']; net['engine'] = 'threshold-layers'; net['layers'] = [4]
        status, body = self.request('POST', '/api/runs', {'run': {'id': 'bad-engine', 'bundle': b, 'bundleHash': HASH_A}})
        self.assertEqual(status, 400, body); self.assertIn(b'engine', body)
        b = bundle('reinforce'); del b['env']['programs']['step']
        status, body = self.request('POST', '/api/runs', {'run': {'id': 'bad-env', 'bundle': b, 'bundleHash': HASH_A}})
        self.assertEqual(status, 400, body); self.assertIn(b'step', body)
        status, body = self.request('POST', '/api/runs', {'run': {'id': 'bad id!', 'bundle': bundle('reinforce'), 'bundleHash': HASH_A}})
        self.assertEqual(status, 400, body)
        status, body = self.request('POST', '/api/runs', {'run': {'id': 'bad-hash', 'bundle': bundle('reinforce'), 'bundleHash': 'abc'}})
        self.assertEqual(status, 400, body)
        for i, env in enumerate(([], 'env', dict(bundle('reinforce')['env'], tables='x'), dict(bundle('reinforce')['env'], tables=['x']))):
            status, body = self.request('POST', '/api/runs', {'run': {'id': f'bad-shape-{i}', 'bundle': dict(bundle('reinforce'), env=env), 'bundleHash': HASH_A}})
            self.assertEqual(status, 400, body)
        self.assertEqual(json.loads(self.request('GET', '/api/runs')[1])['runs'], [])
        self.assertEqual(list((self.root / 'ws' / 'runs').iterdir()), [])

    def test_a_bundle_reading_a_dataset_needs_its_rows_which_stay_with_the_run(self):
        b, tables = window_table_bundle(epochs=1, evalEvery=1, replicas=1)
        status, body = self.request('POST', '/api/runs', {'run': {'id': 'run-t', 'bundle': b, 'bundleHash': HASH_A}})
        self.assertEqual(status, 400, body); self.assertIn(b'ds-prices', body)
        self.assertEqual(list((self.root / 'ws' / 'runs').iterdir()), [])
        status, body = self.request('POST', '/api/runs', {'run': {'id': 'run-t', 'bundle': b, 'bundleHash': HASH_A, 'tables': tables}})
        self.assertEqual(status, 201, body)
        self.assertEqual(json.loads((self.root / 'ws' / 'runs' / 'run-t' / 'tables.json').read_text()), tables)
        run = self.wait_terminal('run-t')
        self.assertEqual(run['status'], 'completed', run)
        restarted = Workspace(self.root / 'ws', 1)                       # a restart reads the run back with its rows
        try: self.assertEqual(restarted.get('run-t')['status'], 'completed')
        finally: restarted.shutdown()

    def test_cancelling_a_running_job_kills_the_child_and_publishes_nothing(self):
        b = bundle('reinforce', epochs=100000, evalEvery=100000, replicas=1, episodesPerEpoch=8)
        status, body = self.request('POST', '/api/runs', {'run': {'id': 'long', 'bundle': b, 'bundleHash': HASH_A}})
        self.assertEqual(status, 201, body)
        deadline = time.time() + 30
        while time.time() < deadline:
            run = json.loads(self.request('GET', '/api/runs/long')[1])
            if run['status'] == 'running' and run.get('progress'): break
            time.sleep(0.1)
        self.assertEqual(run['status'], 'running', run)
        proc = self.workspace.runs['long'].proc
        status, body = self.request('DELETE', '/api/runs/long')
        self.assertEqual(status, 200, body)
        self.assertEqual(json.loads(body)['status'], 'cancelled')
        self.assertIsNotNone(proc.wait(timeout=10))
        time.sleep(0.3)
        run = json.loads(self.request('GET', '/api/runs/long')[1])
        self.assertEqual(run['status'], 'cancelled'); self.assertNotIn('result', run)
        self.assertFalse((self.root / 'ws' / 'runs' / 'long' / 'result.json').exists())
        # a queued run behind it starts once the slot frees
        status, body = self.request('POST', '/api/runs', {'run': {'id': 'next', 'bundle': bundle('hinge', epochs=1, replicas=1), 'bundleHash': HASH_B}})
        self.assertEqual(status, 201, body)
        self.assertEqual(self.wait_terminal('next')['status'], 'completed')

    def test_external_results_are_validated_and_stored_as_completed_runs(self):
        b = bundle('hinge', epochs=1, replicas=1)
        model = {'format': 'threshold-layers', 'inputs': 4, 'outputs': 3, 'weightBits': 8, 'layers': [{'W': [[1] * 4] * 8, 'th': [1] * 8, 'scale': 1.0, 'k': 0}, {'W': [[1] * 8] * 3, 'th': [2] * 3, 'scale': 1.0, 'k': 0}]}
        status, body = self.request('POST', '/api/artifacts', {'bundleHash': HASH_A, 'bundle': b, 'model': model, 'evaluation': {'metric': 0.5}, 'provenance': {'backend': 'browser'}})
        self.assertEqual(status, 201, body)
        run = json.loads(body)['run']
        self.assertEqual((run['status'], run['source'], run['bundleHash']), ('completed', 'imported', HASH_A))
        self.assertEqual(run['result']['provenance']['imported'], True)
        bad = dict(model, layers=model['layers'][:1])
        status, body = self.request('POST', '/api/artifacts', {'bundleHash': HASH_A, 'bundle': b, 'model': bad, 'evaluation': {}, 'provenance': {}})
        self.assertEqual(status, 400, body)

    # ---- isolation
    def test_state_changes_need_the_token_and_foreign_origins_cannot_read_it(self):
        status, body = self.request('POST', '/api/runs', {'run': {'id': 'x', 'bundle': bundle('reinforce'), 'bundleHash': HASH_A}}, token='wrong')
        self.assertEqual(status, 401, body)
        status, _ = self.request('DELETE', '/api/runs/x', token='')
        self.assertEqual(status, 401)
        for headers in ({'Origin': 'https://foreign.invalid'}, {'Host': '127.0.0.1:invalid'}, {'Origin': 'http://[invalid'}, {'Sec-Fetch-Site': 'cross-site'}):
            with self.subTest(headers=headers):
                status, body = self.request('GET', '/api/session', headers=headers)
                self.assertEqual(status, 403, body)
                self.assertNotIn(b'local-test-token', body)

    def test_directory_index_symlink_cannot_expose_outside_files(self):
        private = self.root / 'private.txt'
        private.write_text('private content')
        directory = self.frontend / 'linked'
        directory.mkdir()
        (directory / 'index.html').symlink_to(private)
        status, _ = self.request('GET', '/linked/')
        self.assertEqual(status, 404)
        status, _ = self.request('GET', '/index.html')
        self.assertEqual(status, 200)


class Restore(unittest.TestCase):
    def test_in_flight_runs_become_failed_and_completed_results_are_kept_when_valid(self):
        with tempfile.TemporaryDirectory() as tmp:
            runs = Path(tmp) / 'ws' / 'runs'
            b = bundle('hinge')
            model = {'format': 'threshold-layers', 'inputs': 4, 'outputs': 3, 'weightBits': 8, 'layers': [{'W': [[1] * 4] * 8, 'th': [1] * 8, 'scale': 1.0, 'k': 0}, {'W': [[1] * 8] * 3, 'th': [2] * 3, 'scale': 1.0, 'k': 0}]}
            for name, status, result in (('orphan', 'running', None), ('kept', 'completed', {'model': model, 'evaluation': {}, 'provenance': {}}),
                                         ('broken', 'completed', {'model': dict(model, inputs=5), 'evaluation': {}, 'provenance': {}})):
                d = runs / name; d.mkdir(parents=True)
                write_json(d / 'bundle.json', b)
                write_json(d / 'run.json', {'id': name, 'source': 'workspace', 'status': status, 'progress': None, 'error': None, 'createdAt': 't', 'updatedAt': 't', 'bundleHash': HASH_A})
                if result: write_json(d / 'result.json', result)
            (runs / 'junk').mkdir(); (runs / 'junk' / 'run.json').write_text('not json')
            ws = Workspace(Path(tmp) / 'ws', 1)
            self.assertEqual(sorted(ws.runs), ['broken', 'kept', 'orphan'])
            self.assertEqual(ws.get('orphan')['status'], 'failed'); self.assertIn('orphaned', ws.get('orphan')['error'])
            self.assertEqual(ws.get('kept')['status'], 'completed'); self.assertEqual(ws.get('kept')['result']['model'], model)
            self.assertEqual(ws.get('broken')['status'], 'failed'); self.assertIn('unreadable', ws.get('broken')['error'])
            ws.shutdown()


if __name__ == '__main__':
    unittest.main()
