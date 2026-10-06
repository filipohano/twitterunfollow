/* Unfollow Bot dashboard. Vanilla JS, no dependencies, no inline anything (CSP: script-src 'self').
 *
 * Rules this file follows on purpose:
 *  - Server-provided strings (handles, log lines, error text) only ever go through textContent.
 *  - Cookie values are write-only: never read back, cleared from the inputs after a save.
 *  - Progress bars are driven with el.style.* (allowed by CSP), never with style="" attributes.
 */
(function () {
  'use strict';

  const POLL_ACTIVE_MS = 3000;
  const POLL_IDLE_MS = 15000;
  const POLL_BURST_MS = 25000;            // after Run/Stop, keep polling fast even if the first reply still says "idle"
  const REQUEST_TIMEOUT_GET_MS = 15000;
  const REQUEST_TIMEOUT_POST_MS = 30000;
  const ACTIVE = { starting: true, running: true, waiting: true };
  const LABELS = {
    idle: 'Ready',
    starting: 'Starting',
    running: 'Running',
    waiting: 'Resting',
    finished: 'Finished',
    stopped: 'Stopped',
    'rate-limited': 'Rate limited',
    error: 'Error'
  };
  const PREVIEWED_KEY = 'unfollowbot.previewed';
  const HANDLE_RE = /^[A-Za-z0-9_]{1,30}$/;

  // Which input a server-reported "field" name belongs to.
  const FIELD_INPUT = {
    authToken: 'authToken',
    ct0: 'ct0',
    username: 'username',
    keepText: 'keep',
    keep: 'keep',
    maxPerHour: 'maxPerHour',
    maxPerDay: 'maxPerDay',
    delayMinSec: 'delayMin',
    delayMin: 'delayMin',
    delayMaxSec: 'delayMax',
    delayMax: 'delayMax'
  };
  const PACING_INPUTS = ['maxPerHour', 'maxPerDay', 'delayMin', 'delayMax'];
  const ALL_INPUTS = ['authToken', 'ct0', 'username', 'keep', 'maxPerHour', 'maxPerDay', 'delayMin', 'delayMax'];

  const $ = (id) => document.getElementById(id);

  const S = {
    authed: false,
    settings: null,       // last settings object from the server
    state: null,          // last /api/state object
    offset: 0,            // serverTime - Date.now(), for clock-skew-safe countdowns
    seq: 0,               // request counter so stale responses are ignored
    pollTimer: null,
    netDown: false,
    busy: false,          // a run/preview start is in flight
    stopping: false,
    saving: false,
    settingsPromise: null,
    settingsSeq: 0,       // bumped by every settings load/save so a slow, older reply can't overwrite a newer one
    savePromise: null,    // in-flight settings save, so a second caller can wait for it
    fastUntil: 0,         // poll fast until this time (set after Run/Stop)
    forgetting: false,
    forgetArmed: false,
    forgetTimer: null,
    waitRefreshedFor: null,
    lockTimer: null,
    renderKey: {}         // remembers what lists/boxes currently show, to avoid pointless DOM churn
  };

  /* ------------------------------------------------------------------ */
  /* small helpers                                                       */
  /* ------------------------------------------------------------------ */

  function setText(el, text) {
    text = String(text);
    if (el.textContent !== text) el.textContent = text;
  }

  function setHidden(el, hidden) {
    if (el.hidden !== hidden) el.hidden = hidden;
  }

  function plural(n, word) {
    return n + ' ' + word + (n === 1 ? '' : 's');
  }

  function safeStorageGet(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }

  function safeStorageSet(key, value) {
    try { window.localStorage.setItem(key, value); } catch (e) { /* storage may be unavailable */ }
  }

  function serverNow() {
    return Date.now() + S.offset;
  }

  // "42 s", "4 min 12 s", "47 min", "2 h 13 min", "1 day 3 h". Short waits count down in seconds so they visibly tick.
  function fmtIn(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + ' s';
    if (s < 600) {
      const r = s % 60;
      return Math.floor(s / 60) + ' min' + (r ? ' ' + r + ' s' : '');
    }
    const m = Math.round(s / 60);
    if (m < 60) return m + ' min';
    const h = Math.floor(m / 60);
    const rm = m % 60;
    if (h < 24) return rm ? h + ' h ' + rm + ' min' : h + ' h';
    const d = Math.floor(h / 24);
    const rh = h % 24;
    return plural(d, 'day') + (rh ? ' ' + rh + ' h' : '');
  }

  function fmtAgo(ms) {
    const s = Math.round(ms / 1000);
    if (s < 5) return 'just now';
    if (s < 60) return s + ' s ago';
    const m = Math.floor(s / 60);
    if (m < 60) return m + ' min ago';
    const h = Math.floor(m / 60);
    if (h < 24) return h + ' h ago';
    return plural(Math.floor(h / 24), 'day') + ' ago';
  }

  function fmtClock(ts) {
    const d = new Date(ts);
    const sameDay = d.toDateString() === new Date().toDateString();
    try {
      return sameDay
        ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
        : d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    } catch (e) {
      return d.toTimeString().slice(0, 5);
    }
  }

  function normHandle(s) {
    return String(s || '').trim().replace(/^@+/, '');
  }

  // Mirrors the server's keep-list parsing (one per line or comma separated, "#" starts a comment,
  // "@" optional, profile URLs accepted) so the count in the confirm dialog matches what will be kept.
  function parseKeep(text) {
    const seen = new Set();
    String(text || '').split(/[\n,]+/).forEach((raw) => {
      const line = raw.replace(/#.*/, '').trim();
      const m = line.match(/^(?:https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/)?@?([A-Za-z0-9_]{1,15})\/?(?:\?.*)?$/i);
      if (m) seen.add(m[1].toLowerCase());
    });
    return Array.from(seen);
  }

  // Pasted cookie values often come with quotes, a "name=" prefix or a trailing semicolon, in any combination.
  function cleanCookie(value, name) {
    const prefix = new RegExp('^' + name + '\\s*=\\s*', 'i');
    let v = String(value || '').trim();
    for (let i = 0; i < 3; i++) {
      v = v.replace(/;+\s*$/, '').replace(/^["']+|["']+$/g, '').replace(prefix, '').trim();
    }
    return v;
  }

  function toast(message, kind) {
    const box = $('toast');
    const el = document.createElement('div');
    el.className = 'toast-msg';
    if (kind) el.dataset.kind = kind;
    el.textContent = message;
    box.appendChild(el);
    while (box.children.length > 3) box.removeChild(box.firstChild);
    window.setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, kind === 'error' ? 7000 : 4500);
  }

  function profileLink(handle, className) {
    if (!HANDLE_RE.test(handle)) {
      const span = document.createElement('span');
      span.textContent = '@' + handle;
      return span;
    }
    const a = document.createElement('a');
    a.href = 'https://x.com/' + encodeURIComponent(handle);
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = '@' + handle;
    if (className) a.className = className;
    return a;
  }

  /* ------------------------------------------------------------------ */
  /* network                                                             */
  /* ------------------------------------------------------------------ */

  // Resolves {ok, status, data}. Rejects with {network:true} when the server can't be reached,
  // or {unauthorized:true} (after switching to the login screen) on a 401.
  async function api(path, opts) {
    opts = opts || {};
    const init = {
      method: opts.method || (opts.body !== undefined || opts.post ? 'POST' : 'GET'),
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json' }
    };
    if (init.method === 'POST') {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body !== undefined ? opts.body : {});
    }
    // A connection that silently hangs (phone woke up, wifi changed) must not stall the polling loop forever.
    let timer = null;
    if (typeof AbortController === 'function') {
      const ac = new AbortController();
      init.signal = ac.signal;
      timer = window.setTimeout(() => ac.abort(), init.method === 'POST' ? REQUEST_TIMEOUT_POST_MS : REQUEST_TIMEOUT_GET_MS);
    }
    let res;
    let data = null;
    try {
      res = await fetch(path, init);
      try { data = await res.json(); } catch (e) { data = null; }
    } catch (e) {
      throw { network: true };
    } finally {
      window.clearTimeout(timer);
    }
    if (res.status === 401 && !opts.allow401) {
      handleUnauthorized();
      throw { unauthorized: true };
    }
    return { ok: res.ok, status: res.status, data: data && typeof data === 'object' ? data : {} };
  }

  function setNetDown(down) {
    if (S.netDown === down) return;
    S.netDown = down;
    setHidden($('net-notice'), !down);
  }

  /* ------------------------------------------------------------------ */
  /* views: login / main                                                 */
  /* ------------------------------------------------------------------ */

  function showLogin(notice) {
    S.authed = false;
    stopPolling();
    const dlg = $('confirm-dialog');
    if (dlg.open) dlg.close();
    S.state = null;
    S.settings = null;
    S.renderKey = {};
    setHidden($('boot'), true);
    setHidden($('main-view'), true);
    setHidden($('login-view'), false);
    setNetDown(false);
    // never leave cookie values or the password lying around in the DOM
    $('authToken').value = '';
    $('ct0').value = '';
    $('password').value = '';
    const n = $('login-notice');
    if (notice) { n.textContent = notice; n.hidden = false; } else { n.textContent = ''; n.hidden = true; }
    const err = $('login-error');
    err.textContent = '';
    err.hidden = true;
    if (!S.lockTimer) setLoginBusy(false);
    window.setTimeout(() => { $('password').focus(); }, 0);
  }

  function handleUnauthorized() {
    if (!S.authed) return;
    showLogin('Your session ended. Please sign in again.');
  }

  async function enterMain() {
    S.authed = true;
    setHidden($('boot'), true);
    setHidden($('login-view'), true);
    setHidden($('main-view'), false);
    S.waitRefreshedFor = null;
    updateControls();
    renderSettingsExtras();
    await Promise.all([ensureSettings(), fetchState()]);
    if (S.authed) schedule();
  }

  function setLoginBusy(busy, label) {
    const btn = $('login-btn');
    btn.disabled = busy;
    btn.textContent = label || (busy ? 'Signing in...' : 'Sign in');
  }

  function lockLogin(seconds) {
    window.clearInterval(S.lockTimer);
    const until = Date.now() + seconds * 1000;
    const tick = () => {
      const left = Math.ceil((until - Date.now()) / 1000);
      if (left <= 0) {
        window.clearInterval(S.lockTimer);
        S.lockTimer = null;
        setLoginBusy(false);
        const err = $('login-error');
        err.textContent = '';
        err.hidden = true;
        return;
      }
      const m = Math.floor(left / 60);
      const s = String(left % 60).padStart(2, '0');
      setLoginBusy(true, 'Try again in ' + m + ':' + s);
    };
    S.lockTimer = window.setInterval(tick, 1000);
    tick();
  }

  async function onLogin(ev) {
    ev.preventDefault();
    if (S.lockTimer) return;
    const pw = $('password').value;
    const err = $('login-error');
    err.hidden = true;
    if (!pw) {
      err.textContent = 'Please type the password.';
      err.hidden = false;
      $('password').focus();
      return;
    }
    setLoginBusy(true);
    try {
      const r = await api('/api/login', { body: { password: pw }, allow401: true });
      if (r.ok) {
        $('password').value = '';
        $('login-notice').hidden = true;
        setLoginBusy(false);
        await enterMain();
        return;
      }
      if (r.status === 429) {
        const secs = Math.max(1, Math.ceil(Number(r.data.retryAfterSec) || 30));
        err.textContent = (r.data.error || 'Too many attempts') + '. Try again in ' + fmtIn(secs * 1000) + '.';
        err.hidden = false;
        lockLogin(secs);
        return;
      }
      err.textContent = r.data.error || 'Could not sign in (error ' + r.status + ').';
      err.hidden = false;
      setLoginBusy(false);
      $('password').focus();
      $('password').select();
    } catch (e) {
      err.textContent = "Can't reach the server. Check your connection and try again.";
      err.hidden = false;
      setLoginBusy(false);
    }
  }

  async function onLogout() {
    try { await api('/api/logout', { post: true, allow401: true }); } catch (e) { /* signing out locally anyway */ }
    showLogin(null);
  }

  /* ------------------------------------------------------------------ */
  /* polling                                                             */
  /* ------------------------------------------------------------------ */

  function currentInterval() {
    if (Date.now() < S.fastUntil) return POLL_ACTIVE_MS;
    return S.state && !ACTIVE[S.state.state] ? POLL_IDLE_MS : POLL_ACTIVE_MS;
  }

  function stopPolling() {
    window.clearTimeout(S.pollTimer);
    S.pollTimer = null;
  }

  function schedule() {
    window.clearTimeout(S.pollTimer);
    if (!S.authed) return;
    S.pollTimer = window.setTimeout(pollTick, currentInterval());
  }

  async function pollTick() {
    if (!S.authed) return;
    // Paused while the tab is hidden; the visibilitychange handler refreshes as soon as it is shown again.
    if (!document.hidden) await fetchState();
    schedule();
  }

  // Fetch right now (used after button presses and when the tab becomes visible).
  async function refreshNow() {
    if (!S.authed) return;
    window.clearTimeout(S.pollTimer);
    await fetchState();
    schedule();
  }

  async function fetchState() {
    const mine = ++S.seq;
    try {
      const r = await api('/api/state');
      if (mine !== S.seq) return;
      if (!r.ok || typeof r.data.state !== 'string') throw { network: true };
      if (typeof r.data.serverTime === 'number') S.offset = r.data.serverTime - Date.now();
      S.state = r.data;
      setNetDown(false);
      // The headline and buttons depend on whether cookies are saved, so know that before the first paint.
      if (!S.settings) await ensureSettings();
      if (!S.authed) return;
      render();
    } catch (e) {
      if (e && e.unauthorized) return;
      if (mine === S.seq) setNetDown(true);
    }
  }

  /* ------------------------------------------------------------------ */
  /* rendering the status                                                */
  /* ------------------------------------------------------------------ */

  function isActive() {
    return !!(S.state && ACTIVE[S.state.state]);
  }

  function credsSaved() {
    return !!(S.settings && S.settings.credentialsSaved);
  }

  function composeHeadline(st) {
    const msg = typeof st.message === 'string' ? st.message.trim() : '';
    const acct = st.account ? '@' + st.account : '';
    switch (st.state) {
      case 'idle':
        return credsSaved() ? 'Ready. Preview first, then run.' : 'Ready. Save your cookies, preview, then run.';
      case 'starting':
        return msg || 'Opening a browser and logging in...';
      case 'running':
        if (msg) return msg;
        if (st.mode === 'preview') return 'Checking who you follow...';
        return acct ? 'Unfollowing ' + acct : 'Unfollowing...';
      case 'waiting':
        return msg || 'Resting for a while';
      case 'finished':
        if (st.mode === 'preview') {
          const p = st.preview;
          return p ? 'Preview done: ' + plural(p.count, 'account') + ' would be unfollowed' : 'Preview done';
        }
        return 'All done - 0 left';
      case 'stopped':
        return st.mode === 'preview'
          ? 'Preview stopped - run it again whenever you like'
          : 'Stopped - click "Unfollow everyone" to continue where it left off';
      case 'rate-limited':
        return 'X told the bot to slow down';
      case 'error':
        return 'The run stopped because of a problem';
      default:
        return msg || st.state;
    }
  }

  function composeSubhint(st) {
    const skipped = Array.isArray(st.skipped) ? st.skipped.length : 0;
    switch (st.state) {
      case 'idle':
        return credsSaved()
          ? 'A preview shows who would be unfollowed without changing anything.'
          : 'Open Settings below and paste your two cookie values to begin.';
      case 'starting':
        return 'This can take a minute.';
      case 'running':
        return st.mode === 'preview'
          ? 'Reading your following list. Nothing is being unfollowed.'
          : 'You can close this page. The bot keeps working. Come back any time to check.';
      case 'waiting':
        return '';
      case 'finished': {
        if (st.mode === 'preview') return 'If the list below looks right, press "Unfollow everyone". Nothing has been changed yet.';
        const done = Number(st.unfollowedThisRun) || 0;
        const parts = [];
        parts.push(done ? plural(done, 'account') + ' unfollowed in this run, ' + (Number(st.unfollowedTotal) || 0) + ' in total.' : 'There was nothing left to unfollow.');
        if (skipped) parts.push(plural(skipped, 'account') + ' could not be unfollowed (see the list below).');
        return parts.join(' ');
      }
      case 'stopped':
        return 'Your progress is saved.';
      default:
        return '';
    }
  }

  const COOKIE_PROBLEM_RE = /cookie|not logged in|logged out|log in|login|auth_token|ct0|unauthori|expired/i;

  function errorHint(st) {
    const text = String(st.error || '');
    if (st.state === 'rate-limited') {
      return 'Nothing is wrong with your settings. Press "Unfollow everyone" in a few hours and it carries on where it left off.';
    }
    if (COOKIE_PROBLEM_RE.test(text)) {
      return 'Your saved cookies probably stopped working (this happens if you log out of x.com in that browser). Copy fresh auth_token and ct0 values, save them in Settings, then run again.';
    }
    if (/verif|locked|suspend/i.test(text)) {
      return 'Open x.com in a normal browser and sort out any verification or lock on the account first. Then try again.';
    }
    return 'You can try again. If it keeps happening, check the activity log below for details.';
  }

  function render() {
    const st = S.state;
    if (!st) return;
    const key = st.state;
    const label = LABELS[key] || key;

    // badge + card accent
    const badge = $('state-badge');
    if (badge.dataset.state !== key) badge.dataset.state = key;
    setText($('state-badge-text'), label);
    $('status-card').dataset.state = key;

    // mode pill
    const pill = $('mode-pill');
    if (st.mode && st.state !== 'idle') {
      setText(pill, st.mode === 'preview' ? 'Preview run' : 'Unfollow run');
      setHidden(pill, false);
    } else {
      setHidden(pill, true);
    }

    // headline + hint
    setText($('headline'), composeHeadline(st));
    const sub = composeSubhint(st);
    setText($('subhint'), sub);
    setHidden($('subhint'), !sub);
    setHidden($('spinner'), !(st.state === 'starting' || (st.state === 'running' && st.mode === 'preview')));

    renderError(st);
    renderRest(st);
    renderProgress(st);
    renderStats(st);
    renderMeta();
    renderLists(st);
    renderLog(st);
    renderActivityLayout(st);
    renderChecklist(st);

    // if another device started a run while the confirm dialog was open, get out of the way
    if (isActive() && $('confirm-dialog').open) $('confirm-dialog').close();

    updateControls();
    renderSettingsExtras();
  }

  function renderError(st) {
    const box = $('error-box');
    const show = st.state === 'error' || st.state === 'rate-limited';
    setHidden(box, !show);
    if (!show) { S.renderKey.error = null; return; }
    const k = st.state + '|' + (st.error || '');
    if (S.renderKey.error === k) return;
    S.renderKey.error = k;
    box.dataset.kind = st.state;
    const defaultText = st.state === 'rate-limited'
      ? 'X told the bot to slow down. It stopped to protect your account. Try again in a few hours.'
      : 'Something went wrong.';
    setText($('error-text'), st.error || defaultText);
    setText($('error-hint'), errorHint(st));
    const cookieish = st.state === 'error' && COOKIE_PROBLEM_RE.test(String(st.error || ''));
    setHidden($('error-help-link'), !cookieish);
  }

  function renderRest(st) {
    const waiting = st.state === 'waiting';
    setHidden($('rest-box'), !waiting);
    setHidden($('countdown'), !waiting);
    if (waiting) renderCountdown();
  }

  function renderCountdown() {
    const st = S.state;
    if (!st || st.state !== 'waiting') return;
    const w = st.wait;
    const el = $('countdown');
    if (!w || typeof w.until !== 'number') {
      setText(el, 'Resting for a while');
      return;
    }
    const remaining = w.until - serverNow();
    const when = fmtClock(Date.now() + remaining);
    const rel = remaining <= 1000 ? 'any moment now' : 'in ' + fmtIn(remaining);
    const reason = w.reason ? ' - ' + String(w.reason).trim().replace(/[.\s]+$/, '') : '';
    setText(el, 'Resting until ' + when + ' (' + rel + ')' + reason);
    // the rest is over: fetch fresh state once instead of waiting for the next poll
    if (remaining <= 0 && S.waitRefreshedFor !== w.until) {
      S.waitRefreshedFor = w.until;
      refreshNow();
    }
  }

  function renderProgress(st) {
    const block = $('progress-block');
    const bar = $('progress');
    const label = $('progress-label');
    const eta = $('eta');
    const total = typeof st.followingAtStart === 'number' ? st.followingAtStart : null;
    const done = Number(st.unfollowedThisRun) || 0;
    const unfollowRun = st.mode === 'unfollow' && st.state !== 'idle';

    block.dataset.state = st.state;
    let showBar = false;
    let text = '';

    if (unfollowRun && total !== null && total > 0) {
      const raw = Math.max(0, Math.min(100, (done / total) * 100));
      // floor, and hold at 99 while the run is still going, so "399 of 400" never reads as "100%"
      // (a finished run is complete even if a few accounts could not be unfollowed)
      const pct = (done >= total || st.state === 'finished') ? 100 : Math.min(99, Math.floor(raw));
      showBar = true;
      bar.setAttribute('aria-valuenow', String(pct));
      bar.setAttribute('aria-valuetext', done + ' of ' + total + ' unfollowed');
      $('progress-fill').style.width = raw + '%';
      text = pct + '% - ' + done + ' of ' + total + ' unfollowed this run';
    } else if (unfollowRun && done > 0) {
      text = done + ' unfollowed so far in this run';
    }
    setHidden(bar, !showBar);
    setText(label, text);
    setHidden(label, !text);
    setHidden(block, !text && !showBar);

    // rough ETA from the daily cap
    let etaText = '';
    if (ACTIVE[st.state] && unfollowRun && total !== null) {
      const remaining = total - done;
      // the slower of the two caps decides the real pace (e.g. 5 per hour can never reach 400 per day)
      const u = st.usage || {};
      let perDay = Number(u.maxPerDay);
      const perHour = Number(u.maxPerHour);
      if (perHour > 0 && (!(perDay > 0) || perHour * 24 < perDay)) perDay = perHour * 24;
      if (remaining > 0 && perDay > 0) {
        const days = remaining / perDay;
        if (days <= 1) etaText = 'Less than a day left at the current limits';
        else if (days < 1.5) etaText = 'About a day left at the current limits';
        else etaText = 'About ' + Math.round(days) + ' days left at the current limits';
      }
    }
    setText(eta, etaText);
    setHidden(eta, !etaText);
  }

  function renderStats(st) {
    setText($('unfollowed-run'), Number(st.unfollowedThisRun) || 0);
    setText($('unfollowed-total'), Number(st.unfollowedTotal) || 0);
    const u = st.usage;
    const set = (id, used, max) => {
      const ok = typeof used === 'number' && typeof max === 'number' && max > 0;
      setText($('usage-' + id), ok ? used + ' / ' + max : '-');
      const fill = $('usage-' + id + '-bar');
      const pct = ok ? Math.max(0, Math.min(100, (used / max) * 100)) : 0;
      fill.style.width = pct + '%';
      fill.dataset.high = String(pct >= 90);
    };
    set('hour', u && u.hour, u && u.maxPerHour);
    set('day', u && u.day, u && u.maxPerDay);
  }

  function renderMeta() {
    const st = S.state;
    const el = $('run-meta');
    if (!st) return;
    const now = serverNow();
    const parts = [];
    if (st.state !== 'idle') {
      if (typeof st.startedAt === 'number') parts.push('Started ' + fmtAgo(now - st.startedAt));
      if (ACTIVE[st.state]) {
        if (typeof st.updatedAt === 'number') parts.push('last activity ' + fmtAgo(now - st.updatedAt));
      } else {
        const end = typeof st.finishedAt === 'number' ? st.finishedAt : st.updatedAt;
        if (typeof end === 'number') parts.push('ended ' + fmtAgo(now - end));
      }
    }
    const text = parts.join(' · ');
    setText(el, text);
    setHidden(el, !text);
  }

  function renderLists(st) {
    // recently unfollowed
    const recent = Array.isArray(st.recent) ? st.recent : [];
    const rk = recent.map((r) => r.handle + '@' + r.at).join('|');
    if (S.renderKey.recent !== rk) {
      S.renderKey.recent = rk;
      const ol = $('recent');
      ol.textContent = '';
      recent.forEach((r) => {
        const li = document.createElement('li');
        li.appendChild(profileLink(String(r.handle)));
        const t = document.createElement('time');
        t.dateTime = String(r.at || '');
        t.dataset.at = String(r.at || '');
        li.appendChild(t);
        ol.appendChild(li);
      });
      setHidden(ol, recent.length === 0);
      setHidden($('recent-empty'), recent.length > 0);
    }
    updateRecentTimes();

    // skipped
    const skipped = Array.isArray(st.skipped) ? st.skipped : [];
    const sk = skipped.join('|');
    if (S.renderKey.skipped !== sk) {
      S.renderKey.skipped = sk;
      const ul = $('skipped-list');
      ul.textContent = '';
      skipped.forEach((h) => {
        const li = document.createElement('li');
        li.appendChild(profileLink(String(h)));
        ul.appendChild(li);
      });
      setText($('skipped-summary'), plural(skipped.length, 'account') + " the bot couldn't unfollow. You can check them on x.com yourself.");
      setHidden($('skipped-panel'), skipped.length === 0);
    }

    // preview
    const p = st.preview && typeof st.preview === 'object' ? st.preview : null;
    const pk = p ? p.count + '/' + p.kept + '/' + (p.handles || []).join('|') : '';
    if (S.renderKey.preview !== pk) {
      S.renderKey.preview = pk;
      const ul = $('preview-list');
      ul.textContent = '';
      if (p) {
        (Array.isArray(p.handles) ? p.handles : []).forEach((h) => {
          const li = document.createElement('li');
          li.appendChild(profileLink(String(h)));
          ul.appendChild(li);
        });
        setText($('preview-summary'), plural(Number(p.count) || 0, 'account') + ' would be unfollowed, ' + (Number(p.kept) || 0) + ' kept');
        safeStorageSet(PREVIEWED_KEY, '1');
      }
      setHidden($('preview-panel'), !p);
    }
  }

  function updateRecentTimes() {
    const now = serverNow();
    $('recent').querySelectorAll('time[data-at]').forEach((t) => {
      const ts = Date.parse(t.dataset.at);
      setText(t, isNaN(ts) ? '' : fmtAgo(now - ts));
    });
  }

  function renderLog(st) {
    const log = $('log');
    const lines = Array.isArray(st.log) ? st.log.map(String) : [];
    const text = lines.join('\n');
    if (S.renderKey.log === text) return;
    S.renderKey.log = text;
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
    const first = log.dataset.init !== '1';
    log.dataset.init = '1';
    if (lines.length === 0) {
      log.textContent = 'Nothing here yet.';
      log.dataset.empty = 'true';
    } else {
      log.textContent = text;
      log.dataset.empty = 'false';
    }
    if (first || atBottom) log.scrollTop = log.scrollHeight;
  }

  // First run: nothing to show yet, so don't put four empty cards between the checklist and the settings.
  // Right after a preview: the preview result is what the person came for, so it goes to the top of Activity.
  function renderActivityLayout(st) {
    const hasData = (Array.isArray(st.recent) && st.recent.length > 0)
      || (Array.isArray(st.skipped) && st.skipped.length > 0)
      || (Array.isArray(st.log) && st.log.length > 0)
      || !!(st.preview && typeof st.preview === 'object');
    setHidden($('activity'), !credsSaved() && !hasData);

    const first = !!(st.preview && typeof st.preview === 'object') && st.mode === 'preview' && !ACTIVE[st.state];
    if (S.renderKey.previewFirst !== first) {
      S.renderKey.previewFirst = first;
      const activity = $('activity');
      const panel = $('preview-panel');
      const before = first ? $('activity-title').nextElementSibling : $('log').closest('.card');
      if (before !== panel) activity.insertBefore(panel, before);
    }
  }

  function renderChecklist(st) {
    const saved = credsSaved();
    const previewDone = !!st.preview || safeStorageGet(PREVIEWED_KEY) === '1';
    const everRan = (Number(st.unfollowedTotal) || 0) > 0;
    const show = !saved || (st.state === 'idle' && !everRan);
    setHidden($('checklist-card'), !show);
    if (!show) return;
    const done = [saved, saved && previewDone, saved && everRan];
    const current = done.indexOf(false);
    for (let i = 0; i < 3; i++) {
      const li = $('step-' + (i + 1));
      li.dataset.done = String(done[i]);
      li.dataset.current = String(i === current);
      setText($('step-' + (i + 1) + '-flag'), done[i] ? ' (done)' : i === current ? ' (next step)' : '');
    }
  }

  // runs once a second
  function tick() {
    if (!S.authed || !S.state) return;
    renderCountdown();
    renderMeta();
    updateRecentTimes();
  }

  /* ------------------------------------------------------------------ */
  /* controls                                                            */
  /* ------------------------------------------------------------------ */

  function updateControls() {
    const active = isActive();
    const saved = credsSaved();
    const canStart = !!S.state && saved && !active && !S.busy;
    $('btn-preview').disabled = !canStart;
    $('btn-run').disabled = !canStart;
    $('btn-stop').disabled = !active || S.stopping;
    $('btn-forget').disabled = !saved || active || S.forgetting;
    $('controls-card').dataset.active = String(active);

    const note = $('controls-note');
    let text = '';
    let link = false;
    if (!S.state) text = 'Loading...';
    else if (!saved) { text = 'Save your cookies first to unlock these buttons.'; link = true; }
    else if (active) text = 'A run is in progress. Press Stop to pause it; you can continue later.';
    else text = 'Preview is safe: it only lists who would be unfollowed.';
    const noteKey = text + '|' + link;
    if (S.renderKey.note !== noteKey) {
      S.renderKey.note = noteKey;
      note.textContent = text;
      if (link) {
        note.appendChild(document.createTextNode(' '));
        const a = document.createElement('a');
        a.href = '#settings';
        a.textContent = 'Go to Settings';
        note.appendChild(a);
      }
    }
  }

  function renderSettingsExtras() {
    setHidden($('settings-run-note'), !isActive());
  }

  async function startRun(mode) {
    if (S.busy) return;
    S.busy = true;
    updateControls();
    try {
      if (isDirty()) {
        const ok = await saveSettings({ auto: true });
        if (!ok) return;
      }
      const r = await api('/api/run', { body: { mode: mode } });
      if (r.ok) {
        S.fastUntil = Date.now() + POLL_BURST_MS;
        if (mode === 'preview') safeStorageSet(PREVIEWED_KEY, '1');
        toast(mode === 'preview' ? 'Preview started.' : 'Started. You can close this page - it keeps running.');
      } else if (r.status === 409) {
        toast(r.data.error || 'A run is already active.', 'error');
      } else {
        toast(r.data.error || 'Could not start (error ' + r.status + ').', 'error');
        if (/cookie/i.test(String(r.data.error || ''))) loadSettings({ initial: false });
      }
      // Fetch the new state before the buttons come back to life, so a second press can't slip in
      // between "server accepted the run" and "page knows a run is active".
      await refreshNow();
    } catch (e) {
      if (e && e.network) toast("Can't reach the server. Please try again.", 'error');
    } finally {
      S.busy = false;
      updateControls();
    }
  }

  function openConfirm() {
    const dlg = $('confirm-dialog');
    const n = parseKeep($('keep').value).length;
    setText($('confirm-keep'), n === 0
      ? 'Your keep list is empty, so nobody is protected.'
      : 'Your keep list protects ' + plural(n, 'account') + '.');
    setHidden($('confirm-dirty'), !isDirty());
    const neverPreviewed = !(S.state && S.state.preview) && safeStorageGet(PREVIEWED_KEY) !== '1';
    setHidden($('confirm-tip'), !neverPreviewed);
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
    // Cancel is the safe default focus, but focusing it must not scroll the warning text out of view on small screens.
    $('confirm-no').focus({ preventScroll: true });
    const body = dlg.querySelector('.dialog-body');
    if (body) body.scrollTop = 0;
  }

  function closeConfirm() {
    const dlg = $('confirm-dialog');
    if (dlg.open) dlg.close();
  }

  async function onStop() {
    if (S.stopping) return;
    S.stopping = true;
    updateControls();
    try {
      const r = await api('/api/stop', { post: true });
      if (r.ok) {
        S.fastUntil = Date.now() + POLL_BURST_MS;
        toast('Stopping. It will finish what it is doing first.');
      } else {
        toast(r.data.error || 'Could not stop (error ' + r.status + ').', 'error');
      }
      await refreshNow();
    } catch (e) {
      if (e && e.network) toast("Can't reach the server. Please try again.", 'error');
    } finally {
      S.stopping = false;
      updateControls();
    }
  }

  /* ------------------------------------------------------------------ */
  /* settings                                                            */
  /* ------------------------------------------------------------------ */

  function formValues() {
    return {
      authToken: cleanCookie($('authToken').value, 'auth_token'),
      ct0: cleanCookie($('ct0').value, 'ct0'),
      username: normHandle($('username').value),
      keepText: $('keep').value.replace(/\r\n/g, '\n').trimEnd(),
      pacing: {
        maxPerHour: $('maxPerHour').value.trim(),
        maxPerDay: $('maxPerDay').value.trim(),
        delayMinSec: $('delayMin').value.trim(),
        delayMaxSec: $('delayMax').value.trim()
      }
    };
  }

  function isDirty() {
    const s = S.settings;
    if (!s) return false;
    const f = formValues();
    if (f.authToken || f.ct0) return true;
    const p = s.pacing || {};
    return f.username !== normHandle(s.username)
      || f.keepText !== String(s.keepText || '').replace(/\r\n/g, '\n').trimEnd()
      || f.pacing.maxPerHour !== String(p.maxPerHour)
      || f.pacing.maxPerDay !== String(p.maxPerDay)
      || f.pacing.delayMinSec !== String(p.delayMinSec)
      || f.pacing.delayMaxSec !== String(p.delayMaxSec);
  }

  function fillForm(s) {
    const p = s.pacing || {};
    $('username').value = s.username || '';
    $('keep').value = s.keepText || '';
    $('maxPerHour').value = p.maxPerHour != null ? p.maxPerHour : '';
    $('maxPerDay').value = p.maxPerDay != null ? p.maxPerDay : '';
    $('delayMin').value = p.delayMinSec != null ? p.delayMinSec : '';
    $('delayMax').value = p.delayMaxSec != null ? p.delayMaxSec : '';
  }

  function applySettings(s, opts) {
    opts = opts || {};
    const prevSaved = S.settings ? !!S.settings.credentialsSaved : null;
    const keepEdits = !!opts.keepEdits;
    S.settings = s;
    if (s.defaults) {
      const d = s.defaults;
      $('maxPerHour').placeholder = String(d.maxPerHour);
      $('maxPerDay').placeholder = String(d.maxPerDay);
      $('delayMin').placeholder = String(d.delayMinSec);
      $('delayMax').placeholder = String(d.delayMaxSec);
      setText($('hint-pacing'), 'Lower numbers are safer for your account. The defaults (' + d.maxPerHour + ' per hour, ' + d.maxPerDay + ' per day, ' + d.delayMinSec + '-' + d.delayMaxSec + ' second pauses) are a good choice.');
    }
    if (!keepEdits) fillForm(s);
    if (opts.clearTokens) { $('authToken').value = ''; $('ct0').value = ''; }

    const saved = !!s.credentialsSaved;
    const chip = $('creds-status');
    chip.dataset.saved = String(saved);
    setText(chip, saved ? 'Cookies saved' : 'No cookies saved yet');

    // Open the help while there are no cookies; close it once they are saved. Never fight the user in between.
    const help = $('help-cookies');
    if (prevSaved === null) help.open = !saved;
    else if (prevSaved !== saved) help.open = !saved;

    if (S.forgetArmed && !saved) disarmForget();
    // headline, checklist and buttons all depend on whether cookies are saved: refresh them right away
    if (S.state) render();
    else updateControls();
  }

  function ensureSettings() {
    if (S.settings) return Promise.resolve(true);
    if (!S.settingsPromise) {
      S.settingsPromise = loadSettings({ initial: true }).finally(() => { S.settingsPromise = null; });
    }
    return S.settingsPromise;
  }

  async function loadSettings(opts) {
    const mine = ++S.settingsSeq;
    try {
      const r = await api('/api/settings');
      if (mine !== S.settingsSeq) return false;   // a newer load or a save has happened meanwhile
      if (!r.ok || typeof r.data.credentialsSaved !== 'boolean') throw { network: true };
      const keepEdits = !(opts && opts.initial) && !!S.settings && isDirty();
      applySettings(r.data, { keepEdits: keepEdits });
      return true;
    } catch (e) {
      return false;
    }
  }

  function setSaveStatus(text, kind) {
    const el = $('save-status');
    // unchanged text must not be rewritten: the element is a live region and would be re-announced on every keystroke
    if (el.textContent === text && (el.dataset.kind || '') === (kind || '') && el.hidden === !text) return;
    el.textContent = text;
    el.dataset.kind = kind || '';
    el.hidden = !text;
  }

  // The four speed-limit inputs have no inline message of their own: they sit right above the Save
  // button, so the red outline plus the status line under it say everything (and the grid stays tidy).
  function errElFor(inputId) {
    return PACING_INPUTS.indexOf(inputId) !== -1 ? null : $('err-' + inputId);
  }

  function clearFieldError(inputId) {
    const input = $(inputId);
    if (input.getAttribute('aria-invalid')) input.removeAttribute('aria-invalid');
    const err = errElFor(inputId);
    if (err) { err.textContent = ''; err.hidden = true; }
  }

  function clearAllFieldErrors() {
    ALL_INPUTS.forEach(clearFieldError);
  }

  function showFieldError(field, message) {
    let ids = [];
    const name = String(field || '').replace(/^pacing\./, '');
    if (name === 'pacing') ids = PACING_INPUTS.slice();
    else if (FIELD_INPUT[name]) ids = [FIELD_INPUT[name]];
    else if (ALL_INPUTS.indexOf(name) !== -1) ids = [name];
    ids.forEach((id, i) => {
      $(id).setAttribute('aria-invalid', 'true');
      const err = errElFor(id);
      if (err && i === 0) { err.textContent = message; err.hidden = false; }
    });
    setSaveStatus(message, 'error');
    if (ids.length) $(ids[0]).focus();
  }

  async function saveSettings(opts) {
    // A save is already on its way (e.g. Save was pressed, then Preview): wait for it instead of silently doing nothing.
    if (S.saving) return S.savePromise ? S.savePromise.then(() => !isDirty()) : false;
    S.savePromise = doSaveSettings(opts).finally(() => { S.savePromise = null; });
    return S.savePromise;
  }

  async function doSaveSettings(opts) {
    clearAllFieldErrors();
    const f = formValues();

    const hasA = !!f.authToken;
    const hasC = !!f.ct0;
    if (hasA !== hasC) {
      showFieldError(hasA ? 'ct0' : 'authToken', 'Paste both cookie values together (auth_token and ct0), or leave both empty.');
      return false;
    }
    const pacing = {};
    const pairs = [['maxPerHour', 'maxPerHour'], ['maxPerDay', 'maxPerDay'], ['delayMinSec', 'delayMinSec'], ['delayMaxSec', 'delayMaxSec']];
    for (let i = 0; i < pairs.length; i++) {
      const raw = f.pacing[pairs[i][0]];
      const n = raw === '' ? NaN : Number(raw);
      if (!isFinite(n)) {
        showFieldError(pairs[i][1], 'Please enter a number.');
        return false;
      }
      pacing[pairs[i][0]] = n;
    }

    const body = { username: f.username, keepText: $('keep').value, pacing: pacing };
    if (hasA && hasC) { body.authToken = f.authToken; body.ct0 = f.ct0; }

    S.saving = true;
    $('btn-save').disabled = true;
    setSaveStatus('Saving...', 'info');
    try {
      const r = await api('/api/settings', { body: body });
      if (r.ok && typeof r.data.credentialsSaved === 'boolean') {
        S.settingsSeq++;
        applySettings(r.data, { clearTokens: true });
        setSaveStatus('Saved', 'ok');
        if (!opts || !opts.auto) toast('Settings saved.');
        return true;
      }
      const msg = r.data.error || 'Could not save (error ' + r.status + ').';
      showFieldError(r.data.field, msg);
      if (opts && opts.auto) toast('Fix the highlighted setting first.', 'error');
      return false;
    } catch (e) {
      if (e && e.network) setSaveStatus("Can't reach the server, so nothing was saved. Please try again.", 'error');
      return false;
    } finally {
      S.saving = false;
      $('btn-save').disabled = false;
    }
  }

  function onSettingsInput(ev) {
    const id = ev.target && ev.target.id;
    if (id && ALL_INPUTS.indexOf(id) !== -1) clearFieldError(id);
    const status = $('save-status');
    if (status.dataset.kind === 'error') {
      // leave an error visible until every highlighted field has been touched
      if (!document.querySelector('#settings-form [aria-invalid="true"]')) setSaveStatus('', '');
    }
    if (status.dataset.kind !== 'error') {
      setSaveStatus(isDirty() ? 'Unsaved changes' : '', isDirty() ? 'info' : '');
    }
  }

  function onDefaults() {
    const d = (S.settings && S.settings.defaults) || { maxPerHour: 30, maxPerDay: 150, delayMinSec: 15, delayMaxSec: 45 };
    PACING_INPUTS.forEach(clearFieldError);
    $('maxPerHour').value = d.maxPerHour;
    $('maxPerDay').value = d.maxPerDay;
    $('delayMin').value = d.delayMinSec;
    $('delayMax').value = d.delayMaxSec;
    const status = $('save-status');
    if (status.dataset.kind === 'error') setSaveStatus('', '');
    setSaveStatus(isDirty() ? 'Unsaved changes' : '', isDirty() ? 'info' : '');
    toast('Speed limits reset. Press "Save settings" to keep them.');
  }

  function disarmForget() {
    window.clearTimeout(S.forgetTimer);
    S.forgetArmed = false;
    const b = $('btn-forget');
    b.dataset.armed = 'false';
    b.textContent = 'Forget my cookies';
  }

  async function onForget() {
    if (!S.forgetArmed) {
      S.forgetArmed = true;
      const b = $('btn-forget');
      b.dataset.armed = 'true';
      b.textContent = 'Click again to confirm';
      window.clearTimeout(S.forgetTimer);
      S.forgetTimer = window.setTimeout(disarmForget, 6000);
      toast('Press the button again within a few seconds to remove your saved cookies.');   // also tells screen-reader users
      return;
    }
    disarmForget();
    S.forgetting = true;
    updateControls();
    try {
      const r = await api('/api/credentials/forget', { post: true });
      if (r.ok) {
        toast('Your cookies were removed from the server.');
        await loadSettings({ initial: false });
        setSaveStatus('', '');
      } else {
        toast(r.data.error || 'Could not forget the cookies (error ' + r.status + ').', 'error');
      }
    } catch (e) {
      if (e && e.network) toast("Can't reach the server. Please try again.", 'error');
    } finally {
      S.forgetting = false;
      updateControls();
    }
    refreshNow();
  }

  async function onSubmitSettings(ev) {
    ev.preventDefault();
    await saveSettings();
  }

  async function onCopyLog() {
    const lines = S.state && Array.isArray(S.state.log) ? S.state.log.map(String) : [];
    const text = lines.join('\n');
    if (!text) { toast('The log is empty.'); return; }
    let ok = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch (e) { ok = false; }
    if (!ok) {
      // plain-http fallback: select the visible log text and ask the browser to copy it
      try {
        const range = document.createRange();
        range.selectNodeContents($('log'));
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        ok = document.execCommand('copy');
      } catch (e) { ok = false; }
    }
    toast(ok ? 'Log copied.' : 'Could not copy automatically. Select the log text and copy it.', ok ? '' : 'error');
  }

  /* ------------------------------------------------------------------ */
  /* wiring                                                              */
  /* ------------------------------------------------------------------ */

  function wire() {
    $('login-form').addEventListener('submit', onLogin);
    $('logout-btn').addEventListener('click', onLogout);

    $('btn-preview').addEventListener('click', () => startRun('preview'));
    $('btn-run').addEventListener('click', openConfirm);
    $('btn-stop').addEventListener('click', onStop);

    $('confirm-no').addEventListener('click', closeConfirm);
    $('confirm-yes').addEventListener('click', () => { closeConfirm(); startRun('unfollow'); });
    $('confirm-preview').addEventListener('click', () => { closeConfirm(); startRun('preview'); });
    $('confirm-dialog').addEventListener('click', (ev) => { if (ev.target === ev.currentTarget) closeConfirm(); });

    $('settings-form').addEventListener('submit', onSubmitSettings);
    $('settings-form').addEventListener('input', onSettingsInput);
    $('btn-defaults').addEventListener('click', onDefaults);
    $('btn-forget').addEventListener('click', onForget);
    $('btn-forget').addEventListener('blur', () => { if (S.forgetArmed) disarmForget(); });
    $('btn-copy-log').addEventListener('click', onCopyLog);

    // links that point at the help section should open it
    document.addEventListener('click', (ev) => {
      const a = ev.target && ev.target.closest ? ev.target.closest('a[href="#help-cookies"]') : null;
      if (a) $('help-cookies').open = true;
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden || !S.authed) return;
      refreshNow();
      loadSettings({ initial: false });
    });

    window.setInterval(tick, 1000);
  }

  async function boot() {
    try {
      const r = await api('/api/session', { allow401: true });
      setNetDown(false);
      if (r.data.authenticated === true) await enterMain();
      else showLogin(null);
    } catch (e) {
      // server not reachable yet: keep trying quietly
      setNetDown(true);
      window.setTimeout(boot, 3000);
    }
  }

  wire();
  boot();
})();
