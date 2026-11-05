// utils/authCull.js: which logins the monthly cull warns, waits on, or lists for deletion.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { classify } = require('../utils/authCull');

const NOW = Date.parse('2026-11-05T12:00:00Z');
const daysAgo = n => new Date(NOW - n * 864e5).toISOString();

const user = (id, o = {}) => ({
  user_id: id, email: id + '@example.com', last_login: daysAgo(400), created_at: daysAgo(900),
  app_metadata: { betaAccess: true, ...(o.md || {}) }, ...o,
});
const PLAYER = { first_name: 'Dave', family_name: 'Lee' };

function run(users, { linked = [], notices = {} } = {}) {
  const out = classify(users, new Map(linked.map(id => [id, PLAYER])),
    new Map(Object.entries(notices)), NOW);
  const ids = list => list.map(e => e.user.user_id);
  return { notify: ids(out.notify), waiting: ids(out.waiting), due: ids(out.due), raw: out };
}

describe('login cull: scope', () => {
  it('covers logins linked here and unlinked signups from this site, nothing else', () => {
    const r = run([
      user('linked', { md: { league: 'stockport' } }),  // plays both: the link decides
      user('ours-unlinked', { md: { league: 'tameside' } }),
      user('stockport-unlinked', { md: { league: 'stockport' } }),
      user('google-unlinked'),                            // no tag: Stockport's cull
    ], { linked: ['linked'] });
    assert.deepStrictEqual(r.notify.sort(), ['linked', 'ours-unlinked']);
    assert.deepStrictEqual([...r.waiting, ...r.due], []);
  });
});

describe('login cull: the cycle', () => {
  it('leaves a login used within the year alone, on either site', () => {
    assert.deepStrictEqual(run([user('a', { last_login: daysAgo(300) })], { linked: ['a'] }).notify, []);
  });

  it('judges a never-used login by its signup date', () => {
    const r = run([user('new', { last_login: null, created_at: daysAgo(20) }),
      user('old', { last_login: null, created_at: daysAgo(500) })], { linked: ['new', 'old'] });
    assert.deepStrictEqual(r.notify, ['old']);
  });

  it('warns once, waits a month, then lists it', () => {
    const u = [user('a')];
    assert.deepStrictEqual(run(u, { linked: ['a'], notices: { a: { notified_at: daysAgo(10) } } }).waiting, ['a']);
    const due = run(u, { linked: ['a'], notices: { a: { notified_at: daysAgo(31) } } });
    assert.deepStrictEqual(due.due, ['a']);
    assert.strictEqual(due.raw.due[0].reason, 'no answer to the warning');
  });

  it('a login after the warning is the answer', () => {
    const r = run([user('a', { last_login: daysAgo(5) })], { linked: ['a'], notices: { a: { notified_at: daysAgo(20) } } });
    assert.deepStrictEqual([...r.notify, ...r.waiting, ...r.due], []);
  });

  it('the keep link counts as use for a year', () => {
    const r = run([user('a')], { linked: ['a'], notices: { a: { notified_at: daysAgo(40), kept_at: daysAgo(35) } } });
    assert.deepStrictEqual([...r.notify, ...r.waiting, ...r.due], []);
  });

  it('a warning from an earlier year does not count: warn again', () => {
    // Warned 500 days ago, logged in 450 days ago, idle since.
    const r = run([user('a', { last_login: daysAgo(450) })], { linked: ['a'], notices: { a: { notified_at: daysAgo(500) } } });
    assert.deepStrictEqual(r.notify, ['a']);
  });

  it('lists one that cannot be warned without emailing it', () => {
    const r = run([
      user('pending', { md: { betaAccess: false, league: 'tameside' } }),
      user('no-address', { email: undefined }),
    ], { linked: ['no-address'] });
    assert.deepStrictEqual(r.notify, []);
    assert.deepStrictEqual(r.raw.due.map(e => [e.user.user_id, e.reason]),
      [['pending', 'never approved'], ['no-address', 'no address to warn']]);
  });
});
