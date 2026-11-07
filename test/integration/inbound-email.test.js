// POST /webhooks/resend: list mail in, through Mailjet out (BL-04).
//
// Every refusal asserts what reached Mailjet, as abuse-gating.test.js does: a handler that
// answered 200 "refused" after sending would pass a status-only test. And every case that
// should refuse before reading the message asserts Resend was never asked for it.
const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { app, setModel, clearModels } = require('../helpers/app');
const mailer = require('../../utils/mailer');
const svix = require('../../utils/svixSignature');
const resendInbound = require('../../utils/resendInbound');
const forwarded = require('../fixtures/inbound/resend-bcc-forwarded.json');

const SECRET = 'whsec_' + Buffer.from('a-test-signing-key-32-bytes-long').toString('base64');

const VOCAB = {
  divisions: [{ id: 8, name: 'Division 1' }, { id: 9, name: 'Division 2' }],
  clubs: [{ id: 47, name: 'Hyde' }, { id: 39, name: 'Mellor' }],
};

// The Gate 0 message, as mail to `local@` with an ordinary subject.
function message(local = 'hydeteamcaptains', over = {}) {
  const address = `${local}@tameside-badminton.co.uk`;
  return {
    ...forwarded,
    subject: 'Fixture changes this week',
    headers: { ...forwarded.headers, 'x-original-to': `<${address}>` },
    received_for: ['inbound@example.resend.app', address],
    ...over,
  };
}

function post(body, { secret = SECRET, timestamp = Math.floor(Date.now() / 1000) } = {}) {
  const raw = JSON.stringify(body);
  const headers = svix.sign(secret, 'msg_' + Math.random(), timestamp, raw);
  return request(app).post('/webhooks/resend').set(headers).set('Content-Type', 'application/json').send(raw);
}
const received = (emailId) => ({ type: 'email.received', created_at: '2026-11-07T13:18:51Z', data: { email_id: emailId } });

// A fake inbound_email / inbound_email_delivery, enough to show dedupe working.
let rows, deliveries, fetched, sent, lists;
function stubWorld({ knownSenders = ['captain@example.com'], members = {}, emails = {} } = {}) {
  rows = new Map();
  deliveries = new Set();
  fetched = [];
  lists = [];
  setModel('InboundEmail', 'claim', async (id) => {
    const r = rows.get(id);
    if (r && r.outcome !== 'failed') return false;
    rows.set(id, { outcome: null });
    return true;
  });
  setModel('InboundEmail', 'record', async (id, f) => { Object.assign(rows.get(id), f); });
  setModel('InboundEmail', 'claimRecipients', async (key, id, addrs) => addrs.filter(a => {
    if (deliveries.has(key + '|' + a)) return false;
    deliveries.add(key + '|' + a);
    return true;
  }));
  setModel('InboundEmail', 'releaseRecipients', async (key, addrs) => addrs.forEach(a => deliveries.delete(key + '|' + a)));
  setModel('InboundEmail', 'purge', async () => {});
  setModel('InboundEmail', 'vocabulary', async () => VOCAB);
  setModel('InboundEmail', 'isKnownSender', async (a) => knownSenders.includes(a));
  setModel('Player', 'getEmails', (search, done) => {
    lists.push(search);
    const key = JSON.stringify(search);
    done(null, members[key] || []);
  });
  mock.method(resendInbound, 'getEmail', async (id) => {
    fetched.push(id);
    if (!emails[id]) throw new Error('no such email ' + id);
    return emails[id];
  });
  mock.method(resendInbound, 'listAttachments', async () => []);
  sent = [];
  mock.method(mailer.client, 'post', () => ({
    request: (payload) => { sent.push(payload); return Promise.resolve({ body: {} }); },
  }));
}
const bccOf = () => sent.flatMap(p => p.Messages.flatMap(m => (m.Bcc || []).map(r => r.Email)));

const HYDE_CAPTAINS = JSON.stringify({ inDivision: true, role: 'team Captain', club: 47 });

let savedSecret;
beforeEach(() => { savedSecret = process.env.RESEND_WEBHOOK_SECRET; process.env.RESEND_WEBHOOK_SECRET = SECRET; });
afterEach(() => {
  if (savedSecret === undefined) delete process.env.RESEND_WEBHOOK_SECRET; else process.env.RESEND_WEBHOOK_SECRET = savedSecret;
  clearModels();
  mock.restoreAll();
});

