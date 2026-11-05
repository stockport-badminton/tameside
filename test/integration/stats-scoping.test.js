// /player-stats and /pair-stats (Nov 2026): a superadmin sees every club, a login linked
// to a player at a club sees that club, nobody else sees anything. Before this the pages
// asked only for a login, so every Stockport account the shared Auth0 tenant lets in here
// saw every Tameside club, while a club admin was scoped to their own: backwards.
//
// Asserts what reached the model, not just the status: a scope applied after the query
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

function spyOnStats() {
  const seen = [];
  for (const m of ['newGetPlayerStats', 'newGetPairStats']) {
    setModel('Player', m, (searchObj, done) => { seen.push({ m, club: searchObj.club }); done(null, []); });
  }
  return seen;
}

const PAGES = ['/player-stats', '/pair-stats'];

describe('stats pages', () => {
  for (const page of PAGES) {
    it(`${page}: an unlinked login (e.g. a Stockport account) is refused`, asUser({ DEV_MODE: 'true', DEV_ROLE: 'none' }, async () => {
      const seen = spyOnStats();
      const res = await request(app).get(page);
      assert.strictEqual(res.status, 403);
      assert.match(res.text, /isn.t linked to a player/);
      assert.deepStrictEqual(seen, []);
    }));

    it(`${page}: a linked member sees their own club only`, asUser({ DEV_MODE: 'true', DEV_ROLE: 'none', DEV_CLUB: 'Hyde' }, async () => {
      const seen = spyOnStats();
      const res = await request(app).get(page);
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(seen.map(s => s.club), ['Hyde']);
    }));

    it(`${page}: a club filter in the URL cannot widen it`, asUser({ DEV_MODE: 'true', DEV_ROLE: 'none', DEV_CLUB: 'Hyde' }, async () => {
      const seen = spyOnStats();
      await request(app).get(page + '/club-%25');
      await request(app).get(page + '/club-Aerospace');
      assert.deepStrictEqual(seen.map(s => s.club), ['Hyde', 'Hyde']);
    }));

    // The unfiltered /pair-stats was not scoped at all, even for a club admin, until Nov 2026.
    it(`${page}: a club admin is scoped with or without filters`, asUser({ DEV_MODE: 'true', DEV_ROLE: 'admin', DEV_CLUB: 'Hyde' }, async () => {
      const seen = spyOnStats();
      await request(app).get(page);
      await request(app).get(page + '/gender-Male');
      assert.deepStrictEqual(seen.map(s => s.club), ['Hyde', 'Hyde']);
    }));

    it(`${page}: a superadmin sees every club`, asUser({ DEV_MODE: 'true', DEV_ROLE: 'superadmin' }, async () => {
      const seen = spyOnStats();
      const res = await request(app).get(page);
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(seen.map(s => s.club), [undefined]);
    }));

    it(`${page}: a stranger is sent to log in`, asUser({}, async () => {
      const seen = spyOnStats();
      const res = await request(app).get(page);
      assert.strictEqual(res.status, 302);
      assert.deepStrictEqual(seen, []);
    }));
  }
});
