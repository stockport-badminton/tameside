// /admin/missed-three (rule 18). Models are stubbed: what is asserted is the gate, that the
// notice is built only from the server's own rows, and what actually reached Mailjet.
const { describe, it, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { app, clearModels } = require('../helpers/app');
const mailer = require('../../utils/mailer');
const MissedThree = require('../../models/missedThree');
const { buildMissedThreeNotice, RULE } = require('../../utils/missedThreeEmail');
const SAMPLES = require('../fixtures/email-samples');

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
const SUPERADMIN = { role: 'superadmin' };

const ROW = { teamId: 11, teamName: 'College Green A', clubId: 4, teamRank: 1, playerId: 501,
  firstName: 'Leon', familyName: 'Example', gender: 'Male', nextTeamName: 'College Green B' };
const OFFICERS = [
  { clubId: 4, clubName: 'College Green', name: 'Sam Sec', email: 'sec@example.com', role: 'club and match secretary' },
];
function stubModels({ rows = [ROW], officers = OFFICERS } = {}) {
  mock.method(MissedThree, 'getPlayers', async () => rows);
  mock.method(MissedThree, 'getOfficers', async () => officers);
}
function captureMail() {
  const sent = [];
  mock.method(mailer.client, 'post', () => ({ request: (p) => { sent.push(p); return Promise.resolve({ body: {} }); } }));
  return sent;
}

describe('the notice builder', () => {
  it('cites rule 18 and names the team a replacement comes from', () => {
    const n = buildMissedThreeNotice(ROW, OFFICERS, 'Neil Cooper');
    assert.strictEqual(RULE, '18');
    assert.match(n.text, /rule 18/);
    assert.match(n.text, /College Green B team needs to be nominated in his place/);
    assert.strictEqual(n.subject, 'Leon Example, College Green A');
    assert.deepStrictEqual(n.to, ['sec@example.com']);
    assert.strictEqual(n.bcc, true);
  });

  it('produces exactly the data keys the email sample renders', () => {
    const n = buildMissedThreeNotice(ROW, OFFICERS, 'Neil Cooper');
    assert.deepStrictEqual(Object.keys(n.data).sort(), Object.keys(SAMPLES['missed-three']).sort());
  });

  it('signs off with a first name, never an email address', () => {
    assert.strictEqual(buildMissedThreeNotice(ROW, OFFICERS, 'Neil Cooper').data.senderName, 'Neil');
    assert.strictEqual(buildMissedThreeNotice(ROW, OFFICERS, 'neil@example.com').data.senderName, '');
  });

  it('uses she/her for a lady, and escapes the club name in the raw footer line', () => {
    const n = buildMissedThreeNotice({ ...ROW, gender: 'Female' },
      [{ ...OFFICERS[0], clubName: 'A <b>Club</b>' }], '');
    assert.match(n.text, /she should play the next match/);
    assert.match(n.data.whyReceiving, /A &lt;b&gt;Club&lt;\/b&gt;/);
  });

  it('leaves out officers with no address', () => {
    const n = buildMissedThreeNotice(ROW, [...OFFICERS, { clubId: 4, clubName: 'x', name: 'No Mail', email: null, role: 'match secretary' }], '');
    assert.deepStrictEqual(n.to, ['sec@example.com']);
  });
});

describe('gating', () => {
  const routes = [
    ['get', '/admin/missed-three'], ['get', '/admin/missed-three/501/notice'],
    ['get', '/admin/missed-three/501/notice/email'], ['post', '/admin/missed-three/501/notice'],
  ];
  for (const [method, url] of routes) {
    it(`${method.toUpperCase()} ${url}: login, then superadmin only`, async () => {
      const sent = captureMail();
      stubModels();
      await asUser({}, async () => {
        const res = await request(app)[method](url);
        assert.strictEqual(res.status, 302);
      })();
      for (const role of ['none', 'admin']) {
        await asUser({ role }, async () => {
          const res = await request(app)[method](url);
          assert.strictEqual(res.status, 403, role);
        })();
      }
      assert.strictEqual(sent.length, 0);
    });
  }
});

describe('as superadmin', () => {
  it('lists the flagged player with a preview link', asUser(SUPERADMIN, async () => {
    stubModels();
    const res = await request(app).get('/admin/missed-three');
    assert.strictEqual(res.status, 200);
    assert.match(res.text, /Leon Example/);
    assert.match(res.text, /\/admin\/missed-three\/501\/notice/);
  }));

  it('the preview names the recipients and frames the real email', asUser(SUPERADMIN, async () => {
    stubModels();
    const page = await request(app).get('/admin/missed-three/501/notice');
    assert.strictEqual(page.status, 200);
    assert.match(page.text, /sec@example\.com/);
    const email = await request(app).get('/admin/missed-three/501/notice/email');
    assert.strictEqual(email.status, 200);
    assert.match(email.text, /rule 18/);
    assert.doesNotMatch(email.text, /undefined/);
  }));

  it('sends to the server\'s recipients and ignores anything in the body', asUser(SUPERADMIN, async () => {
    stubModels();
    const sent = captureMail();
    const res = await request(app).post('/admin/missed-three/501/notice').type('form')
      .send({ to: 'attacker@example.com', email: 'attacker@example.com', subject: 'x' });
    assert.strictEqual(res.status, 303);
    assert.strictEqual(sent.length, 1);
    const msg = sent[0].Messages[0];
    assert.deepStrictEqual(msg.To.map(r => r.Email), ['sec@example.com']);
    assert.ok(msg.Bcc.some(r => r.Email === mailer.RESULTS_MAILBOX));
    assert.doesNotMatch(JSON.stringify(sent), /attacker/);
  }));

  it('a player no longer on the list is a 404, and sends nothing', asUser(SUPERADMIN, async () => {
    stubModels({ rows: [] });
    const sent = captureMail();
    assert.strictEqual((await request(app).get('/admin/missed-three/501/notice')).status, 404);
    assert.strictEqual((await request(app).post('/admin/missed-three/501/notice')).status, 404);
    assert.strictEqual(sent.length, 0);
  }));

  it('a club with no address on file is a 422, and sends nothing', asUser(SUPERADMIN, async () => {
    stubModels({ officers: [{ ...OFFICERS[0], email: null }] });
    const sent = captureMail();
    assert.strictEqual((await request(app).post('/admin/missed-three/501/notice')).status, 422);
    assert.strictEqual(sent.length, 0);
  }));
});
