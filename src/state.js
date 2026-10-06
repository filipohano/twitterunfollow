import fs from 'node:fs';
import path from 'node:path';

// state.json   -> timestamps of recent unfollows (feeds the rolling hourly/daily caps)
// unfollowed.jsonl -> append-only record of every handle unfollowed, so you can re-follow later

export function loadActions(dataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
    return Array.isArray(parsed.actions) ? parsed.actions : [];
  } catch {
    return [];
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
