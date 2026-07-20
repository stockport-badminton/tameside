// Regression coverage for the email-scorecard entry wizard (views/email-scorecard.ejs
// + controllers/fixtureController.js), built specifically to de-risk the planned
// view-level de-dupe (merging the fresh-form and error-recovery modals into one).
// These lock in the exact bug classes fixed in the 2026-07-20 review: wrong-ordinal
// pre-selection, lost score values on error re-render, the crash on a malformed/empty
// POST, and the duplicate "Third Mixed" validator labels.
//
// Model reads (Division/Team/Player) are mocked via the existing override registry
// (test/helpers/app.js) — no DB needed for those. The one full-submission test hits
// the REAL dev DB (matching how this project already verifies DB-writing changes,
// per CLAUDE.md/project memory) and cleans up the row it creates; Mailjet is stubbed
// so no real email goes out to the results secretary.
// Must run before requiring test/helpers/app: that harness fakes PGPASSWORD
// (etc.) for every OTHER test file, which never needs the real DB. This file's
// happy-path test deliberately does, so load the real .env first — dotenv
// never overwrites an already-set var, so loading it first here wins.
require('dotenv').config();

const { describe, it, before, after, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { app, setModel, clearModels } = require('../helpers/app');
const fixtureController = require('../../controllers/fixtureController');

afterEach(() => { clearModels(); mock.restoreAll(); });

// Selectable rows shaped exactly like Division/Team.getAllAndSelectedById and
// Player.getEligiblePlayersAndSelectedById return them.
const DIVISION_ROWS = [{ id: 8, name: 'Division 1', selected: true }];
const HOME_TEAM_ROWS = [{ id: 55, name: 'Hyde A', selected: true }];
const AWAY_TEAM_ROWS = [{ id: 56, name: 'Hyde B', selected: true }];
const HOME_MEN_ROWS = [
  { id: 101, first_name: 'Alice', family_name: 'A', first: 1, second: 0, third: 0, fourth: 0 },
  { id: 102, first_name: 'Bob', family_name: 'B', first: 0, second: 1, third: 0, fourth: 0 },
  { id: 103, first_name: 'Carl', family_name: 'C', first: 0, second: 0, third: 1, fourth: 0 },
  { id: 104, first_name: 'Dave', family_name: 'D', first: 0, second: 0, third: 0, fourth: 1 },
];
const HOME_LADIES_ROWS = [
  { id: 201, first_name: 'Eve', family_name: 'E', first: 1, second: 0, third: 0, fourth: 0 },
  { id: 202, first_name: 'Fay', family_name: 'F', first: 0, second: 1, third: 0, fourth: 0 },
];
const AWAY_MEN_ROWS = [
  { id: 301, first_name: 'Gus', family_name: 'G', first: 1, second: 0, third: 0, fourth: 0 },
  { id: 304, first_name: 'Jed', family_name: 'J', first: 0, second: 0, third: 0, fourth: 1 },
];
const AWAY_LADIES_ROWS = [
  { id: 401, first_name: 'Kim', family_name: 'K', first: 1, second: 0, third: 0, fourth: 0 },
  { id: 402, first_name: 'Lou', family_name: 'L', first: 0, second: 1, third: 0, fourth: 0 },
];

function mockScorecardModels() {
  setModel('Division', 'getAllAndSelectedById', (leagueId, selectedId, cb) => cb(null, DIVISION_ROWS));
  setModel('Team', 'getAllAndSelectedById', (teamId, divisionId, cb) => {
    cb(null, String(teamId) === '55' || teamId === 55 ? HOME_TEAM_ROWS : AWAY_TEAM_ROWS);
  });
  setModel('Player', 'getEligiblePlayersAndSelectedById', (first, second, teamId, gender, cb) => {
    const isHome = String(teamId) === '55' || teamId === 55;
    if (gender === 'Male') return cb(null, isHome ? HOME_MEN_ROWS : AWAY_MEN_ROWS);
    return cb(null, isHome ? HOME_LADIES_ROWS : AWAY_LADIES_ROWS);
  });
}

// A fully-formed, otherwise-valid body except for one deliberately bad score,
// so every request in this file lands on the error-recovery render path.
function baseScorecardBody(overrides = {}) {
  const body = {
    division: '8', date: '2026-08-01', homeTeam: '55', awayTeam: '56',
    homeMan1: '101', homeMan2: '102', homeMan3: '103', homeMan4: '104',
    homeLady1: '201', homeLady2: '202',
    awayMan1: '301', awayMan2: '302', awayMan3: '303', awayMan4: '304',
    awayLady1: '401', awayLady2: '402',
    FirstMixedhomeMan1: '101', SecondMixedhomeMan2: '102', ThirdMixedhomeMan3: '103', FourthMixedhomeMan4: '104',
    FirstMixedawayMan1: '301', SecondMixedawayMan2: '302', ThirdMixedawayMan3: '303', FourthMixedawayMan4: '304',
    FirstMixedhomeLady1: '201', SecondMixedhomeLady2: '202', ThirdMixedhomeLady1: '201', FourthMixedhomeLady2: '202',
    FirstMixedawayLady1: '401', SecondMixedawayLady2: '402', ThirdMixedawayLady1: '401', FourthMixedawayLady2: '402',
  };
  for (let g = 1; g <= 18; g++) {
    body[`Game${g}homeScore`] = '21';
    body[`Game${g}awayScore`] = '15';
  }
  body.Game1awayScore = '999'; // forces a validation error -> error-recovery render
  return { ...body, ...overrides };
}

function selectedOptionText(html, selectId) {
  const idx = html.indexOf(`id="${selectId}"`);
  if (idx === -1) return null;
  const close = html.indexOf('</select>', idx);
  const chunk = html.slice(idx, close);
  const match = /<option value="\d+"\s*selected>([^<]*)</.exec(chunk);
  return match ? match[1].trim() : null;
}

describe('POST /email-scorecard — error-recovery render (regression suite)', () => {
  before(() => { process.env.DEV_MODE = 'true'; });
  after(() => { delete process.env.DEV_MODE; });

  it('unauthenticated -> 302 /login (auth gate fixed 2026-07-20)', async () => {
    delete process.env.DEV_MODE;
    const res = await request(app).post('/email-scorecard').type('form').send({});
    assert.strictEqual(res.status, 302);
    assert.match(res.headers.location, /\/login/);
    process.env.DEV_MODE = 'true';
  });

  it('completely empty body -> 200 with validation messages, no crash (regression: undefined-division DB crash)', async () => {
    const res = await request(app).post('/email-scorecard').type('form').send({});
    assert.strictEqual(res.status, 200);
    assert.match(res.text, /Please choose a division\./);
    assert.match(res.text, /Please choose a valid date\./);
    assert.match(res.text, /Please choose a home team\./);
    assert.match(res.text, /Please choose an away team\./);
  });

  it('homeTeam === awayTeam -> rejected', async () => {
    mockScorecardModels();
    const res = await request(app).post('/email-scorecard').type('form').send(baseScorecardBody({ awayTeam: '55' }));
    assert.strictEqual(res.status, 200);
    assert.match(res.text, /Home team and away team can&#39;t be the same\./);
  });

  it('renders all 5 ordinal pre-selections correctly (regression: 2026-07-20 review)', async () => {
    mockScorecardModels();
    const res = await request(app).post('/email-scorecard').type('form').send(baseScorecardBody());
    assert.strictEqual(res.status, 200);
    assert.strictEqual(selectedOptionText(res.text, 'homeMan4'), 'Dave D');
    assert.strictEqual(selectedOptionText(res.text, 'homeLady1'), 'Eve E');
    assert.strictEqual(selectedOptionText(res.text, 'homeLady2'), 'Fay F');
    assert.strictEqual(selectedOptionText(res.text, 'awayLady1'), 'Kim K');
    assert.strictEqual(selectedOptionText(res.text, 'awayLady2'), 'Lou L');
  });

  it('preserves all 18 submitted game scores as value= (regression: placeholder= wiped scores)', async () => {
    mockScorecardModels();
    const res = await request(app).post('/email-scorecard').type('form').send(baseScorecardBody());
    assert.strictEqual(res.status, 200);
    for (let g = 2; g <= 18; g++) {
      assert.match(res.text, new RegExp(`id="Game${g}homeScore"[^>]*value="21"`));
      assert.match(res.text, new RegExp(`id="Game${g}awayScore"[^>]*value="15"`));
    }
    assert.doesNotMatch(res.text, /Game\d+(home|away)Score" name="Game\d+(home|away)Score" placeholder="\d/);
  });

  it('validation error message text: "must be between 0 and 30"', async () => {
    mockScorecardModels();
    const res = await request(app).post('/email-scorecard').type('form').send(baseScorecardBody());
    assert.match(res.text, /must be between 0 and 30/);
  });

  it('Fourth Mixed Home/Away Man duplicate-check uses "Fourth" in its message, not "Third" (regression: copy-paste label bug)', async () => {
    mockScorecardModels();
    const res = await request(app).post('/email-scorecard').type('form').send(
      baseScorecardBody({ FourthMixedhomeMan4: '101', FourthMixedawayMan4: '301' }) // dup vs First
    );
    assert.strictEqual(res.status, 200);
    assert.match(res.text, /Fourth Mixed Home Man: can&#39;t use the same player more than once/);
    assert.match(res.text, /Fourth Mixed Away Man: can&#39;t use the same player more than once/);
  });

  it('the error-form modal uses Bootstrap 5 close-button markup (regression: BS3/4 mismatch)', async () => {
    mockScorecardModels();
    const res = await request(app).post('/email-scorecard').type('form').send(baseScorecardBody());
    assert.doesNotMatch(res.text, /class="close" data-dismiss="modal"/);
  });

  it('step-13/14 tab titles carry the correct data-step (regression: both said data-step="12")', async () => {
    mockScorecardModels();
    const res = await request(app).post('/email-scorecard').type('form').send(baseScorecardBody());
    assert.match(res.text, /class="modal-title step-13" data-step="13"/);
    assert.match(res.text, /class="modal-title step-14" data-step="14"/);
  });

  it('the dead "Some Scorecard Data" branch never renders (regression: unreachable hasScorecardData block removed)', async () => {
    mockScorecardModels();
    const res = await request(app).post('/email-scorecard').type('form').send(baseScorecardBody());
    assert.doesNotMatch(res.text, /Some Scorecard Data/);
  });
});

describe('POST /email-scorecard — full valid submission (real DB, stubbed Mailjet)', () => {
  before(() => { process.env.DEV_MODE = 'true'; });
  after(() => { delete process.env.DEV_MODE; });

  it('creates a real scorecardstore row, does not email, then is cleaned up', async () => {
    const postStub = mock.method(
      fixtureController._mailjetClientForTesting,
      'post',
      () => ({ request: () => Promise.resolve({ body: { Messages: [{ Status: 'success' }] } }) })
    );

    const body = {
      division: '8', date: '2026-08-01', homeTeam: '55', awayTeam: '56',
      homeMan1: '2347', homeMan2: '2417', homeMan3: '2431', homeMan4: '71',
      homeLady1: '2164', homeLady2: '1990',
      awayMan1: '2370', awayMan2: '2165', awayMan3: '2251', awayMan4: '419',
      awayLady1: '2262', awayLady2: '2301',
      FirstMixedhomeMan1: '2347', SecondMixedhomeMan2: '2417', ThirdMixedhomeMan3: '2431', FourthMixedhomeMan4: '71',
      FirstMixedawayMan1: '2370', SecondMixedawayMan2: '2165', ThirdMixedawayMan3: '2251', FourthMixedawayMan4: '419',
      FirstMixedhomeLady1: '2164', SecondMixedhomeLady2: '1990', ThirdMixedhomeLady1: '2164', FourthMixedhomeLady2: '1990',
      FirstMixedawayLady1: '2262', SecondMixedawayLady2: '2301', ThirdMixedawayLady1: '2262', FourthMixedawayLady2: '2301',
      'scoresheet-url': 'https://badmintontemp.s3.eu-west-1.amazonaws.com/tameside-test-e2e.jpg',
    };
    for (let g = 1; g <= 18; g++) {
      body[`Game${g}homeScore`] = '21';
      body[`Game${g}awayScore`] = '15';
    }

    const res = await request(app).post('/email-scorecard').type('form').send(body);

    let createdId;
    try {
      assert.strictEqual(res.status, 200);
      assert.match(res.text, /Thanks for entering your result/);
      assert.strictEqual(postStub.mock.callCount(), 1); // stubbed, not a real Mailjet call

      const { sql } = require('../../utils/db_connect');
      const rows = await sql`select id from scorecardstore where "homeTeam" = ${'55'} and "awayTeam" = ${'56'} and date = ${'2026-08-01'} order by id desc limit 1`;
      assert.strictEqual(rows.length, 1, 'expected the row this test just created');
      createdId = rows[0].id;
    } finally {
      if (createdId) {
        const { sql } = require('../../utils/db_connect');
        await sql`delete from scorecardstore where id = ${createdId}`;
      }
    }
  });
});
