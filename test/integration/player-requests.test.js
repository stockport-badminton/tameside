// registrations@ → /admin/player-requests (BL-04 step 6). Ported in spirit from Stockport's
// __tests__/integration/player-requests.test.js; the inbound half is ours, through Resend.
//
// The edges matter most. Inbound: only a known, authenticated sender fills the queue, and
// NOTHING sent to registrations@ is relayed through Mailjet, queued or refused (Stockport
// forwards a refusal; we list it on the page). Outbound: the page is superadmin-only,
// because the queue is other people's email.
const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { app, setModel, clearModels } = require('../helpers/app');
const mailer = require('../../utils/mailer');
const svix = require('../../utils/svixSignature');
const resendInbound = require('../../utils/resendInbound');
const Requests = require('../../models/registrationRequest');
const Roster = require('../../models/roster');
const forwarded = require('../fixtures/inbound/resend-bcc-forwarded.json');

const SECRET = 'whsec_' + Buffer.from('a-test-signing-key-32-bytes-long').toString('base64');
const ADDRESS = 'registrations@tameside-badminton.co.uk';

const TEAMS = [
  { id: 55, name: 'Hyde A', clubId: 47, clubName: 'Hyde' },
  { id: 56, name: 'Hyde B', clubId: 47, clubName: 'Hyde' },
];

const FORWARD = [
  '---------- Forwarded message ---------',
  'From: Jane Secretary <jane@example.com>',
  'Subject: New players',
  '',
  'Please register these for Hyde B:',
  'Mary Whitle (F)',
  'John Smith - M',
  '',
  'Thanks,',
  'Jane',
].join('\r\n');

function message(over = {}) {
  return {
    ...forwarded,
    subject: 'Fwd: New players',
    text: FORWARD,
    html: null,
    headers: { ...forwarded.headers, 'x-original-to': `<${ADDRESS}>` },
    received_for: ['inbound@example.resend.app', ADDRESS],
    attachments: [
      { filename: 'registration.docx', content_disposition: 'attachment' },
      { filename: 'logo.png', content_disposition: 'inline' },
    ],
    ...over,
  };
}

function post(emailId) {
  const raw = JSON.stringify({ type: 'email.received', created_at: '2026-11-08T10:00:00Z', data: { email_id: emailId } });
  const headers = svix.sign(SECRET, 'msg_' + Math.random(), Math.floor(Date.now() / 1000), raw);
  return request(app).post('/webhooks/resend').set(headers).set('Content-Type', 'application/json').send(raw);
}

let recorded, created, sent;
function stubInbound({ email, knownSenders = ['captain@example.com'], createReturns = 7 } = {}) {
  recorded = [];
  created = [];
  sent = [];
  setModel('InboundEmail', 'claim', async () => true);
  setModel('InboundEmail', 'record', async (id, f) => { recorded.push(f); });
  setModel('InboundEmail', 'purge', async () => {});
  setModel('InboundEmail', 'vocabulary', async () => { throw new Error('a queue never reaches the list parser'); });
  setModel('InboundEmail', 'isKnownSender', async (a) => knownSenders.includes(a));
  setModel('Player', 'getEmails', () => { throw new Error('a queue never resolves a list'); });
  mock.method(resendInbound, 'getEmail', async () => email);
  mock.method(resendInbound, 'listAttachments', async () => { throw new Error('a queue downloads nothing'); });
  mock.method(Requests, 'registrableTeams', async () => TEAMS);
  mock.method(Requests, 'create', async (row) => { created.push(row); return typeof createReturns === 'function' ? createReturns() : createReturns; });
  mock.method(mailer.client, 'post', () => ({
    request: (payload) => { sent.push(payload); return Promise.resolve({ body: {} }); },
  }));
}

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

let savedSecret;
beforeEach(() => { savedSecret = process.env.RESEND_WEBHOOK_SECRET; process.env.RESEND_WEBHOOK_SECRET = SECRET; });
afterEach(() => {
  if (savedSecret === undefined) delete process.env.RESEND_WEBHOOK_SECRET; else process.env.RESEND_WEBHOOK_SECRET = savedSecret;
  clearModels();
  mock.restoreAll();
});

