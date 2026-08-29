// The filter toolbar is shared: views/filters.ejs + views/filtersJs.ejs are included
// by five pages, and middleware/filterState.js re-emits the same grammar server-side
// for the chips and "Clear all". So the routes have to speak that grammar:
//
//   /<page>/<division>/<season>/status-x/gender-x/gameType-x/club-x/team-x
//            positional ^^^^^^^  prefixed ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
//
// /fixture-players did not. It was six hand-written route shapes in an older grammar
// that put the season *after* the club, so `/fixture-players/20252026/club-Hyde` — the
// URL the toolbar actually builds from two filters — matched nothing and 404'd, while
// the page's own Apply button was the thing generating it.
//
// These assert both halves: that what the shared builder emits routes, and that the
// controller pulls the right filters out of it. Legacy shapes are covered too, since
// those URLs are indexed and bookmarked.
const { describe, it, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { app, setModel, clearModels } = require('../helpers/app');

afterEach(() => { clearModels(); mock.restoreAll(); });

// Capture the searchObj the controller hands the model, and answer with one row so
// the view renders.
function captureSearch(seen) {
  setModel('Fixture', 'getMatchPlayerOrderDetails', (obj, cb) => {
    seen.push(obj);
    cb(null, [{ id: 1, date: new Date('2025-10-07'), name: 'Hyde', teamName: 'Hyde A' }]);
  });
}

describe('/fixture-players speaks the shared filter grammar', () => {
  const cases = [
    ['no filters',            '/fixture-players',                                          {}],
    ['season only',           '/fixture-players/20252026',                                 { season: '20252026' }],
    ['season + club',         '/fixture-players/20252026/club-Manchester%20Edgeley',       { season: '20252026', club: 'Manchester Edgeley' }],
    ['season + club + team',  '/fixture-players/20252026/club-Hyde/team-Hyde%20A',         { season: '20252026', club: 'Hyde', team: 'Hyde A' }],
    ['club only',             '/fixture-players/club-Hyde',                                { club: 'Hyde' }],
    ['team only',             '/fixture-players/team-Hyde%20A',                            { team: 'Hyde A' }],
  ];

  for (const [name, url, expected] of cases) {
    it(`${name}: ${url} -> 200 with ${JSON.stringify(expected)}`, async () => {
      const seen = [];
      captureSearch(seen);
      const res = await request(app).get(url);
      assert.strictEqual(res.status, 200, `${url} should route, not 404`);
      assert.deepStrictEqual(seen[0], expected);
    });
  }
});

describe('/fixture-players still honours the legacy URL shapes', () => {
  // Pre-existing links and bookmarks, in the grammar the old routes defined.
  const cases = [
    ['/fixture-players/club-Manchester%20Edgeley/20252026', { season: '20252026', club: 'Manchester Edgeley' }],
    ['/fixture-players/team-Hyde%20A/season-20252026',      { season: '20252026', team: 'Hyde A' }],
  ];

  for (const [url, expected] of cases) {
    it(`${url} -> 200 with ${JSON.stringify(expected)}`, async () => {
      const seen = [];
      captureSearch(seen);
      const res = await request(app).get(url);
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(seen[0], expected);
    });
  }
});
