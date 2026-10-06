import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseCount } from '../src/x.js';
import { RateLimiter } from '../src/limiter.js';
import { loadActions } from '../src/state.js';

test('parseCount reads English formats and refuses anything ambiguous', () => {
  assert.equal(parseCount('1,234\nFollowing'), 1234);
  assert.equal(parseCount('1,234 Following'), 1234);
  assert.equal(parseCount('987 Following'), 987);
  assert.equal(parseCount('12.5K Following'), 12500);
  assert.equal(parseCount('1.2M Following'), 1_200_000);
  assert.equal(parseCount('0 Following'), 0);
  // other locales: a wrong number is worse than none
  for (const t of ['1.234 Siguiendo', '12,3 mil Siguiendo', '1 234 abonnements', '1,2 Mio. Folge ich', '12,3 Tsd. Folge ich', 'Following', '']) {
    assert.equal(parseCount(t), null, JSON.stringify(t));
  }
});

test('limiter keeps future-dated history (clock stepped back) instead of forgetting it', () => {
  const now = 1_000_000_000_000;
  const l = new RateLimiter({ perHour: 40, perDay: 250, actions: Array.from({ length: 40 }, (_, i) => now + 12 * 60_000 + i) });
  l.prune(now);
  assert.equal(l.actions.length, 40);
  assert.equal(l.usage(now).hour, 40);
  assert.ok(l.waitMs(now) > 0, 'the hourly cap still holds');
});

test('a damaged or missing state.json is rebuilt from the unfollow log, never reset to an empty history', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-test-'));
  try {
    assert.deepEqual(loadActions(dir), [], 'first run: nothing yet');
    const recent = new Date(Date.now() - 10 * 60_000).toISOString();
    const old = new Date(Date.now() - 30 * 3600_000).toISOString();
    fs.writeFileSync(path.join(dir, 'unfollowed.jsonl'), [{ handle: 'a', at: recent }, { handle: 'b', at: recent }, { handle: 'c', at: old }, 'garbage'].map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n'));
    fs.writeFileSync(path.join(dir, 'state.json'), '{"actions": [1, 2');
    assert.equal(loadActions(dir).length, 2, 'truncated state.json -> rebuilt from the log (last 24h only)');
    fs.rmSync(path.join(dir, 'state.json'));
    assert.equal(loadActions(dir).length, 2, 'missing state.json but a log exists -> same');
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ actions: [5, 6, 7] }));
    assert.deepEqual(loadActions(dir), [5, 6, 7], 'a healthy state.json is authoritative');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
