import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { RateLimiter } from './limiter.js';
import { appendUnfollowed, loadActions, saveActions } from './state.js';
import { formatDuration, isStopping, log, randBetween, sleep } from './util.js';
import { FatalError, detectUsername, listCells, openFollowing, pageLooksBroken, scrollDown, unfollow, watchApi } from './x.js';

const MAX_BACKOFF_MS = 4 * 3600_000;
const MAX_FAILURES_PER_HANDLE = 3;
const MAX_CONSECUTIVE_FAILURES = 5;

// Exponential backoff with jitter; honours X's reset time when it supplied one.
function backoffDelay(attempt, cfg, { resetAtMs, actionLimit }) {
  let ms = Math.min(cfg.backoffBaseMs * 2 ** (attempt - 1), MAX_BACKOFF_MS);
  if (actionLimit) ms = Math.max(ms, cfg.backoffBaseMs * 4);
  if (resetAtMs) ms = Math.max(ms, resetAtMs - Date.now() + cfg.timing.backoffMarginMs);
  return Math.round(ms * (1 + Math.random() * 0.2));
}

async function screenshot(page, dataDir, label) {
  try {
    const file = path.join(dataDir, `${label}-${Date.now()}.png`);
    await page.screenshot({ path: file });
    log(`Saved screenshot: ${file}`);
  } catch {
    /* page may already be gone */
  }
}

