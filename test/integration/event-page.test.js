// /event/:id: the preview, the forecast, the metadata, and who sees the scorecard link.
// Models stubbed; the copy itself is tested in fixture-preview.test.js.
const { describe, it, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { app, setModel, clearModels } = require('../helpers/app');
const Fixture = require('../../models/fixture');
const TeamStrength = require('../../models/teamStrength');
const League = require('../../models/league');

afterEach(() => { clearModels(); mock.restoreAll(); });

function asRole(role, club, fn) {
  return async () => {
    const saved = { DEV_MODE: process.env.DEV_MODE, DEV_ROLE: process.env.DEV_ROLE, DEV_CLUB: process.env.DEV_CLUB };
    if (role === undefined) delete process.env.DEV_MODE;
    else { process.env.DEV_MODE = 'true'; process.env.DEV_ROLE = role; }
    if (club) process.env.DEV_CLUB = club; else delete process.env.DEV_CLUB;
    try { await fn(); } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  };
}

const ROW = {
  id: 6171, date: new Date('2026-11-24T00:00:00Z'), homeTeam: 'Hyde A', awayTeam: 'Medlock A',
  homeTeamId: 11, awayTeamId: 22, lewisRound: null,
  homeClub: 'Hyde', awayClub: 'Medlock', divisionName: 'Division 1',
  startTime: '20:00:00', endTime: '22:00:00',
  venueName: 'Hyde Leisure Centre', venueAddress: 'Walker Lane, Hyde, SK14 5PL', venueLink: 'https://maps.example.test',
  Lat: 53.45, Lng: -2.08, placeId: null,
  status: 'outstanding', homeScore: null, awayScore: null,
  teamCaptain: 'Pat One', matchSecretary: 'Sam Two',
};
const FORECAST = {
  ran_at: new Date('2026-11-23T03:30:00Z'),
  fixture: { pHome: 0.71, pDraw: 0.08, pAway: 0.21, expected: 10.9, likely: { home: 11, away: 7 }, edges: { mens: 5.4, ladies: 0.9, mixed: 4.6 } },
  home: { teams: 9, men: 2, ladies: 6, overall: 3, fixtures: 4, settled: 0.83, last: 6, projection: { teams: 9, expected: 2.4, pWinner: 0.3, pUp: 0, pDown: 0 } },
  away: { teams: 9, men: 7, ladies: 3, overall: 6, fixtures: 4, settled: 0.5, last: 3, projection: null },
};

function stub({ row = ROW, forecast = FORECAST, context = null } = {}) {
  setModel('Fixture', 'getFixtureEventById', (id, cb) => cb(null, [row]));
  mock.method(Fixture, 'getMatchContext', async () => context || { season: '20242025', form: [], meetings: [], games: [] });
  mock.method(TeamStrength, 'forecastFor', async () => forecast);
  mock.method(League, 'getRunIn', async () => [
    { id: 22, divisionName: 'Division 1', gamesWon: 40, gamesLost: 32, played: 4 },
    { id: 11, divisionName: 'Division 1', gamesWon: 38, gamesLost: 34, played: 4 },
  ]);
}

const URL = '/event/6171/24112026-Hyde%20A-Medlock%20A';
const ldBlocks = html => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(m => JSON.parse(m[1]));

describe('an upcoming fixture', () => {
  it('leads its title and description with the match, and shows the forecast', async () => {
    stub();
    const res = await request(app).get(URL);
    assert.strictEqual(res.status, 200);
    assert.match(res.text, /<title>Hyde A vs Medlock A – Division 1 preview &amp; prediction, 24 Nov 2026 \| Tameside Badminton League<\/title>/);
    assert.match(res.text, /<meta name="description" content="Hyde A vs Medlock A, Division 1 badminton, Tuesday 24 November 2026\. Preview and prediction: Hyde A 71% favourites\.">/);
    assert.match(res.text, /id="ev-prediction"/);
    assert.match(res.text, /Most likely score: <strong>11–7<\/strong>/);
    assert.match(res.text, /2nd in the table/);
    assert.doesNotMatch(res.text, /undefined|NaN/);
  });

  it('emits SportsEvent and breadcrumbs from code, whatever the title says', async () => {
    stub();
    const blocks = ldBlocks((await request(app).get(URL)).text);
    const ev = blocks.find(b => b['@type'] === 'SportsEvent');
    assert.ok(ev, 'a SportsEvent block');
    assert.strictEqual(ev.homeTeam.name, 'Hyde A');
    assert.match(ev.description, /71% favourites/);
    assert.ok(blocks.find(b => b['@type'] === 'BreadcrumbList'));
  });

  it('renders without a forecast or context, which may fail on their own', async () => {
    stub({ forecast: null });
    Fixture.getMatchContext.mock.mockImplementation(async () => { throw new Error('pool timeout'); });
    const res = await request(app).get(URL);
    assert.strictEqual(res.status, 200);
    assert.doesNotMatch(res.text, /id="ev-prediction"/);
    assert.match(res.text, /Hyde A host Medlock A in Division 1/);
  });

  it('a Lewis Shield tie asks for no forecast and no table', async () => {
    stub({ row: { ...ROW, lewisRound: 2 } });
    const res = await request(app).get(URL);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(TeamStrength.forecastFor.mock.callCount(), 0);
    assert.strictEqual(League.getRunIn.mock.callCount(), 0);
    assert.match(res.text, /Lewis Shield/);
  });
});

describe('a played fixture', () => {
  const DONE = { ...ROW, status: 'complete', homeScore: 12, awayScore: 6 };
  const games = [...Array(8).fill({ gameType: 'FirstMens', homeScore: 21, awayScore: 12 }),
    ...Array(2).fill({ gameType: 'FirstLadies', homeScore: 12, awayScore: 21 }),
    ...Array(8).fill({ gameType: 'FirstMixed', homeScore: 21, awayScore: 19 })];

  it('reports it, uses the result card as og:image, and names no player', async () => {
    stub({ row: DONE, context: { season: '20242025', form: [], meetings: [], games } });
    const res = await request(app).get(URL);
    assert.strictEqual(res.status, 200);
    assert.match(res.text, /Match report/);
    assert.match(res.text, /<meta property="og:image" content="https:\/\/[^"]+\/resultImage\/Hyde%20A\/Medlock%20A\/12\/6\/Division%201\.jpg">/);
    assert.doesNotMatch(res.text, /id="ev-prediction"/);
  });

  it('links the scorecard only for a superadmin or someone from either club', async () => {
    const link = async () => {
      stub({ row: DONE });
      const res = await request(app).get(URL);
      return { has: /\/scorecard\/fixture\/6171/.test(res.text), cache: res.headers['cache-control'] };
    };
    let r;
    await asRole(undefined, null, async () => { r = await link(); assert.strictEqual(r.has, false); })();
    await asRole('admin', 'Mellor', async () => { r = await link(); assert.strictEqual(r.has, false); })();
    await asRole('admin', 'Medlock', async () => { r = await link(); assert.strictEqual(r.has, true); assert.match(r.cache, /private, no-store/); })();
    await asRole('superadmin', null, async () => { r = await link(); assert.strictEqual(r.has, true); })();
  });
});
