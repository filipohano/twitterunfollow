import fs from 'node:fs';

export class ConfigError extends Error {}

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());
const clean = (h) => h.trim().replace(/^@/, '').toLowerCase();

function num(env, name, def, { min = 0, integer = false } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || (integer && !Number.isInteger(n))) {
    throw new ConfigError(`${name} must be ${integer ? 'an integer' : 'a number'} >= ${min} (got "${raw}")`);
  }
  return n;
}

function loadKeep(env) {
  const keep = new Set();
  for (const h of (env.KEEP || '').split(',')) if (clean(h)) keep.add(clean(h));
  if (env.KEEP_FILE) {
    let text;
    try {
      text = fs.readFileSync(env.KEEP_FILE, 'utf8');
    } catch (e) {
      throw new ConfigError(`Cannot read KEEP_FILE ${env.KEEP_FILE}: ${e.message}`);
    }
    for (const line of text.split(/\r?\n/)) {
      const h = clean(line.replace(/#.*/, ''));
      if (h) keep.add(h);
    }
  }
  return keep;
}

export function loadConfig(env = process.env) {
  const cfg = {
    baseUrl: (env.X_BASE_URL || 'https://x.com').replace(/\/+$/, ''),
    authToken: (env.TWITTER_AUTH_TOKEN || '').trim(),
    ct0: (env.TWITTER_CT0 || '').trim(),
    username: env.TWITTER_USERNAME ? clean(env.TWITTER_USERNAME) : '',
    keep: loadKeep(env),
    dryRun: truthy(env.DRY_RUN),
    headless: !/^(0|false|no|off)$/i.test(env.HEADLESS ?? ''),
    chromiumPath: env.CHROMIUM_PATH || undefined,
    dataDir: env.DATA_DIR || './data',

    delayMinMs: num(env, 'DELAY_MIN_SEC', 15) * 1000,
    delayMaxMs: num(env, 'DELAY_MAX_SEC', 45) * 1000,
    burstSize: num(env, 'BURST_SIZE', 20, { integer: true, min: 1 }),
    burstPauseMinMs: num(env, 'BURST_PAUSE_MIN_SEC', 180) * 1000,
    burstPauseMaxMs: num(env, 'BURST_PAUSE_MAX_SEC', 360) * 1000,
    maxPerHour: num(env, 'MAX_PER_HOUR', 30, { integer: true, min: 1 }),
    maxPerDay: num(env, 'MAX_PER_DAY', 150, { integer: true, min: 1 }),
    maxTotal: num(env, 'MAX_TOTAL', 0, { integer: true }),

    backoffBaseMs: num(env, 'BACKOFF_BASE_SEC', 900) * 1000,
    maxBackoffs: num(env, 'MAX_BACKOFFS', 5, { integer: true, min: 1 }),

    // Internal waits (ms). Not env-configurable; tests shrink them.
    timing: {
      listWaitMs: 25_000,
      scrollPauseMs: [900, 1700],
      endWaitMs: 2500,
      capJitterMs: [5_000, 30_000],
      failurePauseMs: [5_000, 10_000],
      verifyRetryWaitMs: 45_000,
      backoffMarginMs: 30_000,
    },
  };

  if (cfg.delayMinMs > cfg.delayMaxMs) throw new ConfigError('DELAY_MIN_SEC must be <= DELAY_MAX_SEC');
  if (cfg.burstPauseMinMs > cfg.burstPauseMaxMs) throw new ConfigError('BURST_PAUSE_MIN_SEC must be <= BURST_PAUSE_MAX_SEC');
  if (!cfg.authToken || !cfg.ct0) {
    throw new ConfigError(
      'TWITTER_AUTH_TOKEN and TWITTER_CT0 are required (the auth_token and ct0 cookies of a logged-in x.com session). See README.',
    );
  }
  return cfg;
}
