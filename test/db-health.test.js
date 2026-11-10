const test = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';
process.env.PGPASSWORD = process.env.PGPASSWORD || 'test-placeholder';

const dbHealth = require('../utils/dbHealth');

test.afterEach(() => dbHealth._setProbeQueryForTests(null));

test('a query that answers is healthy', async () => {
  dbHealth._setProbeQueryForTests(async () => [{ '?column?': 1 }]);
  const result = await dbHealth.check(500);
  assert.deepStrictEqual(result, { ok: true });
});

// The design decision this file exists to protect. A query that fails fast proves the
// socket is alive and the process is fine — the database is the broken part, and this
// container cannot fix that by restarting. Reporting unhealthy here would turn a
// Supabase outage into a restart loop across every instance at once, which is worse
// than serving the pages and cached assets that need no query.
test('a query that FAILS fast is still healthy — only silence is unhealthy', async () => {
  dbHealth._setProbeQueryForTests(async () => { const e = new Error('nope'); e.code = 'ECONNREFUSED'; throw e; });
  const result = await dbHealth.check(500);
  assert.strictEqual(result.ok, true, 'a DB error must not fail the liveness probe');
});

test('a query that never answers is unhealthy', async () => {
  dbHealth._setProbeQueryForTests(() => new Promise(() => {}));
  const started = Date.now();
  const result = await dbHealth.check(120);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'db-timeout');
  assert.ok(Date.now() - started < 2000, 'must resolve on its own deadline, not wait for the query');
});

// A poisoned connection never settles, so a fresh query per probe would check out
// another pool slot every time and starve the pool the probe reports on. At max:5 that
// is five checks to wedge the instance the probe was added to protect.
test('concurrent checks share ONE outstanding query', async () => {
  let calls = 0;
  dbHealth._setProbeQueryForTests(() => { calls += 1; return new Promise(() => {}); });
  await Promise.all([dbHealth.check(60), dbHealth.check(60), dbHealth.check(60)]);
  await dbHealth.check(60);
  assert.strictEqual(calls, 1, 'expected one query across four checks against a hung pool');
});

test('a recovered pool reports healthy again', async () => {
  let hang = true;
  dbHealth._setProbeQueryForTests(() => (hang ? new Promise(() => {}) : Promise.resolve([{ ok: 1 }])));
  assert.strictEqual((await dbHealth.check(60)).ok, false);
  hang = false;
  dbHealth._setProbeQueryForTests(() => Promise.resolve([{ ok: 1 }]));
  assert.strictEqual((await dbHealth.check(500)).ok, true);
});

// 2026-11-08: the pooler stopped completing connections for ten minutes. The connect
// timeout (10s) is longer than the probe's deadline, so the first check sees silence;
// once the probe's own query has come back CONNECT_TIMEOUT, that silence is an
// unreachable database, not a wedged container, and restarting cannot fix it.
function connectTimeout() {
  const e = new Error('write CONNECT_TIMEOUT pooler:6543'); e.code = 'CONNECT_TIMEOUT'; return e;
}

test('after a CONNECT_TIMEOUT, a check that times out is healthy (db-unreachable)', async () => {
  let reject;
  dbHealth._setProbeQueryForTests(() => new Promise((_, r) => { reject = r; }));
  const first = await dbHealth.check(30);
  assert.strictEqual(first.ok, false, 'no evidence yet: the first timeout is still unhealthy');
  reject(connectTimeout());
  await new Promise((r) => setImmediate(r));

  // The next probe's query hangs on its own connect, as every connect did on 8 Nov.
  const second = await dbHealth.check(30);
  assert.deepStrictEqual(second, { ok: true, reason: 'db-unreachable', ms: 30 });
});

test('a hang with no CONNECT_TIMEOUT behind it still restarts the container', async () => {
  let reject;
  dbHealth._setProbeQueryForTests(() => new Promise((_, r) => { reject = r; }));
  assert.strictEqual((await dbHealth.check(30)).ok, false);
  const e = new Error('read ECONNRESET'); e.code = 'ECONNRESET';
  reject(e);
  await new Promise((r) => setImmediate(r));
  const next = await dbHealth.check(30);
  assert.strictEqual(next.ok, false);
  assert.strictEqual(next.reason, 'db-timeout');
});

test('an old CONNECT_TIMEOUT does not excuse a later hang', async (t) => {
  let reject;
  dbHealth._setProbeQueryForTests(() => new Promise((_, r) => { reject = r; }));
  await dbHealth.check(30);
  reject(connectTimeout());
  await new Promise((r) => setImmediate(r));

  const realNow = Date.now;
  t.after(() => { Date.now = realNow; });
  const later = realNow() + dbHealth.UNREACHABLE_WINDOW_MS + 1000;
  Date.now = () => later;
  const result = await dbHealth.check(30);
  assert.strictEqual(result.ok, false, 'a wedge minutes after the outage cleared must still restart');
});
