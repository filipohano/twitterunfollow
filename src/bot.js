import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { RateLimiter } from './limiter.js';
import { appendUnfollowed, loadActions, saveActions } from './state.js';
import { formatDuration, isStopping, log, randBetween, sleep } from './util.js';
import { FatalError, detectUsername, listCells, openFollowing, pageLooksBroken, readFollowingCount, scrollDown, unfollow, watchApi } from './x.js';

const MAX_BACKOFF_MS = 4 * 3600_000;
const MAX_FAILURES_PER_HANDLE = 3;
const MAX_DISTINCT_FAILURES = 3; // this many *different* accounts failing in a row (no success between) = something is wrong
const MAX_DONE_RETRIES = 3;

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
    await page.screenshot({ path: file, timeout: 10_000 });
    log(`Saved screenshot: ${file}`);
  } catch {
    /* page may already be gone */
  }
}

async function newSession(cfg) {
  const browser = await chromium.launch({
    headless: cfg.headless,
    executablePath: cfg.chromiumPath,
    // Without an explicit binary use Playwright's full "chromium" build (new headless mode) instead of the
    // stripped-down headless shell, which lacks window.chrome / plugins that sites use to spot automation.
    channel: cfg.chromiumPath ? undefined : 'chromium',
    args: ['--disable-blink-features=AutomationControlled'],
  });
  try {
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
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    page.setDefaultNavigationTimeout(60_000);
    return { browser, page };
  } catch (e) {
    await browser.close().catch(() => {}); // don't leak a Chromium process when setup fails
    throw e;
  }
}

/**
 * Runs until the following list is empty (or a stop/limit condition hits).
 * Resolves with { status, unfollowed, skipped, note?, candidates?, kept? } where status is one of:
 *   'done' | 'stopped' | 'max-total' | 'rate-limited' | 'dry-run' | 'incomplete'
 *
 * hooks.emit(type, data) reports progress (used by the web dashboard):
 *   ready {username, followingCount|null} · tick {} · working {handle} · unfollowed {handle, count, usage}
 *   scanning {found} · skipped {handle} · wait {until, reason} / resume {} for long rests
 * hooks.onBrowser(browser) hands the caller the browser so a wedged run can be killed from outside.
 */
