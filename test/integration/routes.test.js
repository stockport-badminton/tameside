// Integration tests: drive real Express routes with supertest, overriding the
// model layer (no DB) and using the DEV_MODE bypass for superadmin routes.
// Run with: npm test
const { describe, it, before, after, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { app, setModel, clearModels } = require('../helpers/app');
const seasonModel = require('../../models/season');

afterEach(() => { clearModels(); mock.restoreAll(); });

describe('routing, id constraints & auth gating', () => {
  it('GET /clubs -> 200 JSON from Club.getAll', async () => {
    setModel('Club', 'getAll', (cb) => cb(null, [{ id: 1, name: 'Aces' }]));
    const res = await request(app).get('/clubs');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body[0].name, 'Aces');
  });

  it('numeric-id constraint: GET /player/not-a-number -> 404', async () => {
    const res = await request(app).get('/player/not-a-number');
    assert.strictEqual(res.status, 404);
  });

  it('numeric-id constraint: GET /team/xyz -> 404', async () => {
    const res = await request(app).get('/team/xyz');
    assert.strictEqual(res.status, 404);
  });

  it('admin route gated: GET /admin/clubs -> 302 /login when unauthenticated', async () => {
    delete process.env.DEV_MODE;
    const res = await request(app).get('/admin/clubs');
    assert.strictEqual(res.status, 302);
    assert.match(res.headers.location, /\/login/);
  });
});

describe('superadmin admin UI via DEV_MODE (overridden models)', () => {
  before(() => { process.env.DEV_MODE = 'true'; });
  after(() => { delete process.env.DEV_MODE; });

  it('GET /admin/clubs renders the club list', async () => {
    setModel('Club', 'getAll', (cb) => cb(null, [{ id: 1, name: 'Aces' }, { id: 2, name: 'Bees' }]));
    const res = await request(app).get('/admin/clubs');
    assert.strictEqual(res.status, 200);
    assert.match(res.text, /Club Admin/);
    assert.match(res.text, /Aces/);
    assert.match(res.text, /Bees/);
  });

  it('GET /admin/teams groups teams under their division', async () => {
    setModel('Team', 'getAll', (cb) => cb(null, [{ id: 5, name: 'Aces 1', division: '8', club: 1, divRank: 1 }]));
    setModel('Division', 'getAll', (cb) => cb(null, [
      { id: '8', name: 'Division 1', league: 1, rank: 1 },
      { id: '9', name: 'Division 2', league: 1, rank: 2 },
    ]));
    setModel('Club', 'getAll', (cb) => cb(null, [{ id: 1, name: 'Aces' }]));
    const res = await request(app).get('/admin/teams');
    assert.strictEqual(res.status, 200);
    assert.match(res.text, /Division 1/);
    // team grouped under its division (division.id is a string, team.division numeric — coercion works)
    assert.match(res.text, /Aces 1/);
  });

  it('numeric-id constraint still applies under auth: GET /admin/clubs/abc -> 404', async () => {
    const res = await request(app).get('/admin/clubs/abc');
    assert.strictEqual(res.status, 404);
  });
});

describe('central error handling', () => {
  it('renders the styled 500 page (no double-fault) when a handler errors', async () => {
    mock.method(seasonModel, 'getAll', () => Promise.reject(new Error('boom')));
    const res = await request(app).get('/history');
    assert.strictEqual(res.status, 500);
    assert.match(res.text, /500 Error/);
    // regression guard: the 500 page must not itself throw (undefined `error` local)
    assert.doesNotMatch(res.text.toLowerCase(), /referenceerror/);
  });
});
