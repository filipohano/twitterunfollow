import test from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../src/limiter.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

test('allows actions under the caps', () => {
  const l = new RateLimiter({ perHour: 3, perDay: 10 });
  const now = 1_000_000_000_000;
  l.record(now - 10 * MIN);
  l.record(now - 5 * MIN);
  assert.equal(l.waitMs(now), 0);
});

test('hourly cap waits until the oldest action in the hour ages out', () => {
  const l = new RateLimiter({ perHour: 3, perDay: 100 });
  const now = 1_000_000_000_000;
  l.record(now - 50 * MIN); // frees up in 10 min
  l.record(now - 30 * MIN);
  l.record(now - 10 * MIN);
  assert.equal(l.waitMs(now), 10 * MIN);
  assert.equal(l.waitMs(now + 10 * MIN), 0);
});

test('daily cap holds even when the hourly cap is fine', () => {
  const l = new RateLimiter({ perHour: 100, perDay: 2 });
  const now = 1_000_000_000_000;
  l.record(now - 20 * HOUR);
  l.record(now - 2 * HOUR);
  assert.equal(l.waitMs(now), 4 * HOUR);
});

test('the longer of the two waits wins', () => {
  const l = new RateLimiter({ perHour: 1, perDay: 2 });
  const now = 1_000_000_000_000;
  l.record(now - 23 * HOUR); // daily window frees in 1h
  l.record(now - 30 * MIN); // hourly window frees in 30m
  assert.equal(l.waitMs(now), HOUR);
});

test('persisted timestamps older than a day are dropped', () => {
  const now = 1_000_000_000_000;
  const l = new RateLimiter({ perHour: 1, perDay: 1, actions: [now - 25 * HOUR, now - 90 * MIN] });
  l.prune(now);
  assert.equal(l.actions.length, 1);
  assert.equal(l.waitMs(now), 24 * HOUR - 90 * MIN);
});
