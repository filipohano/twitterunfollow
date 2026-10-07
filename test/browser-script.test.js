// The Chrome-console script (browser/unfollow-all.js) run in real Chromium against the mock of X's following page.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startMockX } from './mock-x.js';

const SCRIPT = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'browser', 'unfollow-all.js'), 'utf8');
const FAST = {
  paces: { test: { label: 'test', minMs: 10, maxMs: 30, burst: 1000, burstMinMs: 10, burstMaxMs: 20, perHour: 1000, perDay: 1000 } },
  defaultPace: 'test',
  timing: {
    scrollPauseMs: [60, 100], endWaitMs: 200, endTries: 3, loadMs: 1500, dialogMs: 3000, outcomeMs: 4000, answerMs: 2000, revertCheckMs: 150,
    settleMs: [10, 20], armMs: 2000, armMinMs: 0, capJitterMs: [0, 10], failPauseMs: [10, 20],
  },
};
const slow = (cfg = FAST, minMs = 150, maxMs = 200) => ({ ...cfg, paces: { test: { ...cfg.paces.test, minMs, maxMs } } });
const withTiming = (cfg, timing) => ({ ...cfg, timing: { ...cfg.timing, ...timing } });

function apiFor(page) {
  return {
    page,
    state: () => page.evaluate(() => window.__unfollowAll.state()),
    preview: () => page.evaluate(() => window.__unfollowAll.preview()),
    start: () => page.evaluate(() => window.__unfollowAll.start()),
    stop: () => page.evaluate(() => window.__unfollowAll.stop()),
    untilPhase: (phases, ms = 30_000) => page.waitForFunction((ps) => ps.includes(window.__unfollowAll.state().phase), phases, { timeout: ms, polling: 50 }),
    untilDone: (n, ms = 30_000) => page.waitForFunction((k) => window.__unfollowAll.state().runDone >= k, n, { timeout: ms, polling: 50 }),
  };
}

// Loads the mock's following page in a new tab and injects the script, as a user pasting it into the console would.
async function openTab(ctx, mock, problems, { config = FAST, keep = '', actions, pagePath = '/tester/following', hooksOff = false, storageFails = false } = {}) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/status of (40\d|429)/.test(m.text()) && problems.push(`console: ${m.text()}`));
  await page.goto(mock.url + pagePath);
  await page.waitForSelector('[data-testid="UserCell"]');
  await page.evaluate(
    ({ config, keep, actions, hooksOff, storageFails }) => {
      window.UNFOLLOW_ALL_CONFIG = config;
      if (keep) localStorage.setItem('ua1.keep', JSON.stringify(keep));
      if (actions !== undefined) localStorage.setItem('ua1.actions', JSON.stringify(actions));
      if (hooksOff) window.__uaNet = { installed: true, destroy: null, limitedAt: 0 }; // pretend X's network calls can't be observed
      if (storageFails) Storage.prototype.setItem = () => { throw new DOMException('full', 'QuotaExceededError'); };
    },
    { config, keep, actions, hooksOff, storageFails },
  );
  await page.evaluate(SCRIPT);
  return page;
}

async function withPage(mockOpts, fn, opts = {}) {
  const mock = await startMockX(mockOpts);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 900 } });
  await ctx.addCookies([
    { name: 'auth_token', value: 'good-token', url: mock.url },
    { name: 'ct0', value: 'good-ct0', url: mock.url },
  ]);
  const problems = [];
  try {
    const page = await openTab(ctx, mock, problems, opts);
    await fn({ ...apiFor(page), mock, problems, ctx, openAnother: async (o = opts) => apiFor(await openTab(ctx, mock, problems, o)) });
  } finally {
    await browser.close();
    await mock.close();
  }
}

// ---------------------------------------------------------------------------------------------- the basics

test('preview lists who would be unfollowed, honours the keep list and touches nothing', { timeout: 90_000 }, async () => {
  await withPage({ count: 30 }, async ({ preview, mock, problems }) => {
    const s = await preview();
    assert.equal(s.phase, 'ready');
    assert.equal(s.preview.count, 28);
    assert.equal(s.preview.kept, 2);
    assert.deepEqual(s.preview.missing, []);
    assert.equal(mock.state.destroyCalls, 0);
    assert.deepEqual(problems, []);
  }, { keep: 'user003\n@User010' });
});

test('Start is refused until a preview has been run', { timeout: 60_000 }, async () => {
  await withPage({ count: 5 }, async ({ start, mock }) => {
    const s = await start();
    assert.equal(s.phase, 'error');
    assert.match(s.msg, /Forhåndsvis/);
    assert.equal(mock.state.destroyCalls, 0);
  });
});

