// HTTP layer for the dashboard: static files + a small JSON API. No framework, no extra dependencies.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { RunnerError } from './runner.js';
import { ValidationError } from './settings.js';
import { log } from './util.js';

const COOKIE = 'ub_session';
const MAX_BODY = 64 * 1024;

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
};

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

const isSecure = (req, trustProxy) =>
  Boolean(req.socket.encrypted) || (trustProxy && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https');

// DNS-rebinding defence: a hostile web page can point its own domain at this server and the browser would
// happily send requests with that Host. Only accept hosts a private server is normally reached by: IP
// addresses, localhost, bare machine names, typical LAN/VPN suffixes, and whatever ALLOWED_HOSTS adds.
function hostNameOf(header = '') {
  const v6 = header.match(/^\[([^\]]+)\](?::\d+)?$/);
  return (v6 ? v6[1] : header.replace(/:\d+$/, '')).toLowerCase();
}
export function isAllowedHost(header, extra = []) {
  const name = hostNameOf(header);
  if (!name) return false;
  if (net.isIP(name)) return true;
  if (name === 'localhost' || !name.includes('.')) return true;
  if (/\.(localhost|local|lan|home|internal|localdomain|home\.arpa|ts\.net)$/.test(name)) return true;
  return extra.some((h) => (h.startsWith('*.') ? name.endsWith(h.slice(1)) : name === h));
}

// Security events go to `docker logs` only (not the dashboard log or bot.log), and are throttled, so that
// strangers hitting the port can't flood or rotate away the log the owner reads to check progress.
const secSeen = new Map();
function secLog(key, msg) {
  const t = Date.now();
  const prev = secSeen.get(key) ?? { at: 0, skipped: 0 };
  if (t - prev.at < 10_000) {
    prev.skipped += 1;
    secSeen.set(key, prev);
    return;
  }
  secSeen.set(key, { at: t, skipped: 0 });
  if (secSeen.size > 500) secSeen.clear();
  console.log(`${new Date().toISOString()} [security] ${msg}${prev.skipped ? ` (+${prev.skipped} similar in the last 10s)` : ''}`);
}

// Buffers/strings are sent as-is; plain objects are sent as JSON.
function send(res, status, body, headers = {}) {
  const raw = typeof body === 'string' || Buffer.isBuffer(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Cache-Control': 'no-store',
    'Content-Type': raw ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    ...headers,
  });
  res.end(raw ? body : JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'Request too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(v && typeof v === 'object' ? v : {});
      } catch {
        reject(new HttpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function csvFor(file) {
  const rows = ['handle,unfollowed_at'];
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const { handle, at } = JSON.parse(line);
        if (/^[A-Za-z0-9_]{1,15}$/.test(handle)) rows.push(`${handle},${at}`);
      } catch {
        /* skip torn line */
      }
    }
  } catch {
    /* none yet */
  }
  return `${rows.join('\n')}\n`;
}

