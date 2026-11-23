// Line-ups and player data behind a login (Nov 2026), after Stockport's lockdown of the
// same routes (league-site 9949f8c, 1ecec18, c8db046, ca7ee51, 6801d52, efbac93).
//
// Every one of these was public: a scorecard's names by fixture id, every line-up in
// order, a player's game history, ELO series and name search, and GET /player/:id, which
// answered SELECT * FROM player (site role and encrypted contact columns included).
//
// The rule is the stats pages' one: a superadmin sees every club, a login linked to a
// player at a club sees that club, nobody else anything — and that includes the Stockport
// accounts the shared Auth0 tenant lets log in here. A scorecard belongs to both clubs.
//
// Asserts what reached the model, not only the status: a gate applied after the read
// would pass a status-only test.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { app, setModel, clearModels } = require('../helpers/app');

afterEach(() => clearModels());

function asUser(env, fn) {
  return async () => {
    const keys = ['DEV_MODE', 'DEV_ROLE', 'DEV_CLUB'];
    const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
    for (const k of keys) delete process.env[k];
    Object.assign(process.env, env);
    try { await fn(); } finally {
      for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
  };
}

const STRANGER = {};
const UNLINKED = { DEV_MODE: 'true', DEV_ROLE: 'none' };            // e.g. a Stockport login
const HYDE = { DEV_MODE: 'true', DEV_ROLE: 'none', DEV_CLUB: 'Hyde' };
const MEDLOCK = { DEV_MODE: 'true', DEV_ROLE: 'none', DEV_CLUB: 'Medlock' };
const AEROSPACE = { DEV_MODE: 'true', DEV_ROLE: 'none', DEV_CLUB: 'Aerospace' };
const HYDE_ADMIN = { DEV_MODE: 'true', DEV_ROLE: 'admin', DEV_CLUB: 'Hyde' };
const SUPERADMIN = { DEV_MODE: 'true', DEV_ROLE: 'superadmin' };

describe('deleted routes', () => {
  for (const path of ['/player/7', '/team/7', '/tables-social']) {
    it(`GET ${path} is gone`, asUser(STRANGER, async () => {
      const res = await request(app).get(path);
      assert.strictEqual(res.status, 404);
    }));
  }

  it('GET /clubs answers id, name and venue only', asUser(STRANGER, async () => {
    setModel('Club', 'getAll', (cb) => cb(null, [{ id: 1, name: 'Hyde', venue: 3, clubSec: 41, matchSec: 41, website: 'x' }]));
    const res = await request(app).get('/clubs');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, [{ id: 1, name: 'Hyde', venue: 3 }]);
  }));
});

describe('GET /scorecard/fixture/:id', () => {
  const SUMMARY = { id: 6027, date: new Date(2026, 2, 17), status: 'complete',
    homeTeam: 'Hyde A', awayTeam: 'Medlock A', homeClub: 'Hyde', awayClub: 'Medlock', homeScore: 9, awayScore: 9 };
  const GAME = { date: SUMMARY.date, homeTeam: 'Hyde A', awayTeam: 'Medlock A',
    homePlayer1: 'Pat One', homePlayer2: 'Sam Two', awayPlayer1: 'Alex Three', awayPlayer2: 'Jo Four',
    homeScore: 21, awayScore: 15, totalHomeScore: 9, totalAwayScore: 9 };

  function stub() {
    const reads = [];
    setModel('Fixture', 'getFixtureSummaryById', (id, cb) => cb(null, [SUMMARY]));
    setModel('Fixture', 'getScorecardDataById', (id, cb) => { reads.push(id); cb(null, [GAME]); });
    return reads;
  }

  it('a stranger is sent to log in', asUser(STRANGER, async () => {
    const reads = stub();
    const res = await request(app).get('/scorecard/fixture/6027');
    assert.strictEqual(res.status, 302);
    assert.match(res.headers.location, /\/login/);
    assert.deepStrictEqual(reads, []);
  }));

  for (const [who, env] of [['an unlinked login', UNLINKED], ['a third club', AEROSPACE]]) {
    it(`${who} is refused before any player is read`, asUser(env, async () => {
      const reads = stub();
      const res = await request(app).get('/scorecard/fixture/6027');
      assert.strictEqual(res.status, 403);
      assert.deepStrictEqual(reads, []);
      assert.doesNotMatch(res.text, /Pat One/);
    }));
  }

  for (const [who, env] of [['the home club', HYDE], ['the away club', MEDLOCK], ['the home club\'s admin', HYDE_ADMIN], ['a superadmin', SUPERADMIN]]) {
    it(`${who} sees it, privately`, asUser(env, async () => {
      stub();
      const res = await request(app).get('/scorecard/fixture/6027');
      assert.strictEqual(res.status, 200);
      assert.match(res.text, /Pat One/);
      assert.match(res.headers['cache-control'], /private/);
      assert.match(res.headers['cache-control'], /no-store/);
    }));
  }
});

