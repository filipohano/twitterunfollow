import test from 'node:test';
import assert from 'node:assert/strict';
import { emptySettings, mergeSettings, parseKeepText, publicSettings, ValidationError } from '../src/settings.js';
import { createAuth } from '../src/auth.js';

const field = (fn) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof ValidationError, `expected ValidationError, got ${e}`);
    return e.field;
  }
  assert.fail('expected a ValidationError');
};

test('keep list accepts @handles, bare handles, URLs and commas, de-duplicates case-insensitively', () => {
  assert.deepEqual(parseKeepText('@Alice\nbob, https://x.com/Carol/\nhttps://twitter.com/dave?s=20\nalice # dup'), ['Alice', 'bob', 'Carol', 'dave']);
  assert.deepEqual(parseKeepText(''), []);
});

test('keep list rejects things that are not handles', () => {
  assert.equal(field(() => parseKeepText('alice\nnot a handle!')), 'keep');
  assert.equal(field(() => parseKeepText('averyveryverylonghandlename')), 'keep');
});

test('cookies: must come as a pair, are cleaned of name= prefixes, quotes and semicolons', () => {
  const s = mergeSettings(emptySettings(), { authToken: ' auth_token=abcdef0123456789; ', ct0: '"0123456789abcdef"' });
  assert.equal(s.authToken, 'abcdef0123456789');
  assert.equal(s.ct0, '0123456789abcdef');
  assert.equal(field(() => mergeSettings(emptySettings(), { authToken: 'abcdef0123456789' })), 'ct0');
  assert.equal(field(() => mergeSettings(emptySettings(), { authToken: 'short', ct0: 'abcdef0123456789' })), 'authToken');
  assert.equal(field(() => mergeSettings(emptySettings(), { authToken: 'has spaces in it!!', ct0: 'abcdef0123456789' })), 'authToken');
});

test('omitting or blanking the cookies keeps the saved ones', () => {
  const saved = mergeSettings(emptySettings(), { authToken: 'abcdef0123456789', ct0: '0123456789abcdef' });
  const next = mergeSettings(saved, { authToken: '', ct0: '', username: '@Me', pacing: { maxPerDay: '100' } });
  assert.equal(next.authToken, 'abcdef0123456789');
  assert.equal(next.username, 'Me');
  assert.equal(next.pacing.maxPerDay, 100);
});

test('pacing guard rails', () => {
  const bad = (pacing) => field(() => mergeSettings(emptySettings(), { pacing }));
  assert.equal(bad({ maxPerDay: 0 }), 'maxPerDay');
  assert.equal(bad({ maxPerDay: 401 }), 'maxPerDay');
  assert.equal(bad({ maxPerHour: 101 }), 'maxPerHour');
  assert.equal(bad({ maxPerHour: 2.5 }), 'maxPerHour');
  assert.equal(bad({ delayMinSec: 1 }), 'delayMinSec');
  assert.equal(bad({ delayMaxSec: '' }), 'delayMaxSec');
  assert.equal(bad({ delayMinSec: 50, delayMaxSec: 20 }), 'delayMinSec');
  assert.equal(bad({ maxPerDay: 'lots' }), 'maxPerDay');
});

test('public settings never include the cookies', () => {
  const s = mergeSettings(emptySettings(), { authToken: 'abcdef0123456789', ct0: '0123456789abcdef' });
  const json = JSON.stringify(publicSettings(s));
  assert.ok(!json.includes('abcdef0123456789') && !json.includes('0123456789abcdef'));
  assert.equal(publicSettings(s).credentialsSaved, true);
  assert.equal(publicSettings(emptySettings()).credentialsSaved, false);
});

test('auth: right password gets a session, wrong one does not', () => {
  const auth = createAuth({ password: 'hunter2hunter2' });
  assert.equal(auth.login('nope').ok, false);
  const r = auth.login('hunter2hunter2');
  assert.equal(r.ok, true);
  assert.equal(auth.check(r.token), true);
  assert.equal(auth.check('forged'), false);
  auth.logout(r.token);
  assert.equal(auth.check(r.token), false);
});

test('auth: lockout after 5 failures also refuses the right password, doubles, then recovers', () => {
  let t = 1_000_000;
  const auth = createAuth({ password: 'hunter2hunter2', now: () => t });
  for (let i = 0; i < 4; i += 1) assert.equal(auth.login('x').locked, false);
  const fifth = auth.login('x');
  assert.equal(fifth.locked, true);
  assert.equal(fifth.retryAfterSec, 30);
  assert.equal(auth.login('hunter2hunter2').ok, false, 'correct password must not bypass the lock');
  t += 31_000;
  const sixth = auth.login('x');
  assert.equal(sixth.retryAfterSec, 60, 'second lockout doubles');
  t += 61_000;
  assert.equal(auth.login('hunter2hunter2').ok, true);
});

test('auth: sessions expire', () => {
  let t = 1_000_000;
  const auth = createAuth({ password: 'hunter2hunter2', now: () => t });
  const { token } = auth.login('hunter2hunter2');
  t += 15 * 24 * 3600_000;
  assert.equal(auth.check(token), false);
});

test('auth: a stranger who is locked out cannot lock out the owner (lockout is per client address)', () => {
  let t = 1_000_000;
  const auth = createAuth({ password: 'hunter2hunter2', now: () => t });
  for (let i = 0; i < 6; i += 1) auth.login('guess', '203.0.113.9'); // attacker hammers
  assert.equal(auth.login('hunter2hunter2', '203.0.113.9').ok, false, 'attacker stays locked even with the right password');
  assert.equal(auth.login('hunter2hunter2', '192.168.1.20').ok, true, 'the owner, from another address, still gets in');
  // a flood of failures from many addresses only adds delay; it never refuses a correct password
  for (let i = 0; i < 150; i += 1) auth.login('x', `198.51.100.${i % 250}`);
  assert.equal(auth.failureDelayMs(), 2000);
  assert.equal(auth.login('hunter2hunter2', '192.168.1.21').ok, true);
});

test('auth: absurdly long or non-string passwords are rejected cheaply', () => {
  const auth = createAuth({ password: 'hunter2hunter2' });
  for (const bad of ['x'.repeat(100_000), null, undefined, 12345, ['hunter2hunter2'], { password: 'hunter2hunter2' }]) {
    assert.equal(auth.login(bad, 'c').ok, false);
  }
});
