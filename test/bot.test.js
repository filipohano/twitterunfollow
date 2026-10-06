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
import { resetStop } from '../src/util.js';
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
  cfg.timing = { listWaitMs: 1500, scrollPauseMs: [60, 100], endWaitMs: 300, capJitterMs: [0, 10], failurePauseMs: [20, 40], emptyRecheckMs: 50, backoffMarginMs: 20 };
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
    await assert.rejects(run(cfg), (e) => e instanceof FatalError && /suspended or locked/.test(e.message));
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