describe('/fixture-players', () => {
  function spy() {
    const seen = [];
    setModel('Fixture', 'getMatchPlayerOrderDetails', (searchObj, done) => { seen.push(searchObj.club); done(null, []); });
    return seen;
  }

  it('a stranger is sent to log in', asUser(STRANGER, async () => {
    const seen = spy();
    const res = await request(app).get('/fixture-players');
    assert.strictEqual(res.status, 302);
    assert.deepStrictEqual(seen, []);
  }));

  it('an unlinked login is refused', asUser(UNLINKED, async () => {
    const seen = spy();
    const res = await request(app).get('/fixture-players');
    assert.strictEqual(res.status, 403);
    assert.deepStrictEqual(seen, []);
  }));

  it('a linked login sees its own club, whatever the URL asks for', asUser(HYDE, async () => {
    const seen = spy();
    await request(app).get('/fixture-players');
    await request(app).get('/fixture-players/club-Aerospace');
    await request(app).get('/fixture-players/club-%25');
    assert.deepStrictEqual(seen, ['Hyde', 'Hyde', 'Hyde']);
  }));

  it('a superadmin sees every club', asUser(SUPERADMIN, async () => {
    const seen = spy();
    const res = await request(app).get('/fixture-players');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(seen, [undefined]);
  }));
});

describe('GET /playerStats/:id/:fullName', () => {
  function stub(club) {
    const reads = [];
    setModel('Player', 'getClubNameById', async () => club);
    setModel('Player', 'getPlayerGameData', (id, done) => { reads.push(id); done(null, []); });
    return reads;
  }

  it('a stranger is sent to log in', asUser(STRANGER, async () => {
    const reads = stub('Hyde');
    const res = await request(app).get('/playerStats/7/Dave-Lee');
    assert.strictEqual(res.status, 302);
    assert.deepStrictEqual(reads, []);
  }));

  for (const [who, env] of [['an unlinked login', UNLINKED], ['another club', AEROSPACE]]) {
    it(`${who} is refused before the games are read`, asUser(env, async () => {
      const reads = stub('Hyde');
      const res = await request(app).get('/playerStats/7/Dave-Lee');
      assert.strictEqual(res.status, 403);
      assert.deepStrictEqual(reads, []);
    }));
  }

  for (const [who, env] of [['the same club', HYDE], ['a superadmin', SUPERADMIN]]) {
    it(`${who} sees them`, asUser(env, async () => {
      const reads = stub('Hyde');
      const res = await request(app).get('/playerStats/7/Dave-Lee');
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(reads, ['7']);
    }));
  }
});

