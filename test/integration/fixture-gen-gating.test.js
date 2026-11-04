// /fixture-gen is superadmin only. It was `secured` alone, so any logged-in member could
// reach it, and POST /fixture-gen/publish targets the LIVE season: it deletes every
// unplayed fixture and re-inserts the whole draft, played matches included.
//
// Each refusal asserts that the model was never called, not just the status: a gate
// that answered 403 after the write would pass a status-only test.
const { describe, it, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { app } = require('../helpers/app');
const fixtureGenModel = require('../../models/fixtureGenModel');

afterEach(() => mock.restoreAll());

// Same shape as auth-gating.test.js: each test names the identity it runs as.
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

function spyOnWrites() {
  const writes = [];
  for (const method of ['publishDraftFixtures', 'saveDraftFixtures', 'getTeamsForScheduler']) {
    mock.method(fixtureGenModel, method, (...args) => { writes.push(method); args[args.length - 1](null, []); });
  }
  return writes;
}

const ROUTES = [
  ['get', '/fixture-gen'],
  ['post', '/fixture-gen/regenerate'],
  ['post', '/fixture-gen/publish'],
];

describe('the fixture generator is superadmin only', () => {
  for (const [method, url] of ROUTES) {
    it(`${method.toUpperCase()} ${url} refuses a club admin`, asUser({ role: 'admin', club: 'Hyde' }, async () => {
      const writes = spyOnWrites();
      const res = await request(app)[method](url);
      assert.strictEqual(res.status, 403);
      assert.deepStrictEqual(writes, []);
    }));

    it(`${method.toUpperCase()} ${url} refuses an ordinary member`, asUser({ role: 'none' }, async () => {
      const writes = spyOnWrites();
      const res = await request(app)[method](url);
      assert.strictEqual(res.status, 403);
      assert.deepStrictEqual(writes, []);
    }));

    it(`${method.toUpperCase()} ${url} sends a stranger to log in`, asUser({}, async () => {
      const writes = spyOnWrites();
      const res = await request(app)[method](url);
      assert.strictEqual(res.status, 302);
      assert.strictEqual(res.headers.location, '/login');
      assert.deepStrictEqual(writes, []);
    }));
  }

  it('a superadmin can publish', asUser({ role: 'superadmin' }, async () => {
    const writes = spyOnWrites();
    const res = await request(app).post('/fixture-gen/publish');
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.location, '/fixture-gen?published=1');
    assert.deepStrictEqual(writes, ['publishDraftFixtures']);
  }));
});

describe('/admin/info/clubs is superadmin only', () => {
  it('refuses a club admin', asUser({ role: 'admin', club: 'Hyde' }, async () => {
    const res = await request(app).get('/admin/info/clubs');
    assert.strictEqual(res.status, 403);
  }));
});