describe('signature', () => {
  for (const [label, opts] of [
    ['a wrong secret', { secret: 'whsec_' + Buffer.from('not-the-key').toString('base64') }],
    ['a stale timestamp', { timestamp: Math.floor(Date.now() / 1000) - 600 }],
  ]) {
    it(`${label}: 404, no Resend fetch, no mail`, async () => {
      stubWorld({ emails: { e1: message() } });
      const res = await post(received('e1'), opts);
      assert.strictEqual(res.status, 404);
      assert.deepStrictEqual(fetched, []);
      assert.strictEqual(sent.length, 0);
    });
  }

  it('no signature at all: 404', async () => {
    stubWorld({ emails: { e1: message() } });
    const res = await request(app).post('/webhooks/resend').set('Content-Type', 'application/json').send(JSON.stringify(received('e1')));
    assert.strictEqual(res.status, 404);
    assert.deepStrictEqual(fetched, []);
  });

  it('no secret configured: 404, i.e. the endpoint is not in use', async () => {
    stubWorld({ emails: { e1: message() } });
    delete process.env.RESEND_WEBHOOK_SECRET;
    const res = await post(received('e1'));
    assert.strictEqual(res.status, 404);
    assert.deepStrictEqual(fetched, []);
  });
});

describe('forwarding', () => {
  it('forwards a known, authenticated sender\'s mail to the list, in Bcc, as "Name via"', async () => {
    stubWorld({
      emails: { e1: message() },
      members: { [HYDE_CAPTAINS]: ['a@example.com', 'B@example.com', 'a@example.com'] },
    });
    const res = await post(received('e1'));
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.outcome, 'forwarded');
    assert.deepStrictEqual(lists, [{ inDivision: true, role: 'team Captain', club: 47 }]);
    assert.deepStrictEqual(bccOf().sort(), ['a@example.com', 'b@example.com']);
    const m = sent[0].Messages[0];
    assert.strictEqual(m.From.Email, 'results@tameside-badminton.co.uk');
    assert.strictEqual(m.From.Name, 'Test Captain via Tameside Badminton');
    assert.strictEqual(m.ReplyTo.Email, 'captain@example.com');
    assert.deepStrictEqual(m.To, [{ Email: 'tameside.badders.results+hydeteamcaptains@gmail.com' }]);
    assert.strictEqual(m.Subject, 'Fixture changes this week');
    assert.strictEqual(m.TextPart, 'bcc field test\n');
    assert.match(m.HTMLPart, /bcc field test/);
    assert.strictEqual(m.Headers['X-Tameside-List'], 'hydeteamcaptains');
    // Mailjet refuses the whole send if Headers sets one it reserves (send-0011). List-Id is
    // one, found live 7 Nov 2026; the other two below were checked in its sandbox mode.
    assert.deepStrictEqual(Object.keys(m.Headers).sort(), ['List-Unsubscribe', 'X-Original-From', 'X-Tameside-List']);
    assert.strictEqual(m.Headers['X-Original-From'], 'captain@example.com');
    assert.match(m.Headers['List-Unsubscribe'], /^<mailto:results@tameside-badminton\.co\.uk\?subject=unsubscribe%20hydeteamcaptains>$/);
    assert.strictEqual(rows.get('e1').outcome, 'forwarded');
    assert.strictEqual(rows.get('e1').recipients, 2);
  });

  it('a duplicate email_id sends once', async () => {
    stubWorld({ emails: { e1: message() }, members: { [HYDE_CAPTAINS]: ['a@example.com'] } });
    await post(received('e1'));
    const again = await post(received('e1'));
    assert.strictEqual(again.status, 200);
    assert.strictEqual(again.body.duplicate, true);
    assert.strictEqual(sent.length, 1);
    assert.deepStrictEqual(fetched, ['e1']);
  });

  it('two list addresses on one mail give the union, each person once', async () => {
    const both = { message_id: '<same@mail.gmail.com>' };
    stubWorld({
      emails: { e1: message('hydeteamcaptains', both), e2: message('division1', both) },
      members: {
        [HYDE_CAPTAINS]: ['a@example.com', 'shared@example.com'],
        [JSON.stringify({ inDivision: true, division: 8 })]: ['shared@example.com', 'c@example.com'],
      },
    });
    await post(received('e1'));
    const res = await post(received('e2'));
    assert.strictEqual(res.body.outcome, 'forwarded');
    assert.deepStrictEqual(bccOf().sort(), ['a@example.com', 'c@example.com', 'shared@example.com']);
    assert.strictEqual(rows.get('e2').recipients, 1);
  });

  it('a Mailjet failure answers 500, and the retry reaches everyone', async () => {
    stubWorld({ emails: { e1: message() }, members: { [HYDE_CAPTAINS]: ['a@example.com'] } });
    mock.restoreAll();
    mock.method(resendInbound, 'getEmail', async () => message());
    mock.method(resendInbound, 'listAttachments', async () => []);
    let fail = true;
    mock.method(mailer.client, 'post', () => ({
      request: (payload) => {
        if (fail) { fail = false; return Promise.reject(new Error('mailjet down')); }
        sent.push(payload); return Promise.resolve({ body: {} });
      },
    }));
    const first = await post(received('e1'));
    assert.strictEqual(first.status, 500);
    assert.strictEqual(rows.get('e1').outcome, 'failed');
    const retry = await post(received('e1'));
    assert.strictEqual(retry.body.outcome, 'forwarded');
    assert.deepStrictEqual(bccOf(), ['a@example.com']);
  });

  it('"test" in the subject goes only to the results mailbox, listing who it would reach', async () => {
    stubWorld({ emails: { e1: message('hydeteamcaptains', { subject: 'test: new list' }) }, members: { [HYDE_CAPTAINS]: ['a@example.com'] } });
    const res = await post(received('e1'));
    assert.strictEqual(res.body.outcome, 'test');
    assert.deepStrictEqual(bccOf(), []);
    const m = sent[0].Messages[0];
    assert.deepStrictEqual(m.To, [{ Email: 'tameside.badders.results+hydeteamcaptains@gmail.com' }]);
    assert.match(m.TextPart, /these 1:\na@example\.com/);
    assert.match(m.HTMLPart, /a@example\.com/);
  });

  it('a long list is split into messages under Mailjet\'s 50-recipient limit', async () => {
    const many = Array.from({ length: 120 }, (_, i) => `p${i}@example.com`);
    stubWorld({ emails: { e1: message() }, members: { [HYDE_CAPTAINS]: many } });
    await post(received('e1'));
    const messages = sent[0].Messages;
    assert.strictEqual(messages.length, 3);
    messages.forEach(m => assert.ok(m.To.length + m.Bcc.length <= 50));
    assert.strictEqual(bccOf().length, 120);
  });
});