async function newSession(cfg) {
  const browser = await chromium.launch({
    headless: cfg.headless,
    executablePath: cfg.chromiumPath,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  // Headless Chromium advertises itself as "HeadlessChrome" in its UA; send the normal Chrome one.
  const major = browser.version().split('.')[0];
  const context = await browser.newContext({
    userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
  });
  const host = new URL(cfg.baseUrl).hostname;
  const secure = cfg.baseUrl.startsWith('https');
  const domain = /(^|\.)x\.com$/.test(host) ? '.x.com' : host;
  await context.addCookies([
    { name: 'auth_token', value: cfg.authToken, domain, path: '/', httpOnly: true, secure, sameSite: secure ? 'None' : 'Lax' },
    { name: 'ct0', value: cfg.ct0, domain, path: '/', httpOnly: false, secure, sameSite: 'Lax' },
  ]);
  return { browser, page: await context.newPage() };
}

/**
 * Runs until the following list is empty (or a stop/limit condition hits).
 * Resolves with { status, unfollowed, skipped, candidates? } where status is one of:
 *   'done' | 'stopped' | 'max-total' | 'rate-limited'
 */
export async function run(cfg) {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const limiter = new RateLimiter({ perHour: cfg.maxPerHour, perDay: cfg.maxPerDay, actions: loadActions(cfg.dataDir) });
  const { timing } = cfg;
  const scroll = { pauseMinMs: timing.scrollPauseMs[0], pauseMaxMs: timing.scrollPauseMs[1], endWaitMs: timing.endWaitMs };

  const { browser, page } = await newSession(cfg);
  try {
    const watch = watchApi(page);
    const username = cfg.username || (await detectUsername(page, cfg.baseUrl));
    log(`Account: @${username}${cfg.dryRun ? ' (dry run: nothing will be unfollowed)' : ''}`);
    if (cfg.keep.size) log(`Keeping ${cfg.keep.size} handle(s): ${[...cfg.keep].join(', ')}`);

    const load = (reload = false) => openFollowing(page, cfg.baseUrl, username, { reload, listWaitMs: timing.listWaitMs });
    const isCandidate = (c, skipped) =>
      c.handle && c.canUnfollow && !cfg.keep.has(c.handle.toLowerCase()) && !skipped.has(c.handle.toLowerCase());

    await load();

    if (cfg.dryRun) return await dryRun(cfg, page, scroll, isCandidate);

    const skipped = new Set();
    const failures = new Map();
    let unfollowed = 0;
    let burst = 0;
    let rateLimitHits = 0;
    let consecutiveFailures = 0;
    let dirty = false; // unfollowed something since the list was last (re)loaded
    let cellsSeen = 0; // cells observed since the list was last (re)loaded
    let emptyChecks = 0;
    let needsReload = false;
    const result = (status) => ({ status, unfollowed, skipped: [...skipped] });

    const reload = async () => {
      await load(true);
      dirty = false;
      cellsSeen = 0;
      needsReload = false;
    };

    const backoff = async (reason, detail) => {
      rateLimitHits += 1;
      if (rateLimitHits > cfg.maxBackoffs) {
        log(`Still rate limited after ${cfg.maxBackoffs} backoffs. Stopping; re-run later (progress is saved).`);
        return false;
      }
      const wait = backoffDelay(rateLimitHits, cfg, { ...detail, actionLimit: reason === 'action_limited' });
      log(`${reason === 'action_limited' ? 'X action limit' : 'Rate limited'} (${rateLimitHits}/${cfg.maxBackoffs})${detail.detail ? `: ${detail.detail}` : ''}. Waiting ${formatDuration(wait)}.`);
      await sleep(wait);
      needsReload = true;
      return true;
    };

    while (!isStopping()) {
      if (cfg.maxTotal && unfollowed >= cfg.maxTotal) return result('max-total');

      // Rate limit noticed while loading/scrolling the list (not from one of our clicks).
      if (watch.rateLimit) {
        const { resetAtMs } = watch.rateLimit;
        watch.rateLimit = null;
        if (!(await backoff('rate_limited', { resetAtMs }))) return result('rate-limited');
        continue;
      }

      const capWait = limiter.waitMs();
      if (capWait > 0) {
        const { hour, day } = limiter.usage();
        log(`Cap reached (${hour}/${cfg.maxPerHour} this hour, ${day}/${cfg.maxPerDay} today). Sleeping ${formatDuration(capWait)}.`);
        await sleep(capWait + randBetween(...timing.capJitterMs));
        needsReload = true;
      }
      if (isStopping()) break;
      if (needsReload) {
        await reload();
        continue;
      }

      const cells = await listCells(page);
      cellsSeen += cells.length;
      const target = cells.find((c) => isCandidate(c, skipped));

      if (!target) {
        if (await scrollDown(page, scroll)) continue;

        // End of the loaded list with nothing left to unfollow.
        if (dirty) {
          await reload(); // unfollowed accounts only disappear on a fresh load; check for leftovers
          continue;
        }
        if (cellsSeen === 0) {
          // An empty page could also be a failed load, so insist on a second look.
          if (await pageLooksBroken(page)) {
            if (!(await backoff('rate_limited', {}))) return result('rate-limited');
            continue;
          }
          emptyChecks += 1;
          if (emptyChecks < 2) {
            await sleep(timing.emptyRecheckMs);
            await reload();
            continue;
          }
        }
        return result('done');
      }

      emptyChecks = 0;
      const handle = target.handle;
      const res = await unfollow(page, watch, handle);

      if (res.ok) {
        limiter.record();
        saveActions(cfg.dataDir, limiter.actions);
        appendUnfollowed(cfg.dataDir, handle);
        unfollowed += 1;
        burst += 1;
        dirty = true;
        rateLimitHits = 0;
        consecutiveFailures = 0;
        failures.delete(handle.toLowerCase());
        const { hour, day } = limiter.usage();
        log(`Unfollowed @${handle}  [run: ${unfollowed}, hour: ${hour}/${cfg.maxPerHour}, 24h: ${day}/${cfg.maxPerDay}]`);

        if (cfg.maxTotal && unfollowed >= cfg.maxTotal) continue; // no point pacing before exiting
        await sleep(randBetween(cfg.delayMinMs, cfg.delayMaxMs));
        if (burst >= cfg.burstSize && !isStopping()) {
          const pause = randBetween(cfg.burstPauseMinMs, cfg.burstPauseMaxMs);
          log(`Taking a ${formatDuration(pause)} break after ${burst} unfollows.`);
          await sleep(pause);
          burst = 0;
          needsReload = true;
        }
      } else if (res.reason === 'rate_limited' || res.reason === 'action_limited') {
        watch.rateLimit = null; // already accounted for by this result; don't back off twice
        if (!(await backoff(res.reason, res))) return result('rate-limited');
      } else {
        consecutiveFailures += 1;
        const n = (failures.get(handle.toLowerCase()) || 0) + 1;
        failures.set(handle.toLowerCase(), n);
        log(`Could not unfollow @${handle} (${res.detail}) [attempt ${n}/${MAX_FAILURES_PER_HANDLE}]`);
        if (n >= MAX_FAILURES_PER_HANDLE) {
          skipped.add(handle.toLowerCase());
          log(`Skipping @${handle} from now on.`);
        }
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          await screenshot(page, cfg.dataDir, 'ui-failure');
          throw new FatalError(`${MAX_CONSECUTIVE_FAILURES} unfollow attempts in a row failed. X's UI may have changed; see the screenshot in ${cfg.dataDir}.`);
        }
        await sleep(randBetween(...timing.failurePauseMs));
        needsReload = true;
      }
    }
    return result('stopped');
  } catch (e) {
    if (!(e instanceof FatalError)) await screenshot(page, cfg.dataDir, 'error');
    throw e;
  } finally {
    await browser.close().catch(() => {});
  }
}

// Walks the whole list and reports who would be unfollowed, touching nothing.
async function dryRun(cfg, page, scroll, isCandidate) {
  const would = new Set();
  const kept = new Set();
  let idleScrolls = 0;
  while (!isStopping() && idleScrolls < 2) {
    for (const c of await listCells(page)) {
      if (!c.handle) continue;
      if (cfg.keep.has(c.handle.toLowerCase())) kept.add(c.handle);
      else if (isCandidate(c, new Set())) would.add(c.handle);
    }
    idleScrolls = (await scrollDown(page, scroll)) ? 0 : idleScrolls + 1;
  }
  const list = [...would];
  fs.writeFileSync(path.join(cfg.dataDir, 'would-unfollow.txt'), `${list.join('\n')}\n`);
  log(`Dry run: ${list.length} account(s) would be unfollowed, ${kept.size} kept. List written to ${path.join(cfg.dataDir, 'would-unfollow.txt')}`);
  return { status: 'dry-run', unfollowed: 0, skipped: [], candidates: list };
}