test('full run: everyone except the keep list is unfollowed, and the history is saved for the CSV', { timeout: 120_000 }, async () => {
  await withPage({ count: 30 }, async ({ preview, start, state, mock, page, problems }) => {
    await preview();
    const s = await start();
    assert.equal(s.phase, 'done');
    assert.equal(s.runDone, 28);
    assert.deepEqual(mock.state.following.map((u) => u.handle), ['user003', 'user010']);
    assert.equal(new Set(mock.state.destroyed).size, 28, 'nobody unfollowed twice');
    const csv = await page.evaluate(() => window.__unfollowAll.csv());
    assert.equal(csv.trim().split('\n').length, 29);
    assert.match(csv, /^handle,avfulgt\n/);
    assert.equal((await state()).usage.day, 28);
    assert.deepEqual(problems, []);
  }, { keep: 'user003, user010' });
});

test('a bio that @-mentions another account never redirects the click onto a kept account', { timeout: 120_000 }, async () => {
  const bios = { user001: 'friend of <a href="/user004">@user004</a>' };
  await withPage({ count: 8, bios }, async ({ preview, start, mock }) => {
    await preview();
    await start();
    assert.deepEqual(mock.state.following.map((u) => u.handle), ['user001'], 'the kept account is untouched');
    assert.equal(new Set(mock.state.destroyed).size, 7);
  }, { keep: 'user001' });
});

// ---------------------------------------------------------------------------------------------- keep list

test('the keep list is read tolerantly: spaces, semicolons, URLs, annotations and invisible characters all count', { timeout: 120_000 }, async () => {
  const keep = 'user003; user005\nhttps://x.com/User007\n@user009 (venn)\n​user011​';
  await withPage({ count: 14 }, async ({ preview, start, mock }) => {
    const p = await preview();
    assert.equal(p.preview.kept, 5);
    assert.equal(p.preview.count, 9);
    await start();
    assert.deepEqual(mock.state.following.map((u) => u.handle), ['user003', 'user005', 'user007', 'user009', 'user011']);
  }, { keep });
});

test('a typo in the keep list is reported, and Start refuses when none of the kept accounts exist', { timeout: 60_000 }, async () => {
  await withPage({ count: 6 }, async ({ preview, start, mock }) => {
    const p = await preview();
    assert.equal(p.phase, 'ready');
    assert.deepEqual(p.preview.missing, ['nosuchperson']);
    assert.match(p.msg, /@nosuchperson/);
    const s = await start();
    assert.equal(s.phase, 'error');
    assert.match(s.msg, /Ingen av kontoene i behold-listen/);
    assert.equal(mock.state.destroyCalls, 0);
  }, { keep: 'nosuchperson' });
});

test('the keep box is locked while running and paused, and a change that still gets through is honoured by the very next unfollow', { timeout: 120_000 }, async () => {
  await withPage({ count: 25 }, async ({ page, preview, start, untilDone, untilPhase, mock }) => {
    await preview();
    const run = start();
    await untilDone(3);
    assert.equal(await page.locator('textarea').isDisabled(), true, 'locked while running');
    await page.locator('[data-ua="pause"]').click();
    await untilPhase(['paused']);
    assert.equal(await page.locator('textarea').isDisabled(), true, 'locked while paused');
    // someone forces it anyway (devtools, a browser extension, a mis-click on a disabled box in another browser)
    await page.evaluate(() => {
      const ta = document.querySelector('[data-ua="host"]').shadowRoot.querySelector('textarea');
      ta.value = 'user020\nuser021\nuser022\nuser023\nuser024';
      ta.dispatchEvent(new Event('input'));
    });
    await page.locator('[data-ua="pause"]').click(); // Fortsett
    const s = await run;
    assert.equal(s.phase, 'done');
    assert.deepEqual(mock.state.following.map((u) => u.handle), ['user020', 'user021', 'user022', 'user023', 'user024']);
  }, { config: slow() });
});

// ---------------------------------------------------------------------------------------------- X pushes back

test('X answering 429 stops the script at once, remembers the cooldown, and refuses to start again until it is cleared', { timeout: 90_000 }, async () => {
  await withPage({ count: 12, destroyFault: (n) => (n >= 4 ? { status: 429, code: 88 } : null) }, async ({ page, preview, start, mock, state }) => {
    await preview();
    const s = await start();
    assert.equal(s.phase, 'error');
    assert.match(s.msg, /bremse|stoppet/i);
    assert.equal(mock.state.destroyCalls, 4, 'exactly one request after the three that worked; no hammering');
    assert.equal((await state()).runDone, 3);
    assert.ok((await state()).cooldownUntil > Date.now() + 30 * 60_000, 'cooldown of about an hour is stored');
    const again = await start();
    assert.equal(again.phase, 'error');
    assert.match(again.msg, /Vent til/);
    assert.equal(mock.state.destroyCalls, 4, 'refused without touching X');
    assert.match((await preview()).msg, /Vent til/);
    await page.evaluate(() => window.__unfollowAll.clearCooldown());
    assert.equal((await preview()).phase, 'ready');
  });
});