export function createApp({ runner, auth, webDir, dataDir, allowedHosts = [], trustProxy = false }) {
  const staticCache = new Map();
  const readStatic = (name) => {
    if (!staticCache.has(name)) staticCache.set(name, fs.readFileSync(path.join(webDir, name)));
    return staticCache.get(name);
  };

  return async function handle(req, res) {
    try {
      if (!isAllowedHost(req.headers.host, allowedHosts)) {
        return send(res, 421, 'Host not allowed. If you reach this server by a custom domain name, set ALLOWED_HOSTS=that.name in the dashboard settings file (.web-env) and run ./start-web.sh again.');
      }
      let url;
      try {
        url = new URL(req.url, 'http://localhost');
      } catch {
        return send(res, 400, 'Bad request'); // e.g. "GET //": client error, not worth a log line
      }
      const { pathname } = url;
      const method = req.method;

      if (pathname === '/healthz') return send(res, 200, 'ok');

      if (method === 'GET' && STATIC[pathname]) {
        const [file, type] = STATIC[pathname];
        return send(res, 200, readStatic(file), { 'Content-Type': type, 'Cache-Control': 'no-cache' });
      }

      if (!pathname.startsWith('/api/')) return send(res, 404, 'Not found');

      // CSRF defence in depth (the session cookie is also SameSite=Strict): state-changing
      // requests must be JSON and, when the browser says where they came from, come from this site.
      if (method === 'POST') {
        const origin = req.headers.origin;
        if (origin !== undefined) {
          let originHost = null;
          try {
            originHost = new URL(origin).host; // a literal "null" origin (sandboxed pages) is not valid -> blocked
          } catch {
            /* fall through */
          }
          if (originHost !== req.headers.host) throw new HttpError(403, 'Cross-site request blocked');
        }
        if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
          throw new HttpError(415, 'Content-Type must be application/json');
        }
      } else if (method !== 'GET') {
        throw new HttpError(405, 'Method not allowed');
      }

      const token = parseCookies(req.headers.cookie)[COOKIE];
      const authed = auth.check(token);

      if (pathname === '/api/session' && method === 'GET') return send(res, 200, { authenticated: authed });

      if (pathname === '/api/login' && method === 'POST') {
        const body = await readJson(req);
        const client = req.socket.remoteAddress || '';
        const result = auth.login(body.password, client);
        if (result.ok) {
          secLog(`login-ok:${client}`, `Dashboard login OK from ${client}`);
          const flags = `HttpOnly; SameSite=Strict; Path=/; Max-Age=${auth.ttlSec}${isSecure(req, trustProxy) ? '; Secure' : ''}`;
          return send(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=${result.token}; ${flags}` });
        }
        secLog(`login-fail:${client}`, `Dashboard login FAILED from ${client}${result.locked ? ` (locked out for ${result.retryAfterSec}s)` : ''}`);
        await new Promise((r) => setTimeout(r, auth.failureDelayMs())); // slow down guessing
        if (result.locked) return send(res, 429, { error: 'Too many attempts', retryAfterSec: result.retryAfterSec }, { 'Retry-After': String(result.retryAfterSec) });
        return send(res, 401, { error: 'Wrong password' });
      }

      if (!authed) return send(res, 401, { error: 'unauthorized' });

      if (pathname === '/api/logout' && method === 'POST') {
        auth.logout(token);
        return send(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
      }
      if (pathname === '/api/state' && method === 'GET') return send(res, 200, runner.getState());
      if (pathname === '/api/settings' && method === 'GET') return send(res, 200, runner.getPublicSettings());
      if (pathname === '/api/settings' && method === 'POST') return send(res, 200, runner.updateSettings(await readJson(req)));
      if (pathname === '/api/credentials/forget' && method === 'POST') {
        runner.forgetCredentials();
        return send(res, 200, { ok: true });
      }
      if (pathname === '/api/run' && method === 'POST') {
        const { mode } = await readJson(req);
        runner.start(mode);
        log(`Run started from the dashboard (${mode}).`);
        return send(res, 202, { ok: true });
      }
      if (pathname === '/api/stop' && method === 'POST') {
        runner.stop();
        return send(res, 200, { ok: true });
      }
      if (pathname === '/api/unfollowed.csv' && method === 'GET') {
        return send(res, 200, csvFor(path.join(dataDir, 'unfollowed.jsonl')), {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="unfollowed.csv"',
        });
      }
      return send(res, 404, { error: 'Not found' });
    } catch (e) {
      if (e instanceof ValidationError) return send(res, 400, { error: e.message, field: e.field });
      if (e instanceof RunnerError) return send(res, e.status, { error: e.message });
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      secLog('server-error', `Server error on ${req.method} ${String(req.url).slice(0, 80)}: ${String(e?.message || e).split('\n')[0]}`);
      if (!res.headersSent) return send(res, 500, { error: 'Internal error' });
      res.end();
    }
  };
}
