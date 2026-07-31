// Regression coverage for Sentry TAMESIDE-NODE-4:
//   PostgresError: relation "lewisnull" does not exist   (GET /lewis-shield/null)
//
// /lewis-shield/:season appends the name to build `lewis<season>` and `team<season>`.
// getLewis guarded with `if (!searchTerms.season)`, which the *string* "null" passes —
// so the name went straight into the identifier and Postgres answered with a missing
// relation, surfacing as a 500. A well-formed name with no archived draw
// (e.g. 20102011 — snapshots only start at 2023-24) failed the same way.
//
// Both are bad URLs rather than server faults, so both must 404. The season model is
// mocked here so these run without a DB; models/season.isValidName is exercised
// directly in test/season-name.test.js.
const { describe, it, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { app, setModel, clearModels } = require('../helpers/app');
const seasonModel = require('../../models/season');
const Team = require('../../models/teams');

afterEach(() => { clearModels(); mock.restoreAll(); });

// A season that exists and has a draw. hasLewis is the DB probe, so stub it rather
// than reaching for information_schema.
function stubSeason({ hasLewis }) {
  mock.method(seasonModel, 'hasLewis', async () => hasLewis);
}

// One bracket row, shaped as getLewis returns them. lewisPrelims is the season's
// comma-separated j-values as *text* (real values: "1,9", "3,9,13,15") — the view does
// prelims.split(","), so a number here fails the render rather than the route.
const LEWIS_ROWS = [{
  drawPos: 1, homeTeamName: 'Hyde A', awayTeamName: 'Hyde B',
  homeScore: 5, awayScore: 4, lewisPrelims: '1,9',
}];

describe('GET /lewis-shield/:season — rejects names it cannot build a table from', () => {
  // The exact URL from the Sentry event, plus the neighbouring shapes a crawler or a
  // broken client-side link would produce.
  for (const season of ['null', 'undefined', 'NaN', 'lewis', '0', '20242025x', '2024', '9999']) {
    it(`404s on /lewis-shield/${season} without touching the model`, async () => {
      let called = false;
      setModel('Team', 'getLewis', (s, cb) => { called = true; cb(null, LEWIS_ROWS); });

      const res = await request(app).get(`/lewis-shield/${season}`);

      assert.strictEqual(res.status, 404, `expected 404 for season "${season}"`);
      assert.strictEqual(called, false, 'getLewis must not be reached with an invalid name');
    });
  }

  it('404s on a well-formed season that has no archived draw', async () => {
    // 20102011 is a valid name but predates the snapshots, so lewis20102011 is absent.
    stubSeason({ hasLewis: false });
    let called = false;
    setModel('Team', 'getLewis', (s, cb) => { called = true; cb(null, LEWIS_ROWS); });

    const res = await request(app).get('/lewis-shield/20102011');

    assert.strictEqual(res.status, 404);
    assert.strictEqual(called, false, 'no point querying a table we know is absent');
  });

  it('sets no-store on the 404 so Firebase edge cannot pin it to the URL', async () => {
    // The domain fronts Cloud Run through Firebase Hosting, which caches cookie-less
    // responses for 10 minutes by default — a cached 404 would outlive the fix.
    const res = await request(app).get('/lewis-shield/null');

    assert.strictEqual(res.status, 404);
    assert.match(res.headers['cache-control'] || '', /no-store/);
  });

  it('still renders a season that does have a draw', async () => {
    stubSeason({ hasLewis: true });
    let seen = null;
    setModel('Team', 'getLewis', (s, cb) => { seen = s; cb(null, LEWIS_ROWS); });

    const res = await request(app).get('/lewis-shield/20242025');

    assert.strictEqual(res.status, 200);
    assert.strictEqual(seen.season, '20242025', 'the validated name should reach the model');
  });

  it('still renders the current season when no name is given', async () => {
    let seen = 'unset';
    setModel('Team', 'getLewis', (s, cb) => { seen = s; cb(null, LEWIS_ROWS); });

    const res = await request(app).get('/lewis-shield');

    assert.strictEqual(res.status, 200);
    assert.strictEqual(seen.season, undefined, 'no season key means "use the live tables"');
  });
});

describe('Team.getLewis — refuses to build an identifier from a bad name', () => {
  // Defence in depth. The controller 404s first, but the model is what concatenates
  // into the SQL identifier, so it must not depend on its caller having checked.
  it('errors instead of querying lewisnull', async () => {
    const err = await new Promise((resolve) => {
      Team.getLewis({ season: 'null' }, (e) => resolve(e));
    });

    assert.ok(err instanceof Error, 'expected an Error for season "null"');
    assert.match(err.message, /Invalid season name/);
  });
});
