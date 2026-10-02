// GET /admin — the grouped hub of every superadmin tool, and the shortlisted Admin menu.
const { describe, it, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { app, clearModels } = require('../helpers/app');
const ClubRegistration = require('../../models/clubRegistration');
const MissedThree = require('../../models/missedThree');
const { GROUPS } = require('../../utils/adminTools');

afterEach(() => { clearModels(); mock.restoreAll(); });

function asUser({ role } = {}, fn) {
  return async () => {
    const saved = { DEV_MODE: process.env.DEV_MODE, DEV_ROLE: process.env.DEV_ROLE };
    if (role === undefined) delete process.env.DEV_MODE;
    else { process.env.DEV_MODE = 'true'; process.env.DEV_ROLE = role; }
    try { await fn(); } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  };
}

describe('GET /admin', () => {
  it('needs a login', asUser({}, async () => {
    assert.strictEqual((await request(app).get('/admin')).status, 302);
  }));
  for (const role of ['none', 'admin']) {
    it(`is 403 for ${role}`, asUser({ role }, async () => {
      assert.strictEqual((await request(app).get('/admin')).status, 403);
    }));
  }

  it('lists every tool, with its counts', asUser({ role: 'superadmin' }, async () => {
    mock.method(ClubRegistration, 'getStatus', async () => [{ received: false }, { received: true }, { received: false }]);
    mock.method(MissedThree, 'getPlayers', async () => [{}, {}, {}, {}]);
    const res = await request(app).get('/admin');
    assert.strictEqual(res.status, 200);
    for (const t of GROUPS.flatMap(g => g.tools)) assert.ok(res.text.includes(`href="${t.href}"`), t.href);
    assert.match(res.text, /2 outstanding/);
    assert.match(res.text, /4 to review/);
  }));

  it('a count that fails shows nothing, and the page still renders', asUser({ role: 'superadmin' }, async () => {
    mock.method(ClubRegistration, 'getStatus', async () => { throw new Error('db down'); });
    mock.method(MissedThree, 'getPlayers', async () => { throw new Error('db down'); });
    const res = await request(app).get('/admin');
    assert.strictEqual(res.status, 200);
    assert.doesNotMatch(res.text, /outstanding|to review|all in/);
  }));
});

describe('the superadmin Admin menu', () => {
  it('carries the shortlist and the hub link, not every tool', asUser({ role: 'superadmin' }, async () => {
    mock.method(ClubRegistration, 'getStatus', async () => []);
    mock.method(MissedThree, 'getPlayers', async () => []);
    const res = await request(app).get('/admin');
    const menu = res.text.slice(res.text.indexOf('dropdown-menu-end'), res.text.indexOf('/logout'));
    assert.match(menu, /href="\/admin">All admin tools/);
    assert.match(menu, /Registration Reminders/);
    assert.doesNotMatch(menu, /Spam Controls/);   // on the hub, not the menu
  }));
});
