// PATCH and DELETE /club/:id are gone (Stockport HARD-49, Nov 2026).
//
// They were guarded by an express-jwt check that verified only the signature — no audience,
// no issuer — against an Auth0 tenant shared with the Stockport site, so any access token
// that tenant issued could rename or delete a Tameside club. Nothing had called either in 90
// days of request logs, so they were removed rather than repaired, along with the two
// "NOT IMPLEMENTED" GET scaffolds beside them. The admin UI (/admin/clubs) is the only
// write path, and it is superadmin-gated.

const { describe, it, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { app } = require('../helpers/app');
const Club = require('../../models/club');

afterEach(() => mock.restoreAll());

describe('retired club API routes', () => {
  for (const [method, url] of [
    ['delete', '/club/1'],
    ['patch', '/club/1'],
    ['get', '/club/1/delete'],
    ['get', '/club/1/update'],
  ]) {
    it(`${method.toUpperCase()} ${url} is a 404 and writes nothing`, async () => {
      const update = mock.method(Club, 'updateById', (...args) => args.at(-1)(null, []));
      const res = await request(app)[method](url)
        .set('Authorization', 'Bearer any.token.here')
        .send({ name: 'Renamed', venue: 1 });
      assert.strictEqual(res.status, 404);
      assert.strictEqual(update.mock.callCount(), 0);
    });
  }

  it('Club.deleteById no longer exists', () => {
    assert.strictEqual(Club.deleteById, undefined);
  });
});