describe('mail to registrations@', () => {
  it('is queued, with the names read out of it, and nothing is sent', async () => {
    stubInbound({ email: message() });
    const res = await post('e1');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.outcome, 'queued');
    assert.strictEqual(sent.length, 0);
    assert.strictEqual(created.length, 1);
    const q = created[0];
    assert.strictEqual(q.messageId, forwarded.message_id);
    assert.strictEqual(q.originalFrom, 'Jane Secretary <jane@example.com>');
    assert.deepStrictEqual(q.attachments, ['registration.docx']);
    assert.deepStrictEqual(q.candidates.map(c => [c.first, c.family, c.gender, c.team, c.outcome]), [
      ['Mary', 'Whitle', 'Female', 'Hyde B', null],
      ['John', 'Smith', 'Male', 'Hyde B', null],
    ]);
    assert.strictEqual(recorded[0].list, 'registrations');
    assert.strictEqual(recorded[0].leagueAddress, ADDRESS);
  });

  it('reads an HTML-only message from its HTML', async () => {
    stubInbound({ email: message({ text: '', html: '<p>Please register these for Hyde A:</p><p>Mary Whitle (F)</p>' }) });
    await post('e1');
    assert.deepStrictEqual(created[0].candidates.map(c => c.first + ' ' + c.family), ['Mary Whitle']);
  });

  it('the same message twice is already-queued, and still sends nothing', async () => {
    stubInbound({ email: message(), createReturns: null });
    const res = await post('e1');
    assert.strictEqual(res.body.outcome, 'already-queued');
    assert.strictEqual(sent.length, 0);
  });

  describe('a refusal is recorded, never queued, never relayed', () => {
    it('an unknown sender', async () => {
      stubInbound({ email: message(), knownSenders: [] });
      const res = await post('e1');
      assert.strictEqual(res.body.outcome, 'unknown-sender');
      assert.strictEqual(created.length, 0);
      assert.strictEqual(sent.length, 0);
    });

    it('SPF pass alone (it proves nothing after the Namecheap forward)', async () => {
      stubInbound({ email: message({ authentication: { spf: 'pass', dkim: 'fail', dmarc: 'fail' } }) });
      const res = await post('e1');
      assert.strictEqual(res.body.outcome, 'unauthenticated');
      assert.strictEqual(created.length, 0);
      assert.strictEqual(sent.length, 0);
    });
  });

  it('a queue failure answers 500 so Resend retries, and sends nothing', async () => {
    stubInbound({ email: message(), createReturns: () => { throw new Error('connection reset'); } });
    const res = await post('e1');
    assert.strictEqual(res.status, 500);
    assert.strictEqual(sent.length, 0);
    assert.strictEqual(recorded.at(-1).outcome, 'failed');
  });

  it('a near miss is not the queue: registrationsx@ is not-a-list', async () => {
    stubInbound({ email: message({
      headers: { ...forwarded.headers, 'x-original-to': '<registrationsx@tameside-badminton.co.uk>' },
      received_for: ['inbound@example.resend.app', 'registrationsx@tameside-badminton.co.uk'],
    }) });
    setModel('InboundEmail', 'vocabulary', async () => ({ divisions: [], clubs: [] }));
    const res = await post('e1');
    assert.strictEqual(res.body.outcome, 'not-a-list');
    assert.strictEqual(created.length, 0);
  });
});

