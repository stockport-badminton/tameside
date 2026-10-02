// The team-admin add-player search and create (views/AddCreatePlayerModal.ejs), after
// utils/nameMatch.js replaced first-letter + edit-distance-10 matching. Models stubbed.
const { describe, it, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { app, setModel, clearModels } = require('../helpers/app');

afterEach(() => { clearModels(); mock.restoreAll(); });

function asUser({ role, club } = {}, fn) {
  return async () => {
    const saved = { DEV_MODE: process.env.DEV_MODE, DEV_ROLE: process.env.DEV_ROLE, DEV_CLUB: process.env.DEV_CLUB };
    if (role === undefined) delete process.env.DEV_MODE;
    else { process.env.DEV_MODE = 'true'; process.env.DEV_ROLE = role; if (club) process.env.DEV_CLUB = club; else delete process.env.DEV_CLUB; }
    try { await fn(); } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  };
}

// Two of the real near-miss pairs found in the player table on 2026-10-02.
const PLAYERS = [
  { playerId: 11, name: 'Edward Higton', gender: 'Male', clubId: 5, clubName: 'Manchester Edgeley' },
  { playerId: 12, name: 'Wahab Siddiqui', gender: 'Male', clubId: 63, clubName: 'No Club' },
  { playerId: 13, name: 'Tom Tang', gender: 'Male', clubId: 2, clubName: 'Hyde' },
];
const stubPlayers = () => setModel('Player', 'allForMatching', async ({ gender } = {}) => PLAYERS.filter(p => !gender || p.gender === gender));

describe('GET /players/matching/:name/:gender', () => {
  it('finds a typo in the FIRST letter, which the old first-letter filter could not', async () => {
    stubPlayers();
    const res = await request(app).get('/players/matching/' + encodeURIComponent('Wahab Siddiqi') + '/Male');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.map(r => r.playerID), [12]);
    assert.strictEqual(res.body[0].clubName, 'No Club');
  });

  it('knows nicknames, in either word order', async () => {
    stubPlayers();
    const res = await request(app).get('/players/matching/' + encodeURIComponent('Higton Ed') + '/Male');
    assert.deepStrictEqual(res.body.map(r => r.name), ['Edward Higton']);
  });

  it('offers no strangers for a short name', async () => {
    stubPlayers();
    const res = await request(app).get('/players/matching/' + encodeURIComponent('Tom Long') + '/Male');
    assert.deepStrictEqual(res.body, []);
  });
});

describe('POST /manage-players/create', () => {
  const body = { first_name: 'Ed', family_name: ' Higton', team: '7', club: '5', gender: 'Male' };
  const stubClub = (name = 'Manchester Edgeley') => setModel('Club', 'nameById', async () => name);

  it('needs a login', asUser({}, async () => {
    assert.strictEqual((await request(app).post('/manage-players/create').type('form').send(body)).status, 302);
  }));

  for (const [label, who] of [['a member', { role: 'none' }], ['another club\'s admin', { role: 'admin', club: 'Hyde' }]]) {
    it(`refuses ${label}, and creates nothing`, asUser(who, async () => {
      stubClub(); stubPlayers();
      let created = 0;
      setModel('Player', 'create', (...a) => { created++; a[a.length - 1](null, [{ id: 1 }]); });
      const res = await request(app).post('/manage-players/create').type('form').send(body);
      assert.strictEqual(res.status, 403);
      assert.strictEqual(created, 0);
    }));
  }

  it('answers 409 with the likely existing player, and creates nothing', asUser({ role: 'admin', club: 'Manchester Edgeley' }, async () => {
    stubClub(); stubPlayers();
    let created = 0;
    setModel('Player', 'create', (...a) => { created++; a[a.length - 1](null, [{ id: 1 }]); });
    const res = await request(app).post('/manage-players/create').type('form').send(body);
    assert.strictEqual(res.status, 409);
    assert.deepStrictEqual(res.body.possibleDuplicates.map(p => p.name), ['Edward Higton']);
    assert.strictEqual(created, 0);
  }));

  it('creates after confirmNew, trimmed, and answers the insertId the modal reads', asUser({ role: 'superadmin' }, async () => {
    stubClub(); stubPlayers();
    let args;
    setModel('Player', 'create', (...a) => { args = a; a[a.length - 1](null, [{ id: 4321 }]); });
    const res = await request(app).post('/manage-players/create').type('form').send({ ...body, confirmNew: 'true' });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { insertId: 4321 });
    assert.deepStrictEqual(args.slice(0, 2), ['Ed', 'Higton']);
  }));

  it('creates straight away when nobody similar exists', asUser({ role: 'superadmin' }, async () => {
    stubClub(); stubPlayers();
    setModel('Player', 'create', (...a) => a[a.length - 1](null, [{ id: 99 }]));
    const res = await request(app).post('/manage-players/create').type('form').send({ ...body, first_name: 'Zara', family_name: 'Quint' });
    assert.strictEqual(res.status, 200);
  }));

  it('a missing name is a 400', asUser({ role: 'superadmin' }, async () => {
    stubClub(); stubPlayers();
    assert.strictEqual((await request(app).post('/manage-players/create').type('form').send({ ...body, family_name: '  ' })).status, 400);
  }));
});
