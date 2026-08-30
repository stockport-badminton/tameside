// Authorization lives on the player table, not in Auth0 app_metadata
// (migrations/player-auth-roles.sql). utils/authz.js is both ends of that interface:
// applyRoleClaims() fills the three claim keys at login, and the readers below are
// what ~46 call sites and four views ask.
//
// The claim KEY STRINGS are the thing under test as much as the logic. Keeping them
// unchanged is what let the source swap from Auth0 to Postgres without touching every
// reader — so if one is renamed, every view that still spells it out longhand breaks
// silently, with no error and no failing page: an admin just quietly stops being an
// admin. Hence the literal strings here rather than referencing the constants.
const { describe, it } = require('node:test');
const assert = require('node:assert');

const authz = require('../utils/authz');

const ROLE = 'https://my-app.example.com/role';
const CLUB = 'https://my-app.example.com/club';
const STATS = 'https://my-app.example.com/stats';

const reqWith = (json) => ({ user: { _json: json } });

describe('authz claim keys', () => {
  it('are the exact strings the views spell out longhand', () => {
    assert.strictEqual(authz.ROLE_CLAIM, ROLE);
    assert.strictEqual(authz.CLUB_CLAIM, CLUB);
    assert.strictEqual(authz.STATS_CLAIM, STATS);
    // Pre-existing export, kept so older call sites don't break.
    assert.strictEqual(authz.SUPERADMIN_CLAIM, ROLE);
  });
});

describe('applyRoleClaims — player row to claims', () => {
  it('superadmin gets club "All", not a club name', () => {
    const json = {};
    authz.applyRoleClaims(json, { role: 'superadmin', clubName: 'Aerospace', statsAccess: 0 });
    assert.strictEqual(json[ROLE], 'superadmin');
    // A superadmin has no single club. Anything interpolating this into a URL must
    // branch on it first — see the note in applyRoleClaims.
    assert.strictEqual(json[CLUB], 'All');
  });

  it('admin is scoped to their own club, from the player row', () => {
    const json = {};
    authz.applyRoleClaims(json, { role: 'admin', clubName: 'Hyde', statsAccess: 0 });
    assert.strictEqual(json[ROLE], 'admin');
    assert.strictEqual(json[CLUB], 'Hyde');
  });

  it('no matching player row means no role and no club', () => {
    const json = {};
    authz.applyRoleClaims(json, undefined);
    assert.strictEqual(json[ROLE], undefined);
    assert.strictEqual(json[CLUB], undefined);
    assert.strictEqual(json[STATS], false);
  });

  it('null (the DB-failure path) is the same as no role — never more privilege', () => {
    const json = {};
    authz.applyRoleClaims(json, null);
    assert.strictEqual(json[ROLE], undefined);
    assert.strictEqual(json[CLUB], undefined);
    assert.strictEqual(json[STATS], false);
  });

  it('statsAccess is carried as a boolean, from the DB bigint 0/1', () => {
    const on = authz.applyRoleClaims({}, { role: 'admin', clubName: 'Hyde', statsAccess: 1 });
    assert.strictEqual(on[STATS], true);
    const off = authz.applyRoleClaims({}, { role: 'admin', clubName: 'Hyde', statsAccess: 0 });
    assert.strictEqual(off[STATS], false);
  });

  it('overwrites stale claims rather than leaving them behind', () => {
    // Auth0 may still be injecting its own claims while the tenant-side cleanup is
    // pending, and the tenant is shared with the Stockport site. The DB answer has to
    // win outright, including when it is "no role".
    const json = { [ROLE]: 'superadmin', [CLUB]: 'All', [STATS]: true };
    authz.applyRoleClaims(json, undefined);
    assert.strictEqual(json[ROLE], undefined);
    assert.strictEqual(json[CLUB], undefined);
    assert.strictEqual(json[STATS], false);
  });

  it('a statsAccess-only row gets stats but no role', () => {
    // getAuthRoleByEmail returns rows with role IS NOT NULL OR statsAccess = 1, so
    // this shape is reachable.
    const json = authz.applyRoleClaims({}, { role: null, clubName: 'Hyde', statsAccess: 1 });
    assert.strictEqual(json[ROLE], undefined);
    assert.strictEqual(json[CLUB], undefined);
    assert.strictEqual(json[STATS], true);
  });
});

