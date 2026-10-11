// Local server: serves public/ and the /api routes. Uses .data/state.json when DATABASE_URL is empty.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { login, logout, state } from '../lib/handlers.js';
import { getStore } from '../lib/store.js';

// Read .env.local / .env if present (no extra dependency).
for (const f of ['.env.local', '.env']) {
  try {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m && !(m[1] in process.env) && m[2]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* file not present */ }
}
const env = process.env;
if (!env.APP_PASSWORD) env.APP_PASSWORD = 'dev-password';
if (!env.SESSION_SECRET) env.SESSION_SECRET = 'dev-secret-dev-secret-dev-secret';

const root = path.resolve('public');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };
const port = +env.PORT || 3000;

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/login') return await login(req, res, { env });
    if (url.pathname === '/api/logout') return await logout(req, res);
    if (url.pathname === '/api/state') return await state(req, res, { env, store: await getStore(env) });
    let p = path.join(root, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.statusCode = 404; return res.end('Not found'); }
    res.setHeader('content-type', types[path.extname(p)] || 'application/octet-stream');
    fs.createReadStream(p).pipe(res);
  } catch (e) { console.error(e); res.statusCode = 500; res.end('Server error'); }
}).listen(port, () => console.log(`CC Tracker on http://localhost:${port}  (password: ${env.APP_PASSWORD === 'dev-password' ? 'dev-password' : 'from your .env.local'})`));
