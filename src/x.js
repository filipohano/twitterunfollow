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
const ERR_ACTION_LIMIT = new Set([161, 185, 226]); // follow limit, daily write limit, "looks automated"
const ERR_ACCOUNT = new Set([64, 141, 231, 261, 326]); // suspended / locked / must verify login / writes blocked
const LIMIT_TEXT = /unable to (follow|unfollow)|limit|too many|try again later|automated/i;

const OP_TIMEOUT_MS = 30_000;

// page.evaluate / mouse calls have no timeout of their own; a wedged renderer would hang the run forever.
export function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out after ${Math.round(ms / 1000)}s: ${what}`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// Collects 429s from any X API call (list loading as well as unfollow clicks).
export function watchApi(page) {
  const watch = { rateLimit: null, destroy: null };
  page.on('response', (res) => {
    // Remember the outcome of the unfollow request itself: even if the page misbehaves afterwards
    // (hangs, throws), an accepted unfollow must still be counted and logged.
    if (/friendships\/destroy/.test(res.url()) && res.request().method() === 'POST') watch.destroy = { status: res.status() };
    if (res.status() !== 429 || !res.url().includes('/i/api/')) return;
    const reset = Number(res.headers()['x-rate-limit-reset']);
    watch.rateLimit = { resetAtMs: Number.isFinite(reset) && reset > 0 ? reset * 1000 : null };
  });
  return watch;
}

const normPath = (p) => p.replace(/\/+$/, '').toLowerCase();

// Throws unless the browser ended up on `expectedPath` (so a redirect to a login wall, a consent flow,
// a verification interstitial or a Cloudflare page is reported instead of being mistaken for "empty list").
async function assertSession(page, expectedPath) {
  const url = page.url();
  let path = '';
  try {
    path = new URL(url).pathname;
  } catch {
    /* about:blank etc. */
  }
  if (/\/account\/(access|suspended)/.test(path)) {
    throw new FatalError(`X is asking for verification or the account is locked/suspended (${url}). Open x.com in a normal browser and resolve it first.`);
  }
  if (/\/i\/flow\/login|\/login$/.test(normPath(path)) || (await page.locator(SEL.loginButton).count()) > 0) {
    throw new FatalError(
      "Not logged in: the auth_token / ct0 cookies are missing, expired or invalid. Copy fresh ones from your browser. If fresh cookies still fail, X may be rejecting this server's network location; try a server on your home network.",
    );
  }
  if (expectedPath && normPath(path) !== normPath(expectedPath)) {
    throw new FatalError(
      `X sent the bot to ${url} instead of ${expectedPath}. Open x.com in a normal browser and look for a verification or consent prompt, then try again.`,
    );
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
  await assertSession(page, '/home');
  const href = await page.locator(SEL.profileLink).first().getAttribute('href').catch(() => null);
  const m = href && href.match(/^\/([A-Za-z0-9_]{1,15})$/);
  if (!m) throw new FatalError('Could not detect your handle automatically. Type it into the "Your X handle" box in Settings (command line: set TWITTER_USERNAME) and try again.');
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
  await assertSession(page, `/${username}/following`);
  await dismissCookieBanner(page);
}

// "1,234", "12.5K", "1.2M" -> number. Anything else (other languages/number formats) -> null,
// because a wrong number is worse than none: "1.234" must not become 1.
export function parseCount(text) {
  // (?!\s?\d): "1 234" is a space-grouped number (French etc.), not "1" followed by something else.
  const m = String(text).replace(/[\u00a0\u202f\u2009]/g, ' ').trim().match(/^(\d[\d.,]*)(?!\s?\d)\s?([KkMm])?(?:\s|$)/);
  if (!m) return null;
  const [, token, suffix] = m;
  if (suffix) {
    if (!/^\d+(\.\d+)?$/.test(token)) return null;
    return Math.round(parseFloat(token) * (suffix.toLowerCase() === 'k' ? 1e3 : 1e6));
  }
  if (!/^(\d{1,3}(,\d{3})+|\d+)$/.test(token)) return null;
  return Number(token.replace(/,/g, ''));
}

// Best effort: how many accounts the profile says you follow. Only used for the progress bar,
// so any failure just returns null.
export async function readFollowingCount(page, baseUrl, username) {
  try {
    await page.goto(`${baseUrl}/${username}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const link = page.locator('a[href$="/following" i]').first();
    await link.waitFor({ timeout: 10_000 });
    return parseCount(await link.innerText({ timeout: 3000 }));
  } catch {
    return null;
  }
}

export async function pageLooksBroken(page) {
  const text = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  return /something went wrong|rate limit exceeded|try reloading/i.test(text);
}

// The handle a cell belongs to = its FIRST profile link (the avatar). Other links in a cell (bio @mentions)
// point at other accounts, so they must never be used to identify the cell. The lookup is written out inline
// in each page.evaluate below (functions can't be passed into the page, and eval may be blocked by X's CSP).

