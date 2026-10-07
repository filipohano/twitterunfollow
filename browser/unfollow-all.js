/*
 * UNFOLLOW ALLE: kjøres i din egen Chrome, på din egen følger-side på x.com.
 *
 * Slik bruker du det:
 *  1. Logg inn på x.com og gå til  https://x.com/DITT_BRUKERNAVN/following
 *     (nettleservinduet må være bredt nok til at menyen til venstre vises; løsne DevTools til eget vindu).
 *  2. Trykk F12 (Mac: Cmd+Option+I) og åpne fanen «Sources» → «Snippets» → «+ New snippet».
 *     Lim inn hele denne filen og trykk Ctrl+Enter (Mac: Cmd+Enter).
 *     Første gang ber Chrome deg skrive «allow pasting» og trykke Enter, både i Snippets og i «Console».
 *     (Snippets finnes ikke i inkognitovinduer.)
 *  3. Et lite panel kommer nederst til høyre. Trykk «Forhåndsvis», sjekk tallene, trykk «Start» to ganger.
 *
 * Gode vaner:
 *  - La fanen ligge i et eget vindu som er synlig (ikke minimert). Chrome bremser skjulte faner kraftig.
 *  - Skriptet husker fremdriften i nettleseren. Stopper du eller X ber deg bremse, kjører du det bare igjen senere.
 *  - Ingenting forlater nettleseren din: ingen cookies, ingen server. Alt skjer i denne fanen.
 *  - Automatisering bryter X sine vilkår, og X kan begrense kontoen din. Bruk bare på din egen konto.
 *    Raskere hastighet gir høyere risiko. Skriptet stopper av seg selv hvis X sier fra.
 */
