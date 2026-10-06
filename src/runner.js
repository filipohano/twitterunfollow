// Owns the single background job behind the dashboard: starts/stops runs, tracks progress for
// GET /api/state, survives container restarts (a run that was active is resumed on boot) and
// retries unexpected crashes (network blips, a dead browser) instead of dying on the first one.
import fs from 'node:fs';
import path from 'node:path';
import { ConfigError, loadConfig } from './config.js';
import { run } from './bot.js';
import { RateLimiter } from './limiter.js';
import { loadActions } from './state.js';
import { FatalError } from './x.js';
import { addLogSink, formatDuration, isStopping, log, requestStop, resetStop, sleep } from './util.js';
import { loadSettings, mergeSettings, parseKeepText, publicSettings, saveSettings, emptySettings } from './settings.js';

const MAX_CRASHES = 5; // consecutive unexpected failures (without any progress in between) before giving up
const LOG_KEEP = 200;
const RECENT_KEEP = 15;
const LOG_ROTATE_BYTES = 2 * 1024 * 1024;

export class RunnerError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};

export class Runner {
  /**
   * @param {object} opts
   * @param {string} opts.dataDir
   * @param {object} [opts.configOverride] merged over the bot config for every run (tests shrink waits with it)
   * @param {number} [opts.crashWaitMs] base wait before retrying after an unexpected crash
   * @param {number} [opts.watchdogMs] kill the browser if the bot has been silent this long (beyond its own pacing)
   * @param {number} [opts.stopGraceMs] after Stop, force-close the browser if the run hasn't unwound in this time
   */
  constructor({ dataDir, configOverride = {}, crashWaitMs = 5 * 60_000, watchdogMs = 10 * 60_000, stopGraceMs = 20_000 }) {
    this.dataDir = dataDir;
    this.configOverride = configOverride;
    this.crashWaitMs = crashWaitMs;
    this.watchdogMs = watchdogMs;
    this.stopGraceMs = stopGraceMs;
    this.browser = null;
    this.timers = [];
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

    this.settings = loadSettings(dataDir);
    this.active = false;
    this.shuttingDown = false;
    this.promise = Promise.resolve();
    this.preview = readJson(this.#file('preview.json'), null);
    this.logBuf = this.#tailLog();
    this.#loadUnfollowed();
    this.s = this.#idleState();

    // Restore the outcome of the previous run so the page isn't blank after a restart.
    const last = readJson(this.#file('job.json'), {}).lastResult;
    if (last && typeof last === 'object') this.s = { ...this.s, ...last, wait: null };

    this.logLines = 0;
    this.removeSink = addLogSink((line) => this.#onLog(line));
  }

  #file(name) {
    return path.join(this.dataDir, name);
  }

  #idleState() {
    return {
      state: 'idle',
      mode: null,
      message: 'Ready.',
      me: null,
      account: null,
      startedAt: null,
      updatedAt: null,
      finishedAt: null,
      followingAtStart: null,
      unfollowedThisRun: 0,
      wait: null,
      skipped: [],
      error: null,
    };
  }

  // ---------- persistence helpers ----------

  #tailLog() {
    try {
      return fs.readFileSync(this.#file('bot.log'), 'utf8').split('\n').filter(Boolean).slice(-LOG_KEEP);
    } catch {
      return [];
    }
  }

  #loadUnfollowed() {
    this.recent = [];
    this.unfollowedTotal = 0;
    try {
      const lines = fs.readFileSync(this.#file('unfollowed.jsonl'), 'utf8').split('\n').filter(Boolean);
      this.unfollowedTotal = lines.length;
      for (const line of lines.slice(-RECENT_KEEP).reverse()) {
        try {
          const { handle, at } = JSON.parse(line);
          if (handle) this.recent.push({ handle, at });
        } catch {
          /* ignore a torn line */
        }
      }
    } catch {
      /* no file yet */
    }
  }

  // Best effort: a full or read-only disk must never stop the bot from starting or (above all) from stopping.
  #saveJob(patch) {
    try {
      const file = this.#file('job.json');
      const job = { ...readJson(file, {}), ...patch };
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(job));
      fs.renameSync(`${file}.tmp`, file);
    } catch (e) {
      log(`Could not save job state (${e.message}). Continuing without it.`);
    }
  }

  #onLog(line) {
    this.logBuf.push(line);
    if (this.logBuf.length > LOG_KEEP * 2) this.logBuf = this.logBuf.slice(-LOG_KEEP);
    try {
      const file = this.#file('bot.log');
      if (++this.logLines % 200 === 1 && fs.existsSync(file) && fs.statSync(file).size > LOG_ROTATE_BYTES) {
        fs.renameSync(file, `${file}.1`);
      }
      fs.appendFileSync(file, `${line}\n`);
    } catch {
      /* logging must never break a run */
    }
  }

  // ---------- settings (called by the API) ----------

  getPublicSettings() {
    return publicSettings(this.settings);
  }

  updateSettings(input) {
    const next = mergeSettings(this.settings, input);
    saveSettings(this.dataDir, next);
    this.settings = next;
    return publicSettings(next);
  }

  forgetCredentials() {
    if (this.active) throw new RunnerError('Stop the run before removing your cookies.', 409);
    this.settings = { ...this.settings, authToken: '', ct0: '' };
    saveSettings(this.dataDir, this.settings);
    this.#saveJob({ desired: null });
  }

  // ---------- state for the dashboard ----------

  getState() {
    const { pacing } = this.settings;
    const limiter = new RateLimiter({ perHour: pacing.maxPerHour, perDay: pacing.maxPerDay, actions: loadActions(this.dataDir) });
    const usage = limiter.usage();
    const { me, ...s } = this.s;
    return {
      ...s,
      me,
      unfollowedTotal: this.unfollowedTotal,
      usage: { hour: usage.hour, day: usage.day, maxPerHour: pacing.maxPerHour, maxPerDay: pacing.maxPerDay },
      recent: this.recent.slice(0, RECENT_KEEP),
      preview: this.preview,
      log: this.logBuf.slice(-LOG_KEEP),
      serverTime: Date.now(),
    };
  }

  // ---------- run control ----------

  start(mode) {
    if (mode !== 'preview' && mode !== 'unfollow') throw new RunnerError('Unknown mode.', 400);
    if (this.active) throw new RunnerError('A run is already active', 409);
    if (!(this.settings.authToken && this.settings.ct0)) throw new RunnerError('Save your cookies first.', 400);

    let cfg;
    try {
      cfg = this.#buildConfig(mode);
    } catch (e) {
      throw new RunnerError(e.message, 400);
    }

    this.shuttingDown = false;
    resetStop();
    const now = Date.now();
    this.s = {
      ...this.#idleState(),
      state: 'starting',
      mode,
      message: mode === 'preview' ? 'Opening a browser to look at your following list…' : 'Opening a browser and logging in…',
      startedAt: now,
      updatedAt: now,
    };
    if (mode === 'unfollow') this.#saveJob({ desired: 'unfollow' });

    this.active = true;
    this.#startWatchdog(cfg);
    this.promise = this.#execute(cfg, mode)
      .catch((e) => log(`Unexpected runner failure: ${e?.stack || e}`))
      .finally(() => {
        this.#clearTimers();
        this.browser = null;
        this.active = false;
      });
  }

  stop() {
    if (!this.active) return;
    requestStop(); // first: nothing below may prevent the bot from stopping
    this.s.message = 'Stopping…';
    log('Stop requested from the dashboard.');
    this.#saveJob({ desired: null });
    // If the run doesn't unwind by itself (a wedged page), kill its browser so Stop always works.
    this.timers.push(setTimeout(() => this.#killBrowser('The run did not stop in time'), this.stopGraceMs).unref());
  }

  #killBrowser(why) {
    if (!this.browser) return;
    log(`${why}; closing the browser by force.`);
    const b = this.browser;
    this.browser = null;
    b.close().catch(() => {});
  }

  #clearTimers() {
    for (const t of this.timers) {
      clearTimeout(t);
      clearInterval(t);
    }
    this.timers = [];
  }

  // A page that stops answering would hang the run forever (and block Stop / Run). If the bot has gone
  // quiet for far longer than its own pacing allows and isn't deliberately resting, kill its browser:
  // the run then fails and the normal crash-retry takes over.
  #startWatchdog(cfg) {
    const interval = Math.max(200, Math.min(30_000, this.watchdogMs / 2));
    this.timers.push(
      setInterval(() => {
        if (!this.active || isStopping() || !this.browser) return;
        const alive = Math.max(this.s.updatedAt ?? 0, this.s.wait?.until ?? 0);
        const limit = (cfg.delayMaxMs ?? 0) + this.watchdogMs;
        if (Date.now() - alive > limit) this.#killBrowser(`The bot has been silent for ${formatDuration(Date.now() - alive)}`);
      }, interval).unref(),
    );
  }

  // Called when the server itself is shutting down (docker stop / reboot): stop cleanly but
  // keep `desired` so the run resumes on the next boot.
  async shutdown() {
    this.shuttingDown = true;
    requestStop();
    // Plain timer on purpose: util.sleep() returns immediately once a stop has been requested.
    await Promise.race([this.promise, new Promise((resolve) => setTimeout(resolve, 25_000).unref())]);
    this.removeSink?.();
  }

  autoResume() {
    const job = readJson(this.#file('job.json'), {});
    if (job.desired !== 'unfollow') return false;
    if (!(this.settings.authToken && this.settings.ct0)) return false;
    log('Resuming the unfollow run that was in progress before the restart.');
    try {
      this.start('unfollow');
      return true;
    } catch (e) {
      log(`Could not resume automatically: ${e.message}`);
      return false;
    }
  }

  #buildConfig(mode) {
    const st = this.settings;
    const env = {
      X_BASE_URL: process.env.X_BASE_URL,
      CHROMIUM_PATH: process.env.CHROMIUM_PATH,
      DATA_DIR: this.dataDir,
      TWITTER_AUTH_TOKEN: st.authToken,
      TWITTER_CT0: st.ct0,
      TWITTER_USERNAME: st.username,
      KEEP: parseKeepText(st.keepText).join(','),
      DRY_RUN: mode === 'preview' ? 'true' : 'false',
      MAX_PER_HOUR: String(st.pacing.maxPerHour),
      MAX_PER_DAY: String(st.pacing.maxPerDay),
      DELAY_MIN_SEC: String(st.pacing.delayMinSec),
      DELAY_MAX_SEC: String(st.pacing.delayMaxSec),
    };
    return Object.assign(loadConfig(env), this.configOverride);
  }

  #onEvent(type, d, base) {
    const s = this.s;
    s.updatedAt = Date.now();
    switch (type) {
      case 'tick':
        break; // heartbeat: keeps updatedAt fresh for the watchdog
      case 'scanning':
        s.message = `Scanning your following list… found ${d.found} so far`;
        break;
      case 'ready':
        s.me = d.username;
        // Only the first attempt knows the true starting total; after a crash-retry the count is what's left.
        if (s.followingAtStart == null && d.followingCount != null) s.followingAtStart = d.followingCount + base;
        s.state = 'running';
        s.message = this.s.mode === 'preview' ? `Logged in as @${d.username}. Scanning your following list…` : `Logged in as @${d.username}. Getting started…`;
        break;
      case 'working':
        s.state = 'running';
        s.wait = null;
        s.account = d.handle;
        s.message = `Unfollowing @${d.handle}`;
        break;
      case 'unfollowed':
        s.unfollowedThisRun = base + d.count;
        this.unfollowedTotal += 1;
        this.recent.unshift({ handle: d.handle, at: new Date().toISOString() });
        this.recent.length = Math.min(this.recent.length, RECENT_KEEP);
        s.message = `Unfollowed @${d.handle}`;
        break;
      case 'skipped':
        if (!s.skipped.includes(d.handle)) s.skipped.push(d.handle);
        break;
      case 'wait':
        s.state = 'waiting';
        s.wait = { until: d.until, reason: d.reason };
        s.message = `Resting: ${d.reason}`;
        break;
      case 'resume':
        s.state = 'running';
        s.wait = null;
        s.message = 'Back to work…';
        break;
      default:
    }
  }

  async #execute(cfg, mode) {
    let crashes = 0;
    let progressAtLastCrash = 0;
    let base = 0; // unfollows from earlier attempts of this same run
    let summary = null;
    let failure = null;

    while (true) {
      try {
        this.s.updatedAt = Date.now(); // a fresh attempt starts the watchdog's silence clock from zero
        summary = await run(cfg, {
          emit: (type, d) => this.#onEvent(type, d, base),
          onBrowser: (b) => {
            this.browser = b;
            this.s.updatedAt = Date.now();
          },
        });
        break;
      } catch (e) {
        base = this.s.unfollowedThisRun;
        this.browser = null;
        if (isStopping() && !(e instanceof FatalError || e instanceof ConfigError)) {
          // Stop (or shutdown) killed the run; that's not a crash worth retrying.
          summary = { status: 'stopped', unfollowed: 0, skipped: [] };
          break;
        }
        if (e instanceof FatalError || e instanceof ConfigError) {
          failure = e.message;
          break;
        }
        const progressed = this.s.unfollowedThisRun > progressAtLastCrash;
        progressAtLastCrash = this.s.unfollowedThisRun;
        crashes = progressed ? 1 : crashes + 1;
        const msg = String(e?.message || e).split('\n')[0];
        log(`Unexpected error: ${msg}`);
        if (crashes > MAX_CRASHES) {
          failure = `The bot hit an unexpected error ${MAX_CRASHES} times in a row and gave up. Last error: ${msg}`;
          break;
        }
        const wait = Math.min(this.crashWaitMs * crashes, 30 * 60_000);
        log(`Retrying in ${formatDuration(wait)} (${crashes}/${MAX_CRASHES}).`);
        this.s.state = 'waiting';
        this.s.wait = { until: Date.now() + wait, reason: 'Recovering from an unexpected error' };
        this.s.message = `Hit a problem (${msg}). Will retry automatically.`;
        await sleep(wait);
        if (isStopping()) {
          summary = { status: 'stopped', unfollowed: 0, skipped: [] };
          break;
        }
        this.s.state = 'starting';
        this.s.wait = null;
        this.s.message = 'Reconnecting…';
      }
    }
    this.#finish(mode, summary, failure);
  }

  #finish(mode, summary, failure) {
    const s = this.s;
    s.finishedAt = Date.now();
    s.updatedAt = s.finishedAt;
    s.wait = null;
    s.account = null;
    let resumeOnBoot = false;

    if (failure) {
      s.state = 'error';
      s.error = failure;
      s.message = 'The bot stopped because of a problem.';
    } else {
      for (const h of summary.skipped ?? []) if (!s.skipped.includes(h)) s.skipped.push(h);
      switch (summary.status) {
        case 'dry-run':
          s.state = 'finished';
          this.preview = { count: summary.candidates.length, kept: summary.kept ?? 0, handles: summary.candidates };
          try {
            fs.writeFileSync(this.#file('preview.json'), JSON.stringify(this.preview));
          } catch (e) {
            log(`Could not save the preview (${e.message}).`);
          }
          s.message = `Preview ready: ${this.preview.count} account(s) would be unfollowed.`;
          break;
        case 'incomplete':
          // X stopped showing the list part-way: neither a finished preview nor a finished run.
          s.state = 'error';
          s.error = `${summary.note || 'X did not show your whole following list.'} Try again in a little while.`;
          s.message = 'The bot could not read your whole list.';
          break;
        case 'done':
          s.state = 'finished';
          s.message = s.unfollowedThisRun ? `All done. Unfollowed ${s.unfollowedThisRun} account(s) in this run.` : 'Nothing left to unfollow.';
          if (s.skipped.length) s.message += ` ${s.skipped.length} could not be unfollowed.`;
          if (summary.note) s.message += ` Note: ${summary.note}`;
          break;
        case 'max-total':
          s.state = 'finished';
          s.message = 'Reached the configured maximum for this run.';
          break;
        case 'rate-limited':
          s.state = 'rate-limited';
          s.error = 'X kept asking the bot to slow down, so it stopped to protect your account. Wait a few hours, then press Unfollow to continue where it left off.';
          s.message = 'Paused because of X rate limits.';
          break;
        default: // 'stopped'
          s.state = 'stopped';
          s.message = this.shuttingDown
            ? 'Server restarting…'
            : mode === 'preview'
              ? 'Preview stopped. Run it again whenever you like.'
              : 'Stopped. Press Unfollow to continue where it left off.';
          resumeOnBoot = this.shuttingDown && mode === 'unfollow';
      }
    }

    if (!resumeOnBoot) this.#saveJob({ desired: null });
    if (!this.shuttingDown) {
      const { me, ...rest } = s;
      this.#saveJob({ lastResult: { ...rest, me } });
    }
    log(`Run ended: ${s.state}${s.error ? ` (${s.error})` : ''}`);
  }
}

export { emptySettings };
