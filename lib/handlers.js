import { safeEqual, makeToken, sessionCookie, clearCookie, isAuthed } from './auth.js';
import { validateState } from '../public/logic.js';
import seed from './seed.js';

const MAX_BODY = 2_000_000; // bytes; Vercel itself stops at 4.5 MB

function send(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') return req.body ? JSON.parse(req.body) : {};
    if (Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString() || '{}');
    return req.body;
  }
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > MAX_BODY) throw Object.assign(new Error('Too large'), { status: 413 }); chunks.push(c); }
  const raw = Buffer.concat(chunks).toString();
  return raw ? JSON.parse(raw) : {};
}

const secure = (req) => (req.headers['x-forwarded-proto'] || '').split(',')[0] === 'https';
const needsJson = (req) => /application\/json/i.test(req.headers['content-type'] || '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function configProblem(env) {
  if (!env.APP_PASSWORD) return 'APP_PASSWORD is not set.';
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 16) return 'SESSION_SECRET is missing or shorter than 16 characters.';
  return null;
}

/** POST /api/login {password} */
export async function login(req, res, { env }) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST.' });
  const problem = configProblem(env); if (problem) return send(res, 500, { error: problem });
  if (!needsJson(req)) return send(res, 415, { error: 'Send JSON.' });
  let body; try { body = await readJson(req); } catch { return send(res, 400, { error: 'Bad request.' }); }
  const ok = typeof body.password === 'string' && safeEqual(body.password, env.APP_PASSWORD);
  if (!ok) { await sleep(env.NODE_ENV === 'test' ? 0 : 600); return send(res, 401, { error: 'Wrong password.' }); }
  return send(res, 200, { ok: true }, { 'set-cookie': sessionCookie(makeToken(env.SESSION_SECRET), secure(req)) });
}

/** POST /api/logout */
export async function logout(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST.' });
  return send(res, 200, { ok: true }, { 'set-cookie': clearCookie(secure(req)) });
}

/** GET /api/state, PUT /api/state {baseVersion, data} */
export async function state(req, res, { env, store }) {
  const problem = configProblem(env); if (problem) return send(res, 500, { error: problem });
  if (!isAuthed(req, env)) return send(res, 401, { error: 'Sign in first.' });
  try {
    if (req.method === 'GET') {
      let row = await store.get();
      if (!row) row = await store.init(seed); // first sign-in: load the starting data once
      return send(res, 200, { version: row.version, data: row.data });
    }
    if (req.method === 'PUT') {
      if (!needsJson(req)) return send(res, 415, { error: 'Send JSON.' });
      let body; try { body = await readJson(req); } catch (e) { return send(res, e.status || 400, { error: 'Bad request.' }); }
      if (!Number.isInteger(body.baseVersion)) return send(res, 400, { error: 'baseVersion is required.' });
      const v = validateState(body.data);
      if (!v.ok) return send(res, 422, { error: v.error });
      const out = await store.put(body.data, body.baseVersion);
      if (!out.ok) return send(res, 409, { error: 'The data changed somewhere else. Reload to get the latest.', version: out.version });
      return send(res, 200, { ok: true, version: out.version });
    }
    return send(res, 405, { error: 'Use GET or PUT.' });
  } catch (e) {
    console.error('state error', e);
    return send(res, 500, { error: 'The database did not answer. Try again in a moment.' });
  }
}
