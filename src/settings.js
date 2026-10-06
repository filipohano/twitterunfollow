// Settings the dashboard edits. Stored in <data>/settings.json (mode 0600: it holds the X cookies).
// The cookies are write-only through the API: they are never sent back to the browser.
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_PACING = { maxPerHour: 30, maxPerDay: 150, delayMinSec: 15, delayMaxSec: 45 };

// Guard rails for the GUI (the CLI is unrestricted): protect a non-expert from burning their account.
const PACING_RULES = {
  maxPerHour: { min: 1, max: 100, integer: true, label: 'Max per hour', hint: 'Please keep it at 100 or lower.' },
  maxPerDay: { min: 1, max: 400, integer: true, label: 'Max per day', hint: 'Please keep it at 400 or lower; going faster risks getting your account limited by X.' },
  delayMinSec: { min: 5, max: 600, integer: false, label: 'Shortest pause', hint: 'Use at least 5 seconds.' },
  delayMaxSec: { min: 5, max: 1800, integer: false, label: 'Longest pause', hint: 'Use between 5 and 1800 seconds.' },
};

export class ValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.field = field;
  }
}

export function emptySettings() {
  return { authToken: '', ct0: '', username: '', keepText: '', pacing: { ...DEFAULT_PACING } };
}

const HANDLE = /^[A-Za-z0-9_]{1,15}$/;

// Accepts one handle per line (or comma separated), with/without @, or a profile URL. Returns unique handles.
export function parseKeepText(text) {
  const seen = new Map();
  for (const raw of String(text ?? '').split(/[\n,]+/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const m = line.match(/^(?:https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/)?@?([A-Za-z0-9_]{1,15})\/?(?:\?.*)?$/i);
    if (!m) {
      throw new ValidationError(`"${line.slice(0, 40)}" doesn't look like an X handle. Use one handle per line, like @alice.`, 'keep');
    }
    if (!seen.has(m[1].toLowerCase())) seen.set(m[1].toLowerCase(), m[1]);
  }
  return [...seen.values()];
}

function cleanCookie(value, cookieName, field) {
  const v = String(value ?? '')
    .trim()
    .replace(/^["']|["']$/g, '') // quotes around the whole thing: "auth_token=abc;"
    .trim()
    .replace(new RegExp(`^${cookieName}\\s*=\\s*`, 'i'), '')
    .replace(/;.*$/s, '')
    .replace(/^["']|["']$/g, '') // quotes around just the value: auth_token="abc"
    .trim();
  if (!/^[A-Za-z0-9%_.-]{8,512}$/.test(v)) {
    throw new ValidationError(`That doesn't look like a valid ${cookieName} value. Paste only the value: one long string of letters and numbers.`, field);
  }
  return v;
}

function cleanPacing(input, current) {
  const out = { ...current };
  for (const [key, rule] of Object.entries(PACING_RULES)) {
    if (!(key in input)) continue;
    const raw = input[key];
    const n = typeof raw === 'string' ? Number(raw.trim()) : raw;
    if (raw === '' || raw === null || typeof n !== 'number' || !Number.isFinite(n)) {
      throw new ValidationError(`${rule.label} must be a number.`, key);
    }
    if (rule.integer && !Number.isInteger(n)) throw new ValidationError(`${rule.label} must be a whole number.`, key);
    if (n < rule.min || n > rule.max) throw new ValidationError(`${rule.label} must be between ${rule.min} and ${rule.max}. ${rule.hint}`, key);
    out[key] = n;
  }
  if (out.delayMinSec > out.delayMaxSec) {
    throw new ValidationError('The shortest pause cannot be longer than the longest pause.', 'delayMinSec');
  }
  return out;
}

// Returns a new settings object with `input` applied, or throws ValidationError.
export function mergeSettings(current, input = {}) {
  const next = { ...current, pacing: { ...current.pacing } };
  const hasAuth = String(input.authToken ?? '').trim() !== '';
  const hasCt0 = String(input.ct0 ?? '').trim() !== '';
  if (hasAuth !== hasCt0) {
    throw new ValidationError('Paste both cookies (auth_token and ct0) together.', hasAuth ? 'ct0' : 'authToken');
  }
  if (hasAuth) {
    next.authToken = cleanCookie(input.authToken, 'auth_token', 'authToken');
    next.ct0 = cleanCookie(input.ct0, 'ct0', 'ct0');
  }
  if ('username' in input) {
    const u = String(input.username ?? '').trim().replace(/^@/, '');
    if (u && !HANDLE.test(u)) throw new ValidationError('Your handle should be 1-15 letters, numbers or underscores (or leave it empty to detect it automatically).', 'username');
    next.username = u;
  }
  if ('keepText' in input) next.keepText = parseKeepText(input.keepText).join('\n');
  if (input.pacing && typeof input.pacing === 'object') next.pacing = cleanPacing(input.pacing, next.pacing);
  return next;
}

export function loadSettings(dataDir) {
  const base = emptySettings();
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
    return {
      authToken: typeof raw.authToken === 'string' ? raw.authToken : '',
      ct0: typeof raw.ct0 === 'string' ? raw.ct0 : '',
      username: typeof raw.username === 'string' ? raw.username : '',
      keepText: typeof raw.keepText === 'string' ? raw.keepText : '',
      pacing: { ...base.pacing, ...(raw.pacing && typeof raw.pacing === 'object' ? raw.pacing : {}) },
    };
  } catch {
    return base;
  }
}

export function saveSettings(dataDir, settings) {
  const file = path.join(dataDir, 'settings.json');
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function publicSettings(s) {
  return {
    credentialsSaved: Boolean(s.authToken && s.ct0),
    username: s.username,
    keepText: s.keepText,
    pacing: { ...s.pacing },
    defaults: { ...DEFAULT_PACING },
  };
}
