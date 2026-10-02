// Two places that pinned a season name and went stale at the rollover, fixed 2026-10-02.
//
//   views/tables.ejs           printed Disley B's 2019-20 penalty on the CURRENT Division 3
//                              table, because the current table carries no :season and the
//                              guard also fired for an undefined season.
//   Player.getPlayedUpCounts   queried season '20252026' literally.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const request = require('supertest');

const { app, setModel, clearModels } = require('../helpers/app');

afterEach(() => clearModels());

describe('Division 3 penalty note', () => {
  const stubTable = () => setModel('League', 'getLeagueTable', (division, season, done) => done(null, []));

  it('is absent from the current table', async () => {
    stubTable();
    const res = await request(app).get('/tables/Division-3');
    assert.strictEqual(res.status, 200);
    assert.doesNotMatch(res.text, /Disley B: fielding ineligible/);
  });

  it('still shows on the 2019-20 table', async () => {
    stubTable();
    const res = await request(app).get('/tables/Division-3/20192020');
    assert.strictEqual(res.status, 200);
    assert.match(res.text, /Disley B: fielding ineligible/);
  });
});

describe('getPlayedUpCounts', () => {
  it('reads the season from the season model, not a literal', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../models/players.js'), 'utf8');
    const start = src.indexOf('exports.getPlayedUpCounts');
    const body = src.slice(start, src.indexOf('\nexports.', start + 1));
    assert.doesNotMatch(body.replace(/^\s*\/\/.*$/gm, ''), /'20\d{6}'/);
    assert.match(body, /seasonModel\.current\(\)/);
  });
});
