#!/usr/bin/env python3
"""Local Workspace service: serves the frontend and runs Python trainers (training/bundle_train.py) for trainer bundles.

    python3 training/workspace.py                              # http://127.0.0.1:18766, workspace ~/.cache/neurom-workspace
    python3 training/workspace.py --host 127.0.0.1 --port 18766 --workspace-dir DIR --max-concurrent 2

Protocol (frontend/core/sessions/workspace-client.js is the client):
    GET    /api/session            {token, capabilities:{methods, engines}, limits, origin}   same-origin or origin-less loopback only
    GET    /api/runs               {runs:[run…]}                        every run (results omitted, hasResult flags them)
    POST   /api/runs               body {run:{id, bundle, bundleHash[, tables]}} -> {run}   validate the bundle, queue a child
                                   409 when `id` already exists with a different bundleHash (same hash: the existing run)
    GET    /api/runs/:id           run snapshot (latest progress, result on completion)
    DELETE /api/runs/:id           cancel: kills the child process group, terminal `cancelled`, nothing published
    GET    /api/runs/:id/events    SSE `progress` / `status` / `complete` events (+ keepalive comments)
    POST   /api/artifacts          body {bundleHash, bundle, model, evaluation, provenance} -> completed imported run
    run = {id, status, progress, error?, result?, bundleHash, source, backend, createdAt, updatedAt}
    status ∈ queued | running | completed | failed | cancelled
    result = {model, evaluation, provenance}
    Bundles are validated server-side (format, method requirements, program checks through training/ir.py) before anything
    is queued. `tables` ({datasetId: {column: numbers}}) is required when the bundle's env reads a dataset.

Security model:
    - The service binds loopback by default.
    - Every request must carry a loopback Host that matches the bound port.
    - Any Origin header must be this service's own origin.
    - State-changing requests need `X-Workspace-Token` (printed at startup and written to <workspace>/session-token,
      mode 0600).
    - Bodies are size-capped JSON without NaN/Infinity.
    - Runs only execute `bundle_train.py` on a private per-run directory — no client-controlled paths, commands, or pickles.
    - Static files are served from the frontend directory only.
"""
import argparse, json, os, re, secrets, signal, subprocess, sys, threading, time, uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bundle_train  # noqa: E402
from bundle_train import now, write_json  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
CHILD = Path(__file__).resolve().parent / 'bundle_train.py'
DEFAULT_WORKSPACE = Path.home() / '.cache' / 'neurom-workspace'
LOOPBACK_HOSTS = ('127.0.0.1', 'localhost', '::1', '[::1]')
TERMINAL = ('completed', 'failed', 'cancelled')
LIMITS = {'runBodyBytes': 8 * 1024 * 1024, 'artifactBodyBytes': 32 * 1024 * 1024, 'maxRuns': 500}
RUN_ID = re.compile(r'^[A-Za-z0-9_-]{1,64}$')
HASH = re.compile(r'^0x[0-9a-f]{64}$')
MIME = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
        '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
        '.md': 'text/markdown; charset=utf-8', '.wasm': 'application/wasm', '.map': 'application/json', '.yaml': 'text/yaml; charset=utf-8'}


class HttpError(Exception):
    def __init__(self, status, message):
        super().__init__(message); self.status = status


def _reject_constant(name): raise ValueError(f'{name} is not valid JSON')


def parse_json(raw):
    try: return json.loads(raw.decode('utf-8'), parse_constant=_reject_constant)
    except (UnicodeDecodeError, ValueError) as e: raise HttpError(HTTPStatus.BAD_REQUEST, f'invalid JSON body: {e}') from e


def check_run_id(run_id):
    if not isinstance(run_id, str) or not RUN_ID.match(run_id): raise HttpError(HTTPStatus.BAD_REQUEST, 'run.id must be 1..64 characters of [A-Za-z0-9_-]')
    return run_id


def check_hash(h):
    if not isinstance(h, str) or not HASH.match(h): raise HttpError(HTTPStatus.BAD_REQUEST, 'bundleHash must be 0x + 64 hex digits')
    return h


def check_tables(tables):
    if tables is None: return None
    if not isinstance(tables, dict): raise HttpError(HTTPStatus.BAD_REQUEST, 'tables must map dataset id → {column: numbers}')
    for tid, cols in tables.items():
        if not isinstance(cols, dict) or not cols: raise HttpError(HTTPStatus.BAD_REQUEST, f'tables.{tid} must be a non-empty {{column: numbers}} object')
        for name, values in cols.items():
            if not isinstance(values, list) or any(isinstance(v, bool) or not isinstance(v, (int, float)) for v in values): raise HttpError(HTTPStatus.BAD_REQUEST, f'tables.{tid}.{name} must be a list of numbers')
    return tables


