import { test } from 'node:test';
import assert from 'node:assert/strict';
import { login, logout, state, changePassword } from '../lib/handlers.js';
import { memoryStore, fileStore } from '../lib/store.js';
import { makeToken, verifyToken } from '../lib/auth.js';
import seed from '../lib/seed.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const env = { APP_PASSWORD: 'correct horse battery', SESSION_SECRET: 'x'.repeat(40), NODE_ENV: 'test' };

function call(handler, { method = 'GET', body, headers = {}, ctx }) {
  return new Promise((resolve) => {
    const req = { method, headers: { 'content-type': 'application/json', ...headers }, body };
    const out = { headers: {}, statusCode: 200 };
    const res = { setHeader: (k, v) => { out.headers[k.toLowerCase()] = v; }, set statusCode(v) { out.statusCode = v; }, get statusCode() { return out.statusCode; }, end: (s) => { out.body = s ? JSON.parse(s) : null; resolve(out); } };
    handler(req, res, ctx);
  });
}
async function signIn(ctx) {
  const r = await call(login, { method: 'POST', body: { password: env.APP_PASSWORD }, ctx });
  assert.equal(r.statusCode, 200);
  return r.headers['set-cookie'].split(';')[0];
}

test('login: wrong password is refused, right password sets an HttpOnly cookie', async () => {
  const ctx = { env, store: memoryStore() };
  assert.equal((await call(login, { method: 'POST', body: { password: 'nope' }, ctx })).statusCode, 401);
  assert.equal((await call(login, { method: 'POST', body: {}, ctx })).statusCode, 401);
  assert.equal((await call(login, { method: 'GET', ctx })).statusCode, 405);
  const ok = await call(login, { method: 'POST', body: { password: env.APP_PASSWORD }, headers: { 'x-forwarded-proto': 'https' }, ctx });
  assert.equal(ok.statusCode, 200);
  assert.match(ok.headers['set-cookie'], /HttpOnly/); assert.match(ok.headers['set-cookie'], /Secure/); assert.match(ok.headers['set-cookie'], /SameSite=Strict/);
});

test('login refuses to run without a configured password and secret', async () => {
  const r = await call(login, { method: 'POST', body: { password: 'a' }, ctx: { env: { SESSION_SECRET: 'x'.repeat(40) }, store: memoryStore() } });
  assert.equal(r.statusCode, 500);
});

test('password changes require authentication and the current password, then replace the login password', async () => {
  const store = memoryStore(), ctx = { env, store }, cookie = await signIn(ctx);
  assert.equal((await call(changePassword, { method: 'POST', body: { currentPassword: env.APP_PASSWORD, newPassword: 'short' }, headers: { cookie }, ctx })).statusCode, 422);
  assert.equal((await call(changePassword, { method: 'POST', body: { currentPassword: 'wrong', newPassword: 'a much stronger password' }, headers: { cookie }, ctx })).statusCode, 401);
  assert.equal((await call(changePassword, { method: 'POST', body: { currentPassword: env.APP_PASSWORD, newPassword: 'a much stronger password' }, headers: { cookie }, ctx })).statusCode, 200);
  assert.equal((await call(login, { method: 'POST', body: { password: env.APP_PASSWORD }, ctx })).statusCode, 401);
  assert.equal((await call(login, { method: 'POST', body: { password: 'a much stronger password' }, ctx })).statusCode, 200);
  assert.equal((await call(state, { ctx, headers: { cookie } })).statusCode, 200, 'the current session remains active');
});

test('configured password reset replaces the stored hash without touching tracker data', async () => {
  const store = memoryStore(), ctx = { env, store }, cookie = await signIn(ctx);
  const before = await call(state, { ctx, headers: { cookie } });
  const resetCtx = { env: { ...env, APP_PASSWORD: 'replacement password for test', APP_PASSWORD_RESET: 'true' }, store };
  assert.equal((await call(login, { method: 'POST', body: { password: 'replacement password for test' }, ctx: resetCtx })).statusCode, 200);
  assert.equal((await call(login, { method: 'POST', body: { password: env.APP_PASSWORD }, ctx })).statusCode, 401);
  assert.equal((await call(login, { method: 'POST', body: { password: 'replacement password for test' }, ctx })).statusCode, 200);
  const after = await call(state, { ctx, headers: { cookie } });
  assert.deepEqual(after.body.data, before.body.data);
});

