// Route-level gating for the two holes closed alongside the Auth0 -> DB authorization
// move. Both were reachable before, and both sit on the path that now grants site
// roles, so a regression here is privilege escalation rather than a broken page.
//
//   GET  /player/:id/update   had NO auth gate at all — the form shows decrypted
//                             email and phone, and now the role controls too.
//   POST /player/:id          had `secured` only, i.e. "any logged-in user may
//                             rewrite any player".
//   GET  /approve-user/:id    had no gate, and did every side effect on a GET, so a
//                             mail scanner prefetching the link could approve someone.
//
// Uses the no-DB model seam in ../helpers/app, and DEV_MODE for the authenticated
// superadmin case (middleware/devMode.js injects a mock superadmin).
const { describe, it, before, after, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { app, setModel, clearModels } = require('../helpers/app');

afterEach(() => { clearModels(); mock.restoreAll(); });

// A player row as getPlayerDetailsbyId returns it, including the clubName the
// per-row authorization check compares against the club claim.
const PLAYER = {
  id: 42, first_name: 'Alice', family_name: 'Cooper', gender: 'Female',
  playerEmail: 'alice@example.com', playerTel: '01610000000',
  club: 7, clubName: 'Hyde',
  teamCaptain: 0, clubSecretary: 0, matchSecrertary: 0, treasurer: 0, otherComms: 0,
  role: null, statsAccess: 0,
};

describe('unauthenticated: both routes redirect to login', () => {
  before(() => { delete process.env.DEV_MODE; });

  it('GET /player/42/update -> 302 /login (was ungated entirely)', async () => {
    const res = await request(app).get('/player/42/update');
    assert.strictEqual(res.status, 302);
    assert.match(res.headers.location, /\/login/);
  });

  it('GET /approve-user/:id -> 302 /login (was ungated entirely)', async () => {
    const res = await request(app).get('/approve-user/auth0%7Cabc123');
    assert.strictEqual(res.status, 302);
    assert.match(res.headers.location, /\/login/);
  });

  it('POST /approve-user/:id -> 302 /login', async () => {
    const res = await request(app).post('/approve-user/auth0%7Cabc123').send({ playerId: '42' });
    assert.strictEqual(res.status, 302);
    assert.match(res.headers.location, /\/login/);
  });
});

describe('superadmin (DEV_MODE): the player edit form', () => {
  before(() => { process.env.DEV_MODE = 'true'; });
  after(() => { delete process.env.DEV_MODE; });

  it('renders, and shows the superadmin-only role controls', async () => {
    setModel('Player', 'getPlayerDetailsbyId', (id, cb) => cb(null, [PLAYER]));
    const res = await request(app).get('/player/42/update');
    assert.strictEqual(res.status, 200);
    // canEditRole is true for a superadmin, so both controls render.
    assert.match(res.text, /name="role"/);
    assert.match(res.text, /name="statsAccess"/);
    // And the checkbox that was silently cleared on every save before.
    assert.match(res.text, /name="otherComms"/);
  });

  it('404s an unknown player instead of crashing the view', async () => {
    setModel('Player', 'getPlayerDetailsbyId', (id, cb) => cb(null, []));
    const res = await request(app).get('/player/999/update');
    assert.strictEqual(res.status, 404);
  });

  it('POST writes the role fields through setAuthRole', async () => {
    setModel('Player', 'getPlayerDetailsbyId', (id, cb) => cb(null, [PLAYER]));
    setModel('Player', 'updateBulk', (patch, cb) => cb(null, [{ id: 42 }]));
    let seen;
    setModel('Player', 'setAuthRole', async (id, opts) => { seen = { id, opts }; return [{ id }]; });

    const res = await request(app)
      .post('/player/42')
      .type('form')
      .send({ first_name: 'Alice', family_name: 'Cooper', gender: 'Female', role: 'admin', statsAccess: '1' });

    assert.strictEqual(res.status, 302);
    assert.strictEqual(seen.id, '42');
    assert.strictEqual(seen.opts.role, 'admin');
    assert.strictEqual(seen.opts.statsAccess, true);
    // Never from this form: it's the link the login lookup matches on, and this form
    // knows nothing about it.
    assert.strictEqual(seen.opts.authEmail, undefined);
  });

  it('POST includes otherComms in the patched fields', async () => {
    setModel('Player', 'getPlayerDetailsbyId', (id, cb) => cb(null, [PLAYER]));
    let patched;
    setModel('Player', 'updateBulk', (patch, cb) => { patched = patch; cb(null, []); });
    setModel('Player', 'setAuthRole', async () => []);

    await request(app).post('/player/42').type('form').send({ otherComms: '1' });
    assert.ok(patched.fields.includes('otherComms'), 'otherComms must be persisted');
    assert.strictEqual(patched.data[0][patched.fields.indexOf('otherComms')], 1);
  });
});

// DEV_ROLE/DEV_CLUB drive middleware/devMode.js's mock, which builds its claims
// through the same authz.applyRoleClaims a real login uses.
describe('club-scoped admin: may edit own club only, and cannot self-promote', () => {
  before(() => {
    process.env.DEV_MODE = 'true';
    process.env.DEV_ROLE = 'admin';
    process.env.DEV_CLUB = 'Hyde';
  });
  after(() => {
    delete process.env.DEV_MODE;
    delete process.env.DEV_ROLE;
    delete process.env.DEV_CLUB;
  });

  it('may open a player in their own club', async () => {
    setModel('Player', 'getPlayerDetailsbyId', (id, cb) => cb(null, [PLAYER]));
    const res = await request(app).get('/player/42/update');
    assert.strictEqual(res.status, 200);
    // canEditRole is false, so the site-role controls must not render at all.
    assert.doesNotMatch(res.text, /name="role"/);
    assert.doesNotMatch(res.text, /name="statsAccess"/);
  });

  it('403s on a player in another club', async () => {
    setModel('Player', 'getPlayerDetailsbyId', (id, cb) =>
      cb(null, [{ ...PLAYER, clubName: 'Aerospace' }]));
    const res = await request(app).get('/player/42/update');
    assert.strictEqual(res.status, 403);
  });

  it('POST to another club\'s player writes nothing', async () => {
    setModel('Player', 'getPlayerDetailsbyId', (id, cb) =>
      cb(null, [{ ...PLAYER, clubName: 'Aerospace' }]));
    setModel('Player', 'updateBulk', () => { throw new Error('must not write'); });
    const res = await request(app).post('/player/42').type('form').send({ first_name: 'Hacked' });
    assert.strictEqual(res.status, 403);
  });

  it('cannot grant itself a role by POSTing the field by hand', async () => {
    // The view hides the control, but hiding a field is not a security boundary — a
    // club admin can still craft the request. setAuthRole must never be reached.
    setModel('Player', 'getPlayerDetailsbyId', (id, cb) => cb(null, [PLAYER]));
    setModel('Player', 'updateBulk', (patch, cb) => cb(null, []));
    setModel('Player', 'setAuthRole', async () => { throw new Error('privilege escalation'); });

    const res = await request(app)
      .post('/player/42')
      .type('form')
      .send({ first_name: 'Alice', role: 'superadmin', statsAccess: '1' });

    // Redirects (the ordinary edit succeeded) but the role fields were ignored.
    assert.strictEqual(res.status, 302);
  });

  it('is refused by the approval flow, which is superadmin-only', async () => {
    const res = await request(app).get('/approve-user/auth0%7Cabc123');
    assert.strictEqual(res.status, 403);
  });
});

describe('the approval flow is superadmin-only and side-effect-free on GET', () => {
  before(() => { process.env.DEV_MODE = 'true'; });
  after(() => { delete process.env.DEV_MODE; });

  it('GET renders the approve page without writing anything', async () => {
    const Auth = require('../../models/auth');
    mock.method(Auth, 'getUserByAuthId', async () => ({
      user_id: 'auth0|abc123', email: 'new@example.com', name: 'New Person'
    }));
    // Would throw if the GET tried to write a role.
    setModel('Player', 'setAuthRole', async () => { throw new Error('GET must not write'); });
    setModel('Player', 'getAuthRoleByEmail', async () => undefined);

    const res = await request(app).get('/approve-user/auth0%7Cabc123');
    assert.strictEqual(res.status, 200);
    assert.match(res.text, /new@example\.com/);
    assert.match(res.text, /Approve/);
  });

  it('GET warns when the email is already linked to a player', async () => {
    const Auth = require('../../models/auth');
    mock.method(Auth, 'getUserByAuthId', async () => ({ email: 'new@example.com' }));
    setModel('Player', 'getAuthRoleByEmail', async () => ({
      id: 7, first_name: 'Bob', family_name: 'Briggs', clubName: 'Hyde',
      role: 'admin', statsAccess: 0
    }));

    const res = await request(app).get('/approve-user/auth0%7Cabc123');
    assert.strictEqual(res.status, 200);
    assert.match(res.text, /already resolves to/);
    assert.match(res.text, /Bob Briggs/);
  });

  it('POST without a chosen player is rejected before any Auth0 call', async () => {
    const Auth = require('../../models/auth');
    mock.method(Auth, 'getUserByAuthId', async () => { throw new Error('must not be called'); });
    const res = await request(app).post('/approve-user/auth0%7Cabc123').type('form').send({});
    assert.strictEqual(res.status, 400);
  });
});
