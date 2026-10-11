// Storage for the one JSON document that holds all tracker data.
// Three interchangeable stores: Neon Postgres (production), a local file (npm run dev), memory (tests).
import fs from 'node:fs';
import path from 'node:path';

/* Each store offers: get() -> {version,data}|null, init(data) -> {version,data}, put(data, baseVersion) -> {ok,version}. */

export function memoryStore() {
  let row = null;
  return {
    async get() { return row ? { version: row.version, data: structuredClone(row.data) } : null; },
    async init(data) { if (!row) row = { version: 1, data: structuredClone(data) }; return { version: row.version, data: structuredClone(row.data) }; },
    async put(data, base) {
      if (!row || row.version !== base) return { ok: false, version: row ? row.version : 0 };
      row = { version: row.version + 1, data: structuredClone(data) }; return { ok: true, version: row.version };
    },
  };
}

export function fileStore(file) {
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
  const write = (row) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(row)); };
  return {
    async get() { return read(); },
    async init(data) { let r = read(); if (!r) { r = { version: 1, data }; write(r); } return r; },
    async put(data, base) {
      const r = read(); if (!r || r.version !== base) return { ok: false, version: r ? r.version : 0 };
      write({ version: r.version + 1, data }); return { ok: true, version: r.version + 1 };
    },
  };
}

export async function neonStore(url) {
  const { neon } = await import('@neondatabase/serverless');
  const sql = neon(url);
  let ready = null;
  const ensure = () => {
    if (!ready) {
      ready = (async () => {
        await sql`CREATE TABLE IF NOT EXISTS app_state (id text PRIMARY KEY, data jsonb NOT NULL, version integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now())`;
        // One snapshot per day, taken before the first change of that day. A safety net if something is deleted by mistake.
        await sql`CREATE TABLE IF NOT EXISTS app_backups (day date PRIMARY KEY, data jsonb NOT NULL, version integer NOT NULL)`;
      })().catch((e) => { ready = null; throw e; });
    }
    return ready;
  };
  return {
    async get() {
      await ensure();
      const rows = await sql`SELECT data, version FROM app_state WHERE id = 'main'`;
      return rows.length ? { version: rows[0].version, data: rows[0].data } : null;
    },
    async init(data) {
      await ensure();
      await sql`INSERT INTO app_state (id, data, version) VALUES ('main', ${JSON.stringify(data)}::jsonb, 1) ON CONFLICT (id) DO NOTHING`;
      const rows = await sql`SELECT data, version FROM app_state WHERE id = 'main'`;
      return { version: rows[0].version, data: rows[0].data };
    },
    async put(data, base) {
      await ensure();
      await sql`INSERT INTO app_backups (day, data, version) SELECT current_date, data, version FROM app_state WHERE id = 'main' AND version = ${base} ON CONFLICT (day) DO NOTHING`;
      const rows = await sql`UPDATE app_state SET data = ${JSON.stringify(data)}::jsonb, version = version + 1, updated_at = now() WHERE id = 'main' AND version = ${base} RETURNING version`;
      if (rows.length) return { ok: true, version: rows[0].version };
      const cur = await sql`SELECT version FROM app_state WHERE id = 'main'`;
      return { ok: false, version: cur.length ? cur[0].version : 0 };
    },
  };
}

let shared = null;
/** The store the running server should use. */
export async function getStore(env = process.env) {
  if (shared) return shared;
  if (env.DATABASE_URL) shared = await neonStore(env.DATABASE_URL);
  else if (env.VERCEL) throw new Error('DATABASE_URL is not set. Add it in the Vercel project settings.');
  else shared = fileStore(path.join(process.cwd(), '.data', 'state.json'));
  return shared;
}
