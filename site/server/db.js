// db.js — the database of the name service. Production: Neon Postgres over HTTP (`DATABASE_URL`). Tests: PGlite in
// the process. Both give the same small interface: `query(text, params) → rows` and `close()`. `ensureSchema` applies
// schema.sql (idempotent statements), once per database object.
import { readFileSync } from 'node:fs';

const SCHEMA = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
/** The statements of schema.sql, without comments. */
const STATEMENTS = SCHEMA.split('\n').filter(line => !line.startsWith('--')).join('\n').split(/;\s*\n/).map(s => s.trim()).filter(Boolean);

/** Neon over HTTP. `url` is the `DATABASE_URL` of the Vercel project. */
export async function openDatabase(url) {
  if (!url) throw new Error('DATABASE_URL is not set');
  const { neon } = await import('@neondatabase/serverless');
  const sql = neon(url);
  return { query: (text, params = []) => sql.query(text, params), close: async () => {} };
}

/** PGlite in memory, for tests. */
export async function openTestDatabase() {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite();
  await pg.waitReady;
  return { query: async (text, params = []) => (await pg.query(text, params)).rows, close: () => pg.close() };
}

const ready = new WeakMap();
/** Apply schema.sql to `db` once. Later calls return the same promise. */
export function ensureSchema(db) {
  if (!ready.has(db)) ready.set(db, (async () => { for (const s of STATEMENTS) await db.query(s); })());
  return ready.get(db);
}
