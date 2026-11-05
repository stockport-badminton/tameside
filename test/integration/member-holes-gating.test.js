// Three routes the route table (docs/routes.md) showed open to any logged-in member,
// closed Nov 2026:
//
// - POST /fixture/rearrangement marks an outstanding fixture rearranged (and inserts its
//   replacement). The results grid offers the Rearrange link to superadmins only; the
//   server checked nothing.
// - GET /played-up-counts is an admin-hub tool.
// - GET/POST /player/create created a player at any club. Deleted: nothing linked to it
//   once the roster editor replaced it.
//
// Each refusal asserts the model was never called, not just the status.
const { describe, it, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { app } = require('../helpers/app');
const Fixture = require('../../models/fixture');
const Player = require('../../models/players');

afterEach(() => mock.restoreAll());

// Same shape as fixture-gen-gating.test.js: each test names the identity it runs as.
function asUser({ role, club } = {}, fn) {
  return async () => {
    const saved = { DEV_MODE: process.env.DEV_MODE, DEV_ROLE: process.env.DEV_ROLE, DEV_CLUB: process.env.DEV_CLUB };
    if (role === undefined) delete process.env.DEV_MODE;
    else {
      process.env.DEV_MODE = 'true';
      process.env.DEV_ROLE = role;
      if (club) process.env.DEV_CLUB = club; else delete process.env.DEV_CLUB;
    }
    try { await fn(); } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  };
}

function spyOnModels() {
  const calls = [];
  mock.method(Fixture, 'rearrangeByTeamNames', (body, done) => { calls.push('rearrange'); done(null, { id: 1, status: 'rearranging' }); });
  mock.method(Player, 'getPlayedUpCounts', (done) => { calls.push('playedUp'); done(null, []); });
  mock.method(Player, 'create', (...args) => { calls.push('create'); args[args.length - 1](null, {}); });
  return calls;
}

const GATED = [
  ['post', '/fixture/rearrangement'],
  ['get', '/played-up-counts'],
];

describe('superadmin-only routes that were open to members', () => {
  for (const [method, url] of GATED) {
    it(`${method.toUpperCase()} ${url} refuses a club admin`, asUser({ role: 'admin', club: 'Hyde' }, async () => {
      const calls = spyOnModels();
      const res = await request(app)[method](url).send({ hometeam: 'Hyde A', awayteam: 'Hyde B' });
      assert.strictEqual(res.status, 403);
      assert.deepStrictEqual(calls, []);
    }));

    it(`${method.toUpperCase()} ${url} refuses an ordinary member`, asUser({ role: 'none' }, async () => {
      const calls = spyOnModels();
      const res = await request(app)[method](url).send({ hometeam: 'Hyde A', awayteam: 'Hyde B' });
      assert.strictEqual(res.status, 403);
      assert.deepStrictEqual(calls, []);
    }));

    it(`${method.toUpperCase()} ${url} sends a stranger to log in`, asUser({}, async () => {
      const calls = spyOnModels();
      const res = await request(app)[method](url);
      assert.strictEqual(res.status, 302);
      assert.strictEqual(res.headers.location, '/login');
      assert.deepStrictEqual(calls, []);
    }));
  }

  it('a superadmin can still rearrange', asUser({ role: 'superadmin' }, async () => {
    const calls = spyOnModels();
    const res = await request(app).post('/fixture/rearrangement').send({ hometeam: 'Hyde A', awayteam: 'Hyde B' });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(calls, ['rearrange']);
  }));
});

describe('/player/create is gone', () => {
  for (const method of ['get', 'post']) {
    it(`${method.toUpperCase()} /player/create is a 404 even for a superadmin`, asUser({ role: 'superadmin' }, async () => {
      const calls = spyOnModels();
      const res = await request(app)[method]('/player/create').send({ first_name: 'X', family_name: 'Y', club: 1, team: 1, gender: 'Male' });
      assert.strictEqual(res.status, 404);
      assert.deepStrictEqual(calls, []);
    }));
  }
});