def validate_bundle(bundle, tables=None):
    try: return bundle_train.validate_bundle(bundle, tables)
    except bundle_train.BundleError as e: raise HttpError(HTTPStatus.BAD_REQUEST, f'invalid bundle: {e}') from e


def validate_result(bundle, result):
    for key in ('model', 'evaluation', 'provenance'):
        if key not in result: raise bundle_train.BundleError(f'result lacks {key}')
    bundle_train.validate_result(bundle, result['model'], result['evaluation'], result['provenance'])


# ───────────────────────────── run registry ─────────────────────────────
class Run:
    def __init__(self, run_id, bundle, bundle_hash, source, directory):
        self.id, self.bundle, self.bundleHash, self.source, self.dir = run_id, bundle, bundle_hash, source, directory
        self.status, self.progress, self.result, self.error = 'queued', None, None, None
        self.createdAt = self.updatedAt = now()
        self.version = 0
        self.proc = None

    def summary(self, with_result=False):
        out = {'id': self.id, 'status': self.status, 'progress': self.progress, 'bundleHash': self.bundleHash, 'backend': 'python', 'source': self.source,
               'createdAt': self.createdAt, 'updatedAt': self.updatedAt}
        if self.error is not None: out['error'] = self.error
        if with_result and self.result is not None: out['result'] = self.result
        elif self.result is not None: out['hasResult'] = True
        return out

    def touch(self): self.updatedAt = now(); self.version += 1

    def persist(self):
        self.touch()
        write_json(self.dir / 'run.json', {k: getattr(self, k) for k in ('id', 'source', 'status', 'progress', 'error', 'createdAt', 'updatedAt', 'bundleHash')})