test('X refusing every unfollow stops after two different accounts, not forever', { timeout: 90_000 }, async () => {
  await withPage({ count: 12, destroyFault: () => ({ status: 403, code: 999 }) }, async ({ preview, start, mock }) => {
    await preview();
    const s = await start();
    assert.equal(s.phase, 'error');
    assert.match(s.msg, /flere kontoer på rad/);
    assert.ok(mock.state.destroyCalls <= 4, `gave up after ${mock.state.destroyCalls} attempts`);
    assert.equal(s.runDone, 0);
  });
});

test('"unable to follow more people" (error 226) stops the run even when X flips the button first and takes it back afterwards', { timeout: 90_000 }, async () => {
  const destroyFault = (n) => (n >= 3 ? { status: 403, code: 226 } : null);
  await withPage({ count: 8, variant: 'optimistic', latency: 300, destroyFault }, async ({ preview, start, mock }) => {
    await preview();
    const s = await start();
    assert.equal(s.phase, 'error');
    assert.match(s.msg, /226/);
    assert.equal(s.runDone, 2, 'the refused one is not counted as done');
    assert.equal(mock.state.following.length, 6);
    assert.ok(s.cooldownUntil > Date.now());
  });
});

test('blind mode (X\'s network calls cannot be watched): the first unfollow that visibly bounces back stops the run', { timeout: 90_000 }, async () => {
  const destroyFault = (n) => (n >= 3 ? { status: 403, code: 226 } : null);
  const cfg = withTiming(FAST, { revertCheckMs: 400 });
  await withPage({ count: 8, variant: 'optimistic', latency: 30, destroyFault }, async ({ preview, start, mock }) => {
    await preview();
    const s = await start();
    assert.equal(s.phase, 'error');
    assert.match(s.msg, /Ingenting skjedde etter bekreftelsen|bremser/);
    assert.equal(mock.state.destroyCalls, 3, 'stopped at the first failure, no second try');
    assert.equal(s.runDone, 2);
  }, { config: cfg, hooksOff: true });
});

test('a confirmation that names a different account is cancelled; the account is skipped after two tries and listed at the end', { timeout: 90_000 }, async () => {
  await withPage({ count: 5, sheetNames: { user002: 'someoneelse' } }, async ({ preview, start, mock }) => {
    await preview();
    const s = await start();
    assert.equal(s.phase, 'done');
    assert.deepEqual(s.skipped, ['user002']);
    assert.match(s.msg, /@user002/);
    assert.deepEqual(mock.state.following.map((u) => u.handle), ['user002']);
  });
});

test('X receiving an unfollow for a different account than the row we clicked stops everything', { timeout: 90_000 }, async () => {
  await withPage({ count: 6, variant: 'wrongid' }, async ({ preview, start, mock }) => {
    await preview();
    const s = await start();
    assert.equal(s.phase, 'error');
    assert.match(s.msg, /annen konto/);
    assert.equal(mock.state.destroyCalls, 1);
    assert.equal(s.runDone, 0);
  });
});

test('an unfollow nobody asked for (you clicked yourself, or another tab did) stops the run', { timeout: 90_000 }, async () => {
  await withPage({ count: 20 }, async ({ page, preview, start, untilDone, untilPhase }) => {
    await preview();
    const run = start();
    await untilDone(2);
    await page.evaluate(() =>
      fetch('/i/api/1.1/friendships/destroy.json', { method: 'POST', headers: { 'x-csrf-token': 'good-ct0', 'content-type': 'application/x-www-form-urlencoded' }, body: 'user_id=1999' }),
    );
    const s = await run;
    assert.equal(s.phase, 'error');
    assert.match(s.msg, /ikke ba om/);
    await untilPhase(['error']);
  }, { config: slow() });
});

test('a dialog that was already open is never confirmed', { timeout: 60_000 }, async () => {
  await withPage({ count: 6 }, async ({ page, preview, start, mock }) => {
    await preview();
    await page.evaluate(() => {
      document.getElementById('no').onclick = null; // cannot be dismissed
      document.getElementById('sheet-text').textContent = 'Unfollow @user000?';
      document.getElementById('sheet').className = 'on';
    });
    const s = await start();
    assert.equal(s.phase, 'error');
    assert.equal(mock.state.destroyCalls, 0);
  });
});

