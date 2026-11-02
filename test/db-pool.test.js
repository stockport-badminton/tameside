const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Requiring db_connect does not open a connection — postgres.js connects lazily on the
// first query — so this file is safe to run alongside the rest of the suite.
const { sql, POOL_MAX, IDLE_TIMEOUT, MAX_PIPELINE, beginOnReserved } = require('../utils/db_connect');
const spamControls = require('../models/spamControls');

const cloudbuild = fs.readFileSync(
  path.join(__dirname, '..', 'cloudbuild.yaml'),
  'utf8'
);

test('db pool ceilings', async (t) => {
  await t.test('idle_timeout stays above the blocklist refresh interval', () => {
    const refreshSeconds = spamControls.CACHE_TTL_MS / 1000;
    assert.ok(
      IDLE_TIMEOUT > refreshSeconds,
      `idle_timeout (${IDLE_TIMEOUT}s) must exceed the blocklist refresh interval ` +
      `(${refreshSeconds}s). Below it, the refresh timer's connection is closed ` +
      `between ticks and every tick opens a new one — 1,800 opens/day when this ` +
      `regressed on 2026-08-05.`
    );
  });

  await t.test('pool max x max-instances stays within the 60-backend ceiling', () => {
    const match = cloudbuild.match(/_MAX_INSTANCES:\s*'(\d+)'/);
    assert.ok(match, 'cloudbuild.yaml must declare _MAX_INSTANCES');

    const maxInstances = Number(match[1]);
    const worstCase = POOL_MAX * maxInstances;
    assert.ok(
      worstCase <= 60,
      `pool max (${POOL_MAX}) x max-instances (${maxInstances}) = ${worstCase} ` +
      `clients, above the 60 backends Postgres allows. Raising either without the ` +
      `other is how Stockport hit EMAXCONNSESSION (Sentry NODE-V, 28 July).`
    );
  });

  await t.test('pipelining stays off on the transaction pooler', () => {
    assert.strictEqual(MAX_PIPELINE, 0);
    // The constant is only half of it: postgres.js must actually have been given it.
    assert.strictEqual(
      sql.options.max_pipeline,
      0,
      'max_pipeline must be 0. Supavisor transaction mode drops a query pipelined ' +
      'behind another one, and the connection then hangs forever — a burst of page ' +
      'loads wedged the whole instance on 2 Nov 2026. See utils/db_connect.js.'
    );
  });

  await t.test('cloudbuild actually passes the declared cap to Cloud Run', () => {
    assert.match(
      cloudbuild,
      /--max-instances=/,
      'the Deploy step must pass --max-instances, or the cap lives only in console ' +
      'state and is not reviewable in git'
    );
  });
});

// postgres.js's own sql.begin() cannot run at max_pipeline 0: it reserves the connection from
// a hook it only calls when `sent.length < max_pipeline`, so every transaction failed with
// UNSAFE_TRANSACTION from 2 Nov 2026 until begin was rebuilt on sql.reserve(). These run that
// rebuild against a fake reserved connection that records what it was sent.
test('sql.begin runs on a reserved connection', async (t) => {
  function fakePool() {
    const sent = [];
    let released = 0;
    const tx = (strings, ...values) => {
      if (!Array.isArray(strings)) return { ident: strings };   // tx('name') identifier helper
      const text = strings.reduce((a, s, i) => a + s + (i < values.length ? (values[i].ident || values[i]) : ''), '');
      sent.push(text.trim());
      return Promise.resolve([{ text }]);
    };
    tx.unsafe = (text) => { sent.push(text.trim()); return Promise.resolve([]); };
    tx.release = () => { released++; };
    return { pool: { reserve: async () => tx }, sent, released: () => released };
  }

  await t.test('is the rebuilt one, not postgres.js\'s', () => {
    assert.strictEqual(sql.begin.name, 'begin');
    assert.match(String(sql.begin), /reserve\(\)/,
      'sql.begin must be beginOnReserved: postgres.js\'s own fails every transaction at max_pipeline 0');
  });

  await t.test('commits, returns the callback\'s value and releases the connection', async () => {
    const f = fakePool();
    const out = await beginOnReserved(f.pool)(async (tx) => { await tx`select 1`; return 42; });
    assert.strictEqual(out, 42);
    assert.deepStrictEqual(f.sent, ['begin', 'select 1', 'commit']);
    assert.strictEqual(f.released(), 1);
  });

  await t.test('rolls back and rethrows on a throw, and still releases', async () => {
    const f = fakePool();
    await assert.rejects(beginOnReserved(f.pool)(async () => { throw new Error('boom'); }), /boom/);
    assert.deepStrictEqual(f.sent, ['begin', 'rollback']);
    assert.strictEqual(f.released(), 1);
  });

  await t.test('takes a mode string and an array of queries', async () => {
    const f = fakePool();
    const out = await beginOnReserved(f.pool)('read only', (tx) => [tx`select 1`, tx`select 2`]);
    assert.strictEqual(out.length, 2);
    assert.deepStrictEqual(f.sent, ['begin read only', 'select 1', 'select 2', 'commit']);
  });

  await t.test('a savepoint that throws rolls back to itself only', async () => {
    const f = fakePool();
    await beginOnReserved(f.pool)(async (tx) => {
      await assert.rejects(tx.savepoint(async (sp) => { await sp`insert 1`; throw new Error('inner'); }), /inner/);
      await tx`insert 2`;
    });
    assert.deepStrictEqual(f.sent,
      ['begin', 'savepoint s1', 'insert 1', 'rollback to savepoint s1', 'insert 2', 'commit']);
  });
});