test('state: no cookie, a forged cookie, a tampered cookie and an expired cookie are all refused', async () => {
  const ctx = { env, store: memoryStore() };
  assert.equal((await call(state, { ctx })).statusCode, 401);
  assert.equal((await call(state, { ctx, headers: { cookie: 'cct_session=abc.def' } })).statusCode, 401);
  const good = makeToken(env.SESSION_SECRET); const [p, s] = good.split('.');
  assert.equal((await call(state, { ctx, headers: { cookie: `cct_session=${p}.${s.slice(0, -2)}xx` } })).statusCode, 401);
  const forged = makeToken('another-secret-another-secret-123456');
  assert.equal((await call(state, { ctx, headers: { cookie: `cct_session=${forged}` } })).statusCode, 401);
  assert.equal(verifyToken(makeToken(env.SESSION_SECRET, 0), env.SESSION_SECRET, Date.now()), false, 'expired');
});

test('state: first sign-in loads the starting data once, saves bump the version, stale saves are refused', async () => {
  const ctx = { env, store: memoryStore() }, cookie = await signIn(ctx);
  const first = await call(state, { ctx, headers: { cookie } });
  assert.equal(first.statusCode, 200); assert.equal(first.body.version, 1);
  assert.equal(first.body.data.months.length, seed.months.length);

  const data = structuredClone(first.body.data); data.limit = 120000;
  const put = await call(state, { method: 'PUT', ctx, headers: { cookie }, body: { baseVersion: 1, data } });
  assert.equal(put.statusCode, 200); assert.equal(put.body.version, 2);

  const again = await call(state, { ctx, headers: { cookie } });
  assert.equal(again.body.data.limit, 120000); assert.equal(again.body.version, 2);

  const stale = await call(state, { method: 'PUT', ctx, headers: { cookie }, body: { baseVersion: 1, data } });
  assert.equal(stale.statusCode, 409);
  assert.equal((await call(state, { ctx, headers: { cookie } })).body.version, 2, 'a refused save changes nothing');
});

test('state: data that does not add up is rejected and never stored', async () => {
  const ctx = { env, store: memoryStore() }, cookie = await signIn(ctx);
  const first = await call(state, { ctx, headers: { cookie } });
  const bad = structuredClone(first.body.data); bad.months[0].items[0].a += 1;
  const r = await call(state, { method: 'PUT', ctx, headers: { cookie }, body: { baseVersion: 1, data: bad } });
  assert.equal(r.statusCode, 422);
  assert.equal((await call(state, { ctx, headers: { cookie } })).body.version, 1);
  assert.equal((await call(state, { method: 'PUT', ctx, headers: { cookie }, body: { data: first.body.data } })).statusCode, 400, 'baseVersion required');
  assert.equal((await call(state, { method: 'PUT', ctx, headers: { cookie, 'content-type': 'text/plain' }, body: 'x' })).statusCode, 415);
  assert.equal((await call(state, { method: 'DELETE', ctx, headers: { cookie } })).statusCode, 405);
});

test('logout clears the cookie', async () => {
  const r = await call(logout, { method: 'POST', ctx: {} });
  assert.match(r.headers['set-cookie'], /Max-Age=0/);
});

test('file store behaves like the memory store (used by npm run dev)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cct-')), store = fileStore(path.join(dir, 's.json'));
  assert.equal(await store.get(), null);
  const row = await store.init(seed); assert.equal(row.version, 1);
  assert.deepEqual(await store.put({ ...seed, limit: 1 }, 1), { ok: true, version: 2 });
  assert.deepEqual(await store.put({ ...seed, limit: 2 }, 1), { ok: false, version: 2 });
  fs.rmSync(dir, { recursive: true });
});
