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
