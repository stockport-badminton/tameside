// rearrangements@ → /admin/rearrangements (BL-04 step 6). Ported in spirit from Stockport's
// __tests__/integration/rearrangement-requests.test.js; the inbound half is ours, through
// Resend, with the same rules as registrations@ (player-requests.test.js).
const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { app, setModel, clearModels } = require('../helpers/app');
const mailer = require('../../utils/mailer');
const svix = require('../../utils/svixSignature');
const resendInbound = require('../../utils/resendInbound');
const Requests = require('../../models/rearrangementRequest');
const forwarded = require('../fixtures/inbound/resend-bcc-forwarded.json');

const SECRET = 'whsec_' + Buffer.from('a-test-signing-key-32-bytes-long').toString('base64');
const ADDRESS = 'rearrangements@tameside-badminton.co.uk';

const CLUBS = [{ id: 49, name: 'Cheadle Hulme' }, { id: 51, name: 'Disley' }, { id: 52, name: 'Hyde' }];
const TEAMS = [{ id: 30, name: 'Disley A', clubId: 51 }, { id: 31, name: 'Cheadle Hulme A', clubId: 49 }];

const FORWARD = [
  '---------- Forwarded message ---------',
  'From: Nathan <nathan@example.com>',
  'Date: Mon, 26 Oct 2026 at 16:25',
  'Subject: Disley v Cheadle Hulme A',
  '',
  'Disley V Cheadle Hulme A',
  'Original date - Tuesday 10th Nov 2026',
  'New date - Tuesday 13th April 2027',
  '',
  'Thanks',
].join('\r\n');

function message(over = {}) {
  return {
    ...forwarded,
    created_at: '2026-10-26T17:00:00Z',
    subject: 'Fwd: Disley v Cheadle Hulme A',
    text: FORWARD,
    html: null,
    headers: { ...forwarded.headers, 'x-original-to': `<${ADDRESS}>` },
    received_for: ['inbound@example.resend.app', ADDRESS],
    ...over,
  };
}

