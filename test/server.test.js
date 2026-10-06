// Integration: the real HTTP server + Runner + bot + Chromium against the mock X.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createAuth } from '../src/auth.js';
import { Runner } from '../src/runner.js';
import { createApp } from '../src/server.js';
import { resetStop } from '../src/util.js';
import { startMockX } from './mock-x.js';

const PASSWORD = 'correct horse battery';
const FAST = {
  delayMinMs: 0,
  delayMaxMs: 20,
  burstSize: 1000,
  maxPerHour: 1000,
  maxPerDay: 1000,
  backoffBaseMs: 300,
  timing: { listWaitMs: 1500, scrollPauseMs: [60, 100], endWaitMs: 300, capJitterMs: [0, 10], failurePauseMs: [20, 40], verifyRetryWaitMs: 50, backoffMarginMs: 20 },
};

function stubWebDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-stub-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>stub</title>');
  fs.writeFileSync(path.join(dir, 'style.css'), 'body{}');
  fs.writeFileSync(path.join(dir, 'app.js'), '// stub');
  return dir;
}

async function boot({ dataDir, overrides = FAST, crashWaitMs = 100, mock, runnerOpts = {}, appOpts = {} }) {
  resetStop();
  const runner = new Runner({ dataDir, configOverride: overrides, crashWaitMs, ...runnerOpts });
  const server = http.createServer(createApp({ runner, auth: createAuth({ password: PASSWORD }), webDir: stubWebDir(), dataDir, ...appOpts }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: { ...(body !== undefined && !headers['content-type'] ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { status: res.status, json, text, headers: res.headers };
  };
  const login = () => call('POST', '/api/login', { password: PASSWORD });
  const saveCookies = (extra = {}) => call('POST', '/api/settings', { authToken: 'good-token', ct0: 'good-ct0', ...extra });
  const waitFor = async (pred, what, ms = 60_000) => {
    const t0 = Date.now();
    for (;;) {
      const { json } = await call('GET', '/api/state');
      if (pred(json)) return json;
      if (Date.now() - t0 > ms) assert.fail(`timed out waiting for ${what}; last state: ${JSON.stringify({ ...json, log: json.log.slice(-5) })}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const close = async () => {
    await runner.shutdown();
    await new Promise((r) => server.close(r));
  };
  return { runner, base, call, login, saveCookies, waitFor, close, mock, port: server.address().port };
}

async function withApp(mockOpts, fn, { overrides, crashWaitMs, seed, runnerOpts, appOpts } = {}) {
  const mock = await startMockX(mockOpts);
  process.env.X_BASE_URL = mock.url;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unfollow-web-'));
  if (seed) seed(dataDir);
  const app = await boot({ dataDir, overrides: overrides ?? FAST, crashWaitMs, mock, runnerOpts, appOpts });
  try {
    await fn({ ...app, mock, dataDir });
  } finally {
    await app.close();
    await mock.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

test('static files are public, everything under /api needs login, security headers present', { timeout: 60_000 }, async () => {
  await withApp({ count: 1 }, async ({ call }) => {
    const page = await call('GET', '/');
    assert.equal(page.status, 200);
    assert.equal(page.text, '<!doctype html><title>stub</title>', 'static files must be served byte-for-byte, not JSON-encoded');
    assert.match(page.headers.get('content-type'), /^text\/html/);
    assert.match((await call('GET', '/style.css')).headers.get('content-type'), /^text\/css/);
    assert.match((await call('GET', '/app.js')).headers.get('content-type'), /^text\/javascript/);
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    assert.equal((await call('GET', '/healthz')).text, 'ok');
    assert.deepEqual((await call('GET', '/api/session')).json, { authenticated: false });
    for (const p of ['/api/state', '/api/settings', '/api/unfollowed.csv']) assert.equal((await call('GET', p)).status, 401, p);
    for (const p of ['/api/run', '/api/stop', '/api/settings', '/api/credentials/forget']) assert.equal((await call('POST', p, {})).status, 401, p);
    assert.equal((await call('GET', '/../../etc/passwd')).status, 404);
    assert.equal((await call('GET', '/package.json')).status, 404);
  });
});

test('login: wrong password 401, right password sets an HttpOnly SameSite=Strict cookie', { timeout: 60_000 }, async () => {
  await withApp({ count: 1 }, async ({ call, login }) => {
    assert.equal((await call('POST', '/api/login', { password: 'nope' })).status, 401);
    const ok = await login();
    assert.equal(ok.status, 200);
    const setCookie = ok.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.ok(!/Secure/.test(setCookie), 'plain http must not set Secure (browser would drop the cookie)');
    assert.deepEqual((await call('GET', '/api/session')).json, { authenticated: true });
    const logout = await call('POST', '/api/logout', {});
    assert.equal(logout.status, 200);
    assert.equal((await call('GET', '/api/state')).status, 401);
  });
});

test('login lockout: 5 wrong guesses lock out even the right password (429 + retryAfterSec)', { timeout: 60_000 }, async () => {
  await withApp({ count: 1 }, async ({ call }) => {
    for (let i = 0; i < 4; i += 1) assert.equal((await call('POST', '/api/login', { password: `bad${i}` })).status, 401);
    const locked = await call('POST', '/api/login', { password: 'bad5' });
    assert.equal(locked.status, 429);
    assert.ok(locked.json.retryAfterSec > 0);
    assert.equal((await call('POST', '/api/login', { password: PASSWORD })).status, 429);
  });
});

test('CSRF: cross-site Origin and non-JSON bodies are refused', { timeout: 60_000 }, async () => {
  await withApp({ count: 1 }, async ({ call, login }) => {
    await login();
    assert.equal((await call('POST', '/api/stop', {}, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await call('POST', '/api/stop', {}, { origin: 'null' })).status, 403);
    assert.equal((await call('POST', '/api/stop', 'x=1', { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await call('POST', '/api/stop', 'x=1', { 'content-type': 'application/x-www-form-urlencoded' })).status, 415);
    assert.equal((await call('POST', '/api/settings', '{not json', { 'content-type': 'application/json' })).status, 400);
    assert.equal((await call('PUT', '/api/settings', {})).status, 405);
  });
});

test('settings: validation errors name the field; cookies are stored 0600 and never returned', { timeout: 60_000 }, async () => {
  await withApp({ count: 1 }, async ({ call, login, dataDir }) => {
    await login();
    assert.deepEqual((await call('POST', '/api/settings', { authToken: 'abcdef0123456789' })).json.field, 'ct0');
    assert.equal((await call('POST', '/api/settings', { pacing: { maxPerDay: 9999 } })).json.field, 'maxPerDay');
    assert.equal((await call('POST', '/api/settings', { keepText: 'ok\nnot ok!' })).json.field, 'keep');
    const saved = await call('POST', '/api/settings', { authToken: 'SECRETAUTH123456', ct0: 'SECRETCT0123456', keepText: '@Alice\nbob' });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.credentialsSaved, true);
    assert.equal(saved.json.keepText, 'Alice\nbob');
    for (const p of ['/api/settings', '/api/state']) {
      const res = await call('GET', p);
      assert.ok(!res.text.includes('SECRETAUTH123456') && !res.text.includes('SECRETCT0123456'), `${p} leaked a cookie`);
    }
    const file = path.join(dataDir, 'settings.json');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    // blank cookie fields keep the saved ones
    assert.equal((await call('POST', '/api/settings', { authToken: '', ct0: '', username: 'me' })).json.credentialsSaved, true);
  });
});

test('run needs cookies; preview lists targets, honours the keep list and unfollows nobody', { timeout: 120_000 }, async () => {
  await withApp({ count: 30 }, async ({ call, login, saveCookies, waitFor, mock }) => {
    await login();
    assert.equal((await call('POST', '/api/run', { mode: 'preview' })).status, 400);
    assert.equal((await call('POST', '/api/run', { mode: 'bogus' })).status, 400);
    await saveCookies({ keepText: 'user003' });
    assert.equal((await call('POST', '/api/run', { mode: 'preview' })).status, 202);
    const st = await waitFor((s) => s.state === 'finished', 'preview to finish');
    assert.equal(st.mode, 'preview');
    assert.equal(st.preview.count, 29);
    assert.equal(st.preview.kept, 1);
    assert.ok(!st.preview.handles.includes('user003'));
    assert.equal(st.followingAtStart, 30);
    assert.equal(mock.state.destroyCalls, 0);
  });
});

test('full run: progress fields, recent list, csv, usage, and a second start is rejected while active', { timeout: 120_000 }, async () => {
  await withApp({ count: 25 }, async ({ call, login, saveCookies, waitFor, mock }) => {
    await login();
    await saveCookies();
    assert.equal((await call('POST', '/api/run', { mode: 'unfollow' })).status, 202);
    assert.equal((await call('POST', '/api/run', { mode: 'unfollow' })).status, 409);
    assert.equal((await call('POST', '/api/credentials/forget', {})).status, 409);
    const mid = await waitFor((s) => s.unfollowedThisRun >= 3, 'some progress');
    assert.ok(['starting', 'running', 'waiting'].includes(mid.state));
    assert.equal(mid.mode, 'unfollow');
    const done = await waitFor((s) => s.state === 'finished', 'run to finish');
    assert.equal(done.unfollowedThisRun, 25);
    assert.equal(done.unfollowedTotal, 25);
    assert.equal(done.me, 'tester');
    assert.equal(done.followingAtStart, 25);
    assert.equal(done.usage.day, 25);
    assert.equal(done.recent.length, 15);
    assert.match(done.message, /All done/);
    assert.ok(done.log.some((l) => /Unfollowed @user000/.test(l)));
    assert.equal(mock.state.following.length, 0);
    const csv = await call('GET', '/api/unfollowed.csv');
    assert.match(csv.headers.get('content-disposition'), /attachment/);
    assert.equal(csv.text.trim().split('\n').length, 26);
    assert.equal((await call('POST', '/api/credentials/forget', {})).status, 200);
    assert.equal((await call('GET', '/api/settings')).json.credentialsSaved, false);
  });
});

test('stop button halts a run cleanly; the run can be started again and continues', { timeout: 120_000 }, async () => {
  const slow = { ...FAST, delayMinMs: 150, delayMaxMs: 200 };
  await withApp({ count: 40 }, async ({ call, login, saveCookies, waitFor, mock, dataDir }) => {
    await login();
    await saveCookies();
    await call('POST', '/api/run', { mode: 'unfollow' });
    await waitFor((s) => s.unfollowedThisRun >= 3, 'progress before stopping');
    assert.equal((await call('POST', '/api/stop', {})).status, 200);
    const stopped = await waitFor((s) => s.state === 'stopped', 'stopped');
    assert.ok(stopped.unfollowedThisRun >= 3 && stopped.unfollowedThisRun < 40);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'job.json'), 'utf8')).desired, null);
    const left = mock.state.following.length;
    assert.ok(left > 0);
    await call('POST', '/api/run', { mode: 'unfollow' });
    await waitFor((s) => s.state === 'finished', 'second run to finish');
    assert.equal(mock.state.following.length, 0);
    assert.equal((await call('GET', '/api/state')).json.unfollowedTotal, 40);
  }, { overrides: slow });
});

test('a dropped connection is retried automatically instead of killing the run', { timeout: 120_000 }, async () => {
  await withApp({ count: 5, homeFault: (n) => n <= 3 }, async ({ call, login, saveCookies, waitFor, mock }) => {
    await login();
    await saveCookies();
    await call('POST', '/api/run', { mode: 'unfollow' });
    const waiting = await waitFor((s) => s.state === 'waiting' || s.state === 'finished', 'recovery wait or finish');
    if (waiting.state === 'waiting') assert.match(waiting.wait.reason, /unexpected error/i);
    const done = await waitFor((s) => s.state === 'finished', 'run to finish after retry');
    assert.equal(mock.state.following.length, 0);
    assert.ok(done.log.some((l) => /Unexpected error/.test(l)));
    assert.ok(done.log.some((l) => /Retrying in/.test(l)));
  });
});

test('wrong cookies end in a clear error state (no retry loop)', { timeout: 120_000 }, async () => {
  await withApp({ count: 3 }, async ({ call, login, waitFor, dataDir }) => {
    await login();
    await call('POST', '/api/settings', { authToken: 'expired-token-123', ct0: 'whatever-ct0-123' });
    await call('POST', '/api/run', { mode: 'unfollow' });
    const st = await waitFor((s) => s.state === 'error', 'error state');
    assert.match(st.error, /Not logged in/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'job.json'), 'utf8')).desired, null);
    // and it can be fixed and re-run
    assert.equal((await call('POST', '/api/settings', { authToken: 'good-token', ct0: 'good-ct0' })).status, 200);
    assert.equal((await call('POST', '/api/run', { mode: 'preview' })).status, 202);
    await waitFor((s) => s.state === 'finished', 'preview after fixing cookies');
  });
});

test('repeated 429s end in the rate-limited state with a plain-English explanation', { timeout: 120_000 }, async () => {
  const overrides = { ...FAST, maxBackoffs: 1, backoffBaseMs: 100 };
  await withApp({ count: 6, destroyFault: (n) => (n >= 3 ? { status: 429, code: 88 } : null) }, async ({ call, login, saveCookies, waitFor }) => {
    await login();
    await saveCookies();
    await call('POST', '/api/run', { mode: 'unfollow' });
    const waiting = await waitFor((s) => s.state === 'waiting' || s.state === 'rate-limited', 'backoff wait');
    if (waiting.state === 'waiting') assert.match(waiting.wait.reason, /slow down/i);
    const st = await waitFor((s) => s.state === 'rate-limited', 'rate-limited state');
    assert.match(st.error, /slow down/i);
    assert.equal(st.unfollowedThisRun, 2);
  }, { overrides });
});

test('hitting the hourly cap shows a waiting state with a countdown target and the reason', { timeout: 120_000 }, async () => {
  const seed = (dir) => fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ actions: [1, 2, 3].map((i) => Date.now() - 3600_000 + 4000 + i) }));
  await withApp({ count: 2 }, async ({ call, login, saveCookies, waitFor }) => {
    await login();
    await saveCookies();
    await call('POST', '/api/run', { mode: 'unfollow' });
    const st = await waitFor((s) => s.state === 'waiting', 'cap wait');
    assert.match(st.wait.reason, /Hourly limit/);
    assert.ok(st.wait.until > st.serverTime);
    assert.ok(st.wait.until - st.serverTime < 6000);
    await waitFor((s) => s.state === 'finished', 'finish after cap frees up');
  }, { overrides: { ...FAST, maxPerHour: 3 }, seed });
});

test('a run that was active when the server stopped resumes by itself after restart', { timeout: 180_000 }, async () => {
  const slow = { ...FAST, delayMinMs: 150, delayMaxMs: 200 };
  const mock = await startMockX({ count: 30 });
  process.env.X_BASE_URL = mock.url;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unfollow-resume-'));
  try {
    const first = await boot({ dataDir, overrides: slow });
    await first.login();
    await first.saveCookies();
    await first.call('POST', '/api/run', { mode: 'unfollow' });
    await first.waitFor((s) => s.unfollowedThisRun >= 3, 'progress before restart');
    await first.close(); // like `docker stop`: graceful, must NOT clear the "keep running" intent
    const remaining = mock.state.following.length;
    assert.ok(remaining > 0 && remaining < 30);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'job.json'), 'utf8')).desired, 'unfollow');

    const second = await boot({ dataDir, overrides: FAST });
    assert.equal(second.runner.autoResume(), true);
    await second.login();
    const done = await second.waitFor((s) => s.state === 'finished', 'resumed run to finish');
    assert.equal(mock.state.following.length, 0);
    assert.equal(done.unfollowedTotal, 30, 'history survives the restart');
    assert.ok(done.log.some((l) => /Resuming the unfollow run/.test(l)));
    await second.close();
  } finally {
    await mock.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('after a stop + restart the page still shows the last result (no blank state)', { timeout: 120_000 }, async () => {
  const mock = await startMockX({ count: 4 });
  process.env.X_BASE_URL = mock.url;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unfollow-persist-'));
  try {
    const first = await boot({ dataDir });
    await first.login();
    await first.saveCookies();
    await first.call('POST', '/api/run', { mode: 'unfollow' });
    await first.waitFor((s) => s.state === 'finished', 'finish');
    await first.close();

    const second = await boot({ dataDir });
    assert.equal(second.runner.autoResume(), false);
    await second.login();
    const st = (await second.call('GET', '/api/state')).json;
    assert.equal(st.state, 'finished');
    assert.equal(st.unfollowedTotal, 4);
    assert.equal(st.recent.length, 4);
    assert.ok(st.log.length > 0, 'log history survives');
    await second.close();
  } finally {
    await mock.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// Regression tests for problems found in review
// ---------------------------------------------------------------------------------------------

const rawGet = (port, requestPath, headers) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: requestPath, method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });

test('Host allowlist blocks DNS-rebinding names but accepts IPs, bare names, LAN names and ALLOWED_HOSTS', { timeout: 60_000 }, async () => {
  await withApp({ count: 1 }, async ({ port }) => {
    for (const host of ['attacker.example.com', 'evil.test:8080', 'myserver.example.org']) {
      assert.equal((await rawGet(port, '/healthz', { host })).status, 421, host);
    }
    for (const host of ['localhost:8080', '127.0.0.1', '192.168.1.20:8080', '[::1]:8080', 'nas', 'nas.local', 'box.lan', 'srv.tail1234.ts.net', 'files.home.example.org']) {
      assert.equal((await rawGet(port, '/healthz', { host })).status, 200, host);
    }
  }, { appOpts: { allowedHosts: ['*.home.example.org'] } });
});

test('malformed request targets get a quiet 400 and cannot flood the dashboard log', { timeout: 60_000 }, async () => {
  await withApp({ count: 1 }, async ({ port, call, login }) => {
    await login();
    for (let i = 0; i < 40; i += 1) assert.equal((await rawGet(port, '//', {})).status, 400);
    const st = (await call('GET', '/api/state')).json;
    assert.ok(!st.log.some((l) => /Server error|Invalid URL|login/i.test(l)), 'client errors and logins must not reach the user-facing log');
  });
});

test('Stop during a preview reports "stopped" and does not replace the saved preview with a partial one', { timeout: 120_000 }, async () => {
  await withApp({ count: 300 }, async ({ call, login, saveCookies, waitFor, dataDir }) => {
    await login();
    await saveCookies();
    fs.writeFileSync(path.join(dataDir, 'preview.json'), JSON.stringify({ count: 7, kept: 0, handles: ['old'] }));
    await call('POST', '/api/run', { mode: 'preview' });
    await waitFor((s) => s.state === 'running', 'preview scanning');
    await call('POST', '/api/stop', {});
    const st = await waitFor((s) => s.state === 'stopped', 'stopped preview');
    assert.match(st.message, /Preview stopped/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'preview.json'), 'utf8')).count, 7, 'the previous good preview is untouched');
  }, { overrides: { ...FAST, timing: { ...FAST.timing, scrollPauseMs: [300, 400] } } });
});

test('a list X stops serving mid-run ends as an error with an explanation, not a happy "finished"', { timeout: 120_000 }, async () => {
  await withApp({ count: 60, listFault: (n) => (n >= 2 ? { empty: true } : null) }, async ({ call, login, saveCookies, waitFor }) => {
    await login();
    await saveCookies();
    await call('POST', '/api/run', { mode: 'unfollow' });
    const st = await waitFor((s) => s.state === 'error' || s.state === 'finished', 'end of run');
    assert.equal(st.state, 'error');
    assert.match(st.error, /profile says/);
  });
});

test('a wedged browser page cannot make Stop useless: Stop force-closes it and a new run can start', { timeout: 120_000 }, async () => {
  await withApp({ count: 30, destroyWedge: (n) => n === 3 }, async ({ call, login, saveCookies, waitFor, mock }) => {
    await login();
    await saveCookies();
    await call('POST', '/api/run', { mode: 'unfollow' });
    for (let i = 0; i < 300 && mock.state.destroyCalls < 3; i += 1) await new Promise((r) => setTimeout(r, 100)); // the 3rd unfollow wedges the page
    assert.ok(mock.state.destroyCalls >= 3, 'the wedge was triggered');
    await new Promise((r) => setTimeout(r, 1500)); // the page is now spinning forever
    assert.equal((await call('POST', '/api/stop', {})).status, 200);
    const st = await waitFor((s) => s.state === 'stopped', 'stopped despite the wedge', 30_000);
    assert.ok(st.log.some((l) => /closing the browser by force/.test(l)));
    assert.equal((await call('POST', '/api/run', { mode: 'preview' })).status, 202, 'not stuck with "already active"');
    await waitFor((s) => s.state === 'finished', 'a fresh run works');
  }, { runnerOpts: { stopGraceMs: 800 } });
});

test('the watchdog recovers a wedged page by itself; progress totals survive the retry', { timeout: 180_000 }, async () => {
  await withApp({ count: 12, destroyWedge: (n) => n === 4 }, async ({ call, login, saveCookies, waitFor, mock }) => {
    await login();
    await saveCookies();
    await call('POST', '/api/run', { mode: 'unfollow' });
    const done = await waitFor((s) => s.state === 'finished', 'recovery and completion', 90_000);
    assert.equal(mock.state.following.length, 0);
    assert.ok(done.log.some((l) => /silent for/.test(l)), 'the watchdog fired');
    assert.equal(done.followingAtStart, 12, 'the denominator is the original total, not what was left after the retry');
    // Cumulative across the retry. The one unfollow in flight at the moment the page wedged may be unrecorded:
    // a hung renderer can't report that X accepted it.
    assert.ok(done.unfollowedThisRun >= 11 && done.unfollowedThisRun <= 12, `cumulative count, got ${done.unfollowedThisRun}`);
  }, { runnerOpts: { watchdogMs: 6000 } });
});

test('an unwritable job file (full or read-only disk) never stops the bot from starting or stopping', { timeout: 120_000 }, async () => {
  const seed = (dir) => fs.mkdirSync(path.join(dir, 'job.json')); // a directory where the file should be: every write fails
  await withApp({ count: 40 }, async ({ call, login, saveCookies, waitFor, mock }) => {
    await login();
    await saveCookies();
    assert.equal((await call('POST', '/api/run', { mode: 'unfollow' })).status, 202, 'start still works');
    await waitFor((s) => s.unfollowedThisRun >= 3, 'progress');
    assert.equal((await call('POST', '/api/stop', {})).status, 200, 'stop still works');
    await waitFor((s) => s.state === 'stopped', 'stopped');
    assert.ok(mock.state.following.length > 0);
    assert.equal((await call('POST', '/api/run', { mode: 'preview' })).status, 202, 'and the runner is not left stuck');
  }, { seed, overrides: { ...FAST, delayMinMs: 150, delayMaxMs: 200 } });
});

test('cookie cleaning accepts the ways people actually copy them', { timeout: 60_000 }, async () => {
  await withApp({ count: 1 }, async ({ call, login }) => {
    await login();
    for (const [a, c] of [['"auth_token=abcdef0123456789;"', 'ct0=0123456789abcdef'], ['auth_token="abcdef0123456789"', '"0123456789abcdef"']]) {
      const r = await call('POST', '/api/settings', { authToken: a, ct0: c });
      assert.equal(r.status, 200, a);
      assert.equal(r.json.credentialsSaved, true);
    }
  });
});