describe('role readers', () => {
  it('isSuperAdmin only for superadmin', () => {
    assert.strictEqual(authz.isSuperAdmin(reqWith({ [ROLE]: 'superadmin' })), true);
    assert.strictEqual(authz.isSuperAdmin(reqWith({ [ROLE]: 'admin' })), false);
    assert.strictEqual(authz.isSuperAdmin(reqWith({})), false);
  });

  it('isAdmin is NOT true for a superadmin', () => {
    // Deliberate: the two branches differ everywhere they're used, so callers wanting
    // "any site role" have to say so.
    assert.strictEqual(authz.isAdmin(reqWith({ [ROLE]: 'admin' })), true);
    assert.strictEqual(authz.isAdmin(reqWith({ [ROLE]: 'superadmin' })), false);
  });

  it('survive an unauthenticated request without throwing', () => {
    for (const req of [undefined, {}, { user: {} }, { user: { _json: null } }]) {
      assert.strictEqual(authz.isSuperAdmin(req), false);
      assert.strictEqual(authz.isAdmin(req), false);
      assert.strictEqual(authz.userClub(req), undefined);
      assert.strictEqual(authz.hasStatsAccess(req), false);
    }
  });
});

describe('hasClubAccess', () => {
  it('a superadmin reaches any club', () => {
    const su = reqWith({ [ROLE]: 'superadmin', [CLUB]: 'All' });
    assert.strictEqual(authz.hasClubAccess(su, 'Hyde'), true);
    assert.strictEqual(authz.hasClubAccess(su, 'Aerospace'), true);
  });

  it('an admin reaches only their own club', () => {
    const admin = reqWith({ [ROLE]: 'admin', [CLUB]: 'Hyde' });
    assert.strictEqual(authz.hasClubAccess(admin, 'Hyde'), true);
    assert.strictEqual(authz.hasClubAccess(admin, 'Aerospace'), false);
  });

  it('a missing club argument is never a match', () => {
    // Guards the shape where a route param is absent: an admin must not end up with
    // undefined === undefined counting as access.
    assert.strictEqual(authz.hasClubAccess(reqWith({ [CLUB]: 'Hyde' }), undefined), false);
    assert.strictEqual(authz.hasClubAccess(reqWith({}), undefined), false);
    assert.strictEqual(authz.hasClubAccess(reqWith({}), 'Hyde'), false);
  });
});

describe('scopeToAdminClub', () => {
  it('pins a club admin to their own club', () => {
    const searchObj = { division: '1' };
    authz.scopeToAdminClub(reqWith({ [ROLE]: 'admin', [CLUB]: 'Hyde' }), searchObj);
    assert.deepStrictEqual(searchObj, { division: '1', club: 'Hyde' });
  });

  it('leaves a superadmin unscoped', () => {
    const searchObj = {};
    authz.scopeToAdminClub(reqWith({ [ROLE]: 'superadmin', [CLUB]: 'All' }), searchObj);
    assert.deepStrictEqual(searchObj, {});
  });

  it('leaves a no-role user unscoped', () => {
    const searchObj = {};
    authz.scopeToAdminClub(reqWith({}), searchObj);
    assert.deepStrictEqual(searchObj, {});
  });

  it('never writes the "All" sentinel in as a club name', () => {
    // 'All' is not a club, and passing it to a model would match nothing.
    const searchObj = {};
    authz.scopeToAdminClub(reqWith({ [ROLE]: 'admin', [CLUB]: 'All' }), searchObj);
    assert.deepStrictEqual(searchObj, {});
  });
});