// ---------------------------------------------------------------------------------------------- X's different faces

test('works with the newer one-item "Unfollow @name" menu instead of a confirmation sheet', { timeout: 90_000 }, async () => {
  await withPage({ count: 8, variant: 'menu' }, async ({ preview, start, mock, problems }) => {
    await preview();
    const s = await start();
    assert.equal(s.phase, 'done');
    assert.equal(mock.state.following.length, 0);
    assert.deepEqual(problems, []);
  });
});

test('works when the unfollow button is named after the handle, and when X flips the button before answering', { timeout: 90_000 }, async () => {
  await withPage({ count: 8, variant: 'handleprefix optimistic', latency: 150 }, async ({ preview, start, mock }) => {
    await preview();
    const s = await start();
    assert.equal(s.phase, 'done');
    assert.equal(s.runDone, 8);
    assert.equal(mock.state.following.length, 0);
  });
});

test('works even when X\'s network calls cannot be observed (falls back to watching the page)', { timeout: 90_000 }, async () => {
  await withPage({ count: 8 }, async ({ preview, start, mock }) => {
    await preview();
    const s = await start();
    assert.equal(s.phase, 'done');
    assert.equal(mock.state.following.length, 0);
  }, { hooksOff: true });
});

test('a slow-loading list (spinner) is counted in full, and a list that never loads is reported instead of "done"', { timeout: 90_000 }, async () => {
  const cfg = withTiming(FAST, { loadMs: 6000 });
  await withPage({ count: 25, pageSize: 10, listDelay: (n) => (n === 2 ? 2500 : 0) }, async ({ preview }) => {
    const p = await preview();
    assert.equal(p.phase, 'ready');
    assert.equal(p.preview.count, 25, 'waited for the spinner instead of deciding the list ended');
  }, { config: cfg });
  await withPage({ count: 25, pageSize: 10, listFault: (n) => (n === 2 ? { hang: true } : null) }, async ({ preview }) => {
    const p = await preview();
    assert.equal(p.phase, 'error');
    assert.match(p.msg, /snurren/);
  });
});

// ---------------------------------------------------------------------------------------------- caps, stop, safety rails

test('the hourly cap makes it rest (with a countdown) instead of continuing, and it carries on afterwards', { timeout: 90_000 }, async () => {
  const actions = [1, 2, 3].map((i) => Date.now() - 3600_000 + 9000 + i); // ages out ~9 s from now, after the preview has run
  const cfg = { ...FAST, paces: { test: { ...FAST.paces.test, perHour: 3 } } };
  await withPage({ count: 2 }, async ({ preview, start, state, untilPhase, mock }) => {
    await preview();
    const run = start().catch((e) => e);
    await untilPhase(['resting']);
    const mid = await state();
    assert.ok(mid.rest.until > Date.now() && mid.rest.until - Date.now() < 10_000);
    assert.match(mid.msg, /Timegrensen/);
    const s = await run;
    assert.equal(s.phase, 'done');
    assert.equal(mock.state.following.length, 0);
  }, { config: cfg, actions });
});

test('the caps still hold when the saved history is corrupt and the browser refuses to save anything new', { timeout: 90_000 }, async () => {
  const cfg = { ...FAST, paces: { test: { ...FAST.paces.test, perHour: 3 } } };
  await withPage({ count: 8 }, async ({ preview, start, stop, state, untilPhase, mock }) => {
    await preview();
    const run = start();
    await untilPhase(['resting']);
    const mid = await state();
    assert.match(mid.msg, /Timegrensen/);
    assert.equal(mid.runDone, 3);
    assert.equal(mock.state.following.length, 5, 'exactly the capped number was unfollowed');
    await stop();
    assert.equal((await run).phase, 'stopped');
  }, { config: cfg, actions: 'garbage', storageFails: true });
});

test('Stop halts a run cleanly and Start continues where it left off', { timeout: 90_000 }, async () => {
  await withPage({ count: 25 }, async ({ preview, start, stop, state, mock, untilDone }) => {
    await preview();
    const run = start().catch((e) => e);
    await untilDone(3);
    await stop();
    const stopped = await run;
    assert.equal(stopped.phase, 'stopped');
    const left = mock.state.following.length;
    assert.ok(left > 0 && left < 25);
    const s = await start();
    assert.equal(s.phase, 'done');
    assert.equal(mock.state.following.length, 0);
    assert.equal(new Set(mock.state.destroyed).size, 25, 'nobody twice');
    assert.equal((await state()).usage.day, 25);
  }, { config: slow() });
});

