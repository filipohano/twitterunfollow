// End-to-end: the real bot + real Chromium against the mock X in test/mock-x.js.
// Needs a Chromium: `npx playwright-core install chromium`, or set CHROMIUM_PATH.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../src/bot.js';
import { loadConfig } from '../src/config.js';
import { FatalError } from '../src/x.js';
import { requestStop, resetStop } from '../src/util.js';
import { startMockX } from './mock-x.js';

async function withMock(opts, fn, { env = {}, mutate, seedActions } = {}) {
  resetStop();
  const mock = await startMockX(opts);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unfollow-test-'));
  if (seedActions) fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ actions: seedActions }));
  const cfg = loadConfig({
    X_BASE_URL: mock.url,
    TWITTER_AUTH_TOKEN: 'good-token',
    TWITTER_CT0: 'good-ct0',
    DATA_DIR: dataDir,
    DELAY_MIN_SEC: '0',
    DELAY_MAX_SEC: '0.02',
    BURST_SIZE: '1000',
    BACKOFF_BASE_SEC: '0.3',
    MAX_PER_HOUR: '1000',
    MAX_PER_DAY: '1000',
    ...env,
  });
  cfg.chromiumPath = process.env.CHROMIUM_PATH || cfg.chromiumPath;
  cfg.timing = { listWaitMs: 1500, scrollPauseMs: [60, 100], endWaitMs: 300, capJitterMs: [0, 10], failurePauseMs: [20, 40], verifyRetryWaitMs: 50, backoffMarginMs: 20 };
  mutate?.(cfg);
  try {
    await fn({ mock, cfg, dataDir });
  } finally {
    await mock.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

test('unfollows everyone across paginated, scrolled results and records them', { timeout: 120_000 }, async () => {
  await withMock({ count: 45 }, async ({ mock, cfg, dataDir }) => {
    const summary = await run(cfg);
    assert.equal(summary.status, 'done');
    assert.equal(summary.unfollowed, 45);
    assert.equal(mock.state.following.length, 0);
    assert.equal(new Set(mock.state.destroyed).size, 45);
    const log = fs.readFileSync(path.join(dataDir, 'unfollowed.jsonl'), 'utf8').trim().split('\n');
    assert.equal(log.length, 45);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8')).actions.length, 45);
  });
});

test('never unfollows handles on the keep list (case/@ insensitive)', { timeout: 120_000 }, async () => {
  await withMock({ count: 30 }, async ({ mock, cfg }) => {
    const summary = await run(cfg);
    assert.equal(summary.status, 'done');
    assert.equal(summary.unfollowed, 28);
    assert.deepEqual(mock.state.following.map((u) => u.handle), ['user003', 'user027']);
  }, { env: { KEEP: '@User003, user027' } });
});

test('dry run lists targets and changes nothing', { timeout: 120_000 }, async () => {
  await withMock({ count: 45 }, async ({ mock, cfg, dataDir }) => {
    const summary = await run(cfg);
    assert.equal(summary.status, 'dry-run');
    assert.equal(summary.candidates.length, 44);
    assert.ok(!summary.candidates.includes('user010'));
    assert.equal(mock.state.destroyCalls, 0);
    assert.equal(mock.state.following.length, 45);
    assert.equal(fs.readFileSync(path.join(dataDir, 'would-unfollow.txt'), 'utf8').trim().split('\n').length, 44);
  }, { env: { DRY_RUN: 'true', KEEP: 'user010' } });
});

test('backs off on HTTP 429 from the unfollow call, retries the same account, and finishes', { timeout: 120_000 }, async () => {
  const reset = () => String(Math.floor(Date.now() / 1000) + 1);
  const destroyFault = (n) => (n === 4 || n === 5 ? { status: 429, code: 88, headers: { 'x-rate-limit-reset': reset() } } : null);
  await withMock({ count: 12, destroyFault }, async ({ mock, cfg }) => {
    const t0 = Date.now();
    const summary = await run(cfg);
    assert.equal(summary.status, 'done');
    assert.equal(summary.unfollowed, 12);
    assert.equal(mock.state.following.length, 0);
    assert.equal(mock.state.destroyCalls, 14); // 12 successes + 2 rejected
    assert.ok(Date.now() - t0 > 1000, 'should have waited out the reset window');
  });
});

test('gives up with status rate-limited after MAX_BACKOFFS consecutive hits, keeping progress', { timeout: 120_000 }, async () => {
  const destroyFault = (n) => (n > 3 ? { status: 429, code: 88 } : null);
  await withMock({ count: 10, destroyFault }, async ({ mock, cfg, dataDir }) => {
    const summary = await run(cfg);
    assert.equal(summary.status, 'rate-limited');
    assert.equal(summary.unfollowed, 3);
    assert.equal(mock.state.following.length, 7);
    // 3 successes + 3 rejected attempts: hits 1 and 2 back off, hit 3 exceeds MAX_BACKOFFS=2.
    // (A double-counted backoff would give up one attempt earlier.)
    assert.equal(mock.state.destroyCalls, 6);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8')).actions.length, 3);
  }, { env: { MAX_BACKOFFS: '2', BACKOFF_BASE_SEC: '0.1' } });
});

test('X "action limit" error code (161) is treated as a limit, not a per-account failure', { timeout: 120_000 }, async () => {
  const destroyFault = (n) => (n === 2 ? { status: 403, code: 161 } : null);
  await withMock({ count: 4, destroyFault }, async ({ mock, cfg }) => {
    const summary = await run(cfg);
    assert.equal(summary.status, 'done');
    assert.equal(summary.skipped.length, 0);
    assert.equal(mock.state.following.length, 0);
  });
});

test('stops with a clear error when the account is locked/suspended (326)', { timeout: 120_000 }, async () => {
  await withMock({ count: 4, destroyFault: () => ({ status: 403, code: 326 }) }, async ({ cfg }) => {
    await assert.rejects(run(cfg), (e) => e instanceof FatalError && /needs attention/.test(e.message));
  });
});

test('429 while loading the list triggers a backoff, then continues', { timeout: 120_000 }, async () => {
  const listFault = (n) => (n === 2 ? { status: 429, headers: { 'x-rate-limit-reset': String(Math.floor(Date.now() / 1000) + 1) } } : null);
  await withMock({ count: 30, listFault }, async ({ mock, cfg }) => {
    const summary = await run(cfg);
    assert.equal(summary.status, 'done');
    assert.equal(mock.state.following.length, 0);
  });
});

test('hourly cap from a previous run (state.json) is respected after a restart', { timeout: 120_000 }, async () => {
  // 3 unfollows already happened ~1h ago minus 2.5s, so the cap of 3/hour frees up in ~2.5s.
  const seed = [1, 2, 3].map((i) => Date.now() - 3600_000 + 2500 + i);
  await withMock({ count: 2 }, async ({ mock, cfg }) => {
    const t0 = Date.now();
    const summary = await run(cfg);
    assert.equal(summary.status, 'done');
    assert.equal(summary.unfollowed, 2);
    assert.ok(Date.now() - t0 >= 2000, `expected to wait for the cap, took ${Date.now() - t0}ms`);
    assert.equal(mock.state.following.length, 0);
  }, { env: { MAX_PER_HOUR: '3' }, seedActions: seed });
});

test('MAX_TOTAL stops the run early', { timeout: 120_000 }, async () => {
  await withMock({ count: 10 }, async ({ mock, cfg }) => {
    const summary = await run(cfg);
    assert.equal(summary.status, 'max-total');
    assert.equal(mock.state.following.length, 7);
  }, { env: { MAX_TOTAL: '3' } });
});

test('invalid cookies produce a clear "not logged in" error', { timeout: 120_000 }, async () => {
  await withMock({ count: 3 }, async ({ cfg }) => {
    await assert.rejects(run(cfg), (e) => e instanceof FatalError && /Not logged in/.test(e.message));
  }, { env: { TWITTER_AUTH_TOKEN: 'expired-token' } });
});

test('an empty following list finishes cleanly', { timeout: 120_000 }, async () => {
  await withMock({ count: 0 }, async ({ cfg }) => {
    const summary = await run(cfg);
    assert.equal(summary.status, 'done');
    assert.equal(summary.unfollowed, 0);
  });
});

// ---------------------------------------------------------------------------------------------
// Regression tests for problems found in review (each reproduces the original failure)
// ---------------------------------------------------------------------------------------------

test('a bio that @-mentions another account must not redirect the click: kept accounts stay followed', { timeout: 120_000 }, async () => {
  // user001 is KEPT and its bio links to /user004. The old code located user004's row by "any link to /user004"
  // and so clicked user001's Following button instead.
  const bios = { user001: 'friend of <a href="/user004">@user004</a>' };
  await withMock({ count: 8, bios }, async ({ mock, cfg, dataDir }) => {
    const summary = await run(cfg);
    assert.equal(summary.status, 'done');
    assert.deepEqual(mock.state.following.map((u) => u.handle), ['user001'], 'the kept account is untouched');
    assert.equal(mock.state.destroyed.length, 7);
    assert.equal(new Set(mock.state.destroyed).size, 7, 'nobody was unfollowed twice');
    const logged = fs.readFileSync(path.join(dataDir, 'unfollowed.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).handle);
    assert.deepEqual([...logged].sort(), [...mock.state.destroyed].sort(), 'the log names exactly who was really unfollowed');
  }, { env: { KEEP: 'user001' } });
});

test('a confirmation sheet that names a different account makes the bot back out', { timeout: 120_000 }, async () => {
  await withMock({ count: 5, sheetNames: { user002: 'someoneelse' } }, async ({ mock, cfg }) => {
    const summary = await run(cfg);
    assert.equal(summary.status, 'done');
    assert.deepEqual(summary.skipped, ['user002']);
    assert.deepEqual(mock.state.following.map((u) => u.handle), ['user002']);
    assert.ok(!mock.state.destroyed.includes('someoneelse'));
  });
});

test('a list that stops loading is "incomplete", never a false "done"', { timeout: 120_000 }, async () => {
  // First page loads, then every list request comes back empty while the profile still says 40 are followed.
  await withMock({ count: 60, listFault: (n) => (n >= 2 ? { empty: true } : null) }, async ({ mock, cfg }) => {
    const summary = await run(cfg);
    assert.equal(summary.status, 'incomplete');
    assert.match(summary.note, /profile says/);
    assert.equal(mock.state.following.length, 40);
  });
});

test('a small gap between the profile count and the list finishes with a note, not an error', { timeout: 120_000 }, async () => {
  await withMock({ count: 10, profileCount: () => 12 }, async ({ mock, cfg }) => {
    const summary = await run(cfg);
    assert.equal(summary.status, 'done');
    assert.match(summary.note, /If you still follow people/);
    assert.equal(mock.state.following.length, 0);
  });
});

test('an unexplained large gap is incomplete', { timeout: 120_000 }, async () => {
  await withMock({ count: 10, profileCount: () => 100 }, async ({ cfg }) => {
    const summary = await run(cfg);
    assert.equal(summary.status, 'incomplete');
  });
});

test('an unreadable following list on a first look is a clear error, not "done"', { timeout: 120_000 }, async () => {
  // The cell markup changed (no UserCell at all) and the profile count is not in a format we understand.
  await withMock({ count: 5, listFault: () => ({ empty: true }), profileCount: () => 0 / 0 }, async ({ cfg }) => {
    await assert.rejects(run(cfg), (e) => e instanceof FatalError && /could not see your following list/.test(e.message));
  });
});

test('being redirected away from the following list (consent / verification page) is reported, not treated as empty', { timeout: 120_000 }, async () => {
  await withMock({ count: 5, followingRedirect: '/i/flow/consent_flow' }, async ({ cfg }) => {
    await assert.rejects(run(cfg), (e) => e instanceof FatalError && /sent the bot to .*consent_flow/.test(e.message));
  });
});

test('an account that stays listed after a successful unfollow is not hit again and again', { timeout: 120_000 }, async () => {
  await withMock({ count: 6, destroyGhost: (u) => u.handle === 'user000' }, async ({ mock, cfg }) => {
    const summary = await run(cfg);
    assert.equal(summary.status, 'done');
    assert.equal(summary.unfollowed, 6);
    assert.equal(mock.state.destroyed.filter((h) => h === 'user000').length, 1, 'only one unfollow request for the ghost');
    assert.equal(mock.state.destroyCalls, 6);
  });
});

test('two accounts X refuses to unfollow are skipped; everyone else is still processed', { timeout: 120_000 }, async () => {
  const destroyFault = (n, u) => (u && (u.handle === 'user000' || u.handle === 'user001') ? { status: 403, code: 999 } : null);
  await withMock({ count: 12, destroyFault }, async ({ mock, cfg }) => {
    const summary = await run(cfg);
    assert.equal(summary.status, 'done');
    assert.deepEqual([...summary.skipped].sort(), ['user000', 'user001']);
    assert.equal(summary.unfollowed, 10);
    assert.deepEqual(mock.state.following.map((u) => u.handle), ['user000', 'user001']);
  });
});

test('when X refuses EVERY unfollow the run stops with an explanation, quickly', { timeout: 120_000 }, async () => {
  await withMock({ count: 10, destroyFault: () => ({ status: 403, code: 999 }) }, async ({ mock, cfg }) => {
    await assert.rejects(run(cfg), (e) => e instanceof FatalError && /X is refusing the unfollow requests/.test(e.message));
    assert.ok(mock.state.destroyCalls <= 9, `gave up after ${mock.state.destroyCalls} attempts`);
  });
});

test('error 231 (must verify login) is treated as an account problem', { timeout: 120_000 }, async () => {
  await withMock({ count: 3, destroyFault: () => ({ status: 403, code: 231 }) }, async ({ cfg }) => {
    await assert.rejects(run(cfg), (e) => e instanceof FatalError && /needs attention/.test(e.message));
  });
});

test('preview: Stop gives "stopped" (no fake empty preview); a failing list gives "incomplete"', { timeout: 120_000 }, async () => {
  await withMock({ count: 300 }, async ({ cfg }) => {
    const t = setTimeout(() => requestStop(), 500);
    const summary = await run(cfg);
    clearTimeout(t);
    assert.equal(summary.status, 'stopped');
    assert.equal(summary.candidates, undefined);
  }, { env: { DRY_RUN: 'true' } });

  await withMock({ count: 60, listFault: (n) => (n >= 2 ? { status: 429, headers: {} } : null) }, async ({ cfg, dataDir }) => {
    const summary = await run(cfg);
    assert.equal(summary.status, 'incomplete');
    assert.ok(!fs.existsSync(path.join(dataDir, 'would-unfollow.txt')), 'no partial list is written');
  }, { env: { DRY_RUN: 'true' } });
});

test('progress hooks report ready/unfollowed/wait events in order', { timeout: 120_000 }, async () => {
  const seed = [1, 2, 3].map((i) => Date.now() - 3600_000 + 6000 + i);
  await withMock({ count: 3 }, async ({ cfg, mock }) => {
    const events = [];
    const summary = await run(cfg, { emit: (type, d) => type !== 'tick' && events.push([type, d]) });
    assert.equal(summary.status, 'done');
    const kinds = events.map((e) => e[0]);
    assert.equal(kinds[0], 'ready');
    assert.equal(events[0][1].followingCount, 3);
    assert.ok(kinds.includes('wait') && kinds.includes('resume'), 'the hourly cap rest is announced');
    assert.equal(kinds.filter((k) => k === 'unfollowed').length, 3);
    assert.equal(mock.state.following.length, 0);
  }, { env: { MAX_PER_HOUR: '3' }, seedActions: seed });
});
