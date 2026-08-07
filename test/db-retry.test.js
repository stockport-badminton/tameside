const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Requiring db_connect does not open a connection — postgres.js connects lazily on the
// first query — and nothing in this file runs a query, so it is safe alongside the rest
// of the suite.
const { withRetry, isRetryable, RETRY_DELAY_MS } = require('../utils/db_connect');

// postgres.js does not export its internals under a subpath, so reach the file directly.
// An absolute path bypasses the package's "exports" restriction. If the layout ever
// changes this returns null and the shape checks below skip rather than fail.
function loadPostgresErrors() {
  try {
    return require(path.join(
      __dirname, '..', 'node_modules', 'postgres', 'cjs', 'src', 'errors.js'
    ));
  } catch { return null; }
}

function connErr(code) {
  // Same shape postgres.js gives a socket failure: the Node errno reaches us verbatim.
  return Object.assign(new Error('read ' + code), { code, errno: code });
}

test('isRetryable', async (t) => {
  await t.test('accepts the socket failures we actually saw in production', () => {
    // TAMESIDE-NODE-5 (Tameside, homepage) was ECONNRESET; NODE-X (Stockport, same day,
    // different driver) was the pg equivalent. Both are a pooled connection dying
    // between checkout and use.
    for (const code of ['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED']) {
      assert.ok(isRetryable(connErr(code)), `${code} should be retryable`);
    }
  });

  await t.test("accepts postgres.js's own connection error codes", () => {
    // These are the four strings Errors.connection is called with across postgres.js.
    for (const code of [
      'CONNECTION_CLOSED', 'CONNECTION_ENDED', 'CONNECTION_DESTROYED', 'CONNECT_TIMEOUT'
    ]) {
      assert.ok(isRetryable(connErr(code)), `${code} should be retryable`);
    }
  });

  await t.test('refuses a PostgresError — the server answered, so a retry gets the same answer', () => {
    const errors = loadPostgresErrors();
    if (!errors) return; // package layout changed; the hand-built check below still runs

    // A real one: this is what `relation "lewisnull" does not exist` (TAMESIDE-NODE-4)
    // arrives as. Retrying a query the server has already rejected is pure latency.
    const real = errors.Errors.postgres({ message: 'relation "x" does not exist', code: '42P01' });
    assert.strictEqual(real.name, 'PostgresError', 'guard keys on .name, so it must be set');
    assert.strictEqual(isRetryable(real), false);
  });

  await t.test('refuses errors that are not connection failures', () => {
    assert.strictEqual(isRetryable(Object.assign(new Error('x'), { name: 'PostgresError', code: '42P01' })), false);
    assert.strictEqual(isRetryable(new TypeError('cannot read properties of undefined')), false);
    assert.strictEqual(isRetryable(Object.assign(new Error('x'), { code: 'ENOENT' })), false);
    assert.strictEqual(isRetryable(undefined), false);
    assert.strictEqual(isRetryable(null), false);
  });

  await t.test('a PostgresError carrying a retryable-looking code is still refused', () => {
    // Belt and braces on ordering inside isRetryable: the name check must come first.
    const err = Object.assign(new Error('x'), { name: 'PostgresError', code: 'ECONNRESET' });
    assert.strictEqual(isRetryable(err), false);
  });
});

