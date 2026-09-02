// Sessions must survive changing Cloud Run instance.
//
// express-session had no `store`, so it used the built-in MemoryStore: one object, per
// Node process. This service runs with maxScale 4, session affinity OFF and minScale 0,
// so a session was valid only on the instance that created it and every session died when
// the service scaled to zero. ("Warning: connect.session() MemoryStore is not designed
// for a production environment" appeared in the Cloud Run logs several times a day.)
//
// The reported symptom was the login round trip -- /login, Auth0, /callback, three hops,
// any of which could land elsewhere. A lost OAuth state made authentication fail; a lost
// `returnTo` made /callback fall back to '/' and dump people on the homepage instead of
// the page they had clicked. It surfaced when GET /scorecard-photo/:id replaced the public
// S3 URL in the results-secretary email, because that turned a link needing no session at
// all into one that forces the whole round trip.
//
// Verified against the real database by running two server processes against one Postgres
// and confirming a session written by the first was read and updated in place by the
// second -- one row, not two.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const session = require('express-session');

const store = require('../utils/sessionStore');

describe('the store satisfies express-session', () => {
  it('is a real Store subclass', () => {
    assert.ok(new store.PostgresSessionStore() instanceof session.Store);
  });

  it('implements get, set and destroy', () => {
    const s = new store.PostgresSessionStore();
    for (const m of ['get', 'set', 'destroy']) {
      assert.strictEqual(typeof s[m], 'function', m);
    }
  });

  it('implements touch, which is NOT optional here', () => {
    // app.js runs with `resave: false`, so a session that is read but not modified is
    // never written back. Without touch its `expire` never moves and an admin is logged
    // out at a fixed time after logging in, mid-session.
    assert.strictEqual(typeof new store.PostgresSessionStore().touch, 'function');
  });
});

describe('expiry', () => {
  it('honours the cookie expiry when there is one', () => {
    const at = new Date(Date.now() + 5 * 60 * 1000);
    assert.strictEqual(store.expiryFor({ cookie: { expires: at } }).getTime(), at.getTime());
  });

  it('falls back to the default TTL, because this app sets no cookie maxAge', () => {
    // sess.cookie in app.js sets httpOnly/sameSite/secure and no expiry, so
    // session.cookie.expires is null and the row would otherwise have no TTL at all.
    for (const s of [{ cookie: {} }, { cookie: { expires: null } }, {}, null]) {
      const ms = store.expiryFor(s).getTime() - Date.now();
      assert.ok(Math.abs(ms - store.DEFAULT_TTL_MS) < 5000, JSON.stringify(s) + ' -> ' + ms);
    }
  });

  it('ignores an unparseable cookie expiry rather than writing an invalid date', () => {
    const ms = store.expiryFor({ cookie: { expires: 'not a date' } }).getTime() - Date.now();
    assert.ok(Math.abs(ms - store.DEFAULT_TTL_MS) < 5000);
  });

  it('prunes far less often than a session lives', () => {
    // Pruning is housekeeping: reads already filter on `expire`, so a slow prune costs
    // dead rows rather than correctness. It must not be so frequent that it becomes the
    // busiest query on the box.
    assert.ok(store.PRUNE_INTERVAL_MS < store.DEFAULT_TTL_MS);
    assert.ok(store.PRUNE_INTERVAL_MS >= 15 * 60 * 1000);
  });
});

describe('app.js still wires the store up', () => {
  // A source assertion, the same tactic as test/db-retry.test.js: the bug was the ABSENCE
  // of configuration, and absence is exactly what a behavioural test of the app cannot
  // see -- MemoryStore works perfectly in a single-process test run. So this pins the
  // wiring itself, because deleting it would restore a bug that only appears in
  // production and only intermittently.
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

  it('assigns a store to the session config', () => {
    assert.match(appSrc, /sess\.store\s*=\s*new PostgresSessionStore\(\)/);
  });

  it('starts the pruning timer', () => {
    assert.match(appSrc, /startPruning\(\)/);
  });

  it('skips the DB store under test, where MemoryStore is correct', () => {
    // test/helpers/app.js has no working database credentials on purpose, and the suite
    // runs in one process.
    assert.match(appSrc, /process\.env\.NODE_ENV !== 'test'[\s\S]{0,400}?sess\.store/);
  });

  it('still sets no cookie maxAge, which is what the default TTL exists for', () => {
    // If a maxAge is ever added, expiryFor starts honouring it and this comment is how
    // the next person knows the two are connected.
    const sessBlock = appSrc.slice(appSrc.indexOf('var sess = {'), appSrc.indexOf('app.use(session(sess))'));
    assert.ok(!/maxAge/.test(sessBlock), 'a cookie maxAge appeared; check expiryFor still does what you want');
  });
});

describe('the migration is in the repo', () => {
  it('creates the session table idempotently', () => {
    // It must be applied BEFORE this code is deployed: without the table every session
    // read throws and nobody can log in at all.
    const sqlSrc = fs.readFileSync(path.join(__dirname, '..', 'migrations', 'session-store.sql'), 'utf8');
    assert.match(sqlSrc, /CREATE TABLE IF NOT EXISTS "session"/);
    assert.match(sqlSrc, /CREATE INDEX IF NOT EXISTS session_expire_idx/);
  });
});
