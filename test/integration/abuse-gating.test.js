// Four endpoints closed on 2026-10-02, found by reviewing Stockport's hardening commits:
//
//   POST /fixture/reminder        no gate at all, recipients and subject from the body —
//                                 an open mail relay sending as the league.
//   POST /new-users-v2            no gate (Auth0 calls it), and it emailed the results
//                                 mailbox about whatever `user`/`id` it was handed.
//   GET  /club-api/:id            `secured` only, returns decrypted officer emails.
//   POST /scorecard-beta          `secured` only — any member could publish a result.
//   GET  /populated-scorecard-beta/:id   `secured` only — any member could read any draft.
//
// Every mail-sending case asserts what reached Mailjet, not just the status: a gate that
// answers 403 after sending would pass a status-only test.
const { describe, it, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { app, clearModels } = require('../helpers/app');
const mailer = require('../../utils/mailer');
const Auth = require('../../models/auth');
const contactus = require('../../controllers/contactusController');

afterEach(() => { clearModels(); mock.restoreAll(); contactus._clearSignupThrottleForTesting(); });

// Same shape as auth-gating.test.js: each test states the identity it runs as.
function asUser({ role, club } = {}, fn) {
  return async () => {
    const saved = { DEV_MODE: process.env.DEV_MODE, DEV_ROLE: process.env.DEV_ROLE, DEV_CLUB: process.env.DEV_CLUB };
    if (role === undefined) {
      delete process.env.DEV_MODE;
    } else {
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
const SUPERADMIN = { role: 'superadmin' };
const CLUB_ADMIN = { role: 'admin', club: 'Hyde' };
const MEMBER = { role: 'none' };

function captureMail() {
  const sent = [];
  mock.method(mailer.client, 'post', () => ({
    request: (payload) => { sent.push(payload); return Promise.resolve({ body: {} }); },
  }));
  return sent;
}
const recipients = sent => sent.flatMap(p => p.Messages.flatMap(m => [...(m.To || []), ...(m.Bcc || [])].map(r => r.Email)));

const REMINDER = { email: 'captain@example.com,matchsec@example.com', hometeam: 'Hyde A', awayteam: 'Glossop B' };

describe('POST /fixture/reminder', () => {
  it('unauthenticated: redirects to login and sends nothing', asUser({}, async () => {
    const sent = captureMail();
    const res = await request(app).post('/fixture/reminder').type('form').send({ ...REMINDER, email: 'victim@example.com' });
    assert.strictEqual(res.status, 302);
    assert.match(res.headers.location, /\/login/);
    assert.strictEqual(sent.length, 0);
  }));

  for (const [label, who] of [['a member', MEMBER], ['a club admin', CLUB_ADMIN]]) {
    it(`${label}: 403 and sends nothing`, asUser(who, async () => {
      const sent = captureMail();
      const res = await request(app).post('/fixture/reminder').type('form').send(REMINDER);
      assert.strictEqual(res.status, 403);
      assert.strictEqual(sent.length, 0);
    }));
  }

  it('superadmin: sends to the addresses given', asUser(SUPERADMIN, async () => {
    const sent = captureMail();
    const res = await request(app).post('/fixture/reminder').type('form').send(REMINDER);
    assert.strictEqual(res.status, 200);
    const to = recipients(sent);
    assert.ok(to.includes('captain@example.com') && to.includes('matchsec@example.com'), to.join());
  }));

  it('superadmin: refuses more than ten recipients', asUser(SUPERADMIN, async () => {
    const sent = captureMail();
    const many = Array.from({ length: 11 }, (_, i) => `p${i}@example.com`).join(',');
    const res = await request(app).post('/fixture/reminder').type('form').send({ ...REMINDER, email: many });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(sent.length, 0);
  }));

  it('superadmin: a missing or malformed address is a 400, not a 500', asUser(SUPERADMIN, async () => {
    const sent = captureMail();
    for (const email of [undefined, '', 'not-an-address', 'a@example.com,<x>@y.z']) {
      const body = { ...REMINDER }; if (email === undefined) delete body.email; else body.email = email;
      const res = await request(app).post('/fixture/reminder').type('form').send(body);
      assert.strictEqual(res.status, 400, String(email));
    }
    assert.strictEqual(sent.length, 0);
  }));
});

describe('GET /club-api/:id (decrypted officer emails)', () => {
  for (const [label, who] of [['a member', MEMBER], ['a club admin', CLUB_ADMIN]]) {
    it(`${label}: 403`, asUser(who, async () => {
      const res = await request(app).get('/club-api/1');
      assert.strictEqual(res.status, 403);
    }));
  }
});

describe('publishing a result is superadmin-only', () => {
  it('POST /scorecard-beta unauthenticated: redirects to login', asUser({}, async () => {
    const res = await request(app).post('/scorecard-beta').type('form').send({ homeTeam: '1', awayTeam: '2' });
    assert.strictEqual(res.status, 302);
    assert.match(res.headers.location, /\/login/);
  }));

  for (const [label, who] of [['a member', MEMBER], ['a club admin', CLUB_ADMIN]]) {
    it(`POST /scorecard-beta as ${label}: 403, and no email`, asUser(who, async () => {
      const sent = captureMail();
      const res = await request(app).post('/scorecard-beta').type('form')
        .send({ homeTeam: '1', awayTeam: '2', email: 'victim@example.com' });
      assert.strictEqual(res.status, 403);
      assert.strictEqual(sent.length, 0);
    }));

    it(`GET /populated-scorecard-beta/:id as ${label}: 403`, asUser(who, async () => {
      const res = await request(app).get('/populated-scorecard-beta/2176');
      assert.strictEqual(res.status, 403);
    }));
  }
});

describe('POST /new-users-v2 believes only what Auth0 confirms', () => {
  const ID = 'auth0|abc123';

  it('notifies about a real unapproved account, using Auth0\'s address not the body\'s', asUser({}, async () => {
    const sent = captureMail();
    mock.method(Auth, 'getUserByAuthId', async () => ({ user_id: ID, email: 'real@example.com', app_metadata: {} }));
    const res = await request(app).post('/new-users-v2').send({ id: ID, user: '<a href="https://evil.example">click</a>' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(sent.length, 1);
    const payload = JSON.stringify(sent[0]);
    assert.match(payload, /real@example\.com/);
    assert.doesNotMatch(payload, /evil\.example/);
  }));

  it('sends nothing for an id Auth0 does not know', asUser({}, async () => {
    const sent = captureMail();
    mock.method(Auth, 'getUserByAuthId', async () => undefined);
    const res = await request(app).post('/new-users-v2').send({ id: ID, user: 'x@example.com' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(sent.length, 0);
  }));

  // The lookup is a Lucene search, so `*` returns somebody.
  it('sends nothing when the search returns a DIFFERENT account', asUser({}, async () => {
    const sent = captureMail();
    mock.method(Auth, 'getUserByAuthId', async () => ({ user_id: 'auth0|someone-else', email: 'a@example.com', app_metadata: {} }));
    const res = await request(app).post('/new-users-v2').send({ id: 'auth0|*', user: 'x' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(sent.length, 0);
  }));

  it('sends nothing for an account that is already approved', asUser({}, async () => {
    const sent = captureMail();
    mock.method(Auth, 'getUserByAuthId', async () => ({ user_id: ID, email: 'a@example.com', app_metadata: { betaAccess: true } }));
    await request(app).post('/new-users-v2').send({ id: ID });
    assert.strictEqual(sent.length, 0);
  }));

  it('sends once, not on every retry', asUser({}, async () => {
    const sent = captureMail();
    mock.method(Auth, 'getUserByAuthId', async () => ({ user_id: ID, email: 'a@example.com', app_metadata: {} }));
    for (let i = 0; i < 3; i++) await request(app).post('/new-users-v2').send({ id: ID });
    assert.strictEqual(sent.length, 1);
  }));
});
