// Regression coverage for the two public fixture pages that were the top two
// unresolved Sentry issues on the tameside-node project (read 2026-07-29).
//
// Both had the same shape: a model whose INNER JOINs can legitimately return zero rows,
// and a caller that read [0] straight off the empty array. Because the throw happened
// inside a model callback rather than the request chain, Express's error handler never
// saw it. These render the real EJS, so they assert on the HTML.
//
// TAMESIDE-NODE-2 (308 events, still firing): GET /event/:id -> row[0].homeTeam.
// TAMESIDE-NODE-3 (2 events, but 366 of 652 fixtures affected): GET /scorecard/fixture/:id
//   -> result[0].date in the view.
//
// Both handlers also used to `res.send(err)` on failure, answering 200 with a serialised
// error object — so a genuine fault looked like a success to the browser and to Sentry.

const { describe, it, afterEach, beforeEach, mock } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { app, setModel, clearModels } = require('../helpers/app');

afterEach(() => { clearModels(); mock.restoreAll(); });

// /scorecard/fixture/:id needs a login since Nov 2026 (superadmin or either club); these
// tests are about rendering, so they run as a superadmin. The gating has its own file,
// line-up-gating.test.js.
function asSuperadmin(fn) {
  return async () => {
    const saved = { DEV_MODE: process.env.DEV_MODE, DEV_ROLE: process.env.DEV_ROLE };
    process.env.DEV_MODE = 'true'; process.env.DEV_ROLE = 'superadmin';
    try { await fn(); } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  };
}

const SUMMARY_6027 = { id: 6027, date: new Date(2026, 2, 17), status: 'complete',
  homeTeam: 'Hyde A', awayTeam: 'Medlock A', homeClub: 'Hyde', awayClub: 'Medlock',
  homeScore: 9, awayScore: 9 };

// Two game rows shaped as getScorecardDataById returns them: every row repeats the
// fixture-level columns (date, team names, totalHome/AwayScore).
const GAME_ROWS = [
  { date: new Date(2026, 2, 17), homeTeam: 'Hyde A', awayTeam: 'Medlock A',
    homePlayer1: 'Pat One', homePlayer2: 'Sam Two',
    awayPlayer1: 'Alex Three', awayPlayer2: 'Jo Four',
    homeScore: 21, awayScore: 15, totalHomeScore: 9, totalAwayScore: 9 },
  { date: new Date(2026, 2, 17), homeTeam: 'Hyde A', awayTeam: 'Medlock A',
    homePlayer1: 'Pat One', homePlayer2: 'Sam Two',
    awayPlayer1: 'Alex Three', awayPlayer2: 'Jo Four',
    homeScore: 21, awayScore: 18, totalHomeScore: 9, totalAwayScore: 9 },
];

