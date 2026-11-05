// The monthly login cull (controllers/authCullController.js).
//
// It sends mail without a session, and it deletes accounts from an Auth0 tenant shared
// with Stockport's site. So the gate is pinned by what reached Mailjet, and deletion by
// what reached Auth0, not just by status.
const { describe, it, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { app, setModel, clearModels } = require('../helpers/app');
const Auth = require('../../models/auth');
const mailer = require('../../utils/mailer');

afterEach(() => { clearModels(); mock.restoreAll(); });

const TOKEN = 'the-real-token';
const daysAgo = n => new Date(Date.now() - n * 864e5).toISOString();

const TENANT = [
  // Ours, idle for 400 days: warn.
  { user_id: 'auth0|idle', email: 'idle@example.com', last_login: daysAgo(400), created_at: daysAgo(900),
    app_metadata: { betaAccess: true } },
  // Ours, warned 40 days ago, no answer: due.
  { user_id: 'auth0|due', email: 'due@example.com', last_login: daysAgo(420), created_at: daysAgo(900),
    app_metadata: { betaAccess: true } },
  // Ours, active.
  { user_id: 'auth0|active', email: 'active@example.com', last_login: daysAgo(3), created_at: daysAgo(900),
    app_metadata: { betaAccess: true } },
  // Not ours: idle, unlinked, untagged. Stockport's cull.
  { user_id: 'google-oauth2|theirs', email: 'theirs@example.com', last_login: daysAgo(800), created_at: daysAgo(900),
    app_metadata: { betaAccess: true } },
];

const P = (id, first, family) => ({ id, first_name: first, family_name: family, clubName: 'Hyde', role: null });

function stubState({ notices = { 'auth0|due': { notified_at: daysAgo(40) } } } = {}) {
  mock.method(Auth, 'listUsers', async () => TENANT);
  setModel('Player', 'getAuthAccountIndex', async () => ([
    { userId: 'auth0|idle', ...P(1, 'Ida', 'Idle') },
    { userId: 'auth0|due', ...P(2, 'Dee', 'Due') },
    { userId: 'auth0|active', ...P(3, 'Act', 'Ive') },
  ]));
  setModel('AuthCull', 'getAll', async () => new Map(Object.entries(notices)));
  const recorded = [];
  setModel('AuthCull', 'recordNotice', async (userId, token) => { recorded.push([userId, token]); });
  return recorded;
}

function captureMail({ failFor } = {}) {
  const sent = [];
  mock.method(mailer.client, 'post', () => ({
    request: (payload) => {
      const m = payload.Messages[0];
      if (failFor && m.To.some(t => t.Email === failFor)) return Promise.reject(new Error('Mailjet said no'));
      sent.push(m);
      return Promise.resolve({ body: {} });
    },
  }));
  return sent;
}

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

const SUPERADMIN = { DEV_MODE: 'true', DEV_ROLE: 'superadmin', DEV_CLUB: undefined };
const CLUB_ADMIN = { DEV_MODE: 'true', DEV_ROLE: 'admin', DEV_CLUB: 'Hyde' };

describe('GET /tasks/login-cull', () => {
  it('404s, and sends and records nothing, without the token', withEnv({ LOGIN_CULL_TOKEN: TOKEN }, async () => {
    const sent = captureMail();
    const recorded = stubState();
    for (const url of ['/tasks/login-cull', '/tasks/login-cull?t=guess']) {
      const res = await request(app).get(url);
      assert.strictEqual(res.status, 404, url);
      assert.strictEqual(res.headers.location, undefined);
    }
    assert.deepStrictEqual([sent.length, recorded.length], [0, 0]);
  }));

  it('an UNSET token closes the path', withEnv({ LOGIN_CULL_TOKEN: undefined }, async () => {
    const sent = captureMail();
    stubState();
    assert.strictEqual((await request(app).get('/tasks/login-cull?t=')).status, 404);
    assert.strictEqual(sent.length, 0);
  }));

  it('warns the idle login, records the token it emailed, and tells the results secretary',
    withEnv({ LOGIN_CULL_TOKEN: TOKEN }, async () => {
      const sent = captureMail();
      const recorded = stubState();
      const res = await request(app).get('/tasks/login-cull?t=' + TOKEN);
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(res.body, { warned: 1, failed: 0, deferred: 0, waiting: 0, due: 1 });

      const warning = sent.find(m => m.To[0].Email === 'idle@example.com');
      assert.ok(warning, 'the idle login was emailed');
      assert.strictEqual(sent.filter(m => /theirs|active|due@/.test(m.To[0].Email)).length, 0);
      const link = warning.TextPart.match(/\/keep-login\/([A-Za-z0-9_-]+)/);
      assert.ok(link, 'the warning carries a keep link');
      assert.deepStrictEqual(recorded, [['auth0|idle', link[1]]]);
      assert.match(warning.HTMLPart, /Hello Ida/);

      const digest = sent.find(m => m.To[0].Email === mailer.RESULTS_MAILBOX);
      assert.match(digest.Subject, /1 warned, 1 due for deletion/);
    }));

  it('records nothing for a warning Mailjet refused', withEnv({ LOGIN_CULL_TOKEN: TOKEN }, async () => {
    captureMail({ failFor: 'idle@example.com' });
    const recorded = stubState();
    const res = await request(app).get('/tasks/login-cull?t=' + TOKEN);
    assert.strictEqual(res.body.failed, 1);
    assert.deepStrictEqual(recorded, []);
  }));

  it('a quiet month sends nothing', withEnv({ LOGIN_CULL_TOKEN: TOKEN }, async () => {
    const sent = captureMail();
    stubState({ notices: {
      'auth0|idle': { kept_at: daysAgo(10) },
      'auth0|due': { kept_at: daysAgo(10) },
    } });
    const res = await request(app).get('/tasks/login-cull?t=' + TOKEN);
    assert.deepStrictEqual(res.body, { warned: 0, failed: 0, deferred: 0, waiting: 0, due: 0 });
    assert.strictEqual(sent.length, 0);
  }));
});

describe('/keep-login/:token', () => {
  it('the GET shows a button and changes nothing (mail scanners prefetch links)', async () => {
    setModel('AuthCull', 'findByToken', async (t) => t === 'good' ? { user_id: 'auth0|idle' } : undefined);
    setModel('AuthCull', 'keepByToken', async () => { throw new Error('a GET must not keep'); });
    const res = await request(app).get('/keep-login/good');
    assert.strictEqual(res.status, 200);
    assert.match(res.text, /<form method="post">/);
    assert.match(res.headers['cache-control'], /no-store/);
    assert.strictEqual((await request(app).get('/keep-login/bad')).status, 404);
  });

  it('the POST keeps the login, once', async () => {
    const kept = [];
    setModel('AuthCull', 'keepByToken', async (t) => { if (t !== 'good') return undefined; kept.push(t); return { user_id: 'auth0|idle' }; });
    const res = await request(app).post('/keep-login/good');
    assert.strictEqual(res.status, 200);
    assert.match(res.text, /your login is kept/);
    assert.deepStrictEqual(kept, ['good']);
    assert.strictEqual((await request(app).post('/keep-login/bad')).status, 404);
  });
});

describe('deleting due logins', () => {
  function asUser(env, fn) {
    return withEnv({ DEV_MODE: undefined, DEV_ROLE: undefined, DEV_CLUB: undefined, ...env }, fn);
  }

  function stubDeletes() {
    const deleted = [];
    const unlinked = [];
    const removed = [];
    mock.method(Auth, 'getManagementAPIKey', async () => 'mgmt');
    mock.method(Auth, 'deleteUser', async (id) => { deleted.push(id); return 'deleted'; });
    setModel('Player', 'unlinkAuthAccount', async (id, email) => { unlinked.push([id, email]); return []; });
    setModel('AuthCull', 'remove', async (id) => { removed.push(id); });
    return { deleted, unlinked, removed };
  }

  it('a club admin gets 403, and nothing reaches Auth0', asUser(CLUB_ADMIN, async () => {
    stubState();
    const d = stubDeletes();
    for (const url of ['/admin/link-auth-accounts/delete-due', '/admin/link-auth-accounts/keep']) {
      const res = await request(app).post(url).type('form').send({ userId: 'auth0|due' });
      assert.strictEqual(res.status, 403, url);
    }
    assert.deepStrictEqual(d.deleted, []);
  }));

  it('deletes only what was shown AND is still due, and unlinks it with the tenant address',
    asUser(SUPERADMIN, async () => {
      stubState();
      const d = stubDeletes();
      const res = await request(app).post('/admin/link-auth-accounts/delete-due').type('form')
        .send('userId=auth0%7Cdue&userId=auth0%7Cactive&userId=auth0%7Cidle&userId=google-oauth2%7Ctheirs');
      assert.strictEqual(res.status, 302);
      assert.deepStrictEqual(d.deleted, ['auth0|due']);
      assert.deepStrictEqual(d.unlinked, [['auth0|due', 'due@example.com']]);
      assert.deepStrictEqual(d.removed, ['auth0|due']);
      assert.match(decodeURIComponent(res.headers.location), /Deleted 1 login\. 3 no longer due/);
    }));

  it('a due login that was not on the page is left alone', asUser(SUPERADMIN, async () => {
    stubState();
    const d = stubDeletes();
    await request(app).post('/admin/link-auth-accounts/delete-due').type('form').send({});
    assert.deepStrictEqual(d.deleted, []);
  }));

  it('keep: only an account the tenant has', asUser(SUPERADMIN, async () => {
    stubState();
    const kept = [];
    setModel('AuthCull', 'keep', async (id) => { kept.push(id); });
    assert.strictEqual((await request(app).post('/admin/link-auth-accounts/keep').type('form')
      .send({ userId: 'auth0|invented' })).status, 404);
    assert.strictEqual((await request(app).post('/admin/link-auth-accounts/keep').type('form')
      .send({ userId: 'auth0|due' })).status, 302);
    assert.deepStrictEqual(kept, ['auth0|due']);
  }));
});
