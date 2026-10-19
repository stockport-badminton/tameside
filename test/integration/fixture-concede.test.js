// POST /admin/fixture/:id/concede — a superadmin marks a fixture conceded, or undoes it.
// The model is stubbed: what is asserted is the gate, that a refused request never
// reached the model, and how the model's answer maps onto a status. The SQL's own
// eligibility rules were rehearsed against production in a rolled-back transaction.
const { describe, it, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { app, clearModels } = require('../helpers/app');
const Fixture = require('../../models/fixture');

afterEach(() => { clearModels(); mock.restoreAll(); });

function asUser({ role } = {}, fn) {
  return async () => {
    const saved = { DEV_MODE: process.env.DEV_MODE, DEV_ROLE: process.env.DEV_ROLE };
    if (role === undefined) delete process.env.DEV_MODE;
    else { process.env.DEV_MODE = 'true'; process.env.DEV_ROLE = role; }
    try { await fn(); } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  };
}

function stubSetConceded(result) {
  const calls = [];
  mock.method(Fixture, 'setConceded', async (...args) => { calls.push(args); return result; });
  return calls;
}

describe('concedeScores', () => {
  it('awards 18-0 to the side that did not concede', () => {
    assert.deepStrictEqual(Fixture.concedeScores('home'), { homeScore: 0, awayScore: 18 });
    assert.deepStrictEqual(Fixture.concedeScores('away'), { homeScore: 18, awayScore: 0 });
    assert.throws(() => Fixture.concedeScores('both'));
  });

  it('never lets a superseded "rearranged" row be conceded', () => {
    // A rearranged row is the original of a match that now has a fresh outstanding row;
    // conceding it would count the match twice in the table.
    assert.deepStrictEqual(Fixture.CONCEDABLE, ['outstanding', 'rearranging']);
  });
});

describe('POST /admin/fixture/:id/concede gating', () => {
  it('redirects an anonymous caller to login and touches nothing', asUser({}, async () => {
    const calls = stubSetConceded({ ok: true });
    const res = await request(app).post('/admin/fixture/5704/concede').type('form').send({ concededBy: 'home' });
    assert.strictEqual(res.status, 302);
    assert.match(res.headers.location, /\/login/);
    assert.strictEqual(calls.length, 0);
  }));

  for (const role of ['admin', 'none']) {
    it(`refuses a ${role} user with 403 and touches nothing`, asUser({ role }, async () => {
      const calls = stubSetConceded({ ok: true });
      const res = await request(app).post('/admin/fixture/5704/concede').type('form').send({ concededBy: 'home' });
      assert.strictEqual(res.status, 403);
      assert.strictEqual(calls.length, 0);
    }));
  }

  it('rejects an unknown concededBy before reaching the model', asUser({ role: 'superadmin' }, async () => {
    const calls = stubSetConceded({ ok: true });
    for (const body of [{ concededBy: 'both' }, {}]) {
      const res = await request(app).post('/admin/fixture/5704/concede').type('form').send(body);
      assert.strictEqual(res.status, 400);
    }
    assert.strictEqual(calls.length, 0);
  }));

  it('404s a non-numeric id', asUser({ role: 'superadmin' }, async () => {
    const calls = stubSetConceded({ ok: true });
    const res = await request(app).post('/admin/fixture/abc/concede').type('form').send({ concededBy: 'home' });
    assert.strictEqual(res.status, 404);
    assert.strictEqual(calls.length, 0);
  }));
});

describe('POST /admin/fixture/:id/concede as superadmin', () => {
  it('passes the id and side to the model and returns the updated fixture', asUser({ role: 'superadmin' }, async () => {
    const fixture = { id: '5704', status: 'conceded', homeScore: 0, awayScore: 18 };
    const calls = stubSetConceded({ ok: true, fixture });
    const res = await request(app).post('/admin/fixture/5704/concede').type('form').send({ concededBy: 'home' });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { ok: true, fixture });
    assert.deepStrictEqual(calls, [['5704', 'home']]);
  }));

  it('accepts concededBy=none as an undo', asUser({ role: 'superadmin' }, async () => {
    const calls = stubSetConceded({ ok: true, fixture: { id: '5704', status: 'outstanding' } });
    const res = await request(app).post('/admin/fixture/5704/concede').type('form').send({ concededBy: 'none' });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(calls, [['5704', 'none']]);
  }));

  it('404s a fixture that does not exist', asUser({ role: 'superadmin' }, async () => {
    stubSetConceded({ ok: false, reason: 'not-found' });
    const res = await request(app).post('/admin/fixture/99999/concede').type('form').send({ concededBy: 'away' });
    assert.strictEqual(res.status, 404);
  }));

  it('409s a fixture that already has a result, naming its status', asUser({ role: 'superadmin' }, async () => {
    stubSetConceded({ ok: false, reason: 'not-concedable', status: 'complete' });
    const res = await request(app).post('/admin/fixture/5600/concede').type('form').send({ concededBy: 'away' });
    assert.strictEqual(res.status, 409);
    assert.match(res.body.error, /complete fixture cannot be conceded/);
  }));
});
