import fs from 'node:fs';
import path from 'node:path';
import { log } from './util.js';

// state.json   -> timestamps of recent unfollows (feeds the rolling hourly/daily caps)
// unfollowed.jsonl -> append-only record of every handle unfollowed, so you can re-follow later

const DAY_MS = 24 * 3600_000;

// Recent unfollow timestamps from the append-only log (fallback source for the rate-limit history).
function actionsFromLog(dataDir) {
  const out = [];
  try {
    for (const line of fs.readFileSync(path.join(dataDir, 'unfollowed.jsonl'), 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const t = Date.parse(JSON.parse(line).at);
        if (Number.isFinite(t) && t > Date.now() - DAY_MS) out.push(t);
      } catch {
        /* torn line */
      }
    }
  } catch {
    /* no log yet */
  }
  return out;
}

export function loadActions(dataDir) {
  const file = path.join(dataDir, 'state.json');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') log(`Could not read ${file} (${e.message}); rebuilding the rate-limit history from the unfollow log.`);
    return actionsFromLog(dataDir); // normally empty on a first run
  }
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.actions)) return parsed.actions;
    throw new Error('missing "actions" list');
  } catch (e) {
    // A damaged history must not reset the caps to zero: rebuild it from the log of what was actually unfollowed.
    log(`${file} is damaged (${e.message}); rebuilding the rate-limit history from the unfollow log.`);
    return actionsFromLog(dataDir);
  }
}

export function saveActions(dataDir, actions) {
  const file = path.join(dataDir, 'state.json');
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ actions }));
  fs.renameSync(tmp, file);
}

export function appendUnfollowed(dataDir, handle) {
  const line = JSON.stringify({ handle, at: new Date().toISOString() });
  fs.appendFileSync(path.join(dataDir, 'unfollowed.jsonl'), `${line}\n`);
}
