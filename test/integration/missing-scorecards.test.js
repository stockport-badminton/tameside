// GET /tasks/missing-scorecards — the daily email to the results secretary.
//
// It sends mail and is reachable without a session, which is the shape of the deleted
// GET /mailjet mail bomb. So the gate is pinned by what reached Mailjet, not just by status.

const { describe, it, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { app, setModel, clearModels } = require('../helpers/app');
const mailer = require('../../utils/mailer');

afterEach(() => { clearModels(); mock.restoreAll(); });

function withEnv(vars, fn) {
  return async () => {
    const saved = {};
    for (const [k, v] of Object.entries(vars)) {
      saved[k] = process.env[k];
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    try { await fn(); } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  };
}

function captureMail() {
  const sent = [];
  mock.method(mailer.client, 'post', () => ({
    request: (payload) => { sent.push(payload.Messages[0]); return Promise.resolve({ body: {} }); },
  }));
  return sent;
}

const ROW = { id: 6054, dateLabel: 'Wed 30 Sep 2026', homeTeam: 'Manchester Edgeley A', awayTeam: 'GHAP B' };
const TOKEN = 'the-real-token';

describe('GET /tasks/missing-scorecards', () => {
  it('404s, and sends nothing, without the token', withEnv({ MISSING_SCORECARDS_TOKEN: TOKEN }, async () => {
    const sent = captureMail();
    let queried = 0;
    setModel('Fixture', 'getCardsDueToday', async () => { queried++; return [ROW]; });
    for (const url of ['/tasks/missing-scorecards', '/tasks/missing-scorecards?t=guess']) {
      const res = await request(app).get(url);
      assert.strictEqual(res.status, 404, url);
      assert.strictEqual(res.headers.location, undefined, 'a refusal must never be a redirect');
    }
    assert.strictEqual(sent.length, 0);
    assert.strictEqual(queried, 0);
  }));

  it('an UNSET token closes the path rather than opening it',
    withEnv({ MISSING_SCORECARDS_TOKEN: undefined }, async () => {
      const sent = captureMail();
      setModel('Fixture', 'getCardsDueToday', async () => [ROW]);
      assert.strictEqual((await request(app).get('/tasks/missing-scorecards?t=')).status, 404);
      assert.strictEqual((await request(app).get('/tasks/missing-scorecards?t=undefined')).status, 404);
      assert.strictEqual(sent.length, 0);
    }));

  it('sends one email listing the fixtures, to the results mailbox by default',
    withEnv({ MISSING_SCORECARDS_TOKEN: TOKEN, MISSING_SCORECARDS_TO: undefined }, async () => {
      const sent = captureMail();
      let askedFor;
      setModel('Fixture', 'getCardsDueToday', async (days) => { askedFor = days; return [ROW]; });
      const res = await request(app).get(`/tasks/missing-scorecards?t=${TOKEN}`);
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(res.body, { sent: true, fixtures: 1 });
      assert.strictEqual(askedFor, 6);
      assert.strictEqual(sent.length, 1);
      assert.deepStrictEqual(sent[0].To, [{ Email: mailer.RESULTS_MAILBOX }]);
      assert.strictEqual(sent[0].Subject, '1 missing scorecard');
      assert.match(sent[0].TextPart, /Wed 30 Sep 2026: Manchester Edgeley A v GHAP B/);
      assert.match(sent[0].HTMLPart, /Manchester Edgeley A v GHAP B/);
    }));

  it('MISSING_SCORECARDS_TO takes a comma-separated list',
    withEnv({ MISSING_SCORECARDS_TOKEN: TOKEN, MISSING_SCORECARDS_TO: 'a@example.com, b@example.com' }, async () => {
      const sent = captureMail();
      setModel('Fixture', 'getCardsDueToday', async () => [ROW, ROW]);
      await request(app).get(`/tasks/missing-scorecards?t=${TOKEN}`);
      assert.deepStrictEqual(sent[0].To, [{ Email: 'a@example.com' }, { Email: 'b@example.com' }]);
      assert.strictEqual(sent[0].Subject, '2 missing scorecards');
    }));

  it('a day with nothing missing answers 200 and sends nothing', withEnv({ MISSING_SCORECARDS_TOKEN: TOKEN }, async () => {
    const sent = captureMail();
    setModel('Fixture', 'getCardsDueToday', async () => []);
    const res = await request(app).get(`/tasks/missing-scorecards?t=${TOKEN}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.sent, false);
    assert.strictEqual(sent.length, 0);
  }));
});