describe('refusals reach nobody', () => {
  const cases = [
    ['an address that is not a list', { emails: { e1: message('hydex') } }, 'not-a-list'],
    ['an unknown sender', { knownSenders: [], emails: { e1: message() } }, 'unknown-sender'],
    ['SPF pass with DKIM and DMARC failing', { emails: { e1: message('hydeteamcaptains', { authentication: { spf: 'pass', dkim: 'fail', dmarc: 'fail' } }) } }, 'unauthenticated'],
    ['a DKIM pass with DMARC failing', { emails: { e1: message('hydeteamcaptains', { authentication: { spf: 'pass', dkim: 'pass', dmarc: 'fail' } }) } }, 'unauthenticated'],
    ['our own forward coming back', { emails: { e1: message('hydeteamcaptains', { headers: { ...message().headers, 'x-tameside-list': 'hyde' } }) } }, 'loop'],
    ['no league address recorded', { emails: { e1: message('hydeteamcaptains', { received_for: ['inbound@example.resend.app'] }) } }, 'no-league-address'],
    ['a list with nobody on it', { emails: { e1: message('mellortreasurers') } }, 'empty-list'],
  ];
  for (const [label, world, outcome] of cases) {
    it(`${label}: ${outcome}, no mail`, async () => {
      stubWorld({ members: { [HYDE_CAPTAINS]: ['a@example.com'] }, ...world });
      const res = await post(received('e1'));
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.outcome, outcome);
      assert.strictEqual(sent.length, 0);
      assert.strictEqual(rows.get('e1').outcome, outcome);
    });
  }

  it('an unrecognised address never even asks who the sender is', async () => {
    stubWorld({ emails: { e1: message('notalist') } });
    let asked = false;
    setModel('InboundEmail', 'isKnownSender', async () => { asked = true; return true; });
    await post(received('e1'));
    assert.strictEqual(asked, false);
  });

  it('ignores other event types without fetching anything', async () => {
    stubWorld({ emails: { e1: message() } });
    const res = await post({ type: 'email.sent', data: { email_id: 'e1' } });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(fetched, []);
    assert.strictEqual(sent.length, 0);
  });
});

describe('/admin/inbound-email', () => {
  const as = (role, fn) => async () => {
    const saved = { DEV_MODE: process.env.DEV_MODE, DEV_ROLE: process.env.DEV_ROLE };
    process.env.DEV_MODE = 'true';
    process.env.DEV_ROLE = role;
    try { await fn(); } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  };

  it('shows a superadmin the log, refusals highlighted', as('superadmin', async () => {
    setModel('InboundEmail', 'recent', async () => [
      { email_id: 'e1', created_at: new Date('2026-11-07T13:18:51Z'), league_address: 'hyde@tameside-badminton.co.uk', sender: 'stranger@example.com', subject: '<b>hi</b>', outcome: 'unknown-sender', auth: 'spf=pass dkim=pass dmarc=pass' },
    ]);
    setModel('InboundEmail', 'dailyCounts', async () => [{ day: '2026-11-07', total: 3, forwarded: 1 }]);
    const res = await request(app).get('/admin/inbound-email');
    assert.strictEqual(res.status, 200);
    assert.match(res.text, /stranger@example\.com/);
    assert.match(res.text, /table-warning[^>]*>\s*<td[^>]*>2026-11-07 13:18/);
    assert.match(res.text, /&lt;b&gt;hi&lt;\/b&gt;/, 'subjects are escaped');
  }));

  it('refuses a club admin', as('admin', async () => {
    const res = await request(app).get('/admin/inbound-email');
    assert.strictEqual(res.status, 403);
  }));
});
