import { createHmac, createHash, timingSafeEqual, randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';

const COOKIE = 'cct_session';
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days
const scrypt = promisify(scryptCallback);

const b64 = (s) => Buffer.from(s).toString('base64url');
const sign = (payload, secret) => createHmac('sha256', secret).update(payload).digest('base64url');

/** Compare two strings without leaking their length or content through timing. */
export function safeEqual(a, b) {
  const x = createHash('sha256').update(String(a)).digest();
  const y = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(x, y);
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(password, encoded) {
  if (typeof encoded !== 'string') return false;
  const [scheme, saltHex, keyHex] = encoded.split('$');
  if (scheme !== 'scrypt' || !/^[\da-f]{32}$/i.test(saltHex || '') || !/^[\da-f]{128}$/i.test(keyHex || '')) return false;
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), 64);
  return timingSafeEqual(actual, Buffer.from(keyHex, 'hex'));
}

export function makeToken(secret, now = Date.now()) {
  const payload = b64(JSON.stringify({ exp: now + MAX_AGE * 1000 }));
  return payload + '.' + sign(payload, secret);
}

export function verifyToken(token, secret, now = Date.now()) {
  if (!token || typeof token !== 'string' || !secret) return false;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;
  if (!safeEqual(sig, sign(payload, secret))) return false;
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString()).exp > now; } catch { return false; }
}

export function readCookie(req, name = COOKIE) {
  const raw = req.headers && req.headers.cookie; if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('='); if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function sessionCookie(token, secure) {
  return `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${MAX_AGE}${secure ? '; Secure' : ''}`;
}
export function clearCookie(secure) {
  return `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;
}
export function isAuthed(req, env) { return verifyToken(readCookie(req), env.SESSION_SECRET); }