function post(emailId) {
  const raw = JSON.stringify({ type: 'email.received', created_at: '2026-10-26T17:00:00Z', data: { email_id: emailId } });
  const headers = svix.sign(SECRET, 'msg_' + Math.random(), Math.floor(Date.now() / 1000), raw);
  return request(app).post('/webhooks/resend').set(headers).set('Content-Type', 'application/json').send(raw);
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

describe('mail to rearrangements@', () => {
  let created, sent, recorded;
  function stubInbound({ email, knownSenders = ['captain@example.com'], createReturns = 3 } = {}) {
    created = []; sent = []; recorded = [];
    setModel('InboundEmail', 'claim', async () => true);
    setModel('InboundEmail', 'record', async (id, f) => { recorded.push(f); });
    setModel('InboundEmail', 'purge', async () => {});
    setModel('InboundEmail', 'vocabulary', async () => { throw new Error('a queue never reaches the list parser'); });
    setModel('InboundEmail', 'isKnownSender', async (a) => knownSenders.includes(a));
    mock.method(resendInbound, 'getEmail', async () => email);
    mock.method(Requests, 'clubsAndTeams', async () => ({ clubs: CLUBS, teams: TEAMS }));
    mock.method(Requests, 'create', async (row) => { created.push(row); return createReturns; });
    mock.method(mailer.client, 'post', () => ({
      request: (payload) => { sent.push(payload); return Promise.resolve({ body: {} }); },
    }));
  }

  it('is queued with its reading, and nothing is sent', async () => {
    stubInbound({ email: message() });
    const res = await post('e1');
    assert.strictEqual(res.body.outcome, 'queued');
    assert.strictEqual(sent.length, 0);
    const q = created[0];
    assert.strictEqual(q.messageId, forwarded.message_id);
    assert.strictEqual(q.originalFrom, 'Nathan <nathan@example.com>');
    assert.deepStrictEqual(q.reading.clubIds.sort(), [49, 51]);
    assert.deepStrictEqual(q.reading.dates.map(d => [d.ymd, d.role]), [['2026-11-10', 'original'], ['2027-04-13', 'new']]);
    assert.ok(!('originalFrom' in q.reading));
    assert.strictEqual(recorded[0].list, 'rearrangements');
  });

  it('an unknown sender is refused, not queued, not relayed', async () => {
    stubInbound({ email: message(), knownSenders: [] });
    const res = await post('e1');
    assert.strictEqual(res.body.outcome, 'unknown-sender');
    assert.strictEqual(created.length, 0);
    assert.strictEqual(sent.length, 0);
  });

  it('the same message twice is already-queued', async () => {
    stubInbound({ email: message(), createReturns: null });
    assert.strictEqual((await post('e1')).body.outcome, 'already-queued');
    assert.strictEqual(sent.length, 0);
  });
});

describe('the pages', () => {
  const REQUEST = {
    id: 3, subject: 'Fwd: Disley v Cheadle Hulme A', status: 'pending', receivedAt: new Date('2026-10-26T17:00:00Z'),
    forwardedBy: 'Neil <neil@example.com>', originalFrom: 'Nathan <nathan@example.com>',
    bodyText: 'Original date 10th Nov <script>alert(1)</script>', outcome: null,
    reading: { dates: [{ ymd: '2026-11-10', role: 'original', raw: 'Tuesday 10th Nov 2026' },
      { ymd: '2027-04-13', role: 'new', raw: 'Tuesday 13th April 2027' }], clubIds: [49, 51], teamIds: [31], noDateYet: false },
  };
  const FIXTURE = {
    id: 7358, date: '2026-11-10', dayLabel: 'Tue 10 Nov 2026', status: 'outstanding', homeScore: null,
    homeTeamId: 30, awayTeamId: 31, homeTeam: 'Disley A', awayTeam: 'Cheadle Hulme A', homeClubId: 51, awayClubId: 49,
    division: 'Division 2',
  };
  let calls, over;
  function stubPages(o = {}) {
    calls = [];
    over = o;
    const rec = (name, impl) => mock.method(Requests, name, async (...a) => {
      calls.push([name, ...a]);
      return name in over ? over[name](...a) : impl(...a);
    });
    rec('list', async () => [REQUEST]);
    rec('getById', async () => REQUEST);
    rec('clubsAndTeams', async () => ({ clubs: CLUBS, teams: TEAMS }));
    rec('playersByEmail', async () => [{ firstName: 'Nathan', familyName: 'M', team: 'Disley A', club: 'Disley',
      clubId: 51, teamCaptain: 1, clubSecretary: 0, matchSecrertary: 0 }]);
    rec('candidateFixtures', async () => [FIXTURE]);
    rec('fixtureById', async () => null);
    rec('homeWeekdays', async () => [{ dow: 2, n: 9 }]);
    rec('fixturesOn', async () => []);
    rec('seasonEnd', async () => '2027-07-31');
    rec('replacementOf', async () => null);
    rec('setStatus', async () => true);
    rec('recordOutcome', async () => true);
    setModel('InboundEmail', 'refusedFor', async () => []);
  }
  const rearranged = [];
  function stubRearrange(impl) {
    rearranged.length = 0;
    setModel('Fixture', 'rearrangeById', async (...a) => { rearranged.push(a); return impl(...a); });
  }

  for (const role of ['admin', 'none']) {
    for (const [method, path] of [
      ['get', '/admin/rearrangements'],
      ['get', '/admin/rearrangements/3'],
      ['post', '/admin/rearrangements/3/apply'],
      ['post', '/admin/rearrangements/3/status'],
    ]) {
      it(`${method.toUpperCase()} ${path} is refused for ${role}, before anything runs`, asUser({ role }, async () => {
        stubPages();
        stubRearrange(async () => ({}));
        const res = await request(app)[method](path).type('form').send({ fixture: '7358', date: '2027-04-13' });
        assert.strictEqual(res.status, 403);
        assert.deepStrictEqual(calls, []);
        assert.strictEqual(rearranged.length, 0);
      }));
    }
  }

  it('lists what is pending', asUser({ role: 'superadmin' }, async () => {
    stubPages();
    const res = await request(app).get('/admin/rearrangements');
    assert.strictEqual(res.status, 200);
    assert.ok(res.text.includes('Fwd: Disley v Cheadle Hulme A'));
  }));

  it('arrives with the fixture and new date chosen, and who the sender is', asUser({ role: 'superadmin' }, async () => {
    stubPages();
    const res = await request(app).get('/admin/rearrangements/3');
    assert.strictEqual(res.status, 200);
    assert.match(res.text, /value="7358" id="fixture-7358" checked/);
    assert.match(res.text, /id="date" name="date" value="2027-04-13"/);
    assert.doesNotMatch(res.text, /id="nodate"[^>]*checked/);
    assert.ok(res.text.includes('Nathan M, Disley'));
    assert.ok(res.text.includes('captain of Disley A'));
    assert.ok(res.text.includes('Nothing to flag'));
    // The sender's club counts as named when finding candidates.
    assert.deepStrictEqual(calls.find(c => c[0] === 'candidateFixtures')[1],
      { dates: ['2026-11-10', '2027-04-13'], clubIds: [49, 51], teamId: null });
  }));

  it('Check shows the warnings for the date on the form', asUser({ role: 'superadmin' }, async () => {
    stubPages({ fixturesOn: async () => [{ id: 9, homeTeam: 'Disley A', awayTeam: 'Hyde A' }] });
    const res = await request(app).get('/admin/rearrangements/3?check=1&fixture=7358&date=2027-04-15');
    assert.match(res.text, /id="date" name="date" value="2027-04-15"/);
    assert.ok(res.text.includes('Disley A usually play at home on Tuesdays; 2027-04-15 is a Thursday.'));
    assert.ok(res.text.includes('Already on that day: Disley A v Hyde A (fixture 9).'));
    assert.deepStrictEqual(calls.find(c => c[0] === 'fixturesOn').slice(1), ['2027-04-15', [30, 31], 7358]);
  }));

  it('says when the fixture has already been moved, and where to', asUser({ role: 'superadmin' }, async () => {
    stubPages({
      candidateFixtures: async () => [{ ...FIXTURE, status: 'rearranged' }],
      replacementOf: async () => ({ id: 7695, dayLabel: 'Tue 13 Apr 2027' }),
    });
    const res = await request(app).get('/admin/rearrangements/3?check=1&fixture=7358&date=2027-04-13');
    assert.ok(res.text.includes('This fixture is already rearranged — it is now on Tue 13 Apr 2027 (fixture 7695).'));
  }));

  it('cannot be scripted by the email it shows, or by the error it is sent back with', asUser({ role: 'superadmin' }, async () => {
    stubPages();
    const res = await request(app).get('/admin/rearrangements/3?check=1&fixture=7358&error=%3Cscript%3Ealert(2)%3C/script%3E');
    assert.ok(!res.text.includes('<script>alert(1)</script>'));
    assert.ok(!res.text.includes('<script>alert(2)</script>'));
    assert.ok(res.text.includes('&lt;script&gt;alert(1)'));
  }));

  it('404s an unknown request', asUser({ role: 'superadmin' }, async () => {
    stubPages({ getById: async () => null });
    assert.strictEqual((await request(app).get('/admin/rearrangements/999')).status, 404);
  }));

  describe('Apply', () => {
    it('moves the fixture and records the outcome in the same transaction', asUser({ role: 'superadmin' }, async () => {
      stubPages();
      const tx = { marker: 'tx' };
      stubRearrange(async (id, date, within) => {
        const result = { action: 'rearranged', fixtureId: id, replacementId: 7695, date };
        await within(tx, result);
        return result;
      });
      const res = await request(app).post('/admin/rearrangements/3/apply').type('form')
        .send({ fixture: '7358', date: '2027-04-13', team: '' });
      assert.strictEqual(res.status, 302);
      assert.strictEqual(res.headers.location, '/admin/rearrangements/3?applied=1');
      assert.deepStrictEqual(rearranged[0].slice(0, 2), [7358, '2027-04-13']);
      const [, gotTx, id, outcome] = calls.find(c => c[0] === 'recordOutcome');
      assert.strictEqual(gotTx, tx);
      assert.strictEqual(id, 3);
      assert.deepStrictEqual(outcome, { action: 'rearranged', fixtureId: 7358, replacementId: 7695, date: '2027-04-13' });
    }));

    it('with "no date agreed yet" marks it rearranging, whatever is in the date box', asUser({ role: 'superadmin' }, async () => {
      stubPages();
      stubRearrange(async () => ({}));
      await request(app).post('/admin/rearrangements/3/apply').type('form').send({ fixture: '7358', date: '2027-04-13', nodate: '1' });
      assert.deepStrictEqual(rearranged[0].slice(0, 2), [7358, null]);
    }));

    it('rolls back when the request was already closed', asUser({ role: 'superadmin' }, async () => {
      stubPages({ recordOutcome: async () => false });
      let thrown = null;
      stubRearrange(async (id, date, within) => {
        try { await within({}, { action: 'rearranged', fixtureId: id }); } catch (err) { thrown = err; throw err; }
      });
      const res = await request(app).post('/admin/rearrangements/3/apply').type('form').send({ fixture: '7358', date: '2027-04-13' });
      assert.strictEqual(thrown && thrown.status, 409);
      assert.strictEqual(res.status, 303);
      assert.ok(res.headers.location.includes('error=This+request+is+not+pending'));
    }));

    it('goes back to the page with the reason and the form as it was when refused', asUser({ role: 'superadmin' }, async () => {
      stubPages();
      stubRearrange(async () => { throw Object.assign(new Error('fixture 7358 is already rearranged'), { status: 409 }); });
      const res = await request(app).post('/admin/rearrangements/3/apply').type('form').send({ fixture: '7358', date: '2027-04-20' });
      assert.strictEqual(res.status, 303);
      const back = new URL(res.headers.location, 'http://x');
      assert.deepStrictEqual(Object.fromEntries(back.searchParams), {
        check: '1', fixture: '7358', date: '2027-04-20', nodate: '', error: 'fixture 7358 is already rearranged' });
      const page = await request(app).get(res.headers.location);
      assert.ok(page.text.includes('Not applied: fixture 7358 is already rearranged'));
    }));

    it('asks for a date or the no-date box rather than guessing', asUser({ role: 'superadmin' }, async () => {
      stubPages();
      stubRearrange(async () => ({}));
      const res = await request(app).post('/admin/rearrangements/3/apply').type('form').send({ fixture: '7358', date: '' });
      assert.strictEqual(res.status, 303);
      assert.strictEqual(rearranged.length, 0);
    }));
  });

  it('closes a request and records who by', asUser({ role: 'superadmin' }, async () => {
    stubPages();
    const res = await request(app).post('/admin/rearrangements/3/status').type('form').send({ status: 'dismissed' });
    assert.strictEqual(res.headers.location, '/admin/rearrangements');
    const [, id, status, by] = calls.find(c => c[0] === 'setStatus');
    assert.deepStrictEqual([id, status], [3, 'dismissed']);
    assert.ok(by);
  }));
});

describe('models/rearrangementRequest.js', () => {
  it('writes jsonb with sql.json, never a stringified ::jsonb', () => {
    const src = require('fs').readFileSync(require.resolve('../../models/rearrangementRequest'), 'utf8');
    assert.doesNotMatch(src, /\$\{JSON\.stringify\([^\n]*::jsonb/);
    assert.match(src, /sql\.json\(/);
  });
});
