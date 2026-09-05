// Route-level gating for the registration chase, and the digest endpoint's shared secret.
//
// Two things need pinning here.
//
// THE WORKLIST IS SUPERADMIN-ONLY. It lists every club in the league and can email any of
// them; a club admin has no business chasing another club. The `secured` route only proves
// somebody is logged in, so the role check in the controller is the whole gate.
//
// THE DIGEST ENDPOINT IS NOT `secured` AT ALL, because Cloud Scheduler cannot log in
// through Auth0. It is guarded by a shared secret in the query string and 404s — not
// 401s — without one, so a scanner learns nothing about what lives there. That is the same
// shape as POST /webhooks/mailjet, and it is the part most worth a regression test: a
// mistake here is an unauthenticated endpoint that sends mail, which is precisely what
// GET /mailjet was before it was deleted.

const { describe, it, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { app, setModel, clearModels } = require('../helpers/app');
const controller = require('../../controllers/registrationReminderController');
const mailer = require('../../utils/mailer');

afterEach(() => { clearModels(); mock.restoreAll(); });

// Identity comes from middleware/devMode.js and is driven by process-global env vars, so
// each test states the identity it runs as and restores what was there. Hooks would race.
function asUser({ role, club } = {}, fn) {
  return async () => {
    const saved = {
      DEV_MODE: process.env.DEV_MODE, DEV_ROLE: process.env.DEV_ROLE, DEV_CLUB: process.env.DEV_CLUB,
    };
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

function withToken(token, fn) {
  return async () => {
    const saved = process.env.REGISTRATION_DIGEST_TOKEN;
    if (token === undefined) delete process.env.REGISTRATION_DIGEST_TOKEN;
    else process.env.REGISTRATION_DIGEST_TOKEN = token;
    try { await fn(); } finally {
      if (saved === undefined) delete process.env.REGISTRATION_DIGEST_TOKEN;
      else process.env.REGISTRATION_DIGEST_TOKEN = saved;
    }
  };
}

const CLUB = {
  id: 47, name: 'Hyde', season: '20242025', teams: 3,
  firstFixture: new Date('2026-09-02T00:00:00.000Z'), daysAway: -3,
  receivedAt: null, chasedAt: null, chaseCount: 0, note: null, updatedBy: null,
  received: false, chased: false,
  officers: [{ name: 'Jill Jackson', email: 'jill@example.com', role: 'club secretary' }],
};

const stubStatus = (clubs = [CLUB]) => setModel('ClubRegistration', 'getStatus', async () => clubs);

describe('the worklist is superadmin-only', () => {
  it('redirects an anonymous visitor to login', asUser({}, async () => {
    const res = await request(app).get('/admin/registration-reminders');
    assert.strictEqual(res.status, 302);
    assert.match(res.headers.location, /\/login/);
  }));

  it('refuses a club admin, who has no business chasing other clubs',
    asUser({ role: 'admin', club: 'Hyde' }, async () => {
      stubStatus();
      const res = await request(app).get('/admin/registration-reminders');
      assert.strictEqual(res.status, 403);
    }));

  it('refuses an ordinary logged-in user', asUser({ role: 'none' }, async () => {
    stubStatus();
    const res = await request(app).get('/admin/registration-reminders');
    assert.strictEqual(res.status, 403);
  }));

  it('renders for a superadmin', asUser({ role: 'superadmin' }, async () => {
    stubStatus();
    const res = await request(app).get('/admin/registration-reminders');
    assert.strictEqual(res.status, 200);
    assert.match(res.text, /Hyde/);
    assert.match(res.text, /Wed 2 Sep 2026/);
    // Overdue is the state that matters most on this page.
    assert.match(res.text, /was 3 days ago/);
  }));

  it('refuses a club admin the chase POST as well as the page',
    asUser({ role: 'admin', club: 'Hyde' }, async () => {
      const res = await request(app).post('/admin/registration-reminders/47/chase');
      assert.strictEqual(res.status, 403);
    }));
});

describe('a club id from the URL is checked against the worklist', () => {
  // The worklist is the allowlist. `club` in this database is full of ids belonging to the
  // other league (817 of 1,139 scorecard rows are theirs), and a club with no fixture this
  // season has no deadline — neither should get a club_registration row from a hand-made
  // POST.
  it('refuses a club that has no fixture this season',
    asUser({ role: 'superadmin' }, async () => {
      stubStatus([CLUB]);
      let wrote = 0;
      setModel('ClubRegistration', 'markReceived', async () => { wrote += 1; });
      const res = await request(app)
        .post('/admin/registration-reminders/999/received')
        .type('form').send({ received: 'true' });
      assert.strictEqual(res.status, 302);
      assert.match(res.headers.location, /err=/);
      assert.strictEqual(wrote, 0);
    }));

  it('marks a club on the worklist as received', asUser({ role: 'superadmin' }, async () => {
    stubStatus([CLUB]);
    const calls = [];
    setModel('ClubRegistration', 'markReceived', async (...args) => { calls.push(args); });
    const res = await request(app)
      .post('/admin/registration-reminders/47/received')
      .type('form').send({ received: 'true' });
    assert.strictEqual(res.status, 302);
    assert.match(res.headers.location, /msg=/);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0][1], 47);
  }));

  it('unticks, which clears received_at rather than deleting the row',
    asUser({ role: 'superadmin' }, async () => {
      stubStatus([{ ...CLUB, received: true, receivedAt: new Date('2026-09-01T00:00:00Z') }]);
      const calls = [];
      setModel('ClubRegistration', 'markNotReceived', async (...args) => { calls.push(args); });
      const res = await request(app)
        .post('/admin/registration-reminders/47/received')
        .type('form').send({ received: 'false' });
      assert.strictEqual(res.status, 302);
      assert.strictEqual(calls.length, 1);
    }));
});

describe('the digest endpoint', () => {
  it('404s when no token is configured, so an unused endpoint gives nothing away',
    withToken(undefined, async () => {
      const res = await request(app).get('/tasks/registration-digest');
      assert.strictEqual(res.status, 404);
    }));

  it('404s on a wrong token — not 401, which would confirm it exists',
    withToken('the-real-token', async () => {
      const res = await request(app).get('/tasks/registration-digest?t=guess');
      assert.strictEqual(res.status, 404);
    }));

  it('404s on no token at all when one is configured',
    withToken('the-real-token', async () => {
      const res = await request(app).get('/tasks/registration-digest');
      assert.strictEqual(res.status, 404);
    }));

  it('runs the digest with the right token', withToken('the-real-token', async () => {
    const ran = mock.method(controller, 'sendDigest', async () => ({ sent: false, reason: 'quiet' }));
    const res = await request(app).get('/tasks/registration-digest?t=the-real-token');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(ran.mock.callCount(), 1);
    assert.strictEqual(res.body.sent, false);
  }));

  // The endpoint sends mail and is reachable without a session. If the token check ever
  // regressed, this is the consequence — so it is asserted directly.
  it('sends no email on a rejected request', withToken('the-real-token', async () => {
    const sent = [];
    mock.method(mailer.client, 'post', () => ({
      request: (payload) => { sent.push(payload); return Promise.resolve({ body: {} }); },
    }));
    await request(app).get('/tasks/registration-digest?t=guess');
    assert.strictEqual(sent.length, 0);
  }));
});