class Workspace:
    def __init__(self, directory, max_concurrent):
        self.dir = Path(directory)
        self.runs_dir = self.dir / 'runs'
        self.max_concurrent = max_concurrent
        self.runs = {}
        self.queue = []
        self.cond = threading.Condition()
        self.closed = False
        for d in (self.dir, self.runs_dir): d.mkdir(parents=True, exist_ok=True); os.chmod(d, 0o700)
        self._load()

    # ---- persistence
    def _load(self):
        for d in sorted(self.runs_dir.iterdir()):
            try:
                with open(d / 'run.json') as f: rec = json.load(f)
                with open(d / 'bundle.json') as f: bundle = json.load(f)
                tables = None
                if (d / 'tables.json').is_file():
                    with open(d / 'tables.json') as f: tables = json.load(f)
                bundle_train.validate_bundle(bundle, tables)
                run_id, bundle_hash = check_run_id(rec['id']), check_hash(rec['bundleHash'])
            except (OSError, ValueError, KeyError, TypeError, HttpError): continue
            run = Run(run_id, bundle, bundle_hash, rec.get('source', 'workspace'), d)
            run.status, run.progress, run.error = rec['status'], rec.get('progress'), rec.get('error')
            run.createdAt, run.updatedAt = rec.get('createdAt', now()), rec.get('updatedAt', now())
            if run.status in ('queued', 'running'):           # a previous service instance died with this job in flight. Never resume it blindly
                run.status, run.error = 'failed', 'orphaned: workspace service stopped while the job was in flight'
                run.persist()
            elif run.status == 'completed':
                try:
                    with open(d / 'result.json') as f: res = json.load(f)
                    validate_result(bundle, res); run.result = res
                except (OSError, ValueError, KeyError, TypeError) as e:
                    run.status, run.error = 'failed', f'stored result unreadable: {e}'; run.persist()
            self.runs[run.id] = run

    def _new_run(self, run_id, bundle, bundle_hash, tables, source):
        if len(self.runs) >= LIMITS['maxRuns']: raise HttpError(HTTPStatus.TOO_MANY_REQUESTS, f"workspace holds {LIMITS['maxRuns']} runs; remove old run directories under {self.runs_dir}")
        d = self.runs_dir / run_id
        d.mkdir(mode=0o700)
        write_json(d / 'bundle.json', bundle)                 # immutable snapshot that the child reads. Nothing rewrites it
        if tables is not None: write_json(d / 'tables.json', tables)
        return Run(run_id, bundle, bundle_hash, source, d)

    # ---- public API (all under self.cond)
    def list(self):
        with self.cond: return [r.summary() for r in sorted(self.runs.values(), key=lambda r: r.createdAt)]

    def get(self, run_id):
        with self.cond:
            run = self.runs.get(run_id)
            if run is None: raise HttpError(HTTPStatus.NOT_FOUND, 'run not found')
            return run.summary(with_result=True)

    def submit(self, spec):
        """POST /api/runs: `{id, bundle, bundleHash[, tables]}` → the run summary (existing run when id + hash already known)."""
        if not isinstance(spec, dict): raise HttpError(HTTPStatus.BAD_REQUEST, 'body must be {run:{id, bundle, bundleHash}}')
        run_id, bundle_hash = check_run_id(spec.get('id')), check_hash(spec.get('bundleHash'))
        tables = check_tables(spec.get('tables'))
        bundle = spec.get('bundle')
        if not isinstance(bundle, dict): raise HttpError(HTTPStatus.BAD_REQUEST, 'run.bundle must be an object')
        with self.cond:
            existing = self.runs.get(run_id)
            if existing is not None:
                if existing.bundleHash != bundle_hash: raise HttpError(HTTPStatus.CONFLICT, f'run {run_id} already exists with a different bundleHash')
                return existing.summary(with_result=True)
        validate_bundle(bundle, tables)                       # first: a malformed env is a structured 400
        missing = [tb.get('id') for tb in bundle['env'].get('tables') or [] if isinstance(tb, dict) and tb.get('id') not in (tables or {})]
        if missing: raise HttpError(HTTPStatus.BAD_REQUEST, f"run.tables lacks the rows of dataset {', '.join(map(str, missing))} the bundle's env reads")
        bundle = json.loads(json.dumps(bundle))
        with self.cond:
            if self.closed: raise HttpError(HTTPStatus.SERVICE_UNAVAILABLE, 'workspace is shutting down')
            existing = self.runs.get(run_id)
            if existing is not None:
                if existing.bundleHash != bundle_hash: raise HttpError(HTTPStatus.CONFLICT, f'run {run_id} already exists with a different bundleHash')
                return existing.summary(with_result=True)
            run = self._new_run(run_id, bundle, bundle_hash, tables, 'workspace')
            self.runs[run.id] = run; self.queue.append(run.id); run.persist()
            self._schedule()
            return run.summary()

    def import_result(self, body):
        """POST /api/artifacts: an externally trained result stored as a completed run."""
        for key in ('bundleHash', 'bundle', 'model', 'evaluation', 'provenance'):
            if key not in body: raise HttpError(HTTPStatus.BAD_REQUEST, f'missing {key}')
        bundle_hash = check_hash(body['bundleHash'])
        bundle = body['bundle']
        if not isinstance(bundle, dict): raise HttpError(HTTPStatus.BAD_REQUEST, 'bundle must be an object')
        validate_bundle(bundle)
        result = {'model': body['model'], 'evaluation': body['evaluation'], 'provenance': body['provenance']}
        try: validate_result(bundle, result)
        except bundle_train.BundleError as e: raise HttpError(HTTPStatus.BAD_REQUEST, f'invalid result: {e}') from e
        result['provenance'] = dict(result['provenance'], imported=True, importedAt=now(), bundleHash=bundle_hash)
        result['provenance'].setdefault('backend', 'external')
        bundle = json.loads(json.dumps(bundle))
        with self.cond:
            if self.closed: raise HttpError(HTTPStatus.SERVICE_UNAVAILABLE, 'workspace is shutting down')
            run_id = uuid.uuid4().hex
            run = self._new_run(run_id, bundle, bundle_hash, None, 'imported')
            write_json(run.dir / 'result.json', result)
            run.result, run.status = result, 'completed'
            self.runs[run.id] = run; run.persist()
            self.cond.notify_all()
            return run.summary(with_result=True)

    def cancel(self, run_id):
        with self.cond:
            run = self.runs.get(run_id)
            if run is None: raise HttpError(HTTPStatus.NOT_FOUND, 'run not found')
            if run.status in TERMINAL: return run.summary(with_result=True)
            if run.id in self.queue: self.queue.remove(run.id)
            run.status, run.error = 'cancelled', 'cancelled by client'
            run.persist(); self.cond.notify_all()
            proc = run.proc
        if proc is not None: self._kill(proc)
        return self.get(run_id)

    def snapshot(self, run_id):
        """(summary with result, version) — version changes on every progress/status update."""
        with self.cond:
            run = self.runs.get(run_id)
            if run is None: raise HttpError(HTTPStatus.NOT_FOUND, 'run not found')
            return run.summary(with_result=True), run.version

    def wait_change(self, run_id, version, timeout):
        """Block until the run's version differs from `version`, the service closes, or timeout. Returns (summary, version)."""
        with self.cond:
            run = self.runs.get(run_id)
            if run is None: raise HttpError(HTTPStatus.NOT_FOUND, 'run not found')
            self.cond.wait_for(lambda: run.version != version or self.closed, timeout=timeout)
            return run.summary(with_result=True), run.version

    # ---- scheduling / child processes
    def _schedule(self):
        running = sum(1 for r in self.runs.values() if r.proc is not None and r.proc.poll() is None)
        while self.queue and running < self.max_concurrent and not self.closed:
            run = self.runs[self.queue.pop(0)]
            log = open(run.dir / 'stderr.log', 'ab')
            try:
                run.proc = subprocess.Popen([sys.executable, str(CHILD), '--run-dir', str(run.dir), '--parent-pid', str(os.getpid())], cwd=str(ROOT), stdin=subprocess.DEVNULL,
                                            stdout=subprocess.PIPE, stderr=log, start_new_session=True, env={**os.environ, 'PYTHONUNBUFFERED': '1'})
            except OSError as e:
                run.status, run.error = 'failed', f'could not start child: {e}'; run.persist(); continue
            finally: log.close()
            run.status = 'running'; run.persist(); running += 1
            threading.Thread(target=self._reader, args=(run,), daemon=True, name=f'run-{run.id[:8]}').start()
        self.cond.notify_all()

    def _reader(self, run):
        error = None
        for raw in run.proc.stdout:
            try: event = json.loads(raw)
            except ValueError: continue
            kind = event.get('type')
            with self.cond:
                if kind == 'progress' and isinstance(event.get('progress'), dict):
                    if run.status == 'running': run.progress = event['progress']; run.touch(); self.cond.notify_all()
                elif kind == 'error': error = str(event.get('error'))[:4000]
        run.proc.stdout.close()
        code = run.proc.wait()
        result_path = run.dir / 'result.json'
        with self.cond:
            if run.status == 'cancelled':                     # killed on purpose: a late result.json must never be published
                if result_path.exists(): result_path.unlink()
            elif code == 0 and result_path.exists():
                try:
                    with open(result_path) as f: res = json.load(f)
                    validate_result(run.bundle, res)
                    run.result, run.status = res, 'completed'
                except (OSError, ValueError, KeyError, TypeError) as e:
                    run.status, run.error = 'failed', f'child produced an invalid result: {e}'
            else:
                run.status, run.error = 'failed', error or f'child exited with code {code} (see {run.dir / "stderr.log"})'
            run.persist(); run.proc = None
            self._schedule()

    @staticmethod
    def _signal(proc, sig):
        """Signal the child's whole process group. If that fails, signal the child pid (macOS reports EPERM for groups with reaped members)."""
        if proc.poll() is not None: return
        try: os.killpg(proc.pid, sig)
        except (ProcessLookupError, PermissionError):
            try: proc.send_signal(sig)
            except ProcessLookupError: pass

    def _kill(self, proc):
        self._signal(proc, signal.SIGTERM)
        def hard():
            time.sleep(5); self._signal(proc, signal.SIGKILL)
        threading.Thread(target=hard, daemon=True).start()

    def shutdown(self):
        with self.cond:
            self.closed = True
            procs = []
            for run in self.runs.values():
                if run.status in ('queued', 'running'):
                    run.status, run.error = 'cancelled', 'workspace service shut down'; run.persist()
                    if run.proc is not None: procs.append(run.proc)
            self.queue.clear(); self.cond.notify_all()
        for proc in procs: self._signal(proc, signal.SIGTERM)
        deadline = time.time() + 5
        for proc in procs:
            try: proc.wait(timeout=max(0.1, deadline - time.time()))
            except subprocess.TimeoutExpired: self._signal(proc, signal.SIGKILL)