test('only one tab may run at a time, and the lock is released when the first one stops', { timeout: 90_000 }, async () => {
  await withPage({ count: 20 }, async ({ preview, start, stop, untilDone, mock, openAnother }) => {
    await preview();
    const other = await openAnother({ config: slow() });
    const run = start();
    await untilDone(1);
    const p = await other.preview();
    assert.equal(p.phase, 'error');
    assert.match(p.msg, /annen fane/);
    const before = mock.state.destroyCalls;
    const s2 = await other.start();
    assert.equal(s2.phase, 'error');
    await stop();
    await run;
    assert.ok(mock.state.destroyCalls - before <= 1, 'the second tab did not unfollow anyone');
    assert.equal((await other.preview()).phase, 'ready', 'lock is free again');
  }, { config: slow() });
});

test('it refuses to run on someone else\'s following page (where the buttons would be YOUR follows)', { timeout: 60_000 }, async () => {
  await withPage({ count: 6 }, async ({ preview, start, mock }) => {
    const p = await preview();
    assert.equal(p.phase, 'error');
    assert.match(p.msg, /din egen/);
    const s = await start();
    assert.equal(s.phase, 'error');
    assert.equal(mock.state.destroyCalls, 0);
  }, { pagePath: '/someoneelse/following' });
});

// ---------------------------------------------------------------------------------------------- the panel

test('the panel works with the mouse: preview, then Start needs two clicks, and running it twice leaves one panel', { timeout: 120_000 }, async () => {
  await withPage({ count: 6 }, async ({ page, mock, untilPhase, problems }) => {
    await page.evaluate(`window.UNFOLLOW_ALL_CONFIG = ${JSON.stringify(FAST)};`);
    await page.evaluate(SCRIPT); // a second copy replaces the first
    assert.equal(await page.locator('[data-ua="host"]').count(), 1);
    assert.equal(await page.locator('[data-ua="start"]').isDisabled(), true, 'Start is disabled before a preview');
    await page.locator('[data-ua="preview"]').click();
    await untilPhase(['ready']);
    await page.locator('[data-ua="start"]').click();
    assert.match(await page.locator('[data-ua="start"]').innerText(), /Bekreft: avfølg 6, behold 0\?/);
    assert.equal(mock.state.destroyCalls, 0, 'one click only arms it');
    await page.locator('[data-ua="start"]').click();
    await untilPhase(['done']);
    assert.equal(mock.state.following.length, 0);
    assert.deepEqual(problems, []);
  });
});

test('a double-click on Start does not start anything; a deliberate second click does', { timeout: 120_000 }, async () => {
  await withPage({ count: 4 }, async ({ page, preview, mock, untilPhase }) => {
    await preview();
    await page.locator('[data-ua="start"]').dblclick();
    await page.waitForTimeout(300);
    assert.equal(mock.state.destroyCalls, 0);
    assert.match(await page.locator('[data-ua="start"]').innerText(), /Bekreft/);
    await page.waitForTimeout(1100);
    await page.locator('[data-ua="start"]').click();
    await untilPhase(['done']);
    assert.equal(mock.state.following.length, 0);
  }, { config: withTiming(FAST, { armMinMs: 1200 }) });
});

test('resetting the counters takes two clicks and also empties the CSV history', { timeout: 90_000 }, async () => {
  await withPage({ count: 4 }, async ({ page, preview, start, state }) => {
    await preview();
    await start();
    assert.equal((await state()).usage.day, 4);
    await page.getByText('Nullstill tellere').click();
    assert.equal((await state()).usage.day, 4, 'first click only asks');
    await page.getByText('Sikker? Trykk igjen').click();
    assert.equal((await state()).usage.day, 0);
    assert.equal((await page.evaluate(() => window.__unfollowAll.csv())).trim(), 'handle,avfulgt');
  });
});

test('typing in the panel does not trigger X\'s keyboard shortcuts', { timeout: 60_000 }, async () => {
  await withPage({ count: 3 }, async ({ page }) => {
    await page.evaluate(() => {
      window.__keys = 0;
      for (const t of [document, window]) for (const k of ['keydown', 'keyup', 'keypress']) t.addEventListener(k, () => (window.__keys += 1));
    });
    await page.locator('textarea').click();
    await page.keyboard.type('nj/gpk');
    assert.equal(await page.evaluate(() => window.__keys), 0);
    assert.equal(await page.locator('textarea').inputValue(), 'nj/gpk');
  });
});