describe('GET /scorecard/fixture/:id', () => {
  it('renders the summary and an explanation when no games were recorded', asSuperadmin(async () => {
    // Fixture 5704 in production: a conceded 2025-26 match, 18-0, zero game rows. This
    // is why the fix can't just be "old archive" — conceded fixtures recur every season.
    setModel('Fixture', 'getScorecardDataById', (id, cb) => cb(null, []));
    setModel('Fixture', 'getFixtureSummaryById', (id, cb) => cb(null, [{
      id: 5704, date: new Date(2025, 2, 27), status: 'conceded',
      homeTeam: 'Medlock A', awayTeam: 'College Green A', homeScore: 18, awayScore: 0,
    }]));

    const res = await request(app).get('/scorecard/fixture/5704');

    assert.strictEqual(res.status, 200);
    // The fixture is still described, rather than the page blowing up.
    assert.match(res.text, /27\/03\/2025/);
    assert.match(res.text, /Medlock A/);
    assert.match(res.text, /College Green A/);
    assert.match(res.text, /No game-by-game detail was recorded/);
    // Final score comes off the fixture row. The points total is blank: with no games
    // there is nothing to add up, and 0-0 would read as a real scoreline.
    assert.match(res.text, /<div class="col-1">18-0<\/div>/);
    assert.match(res.text, /<div class="col-2"><\/div>/);
  }));

  it('renders the games and no explanation when detail exists', asSuperadmin(async () => {
    setModel('Fixture', 'getScorecardDataById', (id, cb) => cb(null, GAME_ROWS));
    setModel('Fixture', 'getFixtureSummaryById', (id, cb) => cb(null, [SUMMARY_6027]));

    const res = await request(app).get('/scorecard/fixture/6027');

    assert.strictEqual(res.status, 200);
    assert.match(res.text, /17\/03\/2026/);
    assert.match(res.text, /Pat One/);
    assert.match(res.text, /Alex Three/);
    assert.doesNotMatch(res.text, /No game-by-game detail was recorded/);
    // Points total (21+21 v 15+18) alongside the fixture score.
    assert.match(res.text, /<div class="col-2">42-33<\/div>/);
    assert.match(res.text, /<div class="col-1">9-9<\/div>/);
  }));

  it('404s when the fixture does not exist at all', asSuperadmin(async () => {
    // getScorecardDataById answers zero rows for both "no game detail" and "no such
    // fixture". getFixtureSummaryById LEFT JOINs, so it separates the two.
    setModel('Fixture', 'getScorecardDataById', (id, cb) => cb(null, []));
    setModel('Fixture', 'getFixtureSummaryById', (id, cb) => cb(null, []));

    const res = await request(app).get('/scorecard/fixture/999999');
    assert.strictEqual(res.status, 404);
  }));

  it('surfaces a model failure as an error, not a 200', asSuperadmin(async () => {
    setModel('Fixture', 'getFixtureSummaryById', (id, cb) => cb(null, [SUMMARY_6027]));
    setModel('Fixture', 'getScorecardDataById', (id, cb) => cb(new Error('connection terminated')));

    const res = await request(app).get('/scorecard/fixture/5704');
    assert.ok(res.status >= 500, `expected 5xx, got ${res.status}`);
  }));

  it('surfaces a summary-query failure as an error too', asSuperadmin(async () => {
    setModel('Fixture', 'getScorecardDataById', (id, cb) => cb(null, []));
    setModel('Fixture', 'getFixtureSummaryById', (id, cb) => cb(new Error('connection terminated')));

    const res = await request(app).get('/scorecard/fixture/5704');
    assert.ok(res.status >= 500, `expected 5xx, got ${res.status}`);
  }));
});

describe('GET /event/:id/:date-:homeTeam-:awayTeam', () => {
  // The page's extras (form, forecast, table) must not reach the database in a test.
  // Their behaviour is covered in event-page.test.js.
  beforeEach(() => {
    mock.method(require('../../models/fixture'), 'getMatchContext', async () => ({ season: null, form: [], meetings: [], games: [] }));
    mock.method(require('../../models/teamStrength'), 'forecastFor', async () => null);
    mock.method(require('../../models/league'), 'getRunIn', async () => []);
  });
  const EVENT_ROW = {
    id: 6171, date: new Date(2026, 4, 5),
    homeTeam: 'Hyde A', awayTeam: 'Medlock A',
    homeClub: 'Hyde', awayClub: 'Medlock', clubWebsite: 'https://example.test',
    divisionName: 'Division 1',
    startTime: '20:00:00', endTime: '22:00:00',
    venueName: 'Hyde Leisure Centre', venueAddress: '1 Test Road',
    venueLink: 'https://maps.example.test', Lat: 53.4, Lng: -2.1, placeId: 'abc',
    status: 'outstanding', homeScore: null, awayScore: null,
    teamCaptain: 'Pat One', teamCaptainId: 1,
    matchSecretary: 'Sam Two', matchSecretaryId: 2,
  };

  it('renders the event when the fixture resolves', async () => {
    setModel('Fixture', 'getFixtureEventById', (id, cb) => cb(null, [EVENT_ROW]));

    const res = await request(app).get('/event/6171/05052026-Hyde%20A-Medlock%20A');

    assert.strictEqual(res.status, 200);
    assert.match(res.text, /Hyde A/);
    assert.match(res.text, /Medlock A/);
  });

  it('404s instead of throwing when the query returns no rows', async () => {
    // This is TAMESIDE-NODE-2. Two causes reach it: the fixture has been deleted or
    // rearranged (/event/5841/... — most of the 308 events, kept alive by the
    // SportsEvent ld+json URLs Google has indexed), or it belongs to an archived season
    // whose teams live in suffixed snapshot tables this query's inner joins never reach.
    setModel('Fixture', 'getFixtureEventById', (id, cb) => cb(null, []));

    const res = await request(app).get('/event/5841/07102025-Aerospace%20A-GHAP%20A');
    assert.strictEqual(res.status, 404);
  });

  it('surfaces a model failure as an error, not a 200', async () => {
    setModel('Fixture', 'getFixtureEventById', (id, cb) => cb(new Error('connection terminated')));

    const res = await request(app).get('/event/6171/05052026-Hyde%20A-Medlock%20A');
    assert.ok(res.status >= 500, `expected 5xx, got ${res.status}`);
  });
});