# ───────────────────────────── HTTP ─────────────────────────────
class Handler(BaseHTTPRequestHandler):
    server_version, sys_version, protocol_version = 'neurom-workspace/2', '', 'HTTP/1.1'
    ws: Workspace; token: str; port: int; frontend: Path; public_host: str

    def log_message(self, fmt, *args):
        sys.stderr.write(f'{now()} {self.address_string()} {fmt % args}\n')

    # ---- guards
    def _origin_ok(self):
        host = self.headers.get('Host', '')
        allowed = LOOPBACK_HOSTS + (self.public_host,)
        try:
            h = urlsplit('//' + host)
            if (h.hostname or '') not in allowed or (h.port or 80) != self.port:
                raise HttpError(HTTPStatus.FORBIDDEN, 'Host is not this workspace')
            origin = self.headers.get('Origin')
            if origin is not None:
                o = urlsplit(origin)
                if origin == 'null' or o.scheme != 'http' or (o.hostname or '') not in allowed or (o.port or 80) != self.port:
                    raise HttpError(HTTPStatus.FORBIDDEN, 'cross-origin request refused')
        except ValueError:
            raise HttpError(HTTPStatus.FORBIDDEN, 'malformed Host or Origin') from None
        site = self.headers.get('Sec-Fetch-Site')
        if site not in (None, 'same-origin', 'none'): raise HttpError(HTTPStatus.FORBIDDEN, f'Sec-Fetch-Site {site} refused')

    def _authorized(self):
        if not secrets.compare_digest(self.headers.get('X-Workspace-Token', ''), self.token): raise HttpError(HTTPStatus.UNAUTHORIZED, 'missing or wrong X-Workspace-Token')

    def _body(self, limit):
        if self.headers.get('Transfer-Encoding'): raise HttpError(HTTPStatus.LENGTH_REQUIRED, 'chunked bodies are not accepted')
        try: length = int(self.headers.get('Content-Length', ''))
        except ValueError: raise HttpError(HTTPStatus.LENGTH_REQUIRED, 'Content-Length required') from None
        if length < 0 or length > limit: raise HttpError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, f'body exceeds {limit} bytes')
        body = parse_json(self.rfile.read(length))
        if not isinstance(body, dict): raise HttpError(HTTPStatus.BAD_REQUEST, 'JSON body must be an object')
        return body

    # ---- responses
    def _send(self, status, payload, content_type='application/json; charset=utf-8', head=False):
        data = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        self.send_response(status)
        self.send_header('Content-Type', content_type); self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store'); self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.end_headers()
        if not head and self.command != 'HEAD': self.wfile.write(data)

    def _error(self, e):
        self.close_connection = True  # Error paths can leave an unread request body.
        self._send(e.status, {'error': str(e)})

    # ---- routing
    def _route(self, method, head=False):
        path = urlsplit(self.path).path
        try:
            self._origin_ok()
            if path.startswith('/api/'):
                if method in ('POST', 'DELETE'): self._authorized()
                return self._api(method, path, head)
            if method not in ('GET', 'HEAD'): raise HttpError(HTTPStatus.METHOD_NOT_ALLOWED, 'method not allowed')
            return self._static(path, head)
        except HttpError as e: self._error(e)
        except (BrokenPipeError, ConnectionResetError): pass

    def _api(self, method, path, head):
        parts = path.strip('/').split('/')
        if parts == ['api', 'session'] and method == 'GET':
            return self._send(HTTPStatus.OK, {'token': self.token, 'backend': 'python', 'capabilities': bundle_train.capabilities(), 'limits': LIMITS | {'maxConcurrent': self.ws.max_concurrent},
                                              'bundleFormat': bundle_train.BUNDLE_FORMAT, 'origin': f'http://{self.public_host}:{self.port}', 'python': sys.version.split()[0]}, head=head)
        if parts == ['api', 'runs']:
            if method == 'GET': return self._send(HTTPStatus.OK, {'runs': self.ws.list()}, head=head)
            if method == 'POST':
                body = self._body(LIMITS['runBodyBytes'])
                if 'run' not in body: raise HttpError(HTTPStatus.BAD_REQUEST, 'body must be {run:{id, bundle, bundleHash}}')
                return self._send(HTTPStatus.CREATED, {'run': self.ws.submit(body['run'])})
        if parts == ['api', 'artifacts'] and method == 'POST':
            return self._send(HTTPStatus.CREATED, {'run': self.ws.import_result(self._body(LIMITS['artifactBodyBytes']))})
        if len(parts) in (3, 4) and parts[:2] == ['api', 'runs'] and RUN_ID.match(parts[2]):
            run_id = parts[2]
            if len(parts) == 3:
                if method == 'GET': return self._send(HTTPStatus.OK, self.ws.get(run_id), head=head)
                if method == 'DELETE': return self._send(HTTPStatus.OK, self.ws.cancel(run_id))
            elif parts[3] == 'events' and method == 'GET': return self._events(run_id)
        raise HttpError(HTTPStatus.NOT_FOUND, f'no route {method} {path}')

    def _events(self, run_id):
        run, version = self.ws.snapshot(run_id)
        self.send_response(HTTPStatus.OK)
        self.send_header('Content-Type', 'text/event-stream'); self.send_header('Cache-Control', 'no-store'); self.send_header('Connection', 'close')
        self.send_header('X-Content-Type-Options', 'nosniff'); self.end_headers()
        while True:
            terminal = run['status'] in TERMINAL
            event = 'complete' if terminal else ('progress' if run.get('progress') is not None else 'status')
            self.wfile.write(f'event: {event}\ndata: {json.dumps(run)}\n\n'.encode()); self.wfile.flush()
            if terminal: return
            run, next_version = self.ws.wait_change(run_id, version, timeout=15)
            if next_version == version: self.wfile.write(b': keepalive\n\n'); self.wfile.flush()
            version = next_version

    def _static(self, path, head):
        rel = path.lstrip('/') or 'index.html'
        # frontend/index.html in the repository is the Vite source entry. The same-origin service serves the built release page.
        if self.frontend == (ROOT / 'frontend').resolve() and rel == 'index.html':
            rel = 'dist/neurom-studio.html'
            if not (self.frontend / rel).is_file():
                raise HttpError(HTTPStatus.SERVICE_UNAVAILABLE, 'frontend is not built; run npm ci && npm run build, or use npm run dev for source development')
        try:
            resolved = (self.frontend / rel).resolve(strict=True)
            if resolved.is_dir(): resolved = (resolved / 'index.html').resolve(strict=True)
        except (OSError, RuntimeError):
            raise HttpError(HTTPStatus.NOT_FOUND, 'not found') from None
        if self.frontend not in resolved.parents or not resolved.is_file():
            raise HttpError(HTTPStatus.NOT_FOUND, 'not found')
        self._send(HTTPStatus.OK, resolved.read_bytes(), MIME.get(resolved.suffix.lower(), 'application/octet-stream'), head=head)

    def do_GET(self): self._route('GET')
    def do_HEAD(self): self._route('HEAD', head=True)
    def do_POST(self): self._route('POST')
    def do_DELETE(self): self._route('DELETE')
    def do_OPTIONS(self): self._error(HttpError(HTTPStatus.FORBIDDEN, 'cross-origin preflight refused: the workspace is same-origin only'))
    do_PUT = do_PATCH = do_OPTIONS


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--host', default='127.0.0.1', choices=('127.0.0.1', 'localhost'), help='loopback only; remote access requires a separately secured deployment')
    ap.add_argument('--port', type=int, default=18766)
    ap.add_argument('--workspace-dir', default=str(DEFAULT_WORKSPACE), help='run directories, bundle snapshots, results and the session token (created 0700)')
    ap.add_argument('--frontend-dir', default=str(ROOT / 'frontend'), help='static files served at / (same origin as the API)')
    ap.add_argument('--max-concurrent', type=int, default=2, help='training child processes allowed at once; further runs queue')
    ap.add_argument('--token', help='fixed session token (default: random per start; also written to <workspace>/session-token)')
    a = ap.parse_args(argv)
    if a.max_concurrent < 1: ap.error('--max-concurrent must be >= 1')
    frontend = Path(a.frontend_dir).resolve()
    if not (frontend / 'index.html').is_file(): ap.error(f'{frontend} has no index.html')

    ws = Workspace(a.workspace_dir, a.max_concurrent)
    token = a.token or secrets.token_urlsafe(32)
    token_path = ws.dir / 'session-token'
    token_path.write_text(token + '\n'); os.chmod(token_path, 0o600)

    class Bound(Handler): pass
    Bound.ws, Bound.token, Bound.port, Bound.frontend, Bound.public_host = ws, token, a.port, frontend, a.host
    ThreadingHTTPServer.daemon_threads = True
    server = ThreadingHTTPServer((a.host, a.port), Bound)
    Bound.port = server.server_address[1]
    print(f'workspace http://{a.host}:{Bound.port}/  runs {ws.runs_dir}  session token in {token_path}', flush=True)
    stop = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM): signal.signal(sig, lambda *_: stop.set())
    threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.5}, daemon=True).start()
    try:
        while not stop.wait(0.5): pass
    finally:
        print('stopping: cancelling in-flight runs', flush=True)
        ws.shutdown(); server.shutdown(); server.server_close()


if __name__ == '__main__':
    main()