describe('the pages', () => {
  const REQUEST = {
    id: 7, subject: 'Fwd: New players', status: 'pending', receivedAt: new Date('2026-11-08T10:00:00Z'),
    forwardedBy: 'Neil <neil@example.com>', originalFrom: 'Jane <jane@example.com>',
    bodyText: 'Mary Whitle (F) <script>alert(1)</script>', attachments: [],
    candidates: [{ first: 'Mary', family: 'Whitle', gender: 'Female', team: 'Hyde B', raw: 'Mary Whitle (F)', outcome: null, playerId: null }],
  };
  let calls;
  function stubPages(request = REQUEST) {
    calls = [];
    const rec = (name, impl) => mock.method(Requests, name, async (...a) => { calls.push([name, ...a]); return impl(...a); });
    rec('list', async () => [request]);
    rec('getById', async () => request);
    rec('registrableTeams', async () => TEAMS);
    rec('setCandidate', async (id, i, c) => [c]);
    rec('appendCandidate', async (id, c) => [REQUEST.candidates[0], c]);
    rec('setStatus', async () => true);
    setModel('InboundEmail', 'refusedFor', async () => [
      { created_at: new Date('2026-11-08T09:00:00Z'), sender: 'stranger@example.org', subject: 'Join', auth: 'spf=pass dkim=pass dmarc=pass', outcome: 'unknown-sender' },
    ]);
    mock.method(Roster, 'allForMatching', async () => [
      { playerId: 163, name: 'Marry Whitle', gender: 'Female', clubName: 'Mellor', clubId: 39, teamName: 'Mellor A' },
      { playerId: 5, name: 'Graham White', gender: 'Male', clubName: 'Mellor', clubId: 39, teamName: 'Mellor A' },
    ]);
  }

  const ROUTES = [
    ['get', '/admin/player-requests'],
    ['get', '/admin/player-requests/7'],
    ['get', '/admin/player-requests/match?q=mary'],
    ['post', '/admin/player-requests/7/candidates/0'],
    ['post', '/admin/player-requests/7/candidates'],
    ['post', '/admin/player-requests/7/status'],
  ];
  for (const role of ['admin', 'none']) {
    for (const [method, path] of ROUTES) {
      it(`${method.toUpperCase()} ${path} is refused for ${role}, before any model`, asUser({ role }, async () => {
        stubPages();
        const res = await request(app)[method](path).send({});
        assert.strictEqual(res.status, 403);
        assert.deepStrictEqual(calls, []);
      }));
    }
  }

  it('lists what is pending, with progress and the refusals', asUser({ role: 'superadmin' }, async () => {
    stubPages();
    const res = await request(app).get('/admin/player-requests');
    assert.strictEqual(res.status, 200);
    assert.ok(res.text.includes('Fwd: New players'));
    assert.ok(res.text.includes('0 of 1 done'));
    assert.ok(res.text.includes('stranger@example.org'));
    assert.deepStrictEqual(calls.find(c => c[0] === 'list'), ['list', 'pending']);
  }));

  it('arrives with each person already matched against the players on file', asUser({ role: 'superadmin' }, async () => {
    stubPages();
    const res = await request(app).get('/admin/player-requests/7');
    assert.strictEqual(res.status, 200);
    const data = JSON.parse(res.text.match(/<script type="application\/json" id="request-data">([\s\S]*?)<\/script>/)[1]);
    assert.deepStrictEqual(data.candidates[0].matches.map(m => [m.playerId, m.where, m.match]), [[163, 'club', 'close']]);
    assert.deepStrictEqual(data.teams, TEAMS);
  }));

  // The body is somebody's email. It must not run on the page, as markup or by closing the
  // JSON block the page script reads.
  it('cannot be scripted by the email it shows', asUser({ role: 'superadmin' }, async () => {
    stubPages({ ...REQUEST, candidates: [{ ...REQUEST.candidates[0], raw: '</script><script>alert(2)</script>' }] });
    const res = await request(app).get('/admin/player-requests/7');
    assert.ok(!res.text.includes('<script>alert(1)</script>'));
    assert.ok(!res.text.includes('<script>alert(2)</script>'));
    assert.ok(res.text.includes('&lt;script&gt;alert(1)'));
  }));

  it('404s an unknown request', asUser({ role: 'superadmin' }, async () => {
    stubPages(null);
    assert.strictEqual((await request(app).get('/admin/player-requests/999')).status, 404);
  }));

  it('re-matches an edited name', asUser({ role: 'superadmin' }, async () => {
    stubPages();
    const res = await request(app).get('/admin/player-requests/match?q=Mary%20Whitle&gender=Female');
    assert.deepStrictEqual(res.body.matches.map(m => m.playerId), [163]);
  }));

  it('stores the edited person and the outcome', asUser({ role: 'superadmin' }, async () => {
    stubPages();
    const res = await request(app).post('/admin/player-requests/7/candidates/0')
      .send({ first: ' Mary ', family: 'Whitle', gender: 'Female', team: 'Hyde B', outcome: 'transferred', playerId: 163 });
    assert.strictEqual(res.status, 200);
    const [, id, index, c] = calls.find(x => x[0] === 'setCandidate');
    assert.deepStrictEqual([id, index, c.first, c.outcome, c.playerId], [7, 0, 'Mary', 'transferred', 163]);
    assert.deepStrictEqual(res.body.summary, { total: 1, handled: 1 });
  }));

  it('refuses an outcome it does not know', asUser({ role: 'superadmin' }, async () => {
    stubPages();
    const res = await request(app).post('/admin/player-requests/7/candidates/0')
      .send({ first: 'Mary', family: 'Whitle', outcome: 'deleted' });
    assert.strictEqual(res.status, 400);
    assert.ok(!calls.some(c => c[0] === 'setCandidate'));
  }));

  it('adds a person the reading missed, unhandled whatever the body says', asUser({ role: 'superadmin' }, async () => {
    stubPages();
    const res = await request(app).post('/admin/player-requests/7/candidates')
      .send({ first: 'Ali', family: 'Khan', outcome: 'created', playerId: 9 });
    assert.strictEqual(res.status, 200);
    const [, , c] = calls.find(x => x[0] === 'appendCandidate');
    assert.deepStrictEqual([c.outcome, c.playerId, c.raw], [null, null, 'added by hand']);
    assert.strictEqual(res.body.index, 1);
  }));

  it('closes a request and records who by', asUser({ role: 'superadmin' }, async () => {
    stubPages();
    const res = await request(app).post('/admin/player-requests/7/status').type('form').send({ status: 'done' });
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.location, '/admin/player-requests');
    const [, id, status, by] = calls.find(x => x[0] === 'setStatus');
    assert.deepStrictEqual([id, status], [7, 'done']);
    assert.ok(by && by !== 'admin', by);
  }));
});

// postgres.js serialises a parameter the server types as jsonb with JSON.stringify, so a
// JSON.stringify'd string cast to ::jsonb is stored as a jsonb STRING, and the first
// jsonb_array_length on it throws. Found rehearsing against production (8 Nov 2026), where
// this file's mocks cannot see it. sql.json(value) is the spelling that works.
describe('models/registrationRequest.js', () => {
  it('writes jsonb with sql.json, never a stringified ::jsonb', () => {
    const src = require('fs').readFileSync(require.resolve('../../models/registrationRequest'), 'utf8');
    assert.doesNotMatch(src, /JSON\.stringify\([^\n]*::jsonb/);
    assert.match(src, /sql\.json\(/);
  });
});
