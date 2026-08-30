// /admin/link-auth-accounts — the worklist that moves site roles from Auth0
// app_metadata onto the player table.
//
// The classification rules under test are the ones that took a live tenant dump to get
// right: the Auth0 tenant is shared with the Stockport league site, so most accounts in
// it are not ours, and "not ours" needs two signals rather than one.
const { describe, it, before, after, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { app, setModel, clearModels } = require('../helpers/app');
const Auth = require('../../models/auth');

afterEach(() => { clearModels(); mock.restoreAll(); });

const CLUBS = [{ id: 1, name: 'Hyde' }, { id: 2, name: 'Aerospace' }, { id: 3, name: 'College Green' }];

// A tenant sample with one of each interesting shape.
const TENANT = [
  // Ours: club is a Tameside club, no league key.
  { user_id: 'auth0|1', email: 'ours@example.com', logins_count: 5, last_login: '2026-08-01T00:00:00Z',
    app_metadata: { role: 'admin', club: 'Hyde' } },
  // Ours, and matchable by playerEmail — should come through as a proposal.
  { user_id: 'auth0|2', email: 'matched@example.com', logins_count: 9, last_login: '2026-08-02T00:00:00Z',
    app_metadata: { role: 'admin', club: 'Aerospace', stats: true } },
  // Other league: club Tameside has never heard of.
  { user_id: 'auth0|3', email: 'stockport@example.com', logins_count: 3, last_login: null,
    app_metadata: { role: 'admin', club: 'Cheadle Hulme' } },
  // Ambiguous: says stockport, but College Green exists here too.
  { user_id: 'auth0|4', email: 'both@example.com', logins_count: 76, last_login: '2026-08-27T00:00:00Z',
    app_metadata: { role: 'admin', club: 'College Green', league: 'stockport' } },
  // Not a role-holder at all — must not appear anywhere.
  { user_id: 'auth0|5', email: 'nobody@example.com', logins_count: 1, last_login: null,
    app_metadata: { betaAccess: true } },
];

function stubTenant() {
  mock.method(Auth, 'listUsers', async () => TENANT);
  setModel('Club', 'getAll', (cb) => cb(null, CLUBS));
  setModel('Player', 'getAllWithSiteRole', async () => []);
  setModel('Player', 'getAuthRoleByEmail', async () => undefined);
  setModel('Player', 'getByPlayerEmail', async (email) =>
    email === 'matched@example.com'
      ? { id: 77, first_name: 'Match', family_name: 'Ed', clubName: 'Aerospace', teamName: 'Aerospace A' }
      : undefined);
}

describe('gating', () => {
  it('unauthenticated -> 302 /login', async () => {
    delete process.env.DEV_MODE;
    const res = await request(app).get('/admin/link-auth-accounts');
    assert.strictEqual(res.status, 302);
    assert.match(res.headers.location, /\/login/);
  });

  it('a club admin gets 403, not the worklist', async () => {
    process.env.DEV_MODE = 'true';
    process.env.DEV_ROLE = 'admin';
    process.env.DEV_CLUB = 'Hyde';
    try {
      const res = await request(app).get('/admin/link-auth-accounts');
      assert.strictEqual(res.status, 403);
    } finally {
      delete process.env.DEV_MODE;
      delete process.env.DEV_ROLE;
      delete process.env.DEV_CLUB;
    }
  });
});

describe('worklist classification', () => {
  before(() => { process.env.DEV_MODE = 'true'; });
  after(() => { delete process.env.DEV_MODE; });

  it('splits ours / other league / ambiguous, and ignores non-role-holders', async () => {
    stubTenant();
    const { _buildWorklistForTesting } = require('../../controllers/authLinkController');
    const data = await _buildWorklistForTesting();

    assert.deepStrictEqual(data.ours.map(e => e.email).sort(),
      ['matched@example.com', 'ours@example.com']);
    assert.deepStrictEqual(data.otherLeague.map(e => e.email), ['stockport@example.com']);
    // Held back for a human: league says stockport but the club exists here too.
    assert.deepStrictEqual(data.ambiguous.map(e => e.email), ['both@example.com']);
    // betaAccess alone is not authorization.
    const all = [...data.ours, ...data.otherLeague, ...data.ambiguous].map(e => e.email);
    assert.ok(!all.includes('nobody@example.com'));
  });

  it('proposes a link where the login email matches a contact email', async () => {
    stubTenant();
    const { _buildWorklistForTesting } = require('../../controllers/authLinkController');
    const data = await _buildWorklistForTesting();

    const matched = data.ours.find(e => e.email === 'matched@example.com');
    assert.strictEqual(matched.proposed.id, 77);
    // The proposal's club agrees with the claim, which is the strong case.
    assert.strictEqual(matched.proposed.clubMatchesClaim, true);

    const unmatched = data.ours.find(e => e.email === 'ours@example.com');
    assert.strictEqual(unmatched.proposed, null);
  });

  it('renders with the real counts', async () => {
    stubTenant();
    const res = await request(app).get('/admin/link-auth-accounts');
    assert.strictEqual(res.status, 200);
    assert.match(res.text, /0 of 2 linked/);
    assert.match(res.text, /Needs a decision \(1\)/);
    assert.match(res.text, /Other league — not our work \(1\)/);
  });
});

describe('linking', () => {
  before(() => { process.env.DEV_MODE = 'true'; });
  after(() => { delete process.env.DEV_MODE; });

  it('writes the role from the TENANT, not from the form body', async () => {
    // The security property that matters here. The form is a worklist; if it were also
    // the authority on what role to grant, a tampered POST could mint a superadmin.
    stubTenant();
    let seen;
    setModel('Player', 'setAuthRole', async (id, opts) => { seen = { id, opts }; return [{ id }]; });

    const res = await request(app)
      .post('/admin/link-auth-accounts')
      .type('form')
      .send({ email: 'ours@example.com', playerId: '42', role: 'superadmin', statsAccess: '1' });

    assert.strictEqual(res.status, 302);
    assert.strictEqual(seen.id, 42);
    assert.strictEqual(seen.opts.role, 'admin');        // tenant says admin
    assert.strictEqual(seen.opts.statsAccess, false);   // tenant has no stats flag
    // The whole point: record the address this identity logs in with.
    assert.strictEqual(seen.opts.authEmail, 'ours@example.com');
  });

  it('carries the stats flag when the tenant has it', async () => {
    stubTenant();
    let seen;
    setModel('Player', 'setAuthRole', async (id, opts) => { seen = { id, opts }; return [{ id }]; });

    await request(app).post('/admin/link-auth-accounts').type('form')
      .send({ email: 'matched@example.com', playerId: '77' });
    assert.strictEqual(seen.opts.statsAccess, true);
  });

  it('refuses an other-league account even if posted directly', async () => {
    stubTenant();
    setModel('Player', 'setAuthRole', async () => { throw new Error('must not write'); });
    const res = await request(app).post('/admin/link-auth-accounts').type('form')
      .send({ email: 'stockport@example.com', playerId: '42' });
    assert.strictEqual(res.status, 400);
  });

  it('refuses an ambiguous account — those need a human, not a form', async () => {
    stubTenant();
    setModel('Player', 'setAuthRole', async () => { throw new Error('must not write'); });
    const res = await request(app).post('/admin/link-auth-accounts').type('form')
      .send({ email: 'both@example.com', playerId: '42' });
    assert.strictEqual(res.status, 400);
  });

  it('404s an email that is not in the tenant', async () => {
    stubTenant();
    setModel('Player', 'setAuthRole', async () => { throw new Error('must not write'); });
    const res = await request(app).post('/admin/link-auth-accounts').type('form')
      .send({ email: 'invented@example.com', playerId: '42' });
    assert.strictEqual(res.status, 404);
  });

  it('400s without a player', async () => {
    stubTenant();
    const res = await request(app).post('/admin/link-auth-accounts').type('form')
      .send({ email: 'ours@example.com' });
    assert.strictEqual(res.status, 400);
  });
});