test('withRetry', async (t) => {
  await t.test('passes through on success without a second call', async () => {
    let calls = 0;
    const result = await withRetry(async () => { calls++; return 'rows'; });
    assert.strictEqual(result, 'rows');
    assert.strictEqual(calls, 1);
  });

  await t.test('retries once and returns the second attempt', async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls === 1) throw connErr('ECONNRESET');
      return 'rows';
    });
    assert.strictEqual(result, 'rows', 'the visitor should get their page, not a 500');
    assert.strictEqual(calls, 2);
  });

  await t.test('gives up after one retry rather than hammering a database that is away', async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(async () => { calls++; throw connErr('ECONNRESET'); }),
      (err) => err.code === 'ECONNRESET'
    );
    assert.strictEqual(calls, 2, 'exactly one retry — more just holds the request open');
  });

  await t.test('does not retry a query the server rejected', async () => {
    let calls = 0;
    const pgErr = Object.assign(new Error('syntax error'), { name: 'PostgresError', code: '42601' });
    await assert.rejects(
      withRetry(async () => { calls++; throw pgErr; }),
      (err) => err.code === '42601'
    );
    assert.strictEqual(calls, 1);
  });

  await t.test('calls the thunk again rather than re-awaiting one query', async () => {
    // The safety contract: callers pass `() => sql`...`` so each attempt builds a fresh
    // Query. Re-awaiting a Query that already rejected just replays the rejection, and
    // the tables queries interpolate nested sql`` fragments that belong to one build.
    const built = [];
    await withRetry(async () => {
      const query = { id: built.length };
      built.push(query);
      if (built.length === 1) throw connErr('CONNECTION_CLOSED');
      return query;
    });
    assert.strictEqual(built.length, 2);
    assert.notStrictEqual(built[0], built[1], 'each attempt must build its own query');
  });

  await t.test('waits before retrying so the pool can drop the dead connection', async () => {
    const started = process.hrtime.bigint();
    let calls = 0;
    await withRetry(async () => {
      calls++;
      if (calls === 1) throw connErr('ECONNRESET');
      return 'rows';
    });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    // Timers can fire a hair early, so allow a small margin rather than asserting >=.
    assert.ok(
      elapsedMs >= RETRY_DELAY_MS - 15,
      `retry should wait ~${RETRY_DELAY_MS}ms, waited ${elapsedMs.toFixed(1)}ms`
    );
  });
});

// The point of the helper is the three pages it covers. Asserting at the source level
// keeps it from being quietly dropped by a later edit to one of these queries — a
// regression that is otherwise invisible until a visitor gets a 500.
test('the three protected pages still retry', async (t) => {
  const PROTECTED = [
    ['models/fixture.js', 'getRecent', '/'],
    ['models/fixture.js', 'getOutstandingScorecards', '/'],
    ['models/fixture.js', 'getupComing', '/'],
    ['models/homepageContent.js', 'getActive', '/'],
    ['models/siteSettings.js', 'get', '/'],
    ['models/club.js', 'clubDetail', '/info/clubs'],
    ['models/venue.js', 'getVenueClubs', '/info/clubs'],
    ['models/league.js', 'getLeagueTable', '/tables/:division'],
    ['models/league.js', 'getAllLeagueTables', '/tables/All'],
  ];

  for (const [file, fn, route] of PROTECTED) {
    await t.test(`${fn} (${route})`, () => {
      const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
      const start = src.indexOf(`exports.${fn} = async function`);
      assert.notStrictEqual(start, -1, `${file} should still export ${fn}`);

      // Bound the slice at the next export so a neighbouring function's withRetry
      // cannot satisfy this assertion. Comments are stripped because several of these
      // functions carry a note quoting the old `.catch(err => done(err))` idiom, which
      // would otherwise trip the check against it below.
      const next = src.indexOf('\nexports.', start + 1);
      const body = src
        .slice(start, next === -1 ? src.length : next)
        .replace(/^\s*\/\/.*$/gm, '');

      assert.match(
        body,
        /withRetry\(\(\) =>/,
        `${fn} backs ${route} and must wrap its query in withRetry(() => sql\`...\`). ` +
        `Without it a pooled connection that died between checkout and use gives the ` +
        `visitor a 500 (Sentry TAMESIDE-NODE-5, 2026-08-06).`
      );
      assert.match(
        body,
        /catch \(err\) \{ done\(err\); \}/,
        `${fn} should report failure through try/catch. The .catch(err => done(err)) ` +
        `idiom it replaced fell through to done(null, undefined) after done(err), so ` +
        `the controller rendered on top of a 500 already in flight.`
      );
      assert.doesNotMatch(
        body,
        /\.catch\(err\s*=>/,
        `${fn} still has a .catch(err => ...) on its query — withRetry's rejection has ` +
        `to reach the try/catch, and the two error paths must not both be live.`
      );
    });
  }
});
