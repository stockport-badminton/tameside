// /admin/league-run-in and the `promotion_places` setting. Models stubbed.
const { describe, it, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { app, clearModels } = require('../helpers/app');
const League = require('../../models/league');
const SiteSettings = require('../../models/siteSettings');

afterEach(() => { clearModels(); mock.restoreAll(); });

function asRole(role, fn) {
  return async () => {
    const saved = { DEV_MODE: process.env.DEV_MODE, DEV_ROLE: process.env.DEV_ROLE };
    if (role === undefined) delete process.env.DEV_MODE;
    else { process.env.DEV_MODE = 'true'; process.env.DEV_ROLE = role; }
    try { await fn(); } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  };
}

const row = (division, rank, name, gamesWon, remaining) => ({
  division, divisionName: `Division ${rank}`, divisionRank: rank, id: name.length, name,
  divRank: 1, played: 5, remaining, gamesWon, gamesLost: 90 - gamesWon,
});
const ROWS = [
  row(8, 1, 'Hyde A', 70, 4), row(8, 1, 'Shell A', 60, 4), row(8, 1, 'GHAP B', 30, 4), row(8, 1, 'Hyde B', 20, 4),
  row(9, 2, 'Manor A', 75, 4), row(9, 2, 'Mellor A', 65, 4), row(9, 2, 'Disley A', 40, 4), row(9, 2, 'Hyde C', 10, 4),
];

describe('gating', () => {
  it('login, then superadmin only', async () => {
    mock.method(League, 'getRunIn', async () => ROWS);
    mock.method(League, 'movingPlaces', async () => 2);
    await asRole(undefined, async () => assert.strictEqual((await request(app).get('/admin/league-run-in')).status, 302))();
    for (const role of ['none', 'admin']) {
      await asRole(role, async () => assert.strictEqual((await request(app).get('/admin/league-run-in')).status, 403))();
    }
    assert.strictEqual(League.getRunIn.mock.callCount(), 0);
  });
});

describe('the page', () => {
  const zonesOf = html => [...html.matchAll(/data-zone="([a-z]*)"/g)].map(m => m[1]);

  it('marks two up and two down by default', asRole('superadmin', async () => {
    mock.method(League, 'getRunIn', async () => ROWS);
    mock.method(League, 'movingPlaces', async () => 2);
    const res = await request(app).get('/admin/league-run-in');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(zonesOf(res.text), ['winner', '', 'down', 'down', 'winner', 'up', '', '']);
    assert.match(res.text, /2 up and 2 down/);
    assert.doesNotMatch(res.text, /undefined|NaN/);
  }));

  it('follows the setting: one up, one down', asRole('superadmin', async () => {
    mock.method(League, 'getRunIn', async () => ROWS);
    mock.method(League, 'movingPlaces', async () => 1);
    const res = await request(app).get('/admin/league-run-in');
    assert.deepStrictEqual(zonesOf(res.text), ['winner', '', '', 'down', 'winner', '', '', '']);
  }));
});

describe('the setting', () => {
  it('stores a whole number 0-4 and ignores anything else', asRole('superadmin', async () => {
    const set = [];
    mock.method(SiteSettings, 'set', (key, value, done) => { set.push([key, value]); done(null, {}); });
    for (const v of ['1', '7', 'two', '-1', '']) {
      const res = await request(app).post('/admin/site-settings').type('form').send({ homepage_gallery_tag: 'x', promotion_places: v });
      assert.strictEqual(res.status, 302);
    }
    assert.deepStrictEqual(set.filter(([k]) => k === 'promotion_places'), [['promotion_places', '1']]);
  }));
});
