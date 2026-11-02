// The two league-table pages read the keys the model returns. Ported in spirit from
// Stockport's REARCH-03 part C test (league-site __tests__/integration/league-tables.test.js).
//
// The keys were `pointsFor` / `pointsAgainst`, which hold GAMES won and lost, not league
// points. A rename that misses one side does not fail: EJS prints `undefined` as an empty
// string, so the page renders 200 with a blank column. Hence asserting the cells.
//
// There is no local database, so the model half is a source check: the outermost SELECT of
// each query must hand back `gamesWon` / `gamesLost`.

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const request = require('supertest');

const { app, setModel, clearModels } = require('../helpers/app');

afterEach(clearModels);

// Distinct numbers, so a swapped won/lost column shows.
const ROW = { name: 'Hyde A', played: 6, gamesWon: 61, gamesLost: 47 };

// The cells of the row naming `team`, whitespace collapsed.
function cellsFor(html, team) {
  const rows = html.split(/<tr[\s>]/).filter(r => r.includes(team));
  assert.ok(rows.length, `a row for ${team}`);
  return [...rows[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => m[1].replace(/<[^>]+>/g, '').trim());
}

describe('/tables/:division', () => {
  test('prints played, games won, games lost', async () => {
    setModel('League', 'getLeagueTable', (division, season, done) => done(null, [ROW]));
    const res = await request(app).get('/tables/Division-1');
    assert.strictEqual(res.status, 200);
    const cells = cellsFor(res.text, 'Hyde A');
    for (const v of ['6', '61', '47']) assert.ok(cells.includes(v), `${v} in ${JSON.stringify(cells)}`);
  });
});

describe('/tables/All', () => {
  test('prints played, games won, games lost', async () => {
    setModel('League', 'getAllLeagueTables', (season, done) =>
      done(null, [{ divisionName: 'Division 1', division: 1, divRank: 1, ...ROW }]));
    const res = await request(app).get('/tables/All');
    assert.strictEqual(res.status, 200);
    const cells = cellsFor(res.text, 'Hyde A');
    for (const v of ['6', '61', '47']) assert.ok(cells.includes(v), `${v} in ${JSON.stringify(cells)}`);
  });
});

describe('models/league.js', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'models', 'league.js'), 'utf8');

  for (const fn of ['getLeagueTable', 'getAllLeagueTables']) {
    test(`${fn} returns gamesWon and gamesLost`, () => {
      const start = src.indexOf(`exports.${fn} =`);
      const end = src.indexOf('exports.', start + 1);
      const body = src.slice(start, end === -1 ? undefined : end);
      assert.match(body, /as "gamesWon"/i);
      assert.match(body, /as "gamesLost"/i);
    });
  }
});