describe('ELO APIs', () => {
  it('a stranger gets a 401, not a login redirect', asUser(STRANGER, async () => {
    for (const path of ['/api/player-elo?players=1,2', '/api/players/search?q=Lee', '/eligiblePlayers/3/Male']) {
      const res = await request(app).get(path);
      assert.strictEqual(res.status, 401, path);
    }
  }));

  it('an unlinked login gets nothing', asUser(UNLINKED, async () => {
    setModel('Player', 'getPlayerEloTimeSeries', async () => { throw new Error('must not be reached'); });
    setModel('Player', 'searchPlayers', async () => { throw new Error('must not be reached'); });
    assert.strictEqual((await request(app).get('/api/player-elo?players=1,2')).status, 403);
    assert.strictEqual((await request(app).get('/api/players/search?q=Lee')).status, 403);
  }));

  it('a linked login charts and searches its own club only', asUser(HYDE, async () => {
    const asked = {};
    setModel('Player', 'filterIdsByClub', async (ids, club) => { asked.filter = { ids, club }; return [2]; });
    setModel('Player', 'getPlayerEloTimeSeries', async (ids) => { asked.series = ids; return []; });
    setModel('Player', 'searchPlayers', async (q, filters) => { asked.search = filters.club; return []; });
    await request(app).get('/api/player-elo?players=1,2');
    await request(app).get('/api/players/search?q=Lee&club=Aerospace');
    assert.deepStrictEqual(asked.filter, { ids: [1, 2], club: 'Hyde' });
    assert.deepStrictEqual(asked.series, [2]);
    assert.strictEqual(asked.search, 'Hyde');
  }));

  it('a superadmin is not narrowed', asUser(SUPERADMIN, async () => {
    const asked = {};
    setModel('Player', 'filterIdsByClub', async () => { throw new Error('must not be reached'); });
    setModel('Player', 'getPlayerEloTimeSeries', async (ids) => { asked.series = ids; return []; });
    setModel('Player', 'searchPlayers', async (q, filters) => { asked.search = filters.club; return []; });
    await request(app).get('/api/player-elo?players=1,2');
    await request(app).get('/api/players/search?q=Lee&club=Aerospace');
    assert.deepStrictEqual(asked.series, [1, 2]);
    assert.strictEqual(asked.search, 'Aerospace');
  }));

  it('/eligiblePlayers answers any login: a captain needs the other side too', asUser(UNLINKED, async () => {
    setModel('Player', 'findElgiblePlayersFromTeamId', (id, g, done) => done(null, [{ id: 9 }]));
    const res = await request(app).get('/eligiblePlayers/3/Male');
    assert.strictEqual(res.status, 200);
  }));
});

// The captains' results grid links each played match to its scorecard. Since the
// scorecard is either club's only, the link is drawn only on the rows this viewer can
// open — not a link to a 403 on every other club's match.
describe('the results grid\'s Details link', () => {
  const ROWS = [
    { id: 101, date: new Date(2026, 9, 6), homeTeam: 'Hyde A', awayTeam: 'Medlock A',
      homeClub: 'Hyde', awayClub: 'Medlock', status: 'complete', homeScore: 10, awayScore: 8 },
    { id: 102, date: new Date(2026, 9, 7), homeTeam: 'Aerospace A', awayTeam: 'Medlock A',
      homeClub: 'Aerospace', awayClub: 'Medlock', status: 'complete', homeScore: 12, awayScore: 6 },
  ];

  function links(text) {
    return [...text.matchAll(/\/scorecard\/fixture\/(\d+)/g)].map(m => Number(m[1]));
  }

  it('a club admin sees it only on their own club\'s matches', asUser(HYDE_ADMIN, async () => {
    setModel('Fixture', 'getFixtureDetails', (obj, cb) => cb(null, ROWS));
    const res = await request(app).get('/admin/results/All');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(links(res.text), [101]);
  }));

  it('a superadmin sees it on every match', asUser(SUPERADMIN, async () => {
    setModel('Fixture', 'getFixtureDetails', (obj, cb) => cb(null, ROWS));
    const res = await request(app).get('/admin/results/All');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(links(res.text), [101, 102]);
  }));
});
