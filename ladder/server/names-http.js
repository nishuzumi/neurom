// names-http.js — the HTTP layer of the name service: a Node `(req, res)` handler that api/names.js exports to Vercel
// and that the tests mount on `http.createServer`. The handler speaks JSON only. A refusal is
// `{ error: code, ...details }` with the status of the NameError. The page maps each code to a message.
//
//   GET    /api/names?modules=0xa,0xb   → { names: { "0xa": "Name" } }
//   POST   /api/names  { module, name, signature }   → { module, name, owner }
//   DELETE /api/names?module=0xa   with `Authorization: Bearer <ADMIN_TOKEN>`  → { module, cleared: boolean }
import { timingSafeEqual } from 'node:crypto';
import { NameError } from './names.js';

const BODY_LIMIT = 16 * 1024;

/** The JSON body of `req`: the body that the Vercel helper parsed, else the request stream. */
async function readBody(req) {
  let raw = req.body;
  if (raw === undefined) {
    const chunks = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > BODY_LIMIT) throw new NameError(413, 'body_too_large', { limit: BODY_LIMIT });
      chunks.push(chunk);
    }
    raw = Buffer.concat(chunks).toString('utf8');
  }
  if (Buffer.isBuffer(raw)) raw = raw.toString('utf8');
  if (typeof raw !== 'string') return raw && typeof raw === 'object' ? raw : {};
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch { throw new NameError(400, 'bad_json'); }
}

const send = (res, status, body) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' });
  res.end(text);
};

const sameToken = (given, expected) => {
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** The handler over `service` (names.js createNameService). `adminToken` guards DELETE. When it is empty, DELETE is refused. */
export function createNameHandler({ service, adminToken = '' }) {
  return async function handler(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET') {
        const list = (url.searchParams.get('modules') ?? '').split(',').map(s => s.trim()).filter(Boolean);
        return send(res, 200, { names: await service.names(list) });
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        if (!body || typeof body !== 'object') throw new NameError(400, 'bad_request');
        return send(res, 200, await service.set({ module: body.module, name: body.name, signature: body.signature }));
      }
      if (req.method === 'DELETE') {
        const given = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
        if (!adminToken || !given || !sameToken(given, adminToken)) throw new NameError(401, 'unauthorized');
        const module = url.searchParams.get('module') ?? '';
        return send(res, 200, { module: module.toLowerCase(), cleared: await service.clear(module) });
      }
      res.setHeader('allow', 'GET, POST, DELETE');
      throw new NameError(405, 'method_not_allowed');
    } catch (e) {
      if (e instanceof NameError) return send(res, e.status, { error: e.code, ...e.details });
      console.error(e);
      return send(res, 500, { error: 'internal' });
    }
  };
}
