// Team management routes (controllers/rosterController.js).
//
// The access model is narrower than Stockport's, by decision (11 Oct 2026): a club admin
// may VIEW their own club's roster, contact details included; every change is superadmin
// only. So the matrix below asserts not just the status but that a refused write never
// reached the model — a 403 that had already written would pass a status-only test.
//
// models/roster is stubbed with mock.method on the module object, which works because the
// controller calls through `Roster.x` rather than destructuring.

const { describe, it, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { app } = require('../helpers/app');
const Roster = require('../../models/roster');

afterEach(() => mock.restoreAll());

function asUser({ role, club } = {}, fn) {
  return async () => {
    const saved = { DEV_MODE: process.env.DEV_MODE, DEV_ROLE: process.env.DEV_ROLE, DEV_CLUB: process.env.DEV_CLUB };
    if (role === undefined) {
      delete process.env.DEV_MODE;
    } else {
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
const ANON = {};
const ORDINARY = { role: 'none' };
const HYDE_ADMIN = { role: 'admin', club: 'Hyde' };
const SUPERADMIN = { role: 'superadmin' };

const TEAMS = [{ id: 55, name: 'Hyde A', teamRank: 1, divisionName: 'Division 1' },
  { id: 56, name: 'Hyde B', teamRank: 2, divisionName: 'Division 1' }];
const ROWS = [
  { playerId: 101, name: 'Andrew Capewell', gender: 'Male', rank: 1, teamId: 55, tel: '07700 900123', email: 'andrew@example.com' },
  { playerId: 102, name: 'Matthew Dex', gender: 'Male', rank: 100, teamId: 55, tel: null, email: null },
  { playerId: 103, name: 'Alice Cooper', gender: 'Female', rank: 1, teamId: 55, teamCaptain: 1, clubSecretary: 1, matchSecrertary: 1 },
];

// Every model call is recorded; reads answer from the fixtures above, writes succeed.
function stubRoster() {
  const calls = [];
  const rec = (name, impl) => mock.method(Roster, name, async (...args) => { calls.push(name); return impl(...args); });
  rec('getClubRoster', async (club) => (club === 'Hyde' ? ROWS : []));
  rec('getClubTeams', async (club) => (club === 'Hyde' ? TEAMS : []));
  rec('getClubSummaries', async () => [{ id: 47, name: 'Hyde', teams: 2, players: 3 }, { id: 39, name: 'Mellor', teams: 1, players: 9 }]);
  rec('getTeamOwner', async (id) => (Number(id) === 55 ? { id: 55, name: 'Hyde A', clubId: 47, clubName: 'Hyde' }
    : Number(id) === 70 ? { id: 70, name: 'Mellor A', clubId: 39, clubName: 'Mellor' } : null));
  rec('getPlayerOwner', async (id) => (Number(id) === 900 ? { id: 900, name: 'Free Agent', clubId: 63, clubName: 'No Club', gender: 'Male' }
    : { id: Number(id), name: 'Someone Else', clubId: 39, clubName: 'Mellor', gender: 'Male' }));
  rec('saveTeamOrder', async () => [{ id: 101, rank: 2 }]);
  rec('movePlayer', async (p, t) => ({ playerId: p, teamId: t, teamName: 'Hyde B', rank: 99 }));
  rec('addToTeam', async (p, t) => ({ playerId: p, teamId: t, rank: 99 }));
  rec('releasePlayer', async (p) => ({ playerId: p }));
  rec('createPlayer', async (o) => ({ playerId: 5000, name: o.firstName + ' ' + o.familyName, teamId: o.teamId, rank: 99 }));
  rec('findCandidates', async () => ({ unattached: [], otherClubs: [], ownClub: [] }));
  return calls;
}
const WRITES = ['saveTeamOrder', 'movePlayer', 'addToTeam', 'releasePlayer', 'createPlayer'];

const API = [
  ['post', '/api/teams/55/order', { sections: [{ gender: 'Male', section: 'nominated', playerIds: [101] }] }],
  ['post', '/api/players/101/move', { teamId: 56, section: 'reserve' }],
  ['post', '/api/players/101/release', {}],
  ['get', '/api/roster/club-Hyde/candidates?term=dave', null],
  ['post', '/api/roster/club-Hyde/players', { firstName: 'New', familyName: 'Person', gender: 'Male', teamId: 55, confirmNew: true }],
  ['post', '/api/roster/club-Hyde/attach', { playerId: 900, teamId: 55 }],
  ['post', '/api/roster/club-Hyde/transfer', { playerId: 777, teamId: 55 }],
];
const call = ([method, url, body]) => (method === 'get' ? request(app).get(url) : request(app).post(url).send(body));

describe('pages: who sees what', () => {
  it('anonymous is sent to log in', asUser(ANON, async () => {
    stubRoster();
    for (const url of ['/manage-players', '/manage-players/club-Hyde', '/manage-players/club-Hyde/edit']) {
      const res = await request(app).get(url);
      assert.strictEqual(res.status, 302, url);
      assert.match(res.headers.location, /\/login/, url);
    }
  }));

  it('a logged-in user with no role is refused', asUser(ORDINARY, async () => {
    stubRoster();
    assert.strictEqual((await request(app).get('/manage-players')).status, 403);
    assert.strictEqual((await request(app).get('/manage-players/club-Hyde')).status, 403);
  }));

  it('a club admin is taken to their own club and sees it, contact details included', asUser(HYDE_ADMIN, async () => {
    stubRoster();
    const picker = await request(app).get('/manage-players');
    assert.strictEqual(picker.status, 302);
    assert.strictEqual(picker.headers.location, '/manage-players/club-Hyde');

    const res = await request(app).get('/manage-players/club-Hyde');
    assert.strictEqual(res.status, 200);
    assert.match(res.text, /tel:07700900123/);
    assert.match(res.text, /mailto:andrew@example\.com/);
    assert.match(res.text, />R1</, 'a reserve at rank 100 shows as R1');
    // View only: no editor link, no drag handles.
    assert.doesNotMatch(res.text, /club-Hyde\/edit/);
    assert.doesNotMatch(res.text, /drag-handle/);
    assert.match(res.text, /contact the results secretary/);
  }));

  it('a club admin cannot see another club, or the editor for their own', asUser(HYDE_ADMIN, async () => {
    stubRoster();
    assert.strictEqual((await request(app).get('/manage-players/club-Mellor')).status, 403);
    assert.strictEqual((await request(app).get('/manage-players/club-Hyde/edit')).status, 403);
  }));

  it('a superadmin gets the picker, any roster with a Manage link, and the editor', asUser(SUPERADMIN, async () => {
    stubRoster();
    const picker = await request(app).get('/manage-players');
    assert.strictEqual(picker.status, 200);
    assert.match(picker.text, /club-Mellor\/edit/);
    const roster = await request(app).get('/manage-players/club-Hyde');
    assert.strictEqual(roster.status, 200);
    assert.match(roster.text, /club-Hyde\/edit/);
    const edit = await request(app).get('/manage-players/club-Hyde/edit');
    assert.strictEqual(edit.status, 200);
    assert.match(edit.text, /id="roster-editor"/);
    assert.match(edit.text, /\/static\/js\/roster-edit\.js\?v=/, 'the editor script is content-hashed');
  }));

  it("'All' is a superadmin's claim, not a club, and an unknown club is a 404", asUser(SUPERADMIN, async () => {
    stubRoster();
    assert.strictEqual((await request(app).get('/manage-players/club-All')).status, 404);
    assert.strictEqual((await request(app).get('/manage-players/club-Nowhere')).status, 404);
  }));

  it('the secretary roles share one flag, so a captain-secretary keeps her name on screen', asUser(SUPERADMIN, async () => {
    stubRoster();
    const res = await request(app).get('/manage-players/club-Hyde');
    assert.match(res.text, /title="club secretary and match secretary">Secretary</);
  }));
});

describe('the write API: superadmin only, and refused before the model', () => {
  it('anonymous gets a JSON 401, not a redirect to /login', asUser(ANON, async () => {
    const calls = stubRoster();
    for (const c of API) {
      const res = await call(c);
      assert.strictEqual(res.status, 401, c[1]);
      assert.match(res.headers['content-type'], /json/, c[1]);
      assert.strictEqual(res.body.ok, false);
    }
    assert.deepStrictEqual(calls, []);
  }));

  for (const [label, who] of [['a user with no role', ORDINARY], ['a club admin, even for their own club', HYDE_ADMIN]]) {
    it(`${label} gets a JSON 403 and nothing is written`, asUser(who, async () => {
      const calls = stubRoster();
      for (const c of API) {
        const res = await call(c);
        assert.strictEqual(res.status, 403, c[1]);
        assert.match(res.headers['content-type'], /json/, c[1]);
      }
      assert.deepStrictEqual(calls.filter((n) => WRITES.includes(n)), []);
    }));
  }

  it('a superadmin can make every change', asUser(SUPERADMIN, async () => {
    const calls = stubRoster();
    for (const c of API) {
      const res = await call(c);
      assert.strictEqual(res.status, 200, c[1] + ' ' + JSON.stringify(res.body));
    }
    for (const w of WRITES) assert.ok(calls.includes(w), w + ' was never called');
  }));
});

describe('the old team-admin write paths are gone', () => {
  // /player/batch-update took a table, columns and rows from the body (it was once
  // unauthenticated); /manage-players/create and the public /players/matching served the
  // add-player modal. All three went with views/team-admin.ejs. batch-update must 404, not
  // fall through to POST /player/:id with 'batch-update' as the id.
  for (const [method, url] of [
    ['post', '/player/batch-update'],
    ['post', '/manage-players/create'],
    ['get', '/players/matching/Dave/Male'],
  ]) {
    it(`${method.toUpperCase()} ${url} is a 404`, asUser(SUPERADMIN, async () => {
      stubRoster();
      const res = await request(app)[method](url).send({ tablename: 'player', fields: ['id', 'role'], data: [[1, 'superadmin']] });
      assert.strictEqual(res.status, 404);
    }));
  }
});

describe('the write API: what it accepts', () => {
  it('refuses a malformed save rather than guessing', asUser(SUPERADMIN, async () => {
    const calls = stubRoster();
    const bad = [
      { sections: 'nope' },
      { sections: [{ gender: 'Other', section: 'nominated', playerIds: [1] }] },
      { sections: [{ gender: 'Male', section: 'captains', playerIds: [1] }] },
      { sections: [{ gender: 'Male', section: 'nominated', playerIds: ['1; DROP TABLE player'] }] },
    ];
    for (const body of bad) {
      const res = await request(app).post('/api/teams/55/order').send(body);
      assert.strictEqual(res.status, 400, JSON.stringify(body));
      assert.strictEqual(res.body.ok, false);
    }
    assert.ok(!calls.includes('saveTeamOrder'));
  }));

  it('a save names no table and no column — only ordered ids per section', asUser(SUPERADMIN, async () => {
    stubRoster();
    const res = await request(app).post('/api/teams/55/order')
      .send({ tablename: 'player', fields: ['role'], sections: [{ gender: 'Male', section: 'reserve', playerIds: [101, '102'] }] });
    assert.strictEqual(res.status, 200);
    const [teamId, sections] = Roster.saveTeamOrder.mock.calls[0].arguments;
    assert.strictEqual(teamId, 55);
    assert.deepStrictEqual(sections, [{ gender: 'Male', section: 'reserve', playerIds: [101, 102] }]);
  }));

  it('an unknown team is a 404', asUser(SUPERADMIN, async () => {
    stubRoster();
    const res = await request(app).post('/api/teams/9999/order').send({ sections: [] });
    assert.strictEqual(res.status, 404);
  }));

  it('creating someone who looks registered asks first (409), then creates on confirmNew', asUser(SUPERADMIN, async () => {
    stubRoster();
    Roster.findCandidates.mock.mockImplementation(async () => ({
      ownClub: [], otherClubs: [],
      unattached: [{ playerId: 900, name: 'Dave Lee', gender: 'Male', match: 'exact' }],
    }));
    const body = { firstName: 'Dave', familyName: 'Lee', gender: 'Male', teamId: 55 };
    const first = await request(app).post('/api/roster/club-Hyde/players').send(body);
    assert.strictEqual(first.status, 409);
    assert.strictEqual(first.body.possibleDuplicates[0].where, 'unattached');
    assert.strictEqual(Roster.createPlayer.mock.callCount(), 0);

    const second = await request(app).post('/api/roster/club-Hyde/players').send({ ...body, confirmNew: true });
    assert.strictEqual(second.status, 200);
    assert.strictEqual(Roster.createPlayer.mock.callCount(), 1);
  }));

  it("won't add to another club's team from this club's editor", asUser(SUPERADMIN, async () => {
    stubRoster();
    for (const [url, body] of [
      ['/api/roster/club-Hyde/players', { firstName: 'A', familyName: 'B', gender: 'Male', teamId: 70, confirmNew: true }],
      ['/api/roster/club-Hyde/attach', { playerId: 900, teamId: 70 }],
      ['/api/roster/club-Hyde/transfer', { playerId: 777, teamId: 70 }],
    ]) {
      const res = await request(app).post(url).send(body);
      assert.strictEqual(res.status, 400, url);
      assert.match(res.body.error, /not a Hyde team/);
    }
  }));

  it('attaching a player who is at a real club is refused — that is a transfer', asUser(SUPERADMIN, async () => {
    stubRoster();
    const res = await request(app).post('/api/roster/club-Hyde/attach').send({ playerId: 777, teamId: 55 });
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /Mellor/);
    assert.strictEqual(Roster.addToTeam.mock.callCount(), 0);
  }));

  it('a transfer is applied, as a reserve, with no email', asUser(SUPERADMIN, async () => {
    stubRoster();
    const res = await request(app).post('/api/roster/club-Hyde/transfer').send({ playerId: 777, teamId: 55 });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.applied, true);
    assert.deepStrictEqual(Roster.movePlayer.mock.calls[0].arguments, [777, 55, 'reserve']);
  }));

  it('a fault answers JSON without its message — it can carry SQL', asUser(SUPERADMIN, async () => {
    stubRoster();
    Roster.releasePlayer.mock.mockImplementation(async () => { throw new Error('relation "player" does not exist'); });
    const res = await request(app).post('/api/players/101/release').send({});
    assert.strictEqual(res.status, 500);
    assert.match(res.headers['content-type'], /json/);
    assert.doesNotMatch(res.body.error, /relation|player/);
  }));
});