(() => {
  'use strict';
  const NS = '__unfollowAll';
  try {
    window[NS]?.destroy?.(); // kjører du skriptet på nytt, erstatter det forrige panel
  } catch {
    /* ignorer */
  }

  // ---------------------------------------------------------------- innstillinger
  const USER = window.UNFOLLOW_ALL_CONFIG || {}; // brukes bare av testene
  // Hastighetene er skjønn, ikke noe X har oppgitt: X publiserer ingen grense for unfollow. Kilder anslår 100–150 per dag som
  // «trygt» og 300–400 som høy risiko, så «Rask» ligger på kanten.
  const PACES = {
    forsiktig: { label: 'Forsiktig (ca. 150 per dag)', minMs: 15000, maxMs: 45000, burst: 20, burstMinMs: 180000, burstMaxMs: 360000, perHour: 30, perDay: 150 },
    normal: { label: 'Normal (ca. 200 per dag)', minMs: 8000, maxMs: 20000, burst: 30, burstMinMs: 90000, burstMaxMs: 200000, perHour: 60, perDay: 200 },
    rask: { label: 'Rask (ca. 300 per dag, høy risiko)', minMs: 4000, maxMs: 10000, burst: 50, burstMinMs: 60000, burstMaxMs: 150000, perHour: 100, perDay: 300 },
    ...(USER.paces || {}),
  };
  const DEFAULT_PACE = USER.defaultPace || 'normal';
  const T = {
    scrollPauseMs: [900, 1600], endWaitMs: 2500, endTries: 3, loadMs: 30000, dialogMs: 6000, outcomeMs: 12000, answerMs: 6000, revertCheckMs: 800,
    settleMs: [150, 350], armMs: 6000, armMinMs: 1200, capJitterMs: [2000, 8000], cooldownMs: 3600_000, lockMs: 10000, failPauseMs: [3000, 6000],
    ...(USER.timing || {}),
  };
  const MAX_FAILS_PER_HANDLE = 2;
  const MAX_DISTINCT_FAILS = 2;
  const HOUR = 3600_000;
  const DAY = 24 * HOUR;

  // ---------------------------------------------------------------- små hjelpere
  const rand = (a, b) => a + Math.random() * (b - a);
  const norm = (h) => String(h || '').trim().replace(/^@/, '').toLowerCase();
  const fmtDur = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 90) return `${s} sek`;
    const m = Math.round(s / 60);
    return m < 90 ? `${m} min` : `${(m / 60).toFixed(1).replace('.', ',')} t`;
  };
  const hhmm = (t) => new Date(t).toLocaleTimeString('nb-NO', { hour: '2-digit', minute: '2-digit' });
  const store = {
    get(k, d) {
      try {
        const v = localStorage.getItem(`ua1.${k}`);
        return v == null ? d : JSON.parse(v);
      } catch {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(`ua1.${k}`, JSON.stringify(v));
      } catch {
        /* privat modus, full lagring e.l. */
      }
    },
  };

  let dead = false;
  let stopFlag = false;
  let paused = false;
  let loopRunning = false;
  const waiters = new Set();
  const wake = () => [...waiters].forEach((w) => w());
  // Sover i biter, så Stopp og Pause virker med en gang.
  const sleep = (ms) =>
    new Promise((resolve) => {
      if (stopFlag || dead || ms <= 0) return resolve();
      const done = () => {
        clearTimeout(t);
        waiters.delete(done);
        resolve();
      };
      const t = setTimeout(done, ms);
      waiters.add(done);
    });
  // ignoreStop: en handling som allerede er i gang (X har fått klikket) skal alltid få bli ferdig og registrert.
  async function waitFor(fn, timeoutMs, { stepMs = 100, ignoreStop = false } = {}) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() > end || dead || (stopFlag && !ignoreStop)) return null;
      await new Promise((r) => setTimeout(r, stepMs));
    }
  }
  // Helt vanlig click(): alle skript som fungerer på x.com gjør bare dette. Ekstra syntetiske pekerhendelser gir bare
  // X sin anti-automatiseringskode (Castle leser isTrusted/pointerType) flere unormale signaler å reagere på.
  const click = (el) => el.click();
  const visible = (el) => !!el && el.getClientRects().length > 0;

  // ---------------------------------------------------------------- nettverksvakt (delt mellom kjøringer)
  // Leser bare svarene på X sine egne kall, så vi vet om unfollow gikk igjennom, for hvilken konto, og om X ber oss bremse.
  const net = (window.__uaNet = window.__uaNet || {});
  net.installed = net.installed || false;
  net.limitedAt = net.limitedAt || 0; // siste 429 (hvilket som helst /i/api-kall)
  net.resetAt = net.resetAt || 0; // x-rate-limit-reset (ms) fra siste 429, hvis X sendte den
  net.apiSeen = net.apiSeen || 0; // antall /i/api-svar vi har sett: 0 = vi er blinde
  net.started = net.started || 0; // friendships/destroy-forespørsler vi har sett gå ut
  net.recs = Array.isArray(net.recs) ? net.recs : []; // svar på friendships/destroy: { status, code, userId, at }
  function bodyUserId(body, url) {
    try {
      if (typeof body === 'string' && body) {
        const v = new URLSearchParams(body).get('user_id');
        if (v) return String(v);
        try {
          const j = JSON.parse(body);
          if (j && j.user_id) return String(j.user_id);
        } catch {
          /* ikke json */
        }
      } else if (body && typeof body.get === 'function') {
        const v = body.get('user_id');
        if (v) return String(v);
      }
    } catch {
      /* ignorer */
    }
    try {
      return new URL(url, location.href).searchParams.get('user_id');
    } catch {
      return null;
    }
  }
  function note(url, status, bodyText, reqBody, resetHeader) {
    if (!url.includes('/i/api/')) return;
    net.apiSeen += 1;
    let code = null;
    if (status >= 400 && bodyText) {
      try {
        code = JSON.parse(bodyText)?.errors?.[0]?.code ?? null;
      } catch {
        /* ikke json */
      }
    }
    if (status === 429) {
      net.limitedAt = Date.now();
      const r = Number(resetHeader);
      net.resetAt = Number.isFinite(r) && r > 0 ? r * 1000 : 0;
    }
    if (/friendships\/destroy/.test(url)) {
      net.recs = [...net.recs.slice(-29), { status, code, userId: bodyUserId(reqBody, url), at: Date.now() }];
    }
  }
  function installNetHooks() {
    if (net.installed) return;
    net.installed = true;
    try {
      const origFetch = window.fetch;
      window.fetch = function (...args) {
        let url = '';
        let bodyP = null;
        let bodyRaw = null;
        try {
          const a0 = args[0];
          url = String((a0 && a0.url) || a0 || '');
          if (/friendships\/destroy/.test(url)) {
            net.started += 1;
            if (a0 && typeof a0 === 'object' && typeof a0.clone === 'function') bodyP = a0.clone().text().catch(() => null);
            else bodyRaw = args[1] && args[1].body != null ? args[1].body : null;
          }
        } catch {
          /* ignorer */
        }
        const p = origFetch.apply(this, args);
        try {
          p.then(async (res) => {
            let text = '';
            if (res.status >= 400) {
              try {
                text = await res.clone().text();
              } catch {
                /* ignorer */
              }
            }
            note(url, res.status, text, bodyP ? await bodyP : bodyRaw, res.headers && res.headers.get && res.headers.get('x-rate-limit-reset'));
          }, () => {});
        } catch {
          /* ignorer */
        }
        return p;
      };
    } catch {
      /* fetch kan ikke overstyres: vi bruker DOM i stedet */
    }
    try {
      const open = XMLHttpRequest.prototype.open;
      const send = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (m, u) {
        this.__ua = String(u);
        return open.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function (body) {
        if (this.__ua) {
          if (/friendships\/destroy/.test(this.__ua)) net.started += 1;
          this.addEventListener('loadend', () => {
            try {
              note(this.__ua, this.status, this.responseType === '' || this.responseType === 'text' ? this.responseText : '', body, this.getResponseHeader('x-rate-limit-reset'));
            } catch {
              /* ignorer */
            }
          });
        }
        return send.apply(this, arguments);
      };
    } catch {
      /* ignorer */
    }
  }

  // ---------------------------------------------------------------- X sin side
  const CELL = '[data-testid="UserCell"]';
  // Hvem raden tilhører = FØRSTE profil-lenke (avataren). Andre lenker i raden (omtaler i bio) peker på andre kontoer.
  const ownHandle = (cell) => {
    for (const a of cell.querySelectorAll('a[href^="/"]')) {
      const m = (a.getAttribute('href') || '').match(/^\/([A-Za-z0-9_]{1,15})$/);
      if (m) return m[1];
    }
    return null;
  };
  // Prefikset i -unfollow-testid er tallet brukeren har i dag (kan være noe annet i morgen): ikke avhengig av det.
  const scan = () =>
    [...document.querySelectorAll(CELL)].map((cell) => {
      const btn = cell.querySelector('[data-testid$="-unfollow"]');
      const id = btn ? btn.getAttribute('data-testid').replace(/-unfollow$/, '') : null;
      // X har lagt «<id>-unfollow» på en «Subscribe to @handle»-knapp: aldri trykk på den.
      const subscribe = !!btn && /^\s*(subscribe|abonn)/i.test(btn.getAttribute('aria-label') || '');
      return { cell, handle: ownHandle(cell), userId: id && /^[A-Za-z0-9_]+$/.test(id) ? id : null, canUnfollow: !!btn && !subscribe };
    });
  const meHandle = () => {
    const a = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    const m = a && (a.getAttribute('href') || '').match(/^\/([A-Za-z0-9_]{1,15})$/);
    return m ? m[1] : null;
  };
  const pageHandle = () => {
    const m = location.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/following\/?$/i);
    return m ? m[1] : null;
  };
  // Viktig sikring: på en ANNEN persons following-side viser «Following»-knappene DINE følginger. Vi kjører bare på din egen.
  const onMyPage = () => {
    const p = pageHandle();
    const me = meHandle();
    return !!p && !!me && norm(p) === norm(me);
  };
  // Menyen til venstre (vår eneste kilde til «hvem er jeg») skjules i smale vinduer, f.eks. med DevTools ved siden av.
  const notMyPage = () =>
    !pageHandle()
      ? 'Åpne din egen følger-side (x.com/DITT_BRUKERNAVN/following) og kjør skriptet der.'
      : !meHandle()
        ? 'Finner ikke hvem du er (menyen til venstre skjules i smale vinduer, f.eks. når DevTools sitter ved siden av). Gjør siden bredere eller løsne DevTools til eget vindu, og prøv igjen.'
        : 'Dette er ikke din egen følger-side. Åpne x.com/DITT_BRUKERNAVN/following.';
  // Bekreftelsen: klassisk dialog (data-testid) eller, siden høsten 2026, en role=menu med ÉN menyvalg «Unfollow @handle» uten testid.
  // Språkuavhengig: menyvalget må være det eneste og må nevne handlen til raden vi trykket på. Må være synlig.
  const findConfirm = (handle) => {
    const sheet = document.querySelector('[data-testid="confirmationSheetConfirm"]');
    if (sheet && visible(sheet)) return sheet;
    const re = new RegExp(`@${handle}(?![A-Za-z0-9_])`, 'i');
    for (const menu of document.querySelectorAll('[role="menu"]')) {
      const items = menu.querySelectorAll('[role="menuitem"]');
      if (items.length === 1 && visible(items[0]) && re.test(items[0].textContent || '')) return items[0];
    }
    return null;
  };
  const dialogText = (el) => (el.closest('[role="dialog"],[role="alertdialog"],[role="menu"],[data-testid="sheetDialog"],[data-testid="confirmationSheetDialog"]') || el.parentElement)?.innerText || '';
  const cancelDialog = () => {
    const cancel = document.querySelector('[data-testid="confirmationSheetCancel"]');
    if (cancel && visible(cancel)) click(cancel);
    else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  };
  // @-omtaler skjæres bort: «You unfollowed @UnlimitedCoffee» skal ikke utløse /limit/.
  const toastText = () => (document.querySelector('[data-testid="toast"]')?.innerText || '').replace(/@\w+/g, '').trim();
  const LIMIT_TEXT = /unable to (follow|unfollow)|limit|too many|try again later|automated|something went wrong|kan ikke|for mange|automatis|grense|begrens|midlertidig|noe gikk galt/i;
  // X viser en snurre nederst i listen mens den laster mer. Mens den vises er vi IKKE ved slutten.
  const listLoading = () => !!document.querySelector('[data-testid="primaryColumn"] [role="progressbar"]');

  async function scrollNext() {
    const before = { y: Math.round(scrollY), h: document.documentElement.scrollHeight };
    window.scrollBy({ top: Math.round(innerHeight * 0.8), behavior: 'auto' });
    await sleep(rand(...T.scrollPauseMs));
    return Math.round(scrollY) !== before.y || document.documentElement.scrollHeight !== before.h;
  }
  // Én runde med «er vi ved slutten?». Returnerer 'more' | 'wait' | 'end' | 'stalled'.
  function endCheck(st) {
    return async () => {
      if (await scrollNext()) {
        st.idle = 0;
        st.loadingSince = 0;
        return 'more';
      }
      if (listLoading()) {
        st.loadingSince = st.loadingSince || Date.now();
        if (Date.now() - st.loadingSince > T.loadMs) return 'stalled';
        await sleep(500);
        return 'wait';
      }
      st.loadingSince = 0;
      st.idle += 1;
      if (st.idle >= T.endTries) return 'end';
      await sleep(T.endWaitMs);
      return 'wait';
    };
  }

  // ---------------------------------------------------------------- tilstand
  const S = {
    phase: 'idle', // idle | previewing | ready | running | paused | resting | done | stopped | error
    msg: 'Klar. Trykk «Forhåndsvis» først.',
    runDone: 0,
    lastHandle: null,
    rest: null, // { until, reason }
    preview: null, // { handles, kept, missing, keepKey }
    armedAt: 0,
    armedUntil: 0,
    resetArmedUntil: 0,
    warn: '',
  };
  const done = new Set(); // handles avfulgt i denne kjøringen (små bokstaver)
  const skipped = new Set();
  let keepList = String(store.get('keep', '') || '');
  let paceKey = PACES[store.get('pace', DEFAULT_PACE)] ? store.get('pace', DEFAULT_PACE) : DEFAULT_PACE;
  const pace = () => PACES[paceKey] || PACES[DEFAULT_PACE];
  // Tolerant: alt som ser ut som en handle teller (mellomrom, komma, semikolon, URL-er, «@navn (venn)», usynlige tegn).
  // Heller for mange enn for få kontoer i listen: en ekstra konto i behold-listen er ufarlig, en som mangler er det ikke.
  const parseKeep = (text) =>
    [...new Set((String(text).replace(/[​-‍⁠﻿]/g, '').replace(/https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\//gi, '@').match(/@?[A-Za-z0-9_]{1,15}/g) || []).map(norm))];
  const keepSet = () => new Set(parseKeep(keepList));
  const keepKey = () => [...keepSet()].sort().join(',');
  let doneLog = (() => {
    const v = store.get('done', []);
    return Array.isArray(v) ? v.filter((r) => Array.isArray(r) && typeof r[0] === 'string') : [];
  })();

  // ---------------------------------------------------------------- tak (rullerende time/døgn, husket mellom kjøringer)
  // Teller i minnet OG i nettleserens lagring (størst vinner), så et tak ikke forsvinner hvis lagring feiler eller er ødelagt.
  const readActions = () => {
    const a = store.get('actions', []);
    return Array.isArray(a) ? a.filter(Number.isFinite) : [];
  };
  let actionsMem = readActions();
  const loadActions = () => {
    const now = Date.now();
    // Tidsstempler langt frem i tid (klokken har stått feil) kastes; små avvik regnes som «nå».
    actionsMem = [...new Set([...readActions(), ...actionsMem])].filter((t) => t > now - DAY && t <= now + 5 * 60_000);
    return actionsMem;
  };
  function capWait() {
    const p = pace();
    const now = Date.now();
    const acts = loadActions().map((t) => Math.min(t, now));
    let wait = 0;
    let reason = '';
    for (const [win, cap, label] of [[HOUR, p.perHour, 'Timegrensen'], [DAY, p.perDay, 'Døgngrensen']]) {
      const inWin = acts.filter((t) => t > now - win).sort((a, b) => a - b);
      if (inWin.length >= cap) {
        const w = inWin[inWin.length - cap] + win - now;
        if (w > wait) {
          wait = w;
          reason = `${label} er nådd`;
        }
      }
    }
    return { wait: Math.ceil(wait), reason };
  }
  const usage = () => {
    const now = Date.now();
    const a = loadActions();
    return { hour: a.filter((t) => t > now - HOUR).length, day: a.length };
  };
  function recordAction(handle) {
    actionsMem.push(Date.now());
    store.set('actions', loadActions());
    doneLog = [...doneLog, [handle, new Date().toISOString()]].slice(-20000);
    store.set('done', doneLog);
  }

  // ---------------------------------------------------------------- avkjøling etter «bremse»-stopp, og lås mot flere faner
  const cooldownUntil = () => {
    const v = Number(store.get('limitedUntil', 0));
    return Number.isFinite(v) ? v : 0;
  };
  const inCooldown = () => Date.now() < cooldownUntil();
  function setCooldown() {
    const now = Date.now();
    const until = Math.min(now + DAY, Math.max(now + T.cooldownMs, net.resetAt ? net.resetAt + 60_000 : 0));
    store.set('limitedUntil', until);
    return until;
  }
  const cooldownMsg = () => `X bremset oss tidligere. Vent til ca. kl. ${hhmm(cooldownUntil())} før du prøver igjen.`;
  const TAB = Math.random().toString(36).slice(2);
  const lockedByOther = () => {
    const l = store.get('lock', null);
    return !!l && l.id !== TAB && Date.now() - Number(l.at) < T.lockMs;
  };
  const touchLock = () => store.set('lock', { id: TAB, at: Date.now() });
  const dropLock = () => {
    const l = store.get('lock', null);
    if (l && l.id === TAB) store.set('lock', null);
  };
  let wakeSentinel = null;
  const takeWake = async () => {
    try {
      wakeSentinel = (await navigator.wakeLock?.request?.('screen')) || null;
    } catch {
      /* ikke kritisk */
    }
  };
  const dropWake = () => {
    try {
      wakeSentinel?.release?.();
    } catch {
      /* ignorer */
    }
    wakeSentinel = null;
  };

  // ---------------------------------------------------------------- selve avfølgingen
  // Returnerer { ok } eller { ok:false, kind: 'limit'|'account'|'wrong'|'fail'|'aborted', detail }
  async function unfollowOne(t) {
    const { cell, handle, userId } = t;
    try {
      // En dialog som allerede er åpen (X sin eller en annen) skal vi aldri trykke på.
      const stale = document.querySelector('[data-testid="confirmationSheetConfirm"]');
      if (stale && visible(stale)) {
        cancelDialog();
        await new Promise((r) => setTimeout(r, 200));
        if (visible(document.querySelector('[data-testid="confirmationSheetConfirm"]'))) return { ok: false, kind: 'fail', detail: 'en annen dialog er åpen på siden' };
      }
      cell.scrollIntoView({ block: 'center', behavior: 'auto' });
      await sleep(rand(...T.settleMs));
      if (stopFlag || dead) return { ok: false, kind: 'aborted', detail: 'stoppet' };
      const btn = cell.querySelector(`[data-testid="${userId}-unfollow"]`);
      if (!btn || !cell.isConnected) return { ok: false, kind: 'fail', detail: 'raden endret seg' };
      if (norm(ownHandle(cell)) !== norm(handle)) return { ok: false, kind: 'fail', detail: 'raden tilhører en annen konto' };
      if (keepSet().has(norm(handle))) return { ok: false, kind: 'fail', detail: 'kontoen er på behold-listen' }; // siste sjekk rett før klikket
      const numeric = /^\d+$/.test(userId);
      const t0 = Date.now();
      const base = net.started;
      const toastBefore = toastText();
      click(btn);
      const confirm = await waitFor(() => findConfirm(handle), T.dialogMs, { ignoreStop: true });
      if (!confirm) return { ok: false, kind: 'fail', detail: 'fikk ingen bekreftelse for denne kontoen' };
      // Bekreftelsen MÅ nevne kontoen vi trykket på (X skriver «Unfollow @navn?»). Ellers avbryter vi: vi gjetter aldri.
      const text = dialogText(confirm);
      if (!new RegExp(`@${handle}(?![A-Za-z0-9_])`, 'i').test(text)) {
        cancelDialog();
        return { ok: false, kind: 'fail', detail: `bekreftelsen nevner ikke @${handle}, så jeg avbrøt` };
      }
      if (stopFlag || dead) {
        cancelDialog(); // Stopp ble trykket mens dialogen åpnet seg: ikke fullfør
        return { ok: false, kind: 'aborted', detail: 'stoppet' };
      }
      click(confirm);
      // Svar fra X på AKKURAT denne forespørselen: samme user_id, sendt etter klikket.
      const mine = () => {
        const recs = net.recs.filter((r) => r.at >= t0 - 100);
        const other = numeric ? recs.find((r) => r.userId && r.userId !== userId) : null;
        if (other) return { wrong: other };
        return recs.find((r) => (numeric ? r.userId === userId || !r.userId : true)) || null;
      };
      const outcome = await waitFor(() => {
        const r = mine();
        if (r) return { net: r };
        const b = cell.isConnected ? cell.querySelector(`[data-testid="${userId}-unfollow"]`) : null;
        if (!b) return { dom: true };
        const tt = toastText();
        if (tt && tt !== toastBefore && LIMIT_TEXT.test(tt)) return { toast: tt };
        return null;
      }, T.outcomeMs, { ignoreStop: true });
      if (!outcome) return { ok: false, kind: 'fail', detail: 'knappen endret seg ikke etter bekreftelse' };
      if (outcome.toast) return { ok: false, kind: 'limit', detail: outcome.toast };
      let verdict = outcome.net;
      if (!verdict && net.started > base) {
        // X flippet knappen med en gang og svaret fra friendships/destroy er på vei: vent på det, og døm etter det.
        await waitFor(() => mine(), T.answerMs, { ignoreStop: true });
        verdict = mine();
        if (!verdict) return { ok: false, kind: 'fail', detail: 'X svarte ikke på unfollow-forespørselen' };
      }
      if (verdict && verdict.wrong) return { ok: false, kind: 'wrong', detail: `X fikk en unfollow for en annen konto (${verdict.wrong.userId}), ikke @${handle}` };
      if (verdict) {
        const { status, code } = verdict;
        if (status >= 200 && status < 300) return { ok: true };
        if (status === 429 || code === 88) return { ok: false, kind: 'limit', detail: 'HTTP 429 (for mange forespørsler)' };
        if ([161, 185, 226].includes(code)) return { ok: false, kind: 'limit', detail: `X sier at grensen er nådd (feil ${code})` };
        if ([64, 141, 231, 261, 326].includes(code)) return { ok: false, kind: 'account', detail: `kontoen trenger oppmerksomhet (feil ${code})` };
        return { ok: false, kind: 'fail', detail: `HTTP ${status}${code ? ` / feil ${code}` : ''}` };
      }
      // Ingen nettverkssvar sett (vi er blinde): sjekk at knappen blir stående flippet og at X ikke viser noen feilmelding.
      await sleep(T.revertCheckMs);
      if (cell.isConnected && cell.querySelector(`[data-testid="${userId}-unfollow"]`)) return { ok: false, kind: 'fail', detail: 'knappen gikk tilbake (X avviste handlingen)' };
      const tt2 = toastText();
      if (tt2 && tt2 !== toastBefore && LIMIT_TEXT.test(tt2)) return { ok: false, kind: 'limit', detail: tt2 };
      return { ok: true }; // knappen forsvant/byttet til «Follow»
    } catch (e) {
      return { ok: false, kind: 'fail', detail: String(e && e.message ? e.message : e).slice(0, 120) };
    }
  }

  async function gate() {
    while (paused && !stopFlag && !dead) {
      setPhase('paused', 'Pauset.');
      await sleep(300);
    }
  }
  const snap = () => ({
    phase: S.phase,
    msg: S.msg,
    runDone: S.runDone,
    rest: S.rest,
    preview: S.preview && { count: S.preview.handles.length, kept: S.preview.kept.length, missing: S.preview.missing },
    usage: usage(),
    lastHandle: S.lastHandle,
    skipped: [...skipped],
    cooldownUntil: inCooldown() ? cooldownUntil() : 0,
  });
  function setPhase(phase, msg) {
    S.phase = phase;
    if (msg !== undefined) S.msg = msg;
    render();
    return snap();
  }
  const fail = (msg) => setPhase('error', msg);
  async function rest(ms, reason) {
    const until = Date.now() + ms;
    S.rest = { until, reason };
    setPhase('resting', `Hviler: ${reason}.`);
    while (Date.now() < until && !stopFlag && !dead) {
      await sleep(Math.min(1000, until - Date.now()));
      await gate();
      if (S.phase !== 'resting' && !stopFlag && !dead) setPhase('resting', `Hviler: ${reason}.`);
      render();
    }
    S.rest = null;
    if (!stopFlag && !dead) setPhase('running', 'Fortsetter …');
  }
  // Felles forhåndssjekk før forhåndsvisning og start.
  function refusal() {
    if (inCooldown()) return cooldownMsg();
    if (lockedByOther()) return 'Skriptet kjører allerede i en annen fane. Bruk bare én om gangen, ellers går det dobbelt så fort som det skal.';
    if (!onMyPage()) return notMyPage();
    return '';
  }

  // ---------------------------------------------------------------- forhåndsvisning
  async function preview() {
    if (S.phase === 'running' || S.phase === 'previewing' || S.phase === 'resting' || S.phase === 'paused') return snap();
    const why = refusal();
    if (why) return fail(why);
    installNetHooks();
    stopFlag = false;
    paused = false;
    touchLock();
    setPhase('previewing', 'Skanner listen …');
    try {
      window.scrollTo(0, 0);
      await sleep(500);
      const keep = keepSet();
      const would = new Set();
      const kept = new Set();
      const seenAll = new Set();
      const st = { idle: 0, loadingSince: 0 };
      const step = endCheck(st);
      for (;;) {
        if (stopFlag || dead) break;
        if (!onMyPage()) return fail(notMyPage());
        for (const c of scan()) {
          if (!c.handle) continue;
          seenAll.add(norm(c.handle));
          if (!c.canUnfollow) continue;
          if (keep.has(norm(c.handle))) kept.add(c.handle);
          else would.add(c.handle);
        }
        S.msg = `Skanner listen … fant ${would.size} så langt`;
        render();
        touchLock();
        if (Date.now() - net.limitedAt < 60_000) {
          setCooldown();
          return fail('X ber oss bremse allerede under skanningen. Vent en stund og prøv igjen.');
        }
        const r = await step();
        if (r === 'end') break;
        if (r === 'stalled') return fail('X laster ikke listen (snurren står stille). Last siden på nytt og prøv igjen om litt.');
      }
      window.scrollTo(0, 0);
      if (stopFlag || dead) return setPhase('stopped', 'Forhåndsvisning avbrutt.');
      if (would.size === 0 && kept.size === 0) return fail('Fant ingen kontoer på listen. Last siden på nytt og prøv igjen (eller er du allerede ferdig?).');
      const missing = [...keep].filter((k) => !seenAll.has(k));
      S.preview = { handles: [...would], kept: [...kept], missing, keepKey: keepKey() };
      const note2 = missing.length ? ` Ikke funnet på listen din: ${missing.slice(0, 8).map((m) => `@${m}`).join(', ')}${missing.length > 8 ? ' …' : ''} (skrivefeil?).` : '';
      return setPhase('ready', `Forhåndsvisning: ${would.size} kontoer vil bli avfulgt, ${kept.size} beholdes.${note2} Trykk «Start».`);
    } finally {
      if (S.phase !== 'running') dropLock();
    }
  }

  // ---------------------------------------------------------------- kjøring
  async function start() {
    if (loopRunning || S.phase === 'paused') return S.runPromise || snap();
    if (!S.preview || S.preview.keepKey !== keepKey()) return fail('Kjør «Forhåndsvis» først (og på nytt hvis du endret behold-listen).');
    const keepTokens = parseKeep(keepList);
    if (keepTokens.length && S.preview.kept.length === 0) return fail('Ingen av kontoene i behold-listen ble funnet på listen din. Sjekk stavemåten, eller tøm behold-listen hvis det er meningen.');
    const why = refusal();
    if (why) return fail(why);
    installNetHooks();
    loopRunning = true;
    stopFlag = false;
    paused = false;
    S.runDone = 0;
    skipped.clear();
    done.clear();
    touchLock();
    S.runPromise = loop()
      .catch((e) => fail(`Uventet feil: ${e && e.message ? e.message : e}`))
      .finally(() => {
        loopRunning = false;
        dropWake();
        dropLock();
      });
    return S.runPromise;
  }

  async function loop() {
    const p = pace();
    const fails = new Map();
    const failedInARow = new Set();
    const expected = new Set(); // numeriske bruker-IDer vi har bedt X om å avfølge
    const st = { idle: 0, loadingSince: 0 };
    const step = endCheck(st);
    const startedAt = Date.now();
    let burst = 0;
    net.limitedAt = 0;
    await takeWake();
    setPhase('running', 'Starter …');
    while (!stopFlag && !dead) {
      await gate();
      if (stopFlag || dead) break;
      touchLock();
      if (!onMyPage()) {
        paused = true;
        S.warn = 'Du forlot følger-siden, så jeg har pauset. Gå tilbake og trykk «Fortsett».';
        continue;
      }
      S.warn = document.hidden
        ? 'Fanen er skjult. Chrome bremser skjulte faner, så legg den i et eget, synlig vindu.'
        : net.apiSeen === 0 && S.runDone + skipped.size + fails.size > 0
          ? 'Jeg kan ikke se X sine svar, bare siden. Jeg stopper ved første feil.'
          : '';
      if (net.limitedAt > 0) {
        setCooldown();
        return fail('X ba oss bremse (for mange forespørsler). Jeg har stoppet og lar deg ikke starte igjen før om en stund. Fremdriften er lagret.');
      }
      // Hver unfollow X faktisk mottok skal være en vi ba om. Alt annet (feil rad, en annen fane, deg selv) stopper kjøringen.
      const stray = net.recs.find((r) => r.at >= startedAt && /^\d+$/.test(r.userId || '') && expected.size > 0 && !expected.has(r.userId));
      if (stray) return fail(`Stoppet: X mottok en unfollow jeg ikke ba om (konto-ID ${stray.userId}). Trykket du selv, eller kjører skriptet i en annen fane?`);

      const keep = keepSet(); // leses på nytt hver runde, slik at endringer i behold-listen alltid gjelder
      const target = scan().find((c) => c.handle && c.canUnfollow && c.userId && !keep.has(norm(c.handle)) && !done.has(norm(c.handle)) && !skipped.has(norm(c.handle)));
      if (!target) {
        const r = await step();
        if (r === 'stalled') return fail('X laster ikke listen (snurren står stille). Jeg har stoppet. Last siden på nytt og kjør igjen om litt.');
        if (r !== 'end') continue;
        window.scrollTo(0, 0);
        if (S.runDone === 0 && S.preview && S.preview.handles.length > 0) return fail(`Forhåndsvisningen fant ${S.preview.handles.length} kontoer, men jeg fant ingen knapp jeg kunne trykke på. X kan ha endret siden.`);
        const sk = [...skipped];
        return setPhase('done', `Ferdig: ${S.runDone} kontoer avfulgt nå.${sk.length ? ` ${sk.length} kunne ikke avfølges og følges fortsatt: ${sk.slice(0, 8).map((h) => `@${h}`).join(', ')}.` : ''} Last siden på nytt og trykk «Forhåndsvis» for å bekrefte at ingen gjenstår.`);
      }
      st.idle = 0;

      // Tak sjekkes først rett før en konto faktisk skal avfølges.
      const cw = capWait();
      if (cw.wait > 0) {
        await rest(cw.wait + rand(...T.capJitterMs), cw.reason);
        continue;
      }

      S.lastHandle = target.handle;
      S.msg = `Avfølger @${target.handle}`;
      render();
      if (/^\d+$/.test(target.userId)) expected.add(target.userId);
      const res = await unfollowOne(target);
      if (res.kind === 'aborted') break;
      if (res.ok) {
        done.add(norm(target.handle));
        S.runDone += 1;
        burst += 1;
        failedInARow.clear();
        fails.delete(norm(target.handle));
        recordAction(target.handle);
        render();
        if (stopFlag || dead) break;
        await sleep(rand(p.minMs, p.maxMs));
        if (burst >= p.burst && !stopFlag && !dead) {
          burst = 0;
          await rest(rand(p.burstMinMs, p.burstMaxMs), 'Kort pause for å holde et naturlig tempo');
        }
        continue;
      }
      if (res.kind === 'limit') {
        setCooldown();
        return fail(`X sier fra: ${res.detail}. Jeg har stoppet og lar deg ikke starte igjen før om en stund. Fremdriften er lagret.`);
      }
      if (res.kind === 'account') return fail(`Stoppet: ${res.detail}. Åpne x.com normalt og se om X ber om noe (bekreftelse e.l.).`);
      if (res.kind === 'wrong') return fail(`Stoppet: ${res.detail}. Sjekk behold-listen din og kjør «Forhåndsvis» på nytt.`);
      const key = norm(target.handle);
      const n = (fails.get(key) || 0) + 1;
      fails.set(key, n);
      failedInARow.add(key);
      S.msg = `Kunne ikke avfølge @${target.handle} (${res.detail}), forsøk ${n}/${MAX_FAILS_PER_HANDLE}`;
      // Blind (ser ikke X sine svar) og ingenting skjedde etter bekreftelsen: da bremser X oss kanskje. Ikke fortsett å prøve.
      if (net.apiSeen === 0 && /endret seg ikke|svarte ikke|gikk tilbake/.test(res.detail)) {
        return fail(`Ingenting skjedde etter bekreftelsen (${res.detail}), og jeg ser ikke X sine svar. Enten bremser X oss, eller siden er endret. Jeg har stoppet: vent en stund før du prøver igjen.`);
      }
      if (n >= MAX_FAILS_PER_HANDLE) skipped.add(key);
      if (failedInARow.size >= MAX_DISTINCT_FAILS) return fail(`Det feiler for flere kontoer på rad (sist: ${res.detail}). X kan ha endret siden, eller bremser oss. Jeg har stoppet.`);
      render();
      await sleep(rand(...T.failPauseMs));
    }
    if (stopFlag && S.phase !== 'error') return setPhase('stopped', `Stoppet. ${S.runDone} kontoer avfulgt nå.`);
    return snap();
  }

  function stop() {
    stopFlag = true;
    paused = false;
    wake();
  }
  function pause() {
    if (S.phase === 'running' || S.phase === 'resting') paused = true;
    render();
  }
  function resume() {
    paused = false;
    S.warn = '';
    if (S.phase === 'paused') setPhase('running', 'Fortsetter …');
    wake();
  }

  // ---------------------------------------------------------------- nedlasting
  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    document.documentElement.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
  }
  const csv = () => `handle,avfulgt\n${doneLog.map(([h, t]) => `${h},${t}`).join('\n')}\n`;

  // ---------------------------------------------------------------- panel (bare stil via JS, fungerer under X sin CSP)
  const host = document.createElement('div');
  host.setAttribute('data-ua', 'host');
  Object.assign(host.style, { position: 'fixed', right: '12px', bottom: '12px', zIndex: '2147483647', width: '330px', font: '13px/1.4 system-ui, sans-serif', color: '#e7e9ea' });
  const root = host.attachShadow({ mode: 'open' });
  const css = (el, o) => Object.assign(el.style, o);
  const mk = (tag, o = {}, text) => {
    const e = document.createElement(tag);
    css(e, o);
    if (text != null) e.textContent = text;
    return e;
  };
  const card = mk('div', { background: '#16181c', border: '1px solid #3b3f45', borderRadius: '12px', padding: '12px', boxShadow: '0 8px 30px rgba(0,0,0,.5)' });
  const head = mk('div', { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' });
  head.append(mk('strong', { fontSize: '14px' }, 'Unfollow alle'));
  const closeBtn = mk('button', { background: 'none', border: 'none', color: '#8b98a5', cursor: 'pointer', fontSize: '16px' }, '×');
  closeBtn.title = 'Lukk (stopper skriptet)';
  head.append(closeBtn);
  const status = mk('div', { minHeight: '38px', marginBottom: '6px' });
  const warn = mk('div', { color: '#ffd400', fontSize: '12px', marginBottom: '6px' });
  const stats = mk('div', { color: '#8b98a5', fontSize: '12px', marginBottom: '8px' });
  const bar = mk('div', { height: '6px', background: '#2f3336', borderRadius: '3px', overflow: 'hidden', marginBottom: '8px' });
  const barFill = mk('div', { height: '100%', width: '0%', background: '#1d9bf0' });
  bar.append(barFill);
  const paceSel = mk('select', { width: '100%', marginBottom: '4px', padding: '4px', background: '#0f1419', color: '#e7e9ea', border: '1px solid #3b3f45', borderRadius: '6px' });
  for (const [k, v] of Object.entries(PACES)) {
    const o = document.createElement('option');
    o.value = k;
    o.textContent = v.label;
    paceSel.append(o);
  }
  const paceWarn = mk('div', { color: '#f4212e', fontSize: '11px', marginBottom: '6px' });
  const keepArea = mk('textarea', { width: '100%', height: '48px', boxSizing: 'border-box', marginBottom: '2px', background: '#0f1419', color: '#e7e9ea', border: '1px solid #3b3f45', borderRadius: '6px', padding: '4px', font: '12px monospace' });
  keepArea.placeholder = 'Behold disse (én per linje, med eller uten @)';
  const keepInfo = mk('div', { color: '#8b98a5', fontSize: '11px', marginBottom: '8px', wordBreak: 'break-word' });
  const row = mk('div', { display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '8px' });
  const btn = (label, key) => {
    const b = mk('button', { padding: '6px 10px', borderRadius: '999px', border: '1px solid #536471', background: '#0f1419', color: '#e7e9ea', cursor: 'pointer', fontWeight: '600' }, label);
    b.setAttribute('data-ua', key);
    return b;
  };
  const bPreview = btn('Forhåndsvis', 'preview');
  const bStart = btn('Start', 'start');
  const bPause = btn('Pause', 'pause');
  const bStop = btn('Stopp', 'stop');
  css(bStart, { background: '#1d9bf0', borderColor: '#1d9bf0', color: '#fff' });
  row.append(bPreview, bStart, bPause, bStop);
  const dl = mk('div', { display: 'flex', gap: '4px 12px', flexWrap: 'wrap', fontSize: '12px' });
  const link = (text, color = '#1d9bf0') => mk('a', { color, cursor: 'pointer', whiteSpace: 'nowrap' }, text);
  const aCsv = link('Last ned CSV');
  const aPrev = link('Last ned forhåndsvisning');
  const aReset = link('Nullstill tellere', '#8b98a5');
  css(aReset, { marginLeft: 'auto' });
  dl.append(aCsv, aPrev, aReset);
  const foot = mk('div', { color: '#8b98a5', fontSize: '11px', marginTop: '8px' }, 'Bruk bare på din egen konto. Automatisering bryter X sine vilkår, og X kan begrense kontoen din. Alt skjer i denne fanen.');
  card.append(head, status, warn, stats, bar, paceSel, paceWarn, keepArea, keepInfo, row, dl, foot);
  root.append(card);
  // Tastetrykk inne i et shadow-rot ser ut som «tasting på siden» for X sine hurtigtaster (n = nytt innlegg osv.). Hold dem inne.
  for (const type of ['keydown', 'keyup', 'keypress']) root.addEventListener(type, (e) => e.stopPropagation());

  keepArea.value = keepList;
  paceSel.value = paceKey;
  keepArea.addEventListener('input', () => {
    keepList = keepArea.value;
    store.set('keep', keepList);
    render();
  });
  paceSel.addEventListener('change', () => {
    paceKey = paceSel.value;
    store.set('pace', paceKey);
    render();
  });
  bPreview.addEventListener('click', () => preview());
  bStart.addEventListener('click', () => {
    if (loopRunning || S.phase === 'paused') return;
    const now = Date.now();
    if (now > S.armedUntil) {
      // To trykk: første trykk «armerer», andre (tidligst etter litt) starter. Hindrer dobbeltklikk.
      S.armedAt = now;
      S.armedUntil = now + T.armMs;
      render();
      setTimeout(render, T.armMs + 50);
      return;
    }
    if (now - S.armedAt < T.armMinMs) return;
    S.armedUntil = 0;
    start();
  });
  bPause.addEventListener('click', () => (paused ? resume() : pause()));
  bStop.addEventListener('click', stop);
  aCsv.addEventListener('click', () => download('avfulgt.csv', csv(), 'text/csv'));
  aPrev.addEventListener('click', () => S.preview && download('forhandsvisning.txt', `${S.preview.handles.join('\n')}\n`, 'text/plain'));
  aReset.addEventListener('click', () => {
    if (isBusy()) return;
    if (Date.now() > S.resetArmedUntil) {
      S.resetArmedUntil = Date.now() + 4000;
      render();
      setTimeout(render, 4050);
      return;
    }
    S.resetArmedUntil = 0;
    actionsMem = [];
    store.set('actions', []);
    store.set('done', []);
    doneLog = [];
    render();
  });
  closeBtn.addEventListener('click', () => destroy());

  const PHASE_COLOR = { error: '#f4212e', done: '#00ba7c', resting: '#ffd400' };
  const isBusy = () => ['previewing', 'running', 'resting', 'paused'].includes(S.phase) || loopRunning;
  function render() {
    if (dead) return;
    const p = pace();
    const u = usage();
    const busy = isBusy();
    const cool = inCooldown();
    status.textContent = S.rest ? `${S.msg} Fortsetter om ${fmtDur(S.rest.until - Date.now())}.` : cool && !busy && S.phase !== 'error' ? cooldownMsg() : S.msg;
    css(status, { color: PHASE_COLOR[S.phase] || (cool && !busy ? '#ffd400' : '#e7e9ea') });
    warn.textContent = S.warn;
    stats.textContent = `Avfulgt nå: ${S.runDone} · totalt i denne nettleseren: ${doneLog.length} · siste time ${u.hour}/${p.perHour} · siste døgn ${u.day}/${p.perDay}`;
    const total = S.preview ? S.preview.handles.length : 0;
    css(barFill, { width: total ? `${Math.min(100, Math.round((S.runDone / total) * 100))}%` : '0%' });
    paceWarn.textContent = paceKey === 'rask' ? 'Rask gir størst risiko for at X begrenser kontoen din. Kilder anslår 100–150 per dag som trygt.' : '';
    const kt = parseKeep(keepList);
    keepInfo.textContent = kt.length ? `Gjenkjent ${kt.length}: ${kt.slice(0, 10).map((k) => `@${k}`).join(' ')}${kt.length > 10 ? ' …' : ''}` : '';
    const armed = Date.now() < S.armedUntil;
    const canStart = !!S.preview && S.preview.keepKey === keepKey() && !busy && !cool;
    bStart.textContent = armed ? `Bekreft: avfølg ${S.preview ? S.preview.handles.length : 0}, behold ${S.preview ? S.preview.kept.length : 0}?` : 'Start';
    bStart.disabled = !canStart;
    bPreview.disabled = busy || cool;
    bPause.textContent = paused ? 'Fortsett' : 'Pause';
    bPause.disabled = !(S.phase === 'running' || S.phase === 'resting' || S.phase === 'paused');
    bStop.disabled = !busy;
    for (const b of [bStart, bPreview, bPause, bStop]) b.style.opacity = b.disabled ? '0.45' : '1';
    keepArea.disabled = busy; // også under pause: endringer midt i en kjøring skal aldri være mulige å gjøre «halvveis»
    paceSel.disabled = busy;
    aReset.textContent = Date.now() < S.resetArmedUntil ? 'Sikker? Trykk igjen' : 'Nullstill tellere';
    aReset.style.opacity = busy ? '0.4' : '1';
  }
  const ticker = setInterval(() => {
    if (isBusy()) touchLock();
    render();
  }, 1000);

  function destroy() {
    dead = true;
    stopFlag = true;
    wake();
    clearInterval(ticker);
    dropWake();
    dropLock();
    host.remove();
    if (window[NS] && window[NS].destroy === destroy) delete window[NS];
  }

  document.documentElement.appendChild(host);
  window[NS] = {
    version: 2,
    state: snap,
    preview,
    start,
    stop,
    pause,
    resume,
    destroy,
    csv,
    clearCooldown: () => {
      store.set('limitedUntil', 0);
      net.limitedAt = 0;
      net.resetAt = 0;
      render();
    },
  };
  if (!onMyPage()) S.msg = notMyPage();
  try {
    render();
  } catch (e) {
    S.msg = `Uventet feil i panelet: ${e && e.message ? e.message : e}`;
  }
})();