// Snapshot of the user cells currently mounted (X virtualises the list, so this is a window).
// userId comes from the cell's own `<id>-unfollow` button and is what unfollow() clicks.
export function listCells(page) {
  return withTimeout(
    page.evaluate(
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
          const btn = cell.querySelector(unfollowSel);
          const id = btn ? btn.getAttribute('data-testid').replace(/-unfollow$/, '') : null;
          return { handle, userId: id && /^\d+$/.test(id) ? id : null, canUnfollow: !!btn };
        }),
      { cellSel: SEL.cell, unfollowSel: SEL.unfollowBtn },
    ),
    OP_TIMEOUT_MS,
    'reading the following list',
  );
}

// Scrolls roughly one screen. Returns false when the page can't scroll any further.
export async function scrollDown(page, { pauseMinMs, pauseMaxMs, endWaitMs }) {
  const read = () =>
    withTimeout(page.evaluate(() => ({ y: Math.round(scrollY), h: document.documentElement.scrollHeight, vh: innerHeight })), OP_TIMEOUT_MS, 'reading scroll position');
  const before = await read();
  await withTimeout(page.mouse.move(before.vh, before.vh / 2), OP_TIMEOUT_MS, 'moving the mouse');
  await withTimeout(page.mouse.wheel(0, Math.round(before.vh * 0.8)), OP_TIMEOUT_MS, 'scrolling');
  await sleep(randBetween(pauseMinMs, pauseMaxMs));
  let after = await read();
  if (after.y === before.y && after.h === before.h) {
    await sleep(endWaitMs); // lazy loading may still be in flight
    after = await read();
  }
  return after.y !== before.y || after.h !== before.h;
}

// Unfollow one handle. Never throws for "expected" failures; returns a typed result:
//   { ok: true } | { ok: false, reason: 'rate_limited' | 'action_limited' | 'failed', resetAtMs?, detail? }
// Throws FatalError when the account itself is suspended/locked.
export async function unfollow(page, watch, { handle, userId }) {
  watch.rateLimit = null;
  watch.destroy = null;
  if (!/^\d+$/.test(String(userId))) return { ok: false, reason: 'failed', detail: 'no user id on the unfollow button' };
  // `<id>-unfollow` belongs to exactly one cell: the one listCells() vetted against the keep list.
  const button = page.locator(`${SEL.cell} [data-testid="${userId}-unfollow"]`).first();

  try {
    // Last line of defence: the row we are about to click must still be the account we chose.
    const own = await withTimeout(
      button.evaluate((el) => {
        const cell = el.closest('[data-testid="UserCell"]');
        for (const a of cell ? cell.querySelectorAll('a[href^="/"]') : []) {
          const m = a.getAttribute('href').match(/^\/([A-Za-z0-9_]{1,15})$/);
          if (m) return m[1];
        }
        return null;
      }),
      OP_TIMEOUT_MS,
      'checking the row',
    );
    if (!own || own.toLowerCase() !== handle.toLowerCase()) {
      return { ok: false, reason: 'failed', detail: `row changed under the bot (expected @${handle}, found @${own})` };
    }

    await button.scrollIntoViewIfNeeded({ timeout: 5000 });
    await button.click({ timeout: 8000 });

    const confirm = page.locator(SEL.confirm);
    const confirmed = await confirm.waitFor({ state: 'visible', timeout: 6000 }).then(() => true, () => false);

    if (confirmed) {
      // X words the sheet "Unfollow @handle?". If it names somebody else, back out. (If it names nobody, we can't tell.)
      const sheet = await confirm.evaluate((el) => (el.closest('[role="dialog"],[role="alertdialog"],[data-testid="confirmationSheetDialog"]') || el.parentElement)?.innerText || '').catch(() => '');
      const named = sheet.match(/@([A-Za-z0-9_]{1,15})/);
      if (named && named[1].toLowerCase() !== handle.toLowerCase()) {
        await withTimeout(page.keyboard.press('Escape'), 3000, 'closing the dialog').catch(() => {});
        return { ok: false, reason: 'failed', detail: `confirmation named @${named[1]} but the bot meant @${handle}; backed out` };
      }
    }

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
      if (ERR_ACCOUNT.has(code)) {
        throw new FatalError(`X says your account needs attention (error ${code}: suspended, locked, or a login verification is required). Open x.com in a normal browser and resolve it, then try again.`);
      }
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
    // The page may have failed AFTER X accepted the unfollow: trust the network response.
    if (watch.destroy && watch.destroy.status >= 200 && watch.destroy.status < 300) return { ok: true };
    // Close a dangling dialog so the next attempt starts clean.
    await withTimeout(page.keyboard.press('Escape'), 3000, 'closing the dialog').catch(() => {});
    return { ok: false, reason: 'failed', detail: e.message.split('\n')[0] };
  }
}
