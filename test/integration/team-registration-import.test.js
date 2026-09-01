// The registration-import screen, and the bulk write path it shares with team admin.
//
// Two things are worth an integration test here, and both are about the write:
//
//  1. THE CLIENT NEVER SAYS WHAT A CHANGE MEANS. The review page posts back a list of
//     change KEYS. The apply route re-parses the stored document, re-reads the database,
//     re-runs the diff, and looks each key up in its own freshly computed result. So a
//     tampered payload can only select from changes the server itself proposed -- it
//     cannot invent a team, a rank or a club, and it cannot promote a flagged transfer
//     into an applied one.
//
//  2. POST /player/batch-update used to be an UNAUTHENTICATED "UPDATE any table SET any
//     column WHERE id = any id" endpoint -- `player.role` included. It is still in use by
//     the team-admin drag-and-drop, so it is narrowed rather than removed, and the
//     narrowing is what these tests pin.

const { describe, it, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const docx = require('docx');

const { app, setModel, clearModels } = require('../helpers/app');

afterEach(() => { clearModels(); mock.restoreAll(); });

// Same pattern as test/integration/auth-gating.test.js: the mock identity is driven by
// process-global env vars, so each test states who it runs as rather than using
// before/after hooks that would race across describe blocks.
function asUser({ role, club } = {}, fn) {
  return async () => {
    const saved = {
      DEV_MODE: process.env.DEV_MODE,
      DEV_ROLE: process.env.DEV_ROLE,
      DEV_CLUB: process.env.DEV_CLUB,
    };
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
const SUPERADMIN = { role: 'superadmin' };
const HYDE_ADMIN = { role: 'admin', club: 'Hyde' };
const ORDINARY = { role: 'none' };

const CLUBS = [
  { id: 47, name: 'Hyde' },
  { id: 39, name: 'Mellor' },
  { id: 63, name: 'No Club' },
];
const TEAMS = [
  { id: 1, name: 'Hyde A', club: 47 },
  { id: 2, name: 'Hyde B', club: 47 },
  { id: 7, name: 'Mellor A', club: 39 },
  { id: 52, name: 'No Team', club: 63 },
];
// Andrew is nominated no. 1 for Hyde A. Jamie is a Hyde B reserve and will be left off
// the form, so he becomes a removal.
const ROSTER = [
  { id: 10, first_name: 'Andrew', family_name: 'Capewell', gender: 'Male', team: 1, teamName: 'Hyde A', rank: 1, club: 47 },
  { id: 14, first_name: 'Jamie', family_name: 'Saint', gender: 'Male', team: 2, teamName: 'Hyde B', rank: 99, club: 47 },
];
// Tony plays for Mellor -- a name matching him is a transfer, never applied here.
const OUTSIDE = [
  { id: 91, first_name: 'Tony', family_name: 'Mooney', gender: 'Male', team: 7, teamName: 'Mellor A', rank: 2, club: 39, clubName: 'Mellor' },
];

function installModels({ onUpdate, onCreate } = {}) {
  setModel('Club', 'getAll', (done) => done(null, CLUBS));
  setModel('Team', 'getAll', (done) => done(null, TEAMS));
  setModel('Player', 'searchRosterForClub', async () => ROSTER);
  setModel('Player', 'searchRosterOutsideClub', async () => OUTSIDE);
  setModel('Player', 'updateBulk', (patch, done) => {
    if (onUpdate) onUpdate(patch);
    done(null, []);
  });
  setModel('Player', 'create', (first, family, team, club, gender, done) => {
    if (onCreate) onCreate({ first, family, team, club, gender });
    done(null, [{ id: 999 }]);
  });
}

const cell = (t, pct) => new docx.TableCell({
  children: [new docx.Paragraph(String(t))], width: { size: pct, type: docx.PERCENTAGE },
});
const trow = (cells) => new docx.TableRow({ children: cells });

// A Hyde form that: moves Andrew to Hyde B, adds a brand-new player, and names Tony
// Mooney (a Mellor player, so a transfer). Jamie is absent, so he is a removal.
function hydeForm() {
  const rows = [
    trow([cell('Hyde Registrations', 100)]),
    trow([cell('Hyde B', 100)]),
    trow([cell('Men', 50), cell('Ladies', 50)]),
    trow([cell('Andrew Capewell', 40), cell('B', 10), cell('', 40), cell('R', 10)]),
    trow([cell('Brand New Person', 40), cell('B', 10), cell('', 40), cell('R', 10)]),
    trow([cell('Tony Mooney', 40), cell('B', 10), cell('', 40), cell('R', 10)]),
  ];
  return docx.Packer.toBuffer(new docx.Document({ sections: [{ children: [new docx.Table({ rows })] }] }));
}

async function reviewAs(agent, clubId = 47) {
  const body = await hydeForm();
  return agent
    .post(`/admin/team-registrations/review?club=${clubId}&filename=Hyde.docx`)
    .set('Content-Type', 'application/octet-stream')
    .send(body);
}

describe('registration import: who can reach it', () => {
  it('redirects an anonymous caller to login', asUser({}, async () => {
    installModels();
    for (const url of ['/admin/team-registrations', '/admin/team-registrations/apply']) {
      const res = await request(app)[url.endsWith('apply') ? 'post' : 'get'](url);
      assert.strictEqual(res.status, 302, url);
      assert.match(res.headers.location, /\/login/);
    }
  }));

  it('403s an ordinary logged-in user', asUser(ORDINARY, async () => {
    installModels();
    const res = await request(app).get('/admin/team-registrations');
    assert.strictEqual(res.status, 403);
  }));

  it('lets a club admin in, but only for their own club', asUser(HYDE_ADMIN, async () => {
    installModels();
    const agent = request.agent(app);
    assert.strictEqual((await agent.get('/admin/team-registrations')).status, 200);
    // Mellor is club 39.
    const res = await reviewAs(agent, 39);
    assert.strictEqual(res.status, 403);
  }));

  it('offers a club admin only their own club to pick from', asUser(HYDE_ADMIN, async () => {
    installModels();
    const res = await request(app).get('/admin/team-registrations');
    assert.match(res.text, /Hyde/);
    assert.ok(!/>Mellor</.test(res.text), 'should not list another club');
    // "No Club" is a placeholder, not somewhere you register a team.
    assert.ok(!/>No Club</.test(res.text));
  }));
});

describe('registration import: the review', () => {
  it('classifies the form against the database', asUser(SUPERADMIN, async () => {
    installModels();
    const res = await reviewAs(request.agent(app));
    assert.strictEqual(res.status, 200);
    // Andrew moves Hyde A -> Hyde B; the new name is new; Tony is a transfer; Jamie is
    // absent from the form so he is a removal.
    assert.match(res.text, /1 team/);
    assert.match(res.text, /1 new/);
    assert.match(res.text, /1 transfer/);
    assert.match(res.text, /1 remove/);
  }));

  it('does not offer a tick box for a transfer', asUser(SUPERADMIN, async () => {
    installModels();
    const res = await reviewAs(request.agent(app));
    const boxes = res.text.match(/<input type="checkbox"[^>]*?>/gs) || [];
    const kinds = boxes.map(b => (b.match(/data-kind="([^"]+)"/) || [])[1]);
    assert.ok(!kinds.includes('transfer'), 'transfer must not be tickable: ' + kinds.join(','));
    assert.ok(kinds.includes('team') && kinds.includes('new') && kinds.includes('remove'));
  }));

  it('never pre-ticks a removal', asUser(SUPERADMIN, async () => {
    // A club omitting a page looks exactly like a club dropping players, and
    // "we removed 30 people because a page was missing" is the failure to avoid.
    installModels();
    const res = await reviewAs(request.agent(app));
    const boxes = res.text.match(/<input type="checkbox"[^>]*?>/gs) || [];
    for (const b of boxes) {
      if (/data-kind="remove"/.test(b)) assert.ok(!/checked/.test(b), 'removal was pre-ticked');
    }
  }));

  it('rejects a file that is not a form, as a 400 not a 500', asUser(SUPERADMIN, async () => {
    installModels();
    const res = await request.agent(app)
      .post('/admin/team-registrations/review?club=47&filename=notes.txt')
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('Hi, our team list is: Andrew, Dave, ...'));
    assert.strictEqual(res.status, 400);
  }));
});

describe('registration import: applying is decided server-side', () => {
  it('applies the ticked change with values it computed itself', asUser(SUPERADMIN, async () => {
    const writes = [];
    installModels({ onUpdate: (p) => writes.push(p) });
    const agent = request.agent(app);
    const review = await reviewAs(agent);
    const key = (review.text.match(/data-key="(e\d+)" data-kind="team"/) || [])[1];
    assert.ok(key, 'expected a team change key in the page');

    const res = await agent.post('/admin/team-registrations/apply')
      .send({ selections: [{ key }] });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(writes.length, 1);
    assert.deepStrictEqual(writes[0].fields, ['id', 'team', 'rank', 'club']);
    // Andrew (10) -> Hyde B (2), no. 1, club 47. Every value from the server's own diff.
    assert.deepStrictEqual(writes[0].data, [[10, 2, 1, 47]]);
  }));

  it('ignores a key the server did not propose', asUser(SUPERADMIN, async () => {
    const writes = [];
    installModels({ onUpdate: (p) => writes.push(p) });
    const agent = request.agent(app);
    await reviewAs(agent);
    const res = await agent.post('/admin/team-registrations/apply')
      .send({ selections: [{ key: 'e999' }, { key: 'r424242' }, { key: 'nonsense' }] });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(writes.length, 0, 'nothing should have been written');
    assert.match(res.text, /Skipped/);
  }));

  it('will not apply a transfer even when the payload ticks it', asUser(SUPERADMIN, async () => {
    // The tampered-payload case. The key is real -- it is on the page -- but its KIND is
    // decided by the server, and transfers are not applicable.
    const writes = [];
    installModels({ onUpdate: (p) => writes.push(p) });
    const agent = request.agent(app);
    const review = await reviewAs(agent);
    // The transfer row has no checkbox at all -- that is the point -- so its key cannot be
    // scraped from one. Keys are the entry's index in document order, and Tony Mooney is
    // the third row of the form built above, so 'e2' is his. Asserted rather than
    // assumed, so this test cannot start passing for the wrong reason.
    const key = 'e2';
    assert.match(review.text, /Tony Mooney/);
    const res = await agent.post('/admin/team-registrations/apply').send({ selections: [{ key }] });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(writes.length, 0, 'a transfer must never be written from this screen');
    assert.match(res.text, /not applied from this screen/);
  }));

  it('creates a new player on the team the server chose', asUser(SUPERADMIN, async () => {
    const created = [];
    installModels({ onCreate: (c) => created.push(c) });
    const agent = request.agent(app);
    const review = await reviewAs(agent);
    const key = (review.text.match(/data-key="(e\d+)" data-kind="new"/) || [])[1];
    assert.ok(key);
    const res = await agent.post('/admin/team-registrations/apply').send({ selections: [{ key }] });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(created, [{ first: 'Brand', family: 'New Person', team: 2, club: 47, gender: 'Male' }]);
  }));

  it('parks a removal at "No Club" rather than deleting anybody', asUser(SUPERADMIN, async () => {
    const writes = [];
    installModels({ onUpdate: (p) => writes.push(p) });
    const agent = request.agent(app);
    const review = await reviewAs(agent);
    const key = (review.text.match(/data-key="(r\d+)" data-kind="remove"/) || [])[1];
    assert.ok(key, 'expected a removal key');
    const res = await agent.post('/admin/team-registrations/apply').send({ selections: [{ key }] });
    assert.strictEqual(res.status, 200);
    // Jamie (14) -> No Team (52), rank 99, No Club (63). Reversible; nothing is deleted.
    assert.deepStrictEqual(writes[0].data, [[14, 52, 99, 63]]);
  }));

  it('refuses an apply with no prior review in the session', asUser(SUPERADMIN, async () => {
    installModels();
    const res = await request.agent(app).post('/admin/team-registrations/apply')
      .send({ selections: [{ key: 'e0' }] });
    assert.strictEqual(res.status, 400);
  }));
});

describe('POST /player/batch-update: the hole that is now closed', () => {
  const OK_BODY = { tablename: 'player', fields: ['id', 'team', 'rank'], data: [[10, 2, 1]] };

  it('requires a session -- it had no auth gate at all', asUser({}, async () => {
    installModels({ onUpdate: () => { throw new Error('must not write'); } });
    const res = await request(app).post('/player/batch-update').send(OK_BODY);
    assert.strictEqual(res.status, 302);
    assert.match(res.headers.location, /\/login/);
  }));

  it('403s an ordinary logged-in user', asUser(ORDINARY, async () => {
    installModels({ onUpdate: () => { throw new Error('must not write'); } });
    const res = await request(app).post('/player/batch-update').send(OK_BODY);
    assert.strictEqual(res.status, 403);
  }));

  it('refuses any table but player', asUser(SUPERADMIN, async () => {
    installModels({ onUpdate: () => { throw new Error('must not write'); } });
    const res = await request(app).post('/player/batch-update')
      .send({ tablename: 'fixture', fields: ['id', 'rank'], data: [[1, 1]] });
    assert.strictEqual(res.status, 400);
  }));

  it('refuses columns outside the allowlist, role above all', asUser(SUPERADMIN, async () => {
    // This is the escalation the open endpoint allowed: anyone could set their own
    // player.role to 'superadmin'.
    installModels({ onUpdate: () => { throw new Error('must not write'); } });
    for (const fields of [['id', 'role'], ['id', 'statsAccess'], ['id', 'playerEmail']]) {
      const res = await request(app).post('/player/batch-update')
        .send({ tablename: 'player', fields, data: [[10, 1]] });
      assert.strictEqual(res.status, 400, fields.join(','));
    }
  }));

  it('requires an id, integers, and rectangular data', asUser(SUPERADMIN, async () => {
    installModels({ onUpdate: () => { throw new Error('must not write'); } });
    const bad = [
      { tablename: 'player', fields: ['team', 'rank'], data: [[2, 1]] },          // no id
      { tablename: 'player', fields: ['id', 'team'], data: [[10]] },              // ragged
      { tablename: 'player', fields: ['id', 'team'], data: [[10, 'DEFAULT']] },   // not an int
      { tablename: 'player', fields: ['id', 'team'], data: [[10, 2], [10, 3]] },  // dup id
      { tablename: 'player', fields: [], data: [[10]] },                          // no fields
    ];
    for (const body of bad) {
      const res = await request(app).post('/player/batch-update').send(body);
      assert.strictEqual(res.status, 400, JSON.stringify(body));
    }
  }));

  it('scopes a club admin to their own club, from the database not the payload', asUser(HYDE_ADMIN, async () => {
    installModels({ onUpdate: () => { throw new Error('must not write'); } });
    setModel('Player', 'getClubsForPlayerIds', (ids, done) =>
      done(null, [{ id: 91, club: 39, clubName: 'Mellor' }]));
    const res = await request(app).post('/player/batch-update')
      .send({ tablename: 'player', fields: ['id', 'team', 'rank'], data: [[91, 2, 1]] });
    assert.strictEqual(res.status, 403);
  }));

  it('refuses an id that does not exist rather than letting it through unchecked', asUser(HYDE_ADMIN, async () => {
    // A missing row has no club to compare, so without this it would fall past the scope
    // check entirely.
    installModels({ onUpdate: () => { throw new Error('must not write'); } });
    setModel('Player', 'getClubsForPlayerIds', (ids, done) => done(null, []));
    const res = await request(app).post('/player/batch-update')
      .send({ tablename: 'player', fields: ['id', 'team', 'rank'], data: [[424242, 2, 1]] });
    assert.strictEqual(res.status, 400);
  }));

  it('lets a club admin reorder their own club', asUser(HYDE_ADMIN, async () => {
    const writes = [];
    installModels({ onUpdate: (p) => writes.push(p) });
    setModel('Player', 'getClubsForPlayerIds', (ids, done) =>
      done(null, [{ id: 10, club: 47, clubName: 'Hyde' }]));
    const res = await request(app).post('/player/batch-update').send(OK_BODY);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(writes.length, 1);
  }));
});
