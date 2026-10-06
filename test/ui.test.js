// Drives the real dashboard (web/) in Chromium against the real server, runner, bot and the mock X.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createAuth } from '../src/auth.js';
import { Runner } from '../src/runner.js';
import { createApp } from '../src/server.js';
import { resetStop } from '../src/util.js';
import { startMockX } from './mock-x.js';

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const PASSWORD = 'correct horse battery';
const FAST = {
  delayMinMs: 150,
  delayMaxMs: 250,
  burstSize: 1000,
  maxPerHour: 1000,
  maxPerDay: 1000,
  backoffBaseMs: 300,
  timing: { listWaitMs: 1500, scrollPauseMs: [60, 100], endWaitMs: 300, capJitterMs: [0, 10], failurePauseMs: [20, 40], verifyRetryWaitMs: 50, backoffMarginMs: 20 },
};

async function withUi(mockOpts, fn, { overrides = FAST, seed } = {}) {
  resetStop();
  const mock = await startMockX(mockOpts);
  process.env.X_BASE_URL = mock.url;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unfollow-ui-'));
  seed?.(dataDir);
  const runner = new Runner({ dataDir, configOverride: overrides, crashWaitMs: 100 });
  const server = http.createServer(createApp({ runner, auth: createAuth({ password: PASSWORD }), webDir: WEB_DIR, dataDir }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true });
  const context = await browser.newContext({ viewport: { width: 1000, height: 900 } });
  const problems = [];
  const watch = (page) => {
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      const t = m.text();
      // The tests deliberately trigger a wrong password (401) and an invalid cookie (400); the browser logs those.
      if (/Failed to load resource.*status of 40[01]\b/.test(t)) return;
      if (m.type() === 'error' || /content security policy/i.test(t)) problems.push(`console ${m.type()}: ${t}`);
    });
  };
  try {
    await fn({ base, mock, context, watch, problems, runner, dataDir });
  } finally {
    await browser.close();
    await runner.shutdown();
    await new Promise((r) => server.close(r));
    await mock.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

const badge = (page, state, timeout = 40_000) =>
  page.waitForFunction((s) => document.querySelector('#state-badge')?.dataset.state === s, state, { timeout, polling: 100 });
const text = (page, sel) => page.locator(sel).first().innerText();
const login = async (page, base) => {
  await page.goto(base);
  await page.locator('#password').fill(PASSWORD);
  await page.locator('#login-btn').click();
  await page.locator('#main-view').waitFor({ state: 'visible', timeout: 10_000 });
};

test('full journey: login, save cookies, preview, confirm + run, come back later, finish, logout', { timeout: 180_000 }, async () => {
  await withUi({ count: 30 }, async ({ base, mock, context, watch, problems }) => {
    const page = await context.newPage();
    watch(page);

    // --- login screen
    await page.goto(base);
    await page.locator('#login-view').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#main-view').isVisible(), false);
    await page.locator('#password').fill('wrong password');
    await page.locator('#login-btn').click();
    await page.locator('#login-error').waitFor({ state: 'visible' });
    await page.locator('#password').fill(PASSWORD);
    await page.locator('#password').press('Enter'); // keyboard-only login works
    await page.locator('#main-view').waitFor({ state: 'visible' });

    // --- first run: nothing saved yet, so nothing can be started
    assert.equal(await page.locator('#btn-run').isDisabled(), true);
    assert.equal(await page.locator('#btn-preview').isDisabled(), true);
    assert.equal(await page.locator('#btn-stop').isDisabled(), true);
    assert.equal(await page.locator('#help-cookies').getAttribute('open') !== null, true, 'cookie help starts open');
    assert.match(await text(page, '#creds-status'), /no cookies/i);

    // --- saving: bad input is explained, good input is accepted and the inputs are wiped
    await page.locator('#authToken').fill('x');
    await page.locator('#ct0').fill('y');
    await page.locator('#btn-save').click();
    await page.waitForFunction(() => document.querySelector('#save-status')?.textContent.trim().length > 0);
    assert.doesNotMatch(await text(page, '#save-status'), /^saved/i);
    await page.locator('#authToken').fill('good-token');
    await page.locator('#ct0').fill('good-ct0');
    await page.locator('#keep').fill('@user003');
    await page.locator('#btn-save').click();
    await page.waitForFunction(() => /saved/i.test(document.querySelector('#save-status')?.textContent || ''));
    assert.match(await text(page, '#creds-status'), /saved/i);
    assert.equal(await page.locator('#authToken').inputValue(), '');
    assert.equal(await page.locator('#ct0').inputValue(), '');
    assert.equal(await page.locator('#btn-run').isDisabled(), false);

    // --- preview
    await page.locator('#btn-preview').click();
    await badge(page, 'finished');
    await page.locator('#preview-panel').waitFor({ state: 'visible' });
    const summary = await text(page, '#preview-summary');
    assert.match(summary, /29/);
    assert.equal(await page.locator('#preview-list').innerText().then((t) => t.includes('user003')), false, 'kept account is not listed');
    assert.equal(mock.state.destroyCalls, 0);

    // --- confirm dialog: cancel does nothing
    await page.locator('#btn-run').click();
    await page.locator('#confirm-dialog').waitFor({ state: 'visible' });
    await page.locator('#confirm-no').click();
    await page.locator('#confirm-dialog').waitFor({ state: 'hidden' });
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(mock.state.destroyCalls, 0, 'cancel must not start anything');

    // --- confirm: run starts, buttons flip, numbers move
    await page.locator('#btn-run').click();
    await page.locator('#confirm-yes').click();
    await page.waitForFunction(() => ['starting', 'running', 'waiting'].includes(document.querySelector('#state-badge')?.dataset.state), null, { timeout: 15_000 });
    assert.equal(await page.locator('#btn-stop').isDisabled(), false);
    assert.equal(await page.locator('#btn-run').isDisabled(), true);
    await page.waitForFunction(() => Number(document.querySelector('#unfollowed-run')?.textContent.replace(/\D/g, '')) >= 3, null, { timeout: 40_000, polling: 100 });

    // --- "come back later": a brand-new tab, no interaction, already shows the running job
    const later = await context.newPage();
    watch(later);
    await later.goto(base);
    await later.locator('#main-view').waitFor({ state: 'visible', timeout: 10_000 });
    await later.waitForFunction(() => Number(document.querySelector('#unfollowed-run')?.textContent.replace(/\D/g, '')) >= 3, null, { timeout: 15_000 });
    await page.close();

    // --- finishes
    await badge(later, 'finished', 90_000);
    assert.equal((await text(later, '#unfollowed-run')).replace(/\D/g, ''), '29');
    assert.equal((await text(later, '#unfollowed-total')).replace(/\D/g, ''), '29');
    assert.ok((await later.locator('#recent a').count()) > 0);
    assert.match(await later.locator('#recent a').first().getAttribute('href'), /^https:\/\/x\.com\/user\d+$/);
    assert.match(await text(later, '#log'), /Unfollowed @user/);
    assert.equal(await later.locator('#download-csv').getAttribute('href'), '/api/unfollowed.csv');
    assert.deepEqual(mock.state.following.map((u) => u.handle), ['user003']);

    // --- logout
    await later.locator('#logout-btn').click();
    await later.locator('#login-view').waitFor({ state: 'visible' });

    assert.deepEqual(problems, [], `browser console problems: ${problems.join(' | ')}`);
  });
});

test('Stop button halts the run and the page says so', { timeout: 120_000 }, async () => {
  await withUi({ count: 40 }, async ({ base, context, watch, problems }) => {
    const page = await context.newPage();
    watch(page);
    await login(page, base);
    await page.locator('#authToken').fill('good-token');
    await page.locator('#ct0').fill('good-ct0');
    await page.locator('#btn-save').click();
    await page.waitForFunction(() => /saved/i.test(document.querySelector('#save-status')?.textContent || ''));
    await page.locator('#btn-run').click();
    await page.locator('#confirm-yes').click();
    await page.waitForFunction(() => Number(document.querySelector('#unfollowed-run')?.textContent.replace(/\D/g, '')) >= 2, null, { timeout: 40_000, polling: 100 });
    await page.locator('#btn-stop').click();
    await badge(page, 'stopped');
    assert.equal(await page.locator('#btn-run').isDisabled(), false, 'can continue afterwards');
    assert.equal(await page.locator('#btn-stop').isDisabled(), true);
    assert.deepEqual(problems, []);
  });
});

test('wrong cookies show a red error with a hint; a waiting state shows a countdown', { timeout: 120_000 }, async () => {
  await withUi({ count: 3 }, async ({ base, context, watch, problems }) => {
    const page = await context.newPage();
    watch(page);
    await login(page, base);
    await page.locator('#authToken').fill('expired-token-123');
    await page.locator('#ct0').fill('whatever-ct0-123');
    await page.locator('#btn-save').click();
    await page.waitForFunction(() => /saved/i.test(document.querySelector('#save-status')?.textContent || ''));
    await page.locator('#btn-preview').click();
    await badge(page, 'error');
    await page.locator('#error-box').waitFor({ state: 'visible' });
    assert.match(await text(page, '#error-box'), /not logged in/i);
    assert.deepEqual(problems, []);
  });

  // an hourly-cap rest: the page shows the countdown + reason
  const seed = (dir) => fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ actions: [1, 2, 3].map((i) => Date.now() - 3600_000 + 8000 + i) }));
  await withUi({ count: 1 }, async ({ base, context, watch, problems }) => {
    const page = await context.newPage();
    watch(page);
    await login(page, base);
    await page.locator('#authToken').fill('good-token');
    await page.locator('#ct0').fill('good-ct0');
    await page.locator('#btn-save').click();
    await page.waitForFunction(() => /saved/i.test(document.querySelector('#save-status')?.textContent || ''));
    await page.locator('#btn-run').click();
    await page.locator('#confirm-yes').click();
    await badge(page, 'waiting', 30_000);
    await page.locator('#countdown').waitFor({ state: 'visible' });
    assert.match(await text(page, '#countdown'), /hourly/i);
    await badge(page, 'finished', 60_000);
    assert.equal(await page.locator('#countdown').isVisible(), false);
    assert.deepEqual(problems, []);
  }, { overrides: { ...FAST, maxPerHour: 3 }, seed });
});

test('a session that disappears server-side sends the user back to the login screen', { timeout: 120_000 }, async () => {
  await withUi({ count: 1 }, async ({ base, context, watch, problems }) => {
    const page = await context.newPage();
    watch(page);
    await login(page, base);
    await page.evaluate(() => fetch('/api/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
    await page.locator('#login-view').waitFor({ state: 'visible', timeout: 25_000 });
    assert.deepEqual(problems, []);
  });
});
