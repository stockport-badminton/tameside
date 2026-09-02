// POST /webhooks/mailjet — capturing the reason an address stopped receiving mail.
//
// This exists because there was nothing to look at after the fact. Mailjet's REST API is
// actively misleading here: the message log only reaches back a few weeks, its `Status`
// filter is silently IGNORED (`?Status=blocked` returns recently delivered messages), and
// `DeliveredCount` on a contact reads 0 for every address including ones you can watch
// receive mail. A per-contact lookup showing `IsSpamComplaining: true` was the only
// reliable signal, and it tells you what happened but not what the receiving server said.
//
// A `spam` event is the one that matters most: a single junk click permanently suppresses
// that address in Mailjet, with no bounce and nothing in any log.

const { describe, it, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { app } = require('./helpers/app');
const controller = require('../controllers/mailjetWebhookController');

const TOKEN = 'test-webhook-token';
const withToken = (fn) => async () => {
  const saved = process.env.MAILJET_WEBHOOK_TOKEN;
  process.env.MAILJET_WEBHOOK_TOKEN = TOKEN;
  try { await fn(); } finally {
    if (saved === undefined) delete process.env.MAILJET_WEBHOOK_TOKEN;
    else process.env.MAILJET_WEBHOOK_TOKEN = saved;
  }
};

afterEach(() => mock.restoreAll());

describe('authentication', () => {
  it('404s without the shared secret, so a scanner learns nothing', withToken(async () => {
    const res = await request(app).post('/webhooks/mailjet').send({ event: 'spam', email: 'a@b.com' });
    assert.strictEqual(res.status, 404);
  }));

  it('404s on a wrong secret', withToken(async () => {
    const res = await request(app).post('/webhooks/mailjet?t=nope').send({ event: 'spam' });
    assert.strictEqual(res.status, 404);
  }));

  it('404s when no token is configured, i.e. the endpoint is not in use', async () => {
    const saved = process.env.MAILJET_WEBHOOK_TOKEN;
    delete process.env.MAILJET_WEBHOOK_TOKEN;
    try {
      const res = await request(app).post('/webhooks/mailjet?t=anything').send({ event: 'spam' });
      assert.strictEqual(res.status, 404);
    } finally {
      if (saved !== undefined) process.env.MAILJET_WEBHOOK_TOKEN = saved;
    }
  });
});

describe('recording events', () => {
  it('logs a spam complaint loudly — this is the one that silently kills an address', withToken(async () => {
    const errors = [];
    mock.method(console, 'error', (line) => errors.push(String(line)));
    const res = await request(app).post(`/webhooks/mailjet?t=${TOKEN}`).send({
      event: 'spam', email: 'peter.taylor13@outlook.com', source: 'JMRP', CustomID: 'ScorecardReceived',
    });
    assert.strictEqual(res.status, 200);
    const line = errors.find(l => l.includes('[mailjet]'));
    assert.ok(line, 'expected a [mailjet] line: ' + errors.join(' | '));
    assert.match(line, /spam/);
    assert.match(line, /peter\.taylor13@outlook\.com/);
    assert.match(line, /source=JMRP/);
    assert.match(line, /ScorecardReceived/);
  }));

  it('captures the receiving server\'s own words on a block', withToken(async () => {
    const errors = [];
    mock.method(console, 'error', (line) => errors.push(String(line)));
    await request(app).post(`/webhooks/mailjet?t=${TOKEN}`).send({
      event: 'blocked', email: 'someone@outlook.com',
      error_related_to: 'recipient', error: 'user unknown',
      comment: '550 5.5.0 Requested action not taken: mailbox unavailable',
    });
    const line = errors.find(l => l.includes('[mailjet]'));
    assert.match(line, /related_to=recipient/);
    assert.match(line, /error=user unknown/);
    assert.match(line, /550 5\.5\.0/);
  }));

  it('distinguishes a hard bounce from a soft one', withToken(async () => {
    const errors = [];
    mock.method(console, 'error', (line) => errors.push(String(line)));
    await request(app).post(`/webhooks/mailjet?t=${TOKEN}`).send([
      { event: 'bounce', email: 'gone@example.com', hard_bounce: true },
      { event: 'bounce', email: 'full@example.com', hard_bounce: false },
    ]);
    assert.ok(errors.some(l => /hard_bounce/.test(l)), errors.join(' | '));
    assert.ok(errors.some(l => /soft_bounce/.test(l)), errors.join(' | '));
  }));

  it('accepts a grouped array and reports how many it took', withToken(async () => {
    mock.method(console, 'error', () => {});
    mock.method(console, 'log', () => {});
    const res = await request(app).post(`/webhooks/mailjet?t=${TOKEN}`).send([
      { event: 'sent', email: 'a@b.com' },
      { event: 'open', email: 'a@b.com' },
      { event: 'spam', email: 'c@d.com' },
    ]);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { ok: true, received: 3 });
  }));

  it('rejects a payload that is not an event', withToken(async () => {
    const res = await request(app).post(`/webhooks/mailjet?t=${TOKEN}`).send('"just a string"')
      .set('Content-Type', 'application/json');
    assert.strictEqual(res.status, 400);
  }));

  it('says so rather than crashing when Mailjet sends no reason at all', () => {
    assert.strictEqual(controller._reasonFromForTesting({}), 'no reason given');
  });
});
