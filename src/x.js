// Everything that touches X's web UI lives here, so selector breakage is a one-file fix.
// Selectors rely on X's `data-testid` attributes, which are far more stable than class names.

import { randBetween, sleep } from './util.js';

export class FatalError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

const SEL = {
  cell: '[data-testid="UserCell"]',
  unfollowBtn: '[data-testid$="-unfollow"]',
  confirm: '[data-testid="confirmationSheetConfirm"]',
  profileLink: 'a[data-testid="AppTabBar_Profile_Link"]',
  toast: '[data-testid="toast"]',
  loginButton: '[data-testid="loginButton"]',
};

// v1.1 error codes returned by friendships/destroy
const ERR_RATE_LIMIT = new Set([88]);
const ERR_ACTION_LIMIT = new Set([161, 185, 226]); // follow limit, daily limit, "looks automated"
const ERR_ACCOUNT = new Set([64, 141, 326]); // suspended / locked
const LIMIT_TEXT = /unable to (follow|unfollow)|limit|too many|try again later|automated/i;

// Collects 429s from any X API call (list loading as well as unfollow clicks).
export function watchApi(page) {
  const watch = { rateLimit: null };
  page.on('response', (res) => {
    if (res.status() !== 429 || !res.url().includes('/i/api/')) return;
    const reset = Number(res.headers()['x-rate-limit-reset']);
    watch.rateLimit = { resetAtMs: Number.isFinite(reset) && reset > 0 ? reset * 1000 : null };
  });
  return watch;
}

async function assertSession(page) {
  const url = page.url();
  if (/\/account\/(access|suspended)/.test(url)) {
    throw new FatalError(`X is asking for verification or the account is locked/suspended (${url}). Resolve it in a normal browser first.`);
  }
  if (/\/i\/flow\/login|\/login(\?|$)/.test(url) || (await page.locator(SEL.loginButton).count()) > 0) {
    throw new FatalError('Not logged in: the auth_token / ct0 cookies are missing, expired or invalid. Copy fresh ones from your browser.');
  }
}

async function dismissCookieBanner(page) {
  try {
    await page.getByRole('button', { name: /refuse non-essential cookies/i }).click({ timeout: 1500 });
  } catch {
    /* no banner */
  }
}

export async function detectUsername(page, baseUrl) {
  await page.goto(`${baseUrl}/home`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.locator(SEL.profileLink).first().waitFor({ timeout: 25_000 }).catch(() => {});
  await assertSession(page);
  const href = await page.locator(SEL.profileLink).first().getAttribute('href').catch(() => null);
  const m = href && href.match(/^\/([A-Za-z0-9_]{1,15})$/);
  if (!m) throw new FatalError('Could not detect your username from the page. Set TWITTER_USERNAME.');
  return m[1];
}

// Loads (or reloads) the following list. Returns once cells show up or the wait gives up.
export async function openFollowing(page, baseUrl, username, { reload = false, listWaitMs = 25_000 } = {}) {
  const target = `${baseUrl}/${username}/following`;
  if (reload && page.url().startsWith(target)) {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
  } else {
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  }
  await page.locator(SEL.cell).first().waitFor({ timeout: listWaitMs }).catch(() => {});
  await assertSession(page);
  await dismissCookieBanner(page);
}

export async function pageLooksBroken(page) {
  const text = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  return /something went wrong|rate limit exceeded|try reloading/i.test(text);
}

// Snapshot of the user cells currently mounted (X virtualises the list, so this is a window).
export function listCells(page) {
  return page.evaluate(
    ({ cellSel, unfollowSel }) =>
      [...document.querySelectorAll(cellSel)].map((cell) => {
        let handle = null;
        for (const a of cell.querySelectorAll('a[href^="/"]')) {
          const m = a.getAttribute('href').match(/^\/([A-Za-z0-9_]{1,15})$/);
          if (m) {
            handle = m[1];
            break;
          }
        }
        return { handle, canUnfollow: !!cell.querySelector(unfollowSel) };
      }),
    { cellSel: SEL.cell, unfollowSel: SEL.unfollowBtn },
  );
}

// Scrolls roughly one screen. Returns false when the page can't scroll any further.
export async function scrollDown(page, { pauseMinMs, pauseMaxMs, endWaitMs }) {
  const read = () => page.evaluate(() => ({ y: Math.round(scrollY), h: document.documentElement.scrollHeight, vh: innerHeight }));
  const before = await read();
  await page.mouse.move(before.vh, before.vh / 2);
  await page.mouse.wheel(0, Math.round(before.vh * 0.8));
  await sleep(randBetween(pauseMinMs, pauseMaxMs));
  let after = await read();
  if (after.y === before.y && after.h === before.h) {
    await sleep(endWaitMs); // lazy loading may still be in flight
    after = await read();
  }
  return after.y !== before.y || after.h !== before.h;
}

const cellFor = (page, handle) =>
  page.locator(SEL.cell).filter({ has: page.locator(`a[href="/${handle}" i]`) }).first();

// Unfollow one handle. Never throws for "expected" failures; returns a typed result:
//   { ok: true } | { ok: false, reason: 'rate_limited' | 'action_limited' | 'failed', resetAtMs?, detail? }
// Throws FatalError when the account itself is suspended/locked.
export async function unfollow(page, watch, handle) {
  const cell = cellFor(page, handle);
  const button = cell.locator(SEL.unfollowBtn).first();
  watch.rateLimit = null;

  try {
    await button.scrollIntoViewIfNeeded({ timeout: 5000 });
    await button.click({ timeout: 8000 });

    const confirm = page.locator(SEL.confirm);
    const confirmed = await confirm.waitFor({ state: 'visible', timeout: 6000 }).then(() => true, () => false);

    let response = null;
    if (confirmed) {
      const pending = page
        .waitForResponse((r) => /friendships\/destroy/.test(r.url()) && r.request().method() === 'POST', { timeout: 12_000 })
        .catch(() => null);
      await confirm.click({ timeout: 5000 });
      response = await pending;
    }

    if (response) {
      const status = response.status();
      if (status >= 200 && status < 300) return { ok: true };
      if (status === 429) return { ok: false, reason: 'rate_limited', resetAtMs: watch.rateLimit?.resetAtMs ?? null };
      const body = await response.json().catch(() => null);
      const code = body?.errors?.[0]?.code;
      if (ERR_ACCOUNT.has(code)) throw new FatalError(`X reports the account is suspended or locked (error ${code}).`);
      if (ERR_RATE_LIMIT.has(code)) return { ok: false, reason: 'rate_limited', resetAtMs: null };
      if (ERR_ACTION_LIMIT.has(code)) return { ok: false, reason: 'action_limited', detail: `error ${code}` };
      return { ok: false, reason: 'failed', detail: `HTTP ${status}${code ? ` / error ${code}` : ''}` };
    }

    // No API response observed (X may have changed the endpoint): fall back to the DOM + toast.
    const toast = await page.locator(SEL.toast).first().innerText({ timeout: 1500 }).catch(() => '');
    if (LIMIT_TEXT.test(toast)) return { ok: false, reason: 'action_limited', detail: `toast: ${toast.trim()}` };
    const flipped = await button.waitFor({ state: 'hidden', timeout: 5000 }).then(() => true, () => false);
    if (flipped) return { ok: true };
    return { ok: false, reason: 'failed', detail: 'button did not change after confirming' };
  } catch (e) {
    if (e instanceof FatalError) throw e;
    // Close a dangling dialog so the next attempt starts clean.
    await page.keyboard.press('Escape').catch(() => {});
    return { ok: false, reason: 'failed', detail: e.message.split('\n')[0] };
  }
}
