import { safeEqual, hashPassword, verifyPassword, makeToken, sessionCookie, clearCookie, isAuthed } from './auth.js';
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
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 16) return 'SESSION_SECRET is missing or shorter than 16 characters.';
  return null;
}

async function matchesPassword(password, { env, store }) {
  const stored = await store.getPasswordHash();
  if (stored) return verifyPassword(password, stored);
  if (!env.APP_PASSWORD) return false;
  const valid = safeEqual(password, env.APP_PASSWORD);
  if (valid) {
    const initialized = await store.initPasswordHash(await hashPassword(password));
    return verifyPassword(password, initialized);
  }
  return false;
}

/** POST /api/login {password} */
export async function login(req, res, { env, store }) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST.' });
  const problem = configProblem(env); if (problem) return send(res, 500, { error: problem });
  if (!needsJson(req)) return send(res, 415, { error: 'Send JSON.' });
  let body; try { body = await readJson(req); } catch { return send(res, 400, { error: 'Bad request.' }); }
  if (env.APP_PASSWORD_RESET === 'true') {
    if (typeof env.APP_PASSWORD !== 'string' || env.APP_PASSWORD.length < 8) return send(res, 500, { error: 'Set APP_PASSWORD to a value of at least 8 characters before enabling password reset.' });
    await store.setPasswordHash(await hashPassword(env.APP_PASSWORD));
  }
  const saved = await store.getPasswordHash();
  if (!saved && !env.APP_PASSWORD) return send(res, 500, { error: 'APP_PASSWORD is not set.' });
  const ok = typeof body.password === 'string' && await matchesPassword(body.password, { env, store });
  if (!ok) { await sleep(env.NODE_ENV === 'test' ? 0 : 600); return send(res, 401, { error: 'Wrong password.' }); }
  return send(res, 200, { ok: true }, { 'set-cookie': sessionCookie(makeToken(env.SESSION_SECRET), secure(req)) });
}

/** POST /api/password {currentPassword, newPassword}; authenticated password change. */
export async function changePassword(req, res, { env, store }) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST.' });
  const problem = configProblem(env); if (problem) return send(res, 500, { error: problem });
  if (!isAuthed(req, env)) return send(res, 401, { error: 'Sign in first.' });
  if (!needsJson(req)) return send(res, 415, { error: 'Send JSON.' });
  let body; try { body = await readJson(req); } catch { return send(res, 400, { error: 'Bad request.' }); }
  if (typeof body.currentPassword !== 'string' || typeof body.newPassword !== 'string') return send(res, 400, { error: 'Enter your current and new passwords.' });
  if (body.newPassword.length < 8) return send(res, 422, { error: 'The new password must be at least 8 characters.' });
  if (!await matchesPassword(body.currentPassword, { env, store })) return send(res, 401, { error: 'Your current password is incorrect.' });
  await store.setPasswordHash(await hashPassword(body.newPassword));
  return send(res, 200, { ok: true });
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
      // Polling clients only need the full document when its version changes.
      if (req.headers['x-state-version'] === String(row.version)) return send(res, 200, { version: row.version, unchanged: true });
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

/** GET /api/storage: current database size, available only to an authenticated user. */
export async function storage(req, res, { env, store }) {
  const problem = configProblem(env); if (problem) return send(res, 500, { error: problem });
  if (!isAuthed(req, env)) return send(res, 401, { error: 'Sign in first.' });
  if (req.method !== 'GET') return send(res, 405, { error: 'Use GET.' });
  try { return send(res, 200, await store.storageUsage()); }
  catch (e) {
    console.error('storage usage error', e);
    return send(res, 500, { error: 'Could not read database storage usage.' });
  }
}

/** POST /api/month {ym, baseVersion, data}: remove one month and its historical safety copies. */
export async function deleteMonth(req, res, { env, store }) {
  const problem = configProblem(env); if (problem) return send(res, 500, { error: problem });
  if (!isAuthed(req, env)) return send(res, 401, { error: 'Sign in first.' });
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST.' });
  if (!needsJson(req)) return send(res, 415, { error: 'Send JSON.' });
  let body; try { body = await readJson(req); } catch { return send(res, 400, { error: 'Bad request.' }); }
  const cardId = typeof body.cardId === 'string' ? body.cardId : 'card-default';
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(body.ym || '') || !Number.isInteger(body.baseVersion)) return send(res, 400, { error: 'A valid month and current version are required.' });
  const valid = validateState(body.data);
  if (!valid.ok) return send(res, 422, { error: valid.error });
  if (body.data.months.some((m) => m.ym === body.ym && (m.cardId || 'card-default') === cardId)) return send(res, 400, { error: 'The selected month is still in the submitted data.' });
  try {
    const result = await store.deleteMonth(body.ym, body.baseVersion, body.data, cardId);
    if (!result.ok) {
      if (result.reason === 'installment') return send(res, 422, { error: 'This month contains installment payments. Delete the linked installment plan first, then try again.' });
      if (result.reason === 'missing') return send(res, 404, { error: 'That month no longer exists. Reload and try again.' });
      return send(res, 409, { error: 'The data changed on another device. Reload before deleting a month.', version: result.version });
    }
    return send(res, 200, { ok: true, version: result.version, data: result.data });
  } catch (e) {
    console.error('month deletion error', e);
    return send(res, 500, { error: 'The month could not be deleted. Try again in a moment.' });
  }
}
