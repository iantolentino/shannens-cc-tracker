// Storage for the one JSON document that holds all tracker data.
// Three interchangeable stores: Neon Postgres (production), a local file (npm run dev), memory (tests).
import fs from 'node:fs';
import path from 'node:path';

/* Each store offers: get() -> {version,data}|null, init(data) -> {version,data}, put(data, baseVersion) -> {ok,version}. */

export function memoryStore() {
  let row = null, passwordHash = null;
  return {
    async get() { return row ? { version: row.version, data: structuredClone(row.data) } : null; },
    async init(data) { if (!row) row = { version: 1, data: structuredClone(data) }; return { version: row.version, data: structuredClone(row.data) }; },
    async put(data, base) {
      if (!row || row.version !== base) return { ok: false, version: row ? row.version : 0 };
      row = { version: row.version + 1, data: structuredClone(data) }; return { ok: true, version: row.version };
    },
    async getPasswordHash() { return passwordHash; },
    async initPasswordHash(hash) { if (!passwordHash) passwordHash = hash; return passwordHash; },
    async setPasswordHash(hash) { passwordHash = hash; },
    async storageUsage() { return { usedBytes: row ? Buffer.byteLength(JSON.stringify(row.data)) : 0, limitBytes: 1073741824, provider: 'Neon Free plan reference' }; },
    async deleteMonth(ym, base, data, cardId = 'card-default') {
      if (!row || row.version !== base) return { ok: false, reason: 'conflict', version: row ? row.version : 0 };
      const month = row.data.months.find((m) => m.ym === ym && (m.cardId || 'card-default') === cardId);
      if (!month) return { ok: false, reason: 'missing', version: row.version };
      if (month.items.some((it) => it.plan)) return { ok: false, reason: 'installment', version: row.version };
      row = { version: row.version + 1, data: structuredClone(data) };
      return { ok: true, version: row.version, data: structuredClone(row.data) };
    },
  };
}

export function fileStore(file) {
  const authFile = file + '.auth';
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
  const readAuth = () => { try { return JSON.parse(fs.readFileSync(authFile, 'utf8')).passwordHash || null; } catch { return null; } };
  const writeAuth = (passwordHash) => { fs.mkdirSync(path.dirname(authFile), { recursive: true }); fs.writeFileSync(authFile, JSON.stringify({ passwordHash })); };
  const write = (row) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(row)); };
  return {
    async get() { return read(); },
    async init(data) { let r = read(); if (!r) { r = { version: 1, data }; write(r); } return r; },
    async put(data, base) {
      const r = read(); if (!r || r.version !== base) return { ok: false, version: r ? r.version : 0 };
      write({ version: r.version + 1, data }); return { ok: true, version: r.version + 1 };
    },
    async getPasswordHash() { return readAuth(); },
    async initPasswordHash(hash) { let current = readAuth(); if (!current) { writeAuth(hash); current = hash; } return current; },
    async setPasswordHash(hash) { writeAuth(hash); },
    async storageUsage() { let usedBytes = 0; try { usedBytes = fs.statSync(file).size; } catch {} return { usedBytes, limitBytes: 1073741824, provider: 'Neon Free plan reference' }; },
    async deleteMonth(ym, base, data, cardId = 'card-default') {
      const row = read();
      if (!row || row.version !== base) return { ok: false, reason: 'conflict', version: row ? row.version : 0 };
      const month = row.data.months.find((m) => m.ym === ym);
      if (!month) return { ok: false, reason: 'missing', version: row.version };
      if (month.items.some((it) => it.plan)) return { ok: false, reason: 'installment', version: row.version };
      const next = { version: row.version + 1, data };
      write(next);
      return { ok: true, version: next.version, data: next.data };
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
        await sql`CREATE TABLE IF NOT EXISTS app_auth (id text PRIMARY KEY, password_hash text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`;
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
    async getPasswordHash() {
      await ensure();
      const rows = await sql`SELECT password_hash FROM app_auth WHERE id = 'main'`;
      return rows.length ? rows[0].password_hash : null;
    },
    async initPasswordHash(hash) {
      await ensure();
      await sql`INSERT INTO app_auth (id, password_hash) VALUES ('main', ${hash}) ON CONFLICT (id) DO NOTHING`;
      const rows = await sql`SELECT password_hash FROM app_auth WHERE id = 'main'`;
      return rows.length ? rows[0].password_hash : null;
    },
    async setPasswordHash(hash) {
      await ensure();
      await sql`INSERT INTO app_auth (id, password_hash) VALUES ('main', ${hash}) ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = now()`;
    },
    async storageUsage() {
      await ensure();
      const rows = await sql`SELECT pg_database_size(current_database())::text AS used_bytes`;
      return { usedBytes: Number(rows[0].used_bytes), limitBytes: 1073741824, provider: 'Neon Free plan reference' };
    },
    async deleteMonth(ym, base, data) {
      await ensure();
      const rows = await sql`
        WITH original AS MATERIALIZED (
          SELECT data, version FROM app_state WHERE id = 'main' AND version = ${base}
        ), updated AS (
          UPDATE app_state
          SET data = ${JSON.stringify(data)}::jsonb, version = version + 1, updated_at = now()
          WHERE id = 'main'
            AND version = ${base}
            AND EXISTS (SELECT 1 FROM jsonb_array_elements(data->'months') AS m(value) WHERE m.value->>'ym' = ${ym} AND COALESCE(m.value->>'cardId', 'card-default') = ${cardId})
            AND EXISTS (SELECT 1 FROM original)
            AND NOT EXISTS (
              SELECT 1
              FROM jsonb_array_elements(data->'months') AS m(value),
                   jsonb_array_elements(m.value->'items') AS it(value)
              WHERE m.value->>'ym' = ${ym} AND COALESCE(m.value->>'cardId', 'card-default') = ${cardId} AND it.value ? 'plan'
          )
          RETURNING version
        ), snapshots AS (
          SELECT day, data, version FROM app_backups
          UNION ALL
          SELECT current_date AS day, original.data, original.version
          FROM original
          WHERE NOT EXISTS (SELECT 1 FROM app_backups WHERE day = current_date)
        ), backups AS (
          INSERT INTO app_backups (day, data, version)
          SELECT snapshots.day,
            jsonb_set(snapshots.data, '{months}', COALESCE((
            SELECT jsonb_agg(m.value ORDER BY m.ordinality)
            FROM jsonb_array_elements(snapshots.data->'months') WITH ORDINALITY AS m(value, ordinality)
            WHERE NOT (m.value->>'ym' = ${ym} AND COALESCE(m.value->>'cardId', 'card-default') = ${cardId})
          ), '[]'::jsonb), false), snapshots.version
          FROM snapshots
          WHERE EXISTS (SELECT 1 FROM updated)
          ON CONFLICT (day) DO UPDATE SET data = EXCLUDED.data
          RETURNING 1
        )
        SELECT version FROM updated`;
      if (rows.length) return { ok: true, version: rows[0].version, data };
      const current = await this.get();
      if (!current || current.version !== base) return { ok: false, reason: 'conflict', version: current ? current.version : 0 };
      const month = current.data.months.find((m) => m.ym === ym && (m.cardId || 'card-default') === cardId);
      if (!month) return { ok: false, reason: 'missing', version: current.version };
      if (month.items.some((it) => it.plan)) return { ok: false, reason: 'installment', version: current.version };
      return { ok: false, reason: 'conflict', version: current.version };
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
