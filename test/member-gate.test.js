// `member` means a Tameside login (Nov 2026), not merely a login: linked to a Tameside
// player, or holding a site role. The Auth0 tenant is shared with Stockport, so their
// approvals let their players log in here (22 of 112 accounts, Nov 2026).
//
// Driven against middleware/secured.js directly, because the third state — link unknown,
// from an old session or a lookup that failed at login — cannot be produced through the
// dev login, and it is the one that must not lock a captain out.
const { describe, it } = require('node:test');
const assert = require('node:assert');

const { secured, securedApi } = require('../middleware/secured');
const authz = require('../utils/authz');

function fakeReq({ loggedIn = true, role, tameside } = {}) {
  const user = { _json: {} };
  if (role) user._json[authz.ROLE_CLAIM] = role;
  if (tameside !== undefined) user.tameside = tameside;
  return { isAuthenticated: () => loggedIn, user: loggedIn ? user : undefined, session: {}, originalUrl: '/email-scorecard' };
}

function fakeRes() {
  const res = { headers: {} };
  res.set = (k, v) => { res.headers[k] = v; return res; };
  res.status = (s) => { res.statusCode = s; return res; };
  res.redirect = (to) => { res.redirectedTo = to; return res; };
  res.render = (view) => { res.view = view; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

function run(mw, req) {
  const res = fakeRes();
  let passed = false;
  mw(req, res, () => { passed = true; });
  return { res, passed };
}

describe('secured (the member gate)', () => {
  it('a stranger is sent to log in', () => {
    const { res, passed } = run(secured, fakeReq({ loggedIn: false }));
    assert.strictEqual(passed, false);
    assert.strictEqual(res.redirectedTo, '/login');
  });

  it('a login linked to a player passes', () => {
    assert.strictEqual(run(secured, fakeReq({ tameside: { playerId: 7, club: 'Hyde' } })).passed, true);
  });

  it('a linked player at No Club passes: linked is what counts, not the club', () => {
    assert.strictEqual(run(secured, fakeReq({ tameside: { playerId: 7, club: null } })).passed, true);
  });

  it('a role-holder passes even unlinked (the results mailbox is a superadmin, not a player)', () => {
    assert.strictEqual(run(secured, fakeReq({ role: 'superadmin', tameside: null })).passed, true);
    assert.strictEqual(run(secured, fakeReq({ role: 'admin', tameside: null })).passed, true);
  });

  it('an unlinked login (a Stockport account, say) is refused with the not-linked page', () => {
    const { res, passed } = run(secured, fakeReq({ tameside: null }));
    assert.strictEqual(passed, false);
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.view, 'not-linked');
    assert.match(res.headers['Cache-Control'], /no-store/);
  });

  it('an unknown link gets one fresh login, then is let through', () => {
    const req = fakeReq();                       // no `tameside` at all
    const first = run(secured, req);
    assert.strictEqual(first.passed, false);
    assert.strictEqual(first.res.redirectedTo, '/login');
    assert.strictEqual(req.session.returnTo, '/email-scorecard');
    // Still unknown after logging in again (the lookup failed twice): a DB blip must not
    // lock a captain out of result entry.
    assert.strictEqual(run(secured, req).passed, true);
  });
});

describe('securedApi', () => {
  it('a stranger gets a 401', () => {
    assert.strictEqual(run(securedApi, fakeReq({ loggedIn: false })).res.statusCode, 401);
  });

  it('an unlinked login gets a 403 it can read', () => {
    const { res, passed } = run(securedApi, fakeReq({ tameside: null }));
    assert.strictEqual(passed, false);
    assert.strictEqual(res.statusCode, 403);
    assert.match(res.body.error, /linked/);
  });

  it('a linked login, a role-holder and an unknown link pass', () => {
    assert.strictEqual(run(securedApi, fakeReq({ tameside: { playerId: 7, club: 'Hyde' } })).passed, true);
    assert.strictEqual(run(securedApi, fakeReq({ role: 'admin', tameside: null })).passed, true);
    assert.strictEqual(run(securedApi, fakeReq()).passed, true);
  });
});
