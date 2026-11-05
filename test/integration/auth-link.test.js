// /admin/link-auth-accounts — which player is each login (controllers/authLinkController.js).
//
// Widened in Nov 2026 from the August role-migration worklist to every account that can
// log in. The Auth0 tenant is shared with the Stockport league site, so most accounts in
// it are not ours, and Stockport approving someone lets them log in here. The properties
// that matter: a superadmin makes every link, the account comes from the tenant rather
// than the form, and linking never writes a role.
const { describe, it, before, after, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { app, setModel, clearModels } = require('../helpers/app');
const Auth = require('../../models/auth');

afterEach(() => { clearModels(); mock.restoreAll(); });

const NOW = Date.parse('2026-11-05T12:00:00Z');
const RECENT = '2026-10-01T00:00:00Z';
const LONG_AGO = '2023-09-01T00:00:00Z';

const CLUBS = [{ id: 1, name: 'Hyde' }, { id: 2, name: 'Aerospace' }, { id: 63, name: 'No Club' }];

const TENANT = [
  // Linked by account id.
  { user_id: 'auth0|linked', email: 'linked@example.com', logins_count: 5, last_login: RECENT,
    app_metadata: { betaAccess: true } },
  // Linked by address only: approve page or the August backfill.
  { user_id: 'google-oauth2|addr', email: 'addr@example.com', logins_count: 2, last_login: RECENT,
    app_metadata: { betaAccess: true } },
  // Ours, unlinked, and the login address is a player's contact address.
  { user_id: 'auth0|contact', email: 'contact@example.com', logins_count: 9, last_login: RECENT,
    app_metadata: { betaAccess: true, role: 'admin', club: 'Hyde' } },
  // Unlinked, with a real name in Auth0.
  { user_id: 'auth0|named', email: 'dl@example.com', given_name: 'Dave', family_name: 'Lee',
    logins_count: 3, last_login: RECENT, app_metadata: { betaAccess: true } },
  // Stockport: an old claim over a club we don't have.
  { user_id: 'auth0|stockport', email: 'stockport@example.com', logins_count: 3, last_login: RECENT,
    app_metadata: { betaAccess: true, role: 'admin', club: 'Cheadle Hulme' } },
  // Stockport: signed up on their site, no claim.
  { user_id: 'auth0|signup', email: 'signup@example.com', logins_count: 1, last_login: RECENT,
    app_metadata: { betaAccess: true, league: 'stockport' } },
  // No login for three years.
  { user_id: 'auth0|stale', email: 'stale@example.com', logins_count: 4, last_login: LONG_AGO,
    app_metadata: { betaAccess: true } },
  // Never approved, never logged in, long ago.
  { user_id: 'auth0|pending', email: 'pending@example.com', logins_count: 0, last_login: null,
    created_at: LONG_AGO, app_metadata: {} },
  // Its address is recorded against two different players: not a link.
  { user_id: 'auth0|dup', email: 'dup@example.com', logins_count: 1, last_login: RECENT,
    app_metadata: { betaAccess: true } },
];

const PLAYER = (id, first, family, clubName, teamName) =>
  ({ id, first_name: first, family_name: family, clubName, teamName, role: null });

function stubTenant() {
  mock.method(Auth, 'listUsers', async () => TENANT);
  setModel('Club', 'getAll', (cb) => cb(null, CLUBS));
  // The page also shows the login cull (controllers/authCullController.js).
  setModel('AuthCull', 'getAll', async () => new Map());
  setModel('Player', 'getAuthAccountIndex', async () => ([
    { userId: 'auth0|linked', ...PLAYER(1, 'Lin', 'Ked', 'Hyde') },
  ]));
  setModel('Player', 'getAuthEmailIndex', async () => ([
    { email: 'addr@example.com', ...PLAYER(2, 'Ad', 'Dress', 'Aerospace') },
    { email: 'dup@example.com', ...PLAYER(3, 'One', 'Person', 'Hyde') },
    { email: 'dup@example.com', ...PLAYER(4, 'Other', 'Person', 'Hyde') },
  ]));
  setModel('Player', 'getContactEmailIndex', async () => ([
    { ...PLAYER(77, 'Con', 'Tact', 'Hyde', 'Hyde A'), playerEmail: 'contact@example.com' },
  ]));
  setModel('Player', 'getNameIndex', async () => ([
    PLAYER(10, 'Dave', 'Lee', 'Hyde', 'Hyde B'),
    // A parked namesake, as the October seed clean-up left ~200 of.
    PLAYER(11, 'Dave', 'Lee', 'No Club', 'No Team'),
    PLAYER(12, 'Someone', 'Else', 'Hyde', 'Hyde A'),
  ]));
}

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
const SUPERADMIN = { DEV_MODE: 'true', DEV_ROLE: 'superadmin' };
const CLUB_ADMIN = { DEV_MODE: 'true', DEV_ROLE: 'admin', DEV_CLUB: 'Hyde' };

function noWrites() {
  for (const m of ['linkAuthAccount', 'unlinkAuthAccount', 'setAuthRole']) {
    setModel('Player', m, async () => { throw new Error(m + ' must not be called'); });
  }
}

async function worklist() {
  const { _buildWorklistForTesting } = require('../../controllers/authLinkController');
  return _buildWorklistForTesting({ now: NOW });
}

describe('gating', () => {
  it('unauthenticated -> 302 /login', asUser({}, async () => {
    const res = await request(app).get('/admin/link-auth-accounts');
    assert.strictEqual(res.status, 302);
    assert.match(res.headers.location, /\/login/);
  }));

  for (const [method, url] of [
    ['get', '/admin/link-auth-accounts'],
    ['post', '/admin/link-auth-accounts'],
    ['post', '/admin/link-auth-accounts/unlink'],
    ['post', '/admin/link-auth-accounts/record-email-links'],
  ]) {
    it(`a club admin gets 403 from ${method.toUpperCase()} ${url}, and nothing is written`, asUser(CLUB_ADMIN, async () => {
      stubTenant();
      noWrites();
      const res = await request(app)[method](url).type('form').send({ userId: 'auth0|named', playerId: '10' });
      assert.strictEqual(res.status, 403);
    }));
  }
});

describe('worklist', () => {
  before(() => { process.env.DEV_MODE = 'true'; });
  after(() => { delete process.env.DEV_MODE; });

  it('sorts every approved account into exactly one group', async () => {
    stubTenant();
    const data = await worklist();
    const ids = list => list.map(e => e.userId).sort();
    assert.deepStrictEqual(ids(data.linked), ['auth0|linked']);
    assert.deepStrictEqual(ids(data.emailOnly), ['google-oauth2|addr']);
    assert.deepStrictEqual(ids(data.needsPlayer), ['auth0|contact', 'auth0|dup', 'auth0|named']);
    assert.deepStrictEqual(ids(data.otherLeague), ['auth0|signup', 'auth0|stockport']);
    assert.deepStrictEqual(ids(data.stale), ['auth0|stale']);
    assert.strictEqual(data.canLogIn, 8);
    // Not approved: counted, never listed. It can't log in.
    assert.strictEqual(data.notApproved, 1);
    assert.strictEqual(data.staleNotApproved, 1);
  });

  it('an address recorded against two players is not a link', async () => {
    stubTenant();
    const data = await worklist();
    assert.ok(data.needsPlayer.some(e => e.userId === 'auth0|dup'));
  });

  it('offers the contact-address match first', async () => {
    stubTenant();
    const data = await worklist();
    const e = data.needsPlayer.find(x => x.userId === 'auth0|contact');
    assert.strictEqual(e.contactMatch.id, 77);
  });

  it('hints by name, and labels a parked namesake', async () => {
    stubTenant();
    const data = await worklist();
    const e = data.needsPlayer.find(x => x.userId === 'auth0|named');
    assert.deepStrictEqual(e.hints.map(h => [h.id, h.parked]), [[10, false], [11, true]]);
  });

  it('gives no hints when Auth0 has no real name (a password signup\'s name is its address)', async () => {
    stubTenant();
    const data = await worklist();
    const e = data.needsPlayer.find(x => x.userId === 'auth0|dup');
    assert.strictEqual(e.name, null);
    assert.deepStrictEqual(e.hints, []);
  });

  it('renders', asUser(SUPERADMIN, async () => {
    stubTenant();
    const res = await request(app).get('/admin/link-auth-accounts');
    assert.strictEqual(res.status, 200);
    assert.match(res.text, /2 of 8 logins linked/);
    assert.match(res.text, /Needs a player \(3\)/);
    assert.match(res.text, /Probably Stockport&#39;s \(2\)|Probably Stockport's \(2\)/);
    assert.match(res.text, /Record 1 account links/);
  }));
});

describe('linking', () => {
  it('links the account the TENANT names, and never writes a role', asUser(SUPERADMIN, async () => {
    stubTenant();
    noWrites();
    let seen;
    setModel('Player', 'linkAuthAccount', async (id, opts) => { seen = { id, opts }; return [{ id }]; });

    const res = await request(app).post('/admin/link-auth-accounts').type('form')
      .send({ userId: 'auth0|named', playerId: '10', email: 'forged@example.com', role: 'superadmin' });

    assert.strictEqual(res.status, 302);
    assert.strictEqual(seen.id, 10);
    assert.deepStrictEqual(seen.opts, { userId: 'auth0|named', email: 'dl@example.com' });
  }));

  it('404s an account that is not in the tenant', asUser(SUPERADMIN, async () => {
    stubTenant();
    noWrites();
    const res = await request(app).post('/admin/link-auth-accounts').type('form')
      .send({ userId: 'auth0|invented', playerId: '10' });
    assert.strictEqual(res.status, 404);
  }));

  it('400s without a player', asUser(SUPERADMIN, async () => {
    stubTenant();
    noWrites();
    const res = await request(app).post('/admin/link-auth-accounts').type('form')
      .send({ userId: 'auth0|named' });
    assert.strictEqual(res.status, 400);
  }));

  it('400s a player id that does not exist', asUser(SUPERADMIN, async () => {
    stubTenant();
    setModel('Player', 'linkAuthAccount', async () => {
      const err = new Error('insert or update violates foreign key constraint');
      err.code = '23503';
      throw err;
    });
    const res = await request(app).post('/admin/link-auth-accounts').type('form')
      .send({ userId: 'auth0|named', playerId: '999999' });
    assert.strictEqual(res.status, 400);
  }));

  it('unlinks with the tenant\'s address for that account', asUser(SUPERADMIN, async () => {
    stubTenant();
    noWrites();
    let seen;
    setModel('Player', 'unlinkAuthAccount', async (userId, email) => { seen = [userId, email]; return []; });
    const res = await request(app).post('/admin/link-auth-accounts/unlink').type('form')
      .send({ userId: 'auth0|linked', email: 'forged@example.com' });
    assert.strictEqual(res.status, 302);
    assert.deepStrictEqual(seen, ['auth0|linked', 'linked@example.com']);
  }));

  it('records account ids for exactly the address-only links, whatever the form says', asUser(SUPERADMIN, async () => {
    stubTenant();
    noWrites();
    const seen = [];
    setModel('Player', 'linkAuthAccount', async (id, opts) => { seen.push([id, opts.userId]); return [{ id }]; });
    const res = await request(app).post('/admin/link-auth-accounts/record-email-links').type('form')
      .send({ userId: 'auth0|named', playerId: '1' });
    assert.strictEqual(res.status, 302);
    assert.deepStrictEqual(seen, [[2, 'google-oauth2|addr']]);
  }));
});