export async function run(cfg, hooks = {}) {
  const emit = hooks.emit ?? (() => {});
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const limiter = new RateLimiter({ perHour: cfg.maxPerHour, perDay: cfg.maxPerDay, actions: loadActions(cfg.dataDir) });
  const { timing } = cfg;
  const scroll = { pauseMinMs: timing.scrollPauseMs[0], pauseMaxMs: timing.scrollPauseMs[1], endWaitMs: timing.endWaitMs };

  const { browser, page } = await newSession(cfg);
  hooks.onBrowser?.(browser);
  try {
    const watch = watchApi(page);
    const username = cfg.username || (await detectUsername(page, cfg.baseUrl));
    log(`Account: @${username}${cfg.dryRun ? ' (dry run: nothing will be unfollowed)' : ''}`);
    const followingCount = await readFollowingCount(page, cfg.baseUrl, username);
    if (followingCount !== null) log(`Following about ${followingCount.toLocaleString('en-US')} account(s).`);
    emit('ready', { username, followingCount });
    if (cfg.keep.size) log(`Keeping ${cfg.keep.size} handle(s): ${[...cfg.keep].join(', ')}`);

    const load = (reload = false) => openFollowing(page, cfg.baseUrl, username, { reload, listWaitMs: timing.listWaitMs });
    const unfollowedOk = new Set(); // handles the API accepted an unfollow for in this run (lower-case)
    const skipped = new Set();
    const keptSeen = new Set(); // keep-list accounts actually seen in the list
    let everSawCells = false;

    const isCandidate = (c) => {
      if (!c.handle || !c.canUnfollow || !c.userId) return false;
      const h = c.handle.toLowerCase();
      return !cfg.keep.has(h) && !skipped.has(h) && !unfollowedOk.has(h);
    };
    const observe = (cells) => {
      if (cells.length) everSawCells = true;
      for (const c of cells) if (c.handle && cfg.keep.has(c.handle.toLowerCase())) keptSeen.add(c.handle.toLowerCase());
    };

    // Is the end of the list real? An empty/stalled list, a half-loaded page or an interstitial must not be
    // mistaken for "everything is unfollowed". Navigates to the profile to compare against its Following count.
    const verifyEnd = async () => {
      if (watch.rateLimit) return { ok: false, why: 'X is rate limiting the list requests' };
      if (await pageLooksBroken(page)) return { ok: false, why: 'the page is showing an error' };
      const count = await readFollowingCount(page, cfg.baseUrl, username);
      if (count === null) {
        return everSawCells ? { ok: true, count } : { ok: false, why: "no accounts were visible and the profile's following count could not be read" };
      }
      const explained = keptSeen.size + skipped.size;
      const tolerance = Math.max(5, Math.ceil(count * 0.02));
      if (count - explained > tolerance) {
        return { ok: false, why: `the profile says ${count.toLocaleString('en-US')} followed but the list shows only ${explained} left`, count, unexplained: count - explained };
      }
      return { ok: true, count };
    };

    await load();

    if (cfg.dryRun) {
      const would = new Set();
      const kept = new Set();
      let idleScrolls = 0;
      while (!isStopping() && !watch.rateLimit && idleScrolls < 2) {
        emit('tick', {});
        const cells = await listCells(page);
        observe(cells);
        for (const c of cells) {
          if (!c.handle) continue;
          if (cfg.keep.has(c.handle.toLowerCase())) kept.add(c.handle);
          else if (isCandidate(c)) would.add(c.handle);
        }
        emit('scanning', { found: would.size });
        idleScrolls = (await scrollDown(page, scroll)) ? 0 : idleScrolls + 1;
      }
      if (isStopping()) return { status: 'stopped', unfollowed: 0, skipped: [] };
      if (watch.rateLimit || (await pageLooksBroken(page))) {
        log('Preview incomplete: X was slow or returned an error while the list was loading.');
        return { status: 'incomplete', unfollowed: 0, skipped: [], note: 'X was slow or returned an error while loading your list, so the preview may be missing accounts.' };
      }
      if (!everSawCells) {
        const count = await readFollowingCount(page, cfg.baseUrl, username);
        if (count !== 0) {
          throw new FatalError(
            `The bot could not see your following list${count ? ` (your profile says ${count.toLocaleString('en-US')} accounts)` : ''}. X may be showing a verification page or its layout may have changed. Open x.com in a normal browser to check.`,
          );
        }
      }
      const list = [...would];
      fs.writeFileSync(path.join(cfg.dataDir, 'would-unfollow.txt'), `${list.join('\n')}\n`);
      log(`Dry run: ${list.length} account(s) would be unfollowed, ${kept.size} kept. List written to ${path.join(cfg.dataDir, 'would-unfollow.txt')}`);
      return { status: 'dry-run', unfollowed: 0, skipped: [], candidates: list, kept: kept.size };
    }

    const failures = new Map();
    const failedInARow = new Set(); // distinct handles that failed since the last success
    let lastFailure = '';
    let unfollowed = 0;
    let burst = 0;
    let rateLimitHits = 0;
    let doneRetries = 0;
    let dirty = false; // unfollowed something since the list was last (re)loaded
    let needsReload = false;
    const ghostLogged = new Set();
    const result = (status, note) => ({ status, unfollowed, skipped: [...skipped], note });

    // A long deliberate rest (cap, backoff, break). Short pacing sleeps don't go through here.
    const rest = async (ms, reason) => {
      emit('wait', { until: Date.now() + ms, reason });
      await sleep(ms);
      emit('resume', {});
    };

    const reload = async () => {
      await load(true);
      dirty = false;
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
      await rest(wait, reason === 'action_limited' ? 'X says an action limit was reached; waiting before trying again' : 'X asked the bot to slow down; waiting it out');
      needsReload = true;
      return true;
    };

    while (!isStopping()) {
      emit('tick', {});
      if (cfg.maxTotal && unfollowed >= cfg.maxTotal) return result('max-total');

      // Rate limit noticed while loading/scrolling the list (not from one of our clicks).
      if (watch.rateLimit) {
        const { resetAtMs } = watch.rateLimit;
        watch.rateLimit = null;
        if (!(await backoff('rate_limited', { resetAtMs }))) return result('rate-limited');
        continue;
      }

      if (isStopping()) break;
      if (needsReload) {
        await reload();
        continue;
      }

      const cells = await listCells(page);
      observe(cells);
      // An account we already unfollowed that is still listed (stale list): never hit it again, but say so once.
      for (const c of cells) {
        const h = c.handle?.toLowerCase();
        if (h && c.canUnfollow && unfollowedOk.has(h) && !ghostLogged.has(h)) {
          ghostLogged.add(h);
          log(`@${c.handle} still shows as followed after being unfollowed; X's list may be stale. Not touching it again.`);
        }
      }
      const target = cells.find(isCandidate);

      if (!target) {
        if (await scrollDown(page, scroll)) continue;

        // End of the loaded list with nothing left to unfollow.
        if (dirty) {
          await reload(); // unfollowed accounts only disappear on a fresh load; check for leftovers
          continue;
        }
        const verdict = await verifyEnd();
        if (verdict.ok) return result('done');
        doneRetries += 1;
        if (doneRetries > MAX_DONE_RETRIES) {
          if (!everSawCells) {
            throw new FatalError(`The bot could not see your following list (${verdict.why}). X may be showing a verification page, or its layout may have changed. Open x.com in a normal browser to check.`);
          }
          const note = `The list looks finished, but ${verdict.why}. If you still follow people, run it again.`;
          log(note);
          // A large gap means X stopped showing the list (not just a few unlisted accounts): don't call that "done".
          const bigGap = verdict.unexplained !== undefined && verdict.unexplained > Math.max(25, Math.ceil(verdict.count * 0.1));
          return result(bigGap ? 'incomplete' : 'done', note);
        }
        log(`The list looks finished, but ${verdict.why}. Looking again in a moment (${doneRetries}/${MAX_DONE_RETRIES}).`);
        await sleep(timing.verifyRetryWaitMs);
        if (isStopping()) break;
        await reload();
        continue;
      }

      // Only now, with an account actually waiting to be unfollowed, do the hourly/daily caps matter. (Checking
      // earlier would make a run that has just used up its quota "rest" for an hour with nothing left to do.)
      const capWait = limiter.waitMs();
      if (capWait > 0) {
        const { hour, day } = limiter.usage();
        log(`Cap reached (${hour}/${cfg.maxPerHour} this hour, ${day}/${cfg.maxPerDay} today). Sleeping ${formatDuration(capWait)}.`);
        await rest(capWait + randBetween(...timing.capJitterMs), day >= cfg.maxPerDay ? 'Daily limit reached' : 'Hourly limit reached');
        needsReload = true; // the page is stale after a long rest
        continue;
      }

      const handle = target.handle;
      emit('working', { handle });
      const res = await unfollow(page, watch, { handle, userId: target.userId });

      if (res.ok) {
        limiter.record();
        saveActions(cfg.dataDir, limiter.actions);
        appendUnfollowed(cfg.dataDir, handle);
        unfollowedOk.add(handle.toLowerCase());
        unfollowed += 1;
        burst += 1;
        dirty = true;
        rateLimitHits = 0;
        doneRetries = 0;
        failedInARow.clear();
        failures.delete(handle.toLowerCase());
        const { hour, day } = limiter.usage();
        log(`Unfollowed @${handle}  [run: ${unfollowed}, hour: ${hour}/${cfg.maxPerHour}, 24h: ${day}/${cfg.maxPerDay}]`);
        emit('unfollowed', { handle, count: unfollowed, usage: { hour, day } });

        if (cfg.maxTotal && unfollowed >= cfg.maxTotal) continue; // no point pacing before exiting
        await sleep(randBetween(cfg.delayMinMs, cfg.delayMaxMs));
        if (burst >= cfg.burstSize && !isStopping()) {
          const pause = randBetween(cfg.burstPauseMinMs, cfg.burstPauseMaxMs);
          log(`Taking a ${formatDuration(pause)} break after ${burst} unfollows.`);
          await rest(pause, 'Short break to keep a natural pace');
          burst = 0;
          needsReload = true;
        }
      } else if (res.reason === 'rate_limited' || res.reason === 'action_limited') {
        watch.rateLimit = null; // already accounted for by this result; don't back off twice
        if (!(await backoff(res.reason, res))) return result('rate-limited');
      } else {
        const key = handle.toLowerCase();
        const n = (failures.get(key) || 0) + 1;
        failures.set(key, n);
        failedInARow.add(key);
        lastFailure = res.detail || '';
        log(`Could not unfollow @${handle} (${res.detail}) [attempt ${n}/${MAX_FAILURES_PER_HANDLE}]`);
        if (n >= MAX_FAILURES_PER_HANDLE) {
          skipped.add(key);
          log(`Skipping @${handle} from now on.`);
          emit('skipped', { handle });
        }
        // One or two accounts X refuses to unfollow just get skipped. Several *different* accounts failing with
        // no success in between means the problem is global (changed UI, restricted session).
        if (failedInARow.size >= MAX_DISTINCT_FAILURES) {
          await screenshot(page, cfg.dataDir, 'ui-failure');
          throw new FatalError(
            /HTTP (401|403)/.test(lastFailure)
              ? `X is refusing the unfollow requests (last: ${lastFailure}). Your session may be restricted: open x.com in a normal browser and look for a warning or verification request.`
              : `Unfollowing failed for ${MAX_DISTINCT_FAILURES} different accounts in a row (last: ${lastFailure}). X's page layout may have changed; see the screenshot in ${cfg.dataDir}.`,
          );
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
