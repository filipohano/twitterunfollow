// One shared password protects the dashboard (it holds the keys to an X account).
import crypto from 'node:crypto';

const SESSION_TTL_MS = 14 * 24 * 3600_000;
const FREE_ATTEMPTS = 5;
const MAX_CLIENTS = 2000;
const PRESSURE_WINDOW_MS = 10 * 60_000;
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();

export function createAuth({ password, now = Date.now }) {
  const expected = sha256(password);
  const sessions = new Map(); // token -> expiry (ms)
  const clients = new Map(); // client id (remote address) -> { failures, lockedUntil, last }
  let recentFailures = []; // timestamps of failed logins from anyone, for the global "pressure" delay

  const prune = (t) => {
    if (clients.size <= MAX_CLIENTS) return;
    for (const [id, c] of clients) if (c.lockedUntil < t && t - c.last > 3600_000) clients.delete(id);
  };

  return {
    // Brute-force protection is PER CLIENT: after 5 wrong guesses from one address, that address is refused
    // (even with the right password) for a while, doubling with each further failure (max 1 hour). One
    // stranger therefore cannot lock the owner out, which a single shared counter would allow.
    login(candidate, client = '') {
      const t = now();
      prune(t);
      const c = clients.get(client) ?? { failures: 0, lockedUntil: 0, last: t };
      c.last = t;
      if (t < c.lockedUntil) return { ok: false, locked: true, retryAfterSec: Math.ceil((c.lockedUntil - t) / 1000) };
      if (typeof candidate === 'string' && candidate.length <= 1024 && crypto.timingSafeEqual(sha256(candidate), expected)) {
        clients.delete(client);
        const token = crypto.randomBytes(32).toString('hex');
        sessions.set(token, t + SESSION_TTL_MS);
        return { ok: true, token };
      }
      c.failures += 1;
      clients.set(client, c);
      recentFailures.push(t);
      if (c.failures >= FREE_ATTEMPTS) {
        c.lockedUntil = t + Math.min(3600_000, 30_000 * 2 ** (c.failures - FREE_ATTEMPTS));
        return { ok: false, locked: true, retryAfterSec: Math.ceil((c.lockedUntil - t) / 1000) };
      }
      return { ok: false, locked: false };
    },
    // Extra delay (ms) to put on FAILED logins when many guesses are arriving from everywhere (a distributed
    // attack). It only slows wrong guesses down; it never refuses the right password.
    failureDelayMs() {
      const t = now();
      recentFailures = recentFailures.filter((x) => x > t - PRESSURE_WINDOW_MS);
      return recentFailures.length > 100 ? 2000 : 400;
    },
    check(token) {
      if (!token) return false;
      const expiry = sessions.get(token);
      if (!expiry) return false;
      if (expiry < now()) {
        sessions.delete(token);
        return false;
      }
      return true;
    },
    logout(token) {
      sessions.delete(token);
    },
    ttlSec: SESSION_TTL_MS / 1000,
  };
}
