// Integration coverage for the contact-form spam controls, ported from the Stockport
// league site (its __tests__/integration/spam-gate.test.js, rewritten for node:test).
//
// Mailjet is stubbed throughout — these tests must never send a real email. The DB is not
// available under test/helpers/app, so the blocklists are installed through the
// _setCacheForTests seam and the submission log is captured by stubbing logSubmission.
//
// The behaviour that most needs pinning down: a spamGate rejection is deliberately
// INDISTINGUISHABLE from a success (same status, same page), so the only way to tell they
// fired is that no email was sent and a rejection was logged.
const { describe, it, before, after, afterEach, beforeEach, mock } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { app, setModel, clearModels } = require('../helpers/app');
const contactusController = require('../../controllers/contactusController');
const Spam = require('../../models/spamControls');
const { formStamp, MIN_SECONDS } = require('../../utils/spamChecks');

afterEach(() => { clearModels(); mock.restoreAll(); });

// A stamp old enough to clear the timing floor.
function goodStamp() {
  return formStamp(Date.now() - (MIN_SECONDS + 2) * 1000);
}

// Stub Mailjet and capture whether a send was attempted.
function stubMailjet() {
  return mock.method(
    contactusController._mailjetClientForTesting,
    'post',
    () => ({ request: () => Promise.resolve({ body: { Messages: [{ Status: 'success' }] } }) })
  );
}

// Capture what would have gone into submission_log.
function captureLog() {
  const entries = [];
  mock.method(Spam, 'logSubmission', async (entry) => { entries.push(entry); });
  return entries;
}

// The captcha is a separate layer and is not what these tests are about; stub it to pass so
// a submission can reach the blocklists and the mailer.
function stubCaptchaPass() {
  // validCaptcha is used via .not().custom(...) and returns undefined on success, so the
  // default behaviour with no token already "passes" as far as express-validator is
  // concerned. Nothing to stub — documented here so the omission doesn't look accidental.
}

// contactType and leagueSelect are what the handler actually branches on. Get them wrong
// and the request used to hang forever rather than erroring — see the regression test at the
// bottom of this file.
const GOOD_BODY = {
  contactName: 'Chris Example',
  contactEmail: 'real.person@example.com',
  contactQuery: 'Hello, I would like to join the league next season please.',
  contactType: 'League',
  leagueSelect: 'secretary',
};

beforeEach(() => {
  Spam._setCacheForTests({
    ip: [],
    email: ['spammer@example.com'],
    phrase: ['brokerage'],
    word: ['SEO'],
  });
});

describe('spamGate — silent rejections', () => {
  it('rejects a filled honeypot, looks identical to a success, and sends no email', async () => {
    const postStub = stubMailjet();
    const logged = captureLog();

    const res = await request(app).post('/contact-us').type('form').send({
      ...GOOD_BODY,
      contactUrl: 'http://spam.example',   // the honeypot
      formTs: goodStamp(),
    });

    assert.strictEqual(res.status, 200);
    // Indistinguishable from a real success — that's the design.
    assert.match(res.text, /Success/);
    assert.strictEqual(postStub.mock.callCount(), 0, 'must not email a honeypot hit');
    assert.strictEqual(logged.length, 1);
    assert.strictEqual(logged[0].verdict, 'rejected');
    assert.strictEqual(logged[0].reason, 'honeypot');
  });

  it('rejects a submission faster than the timing floor', async () => {
    const postStub = stubMailjet();
    const logged = captureLog();

    const res = await request(app).post('/contact-us').type('form').send({
      ...GOOD_BODY,
      formTs: formStamp(Date.now()),   // submitted immediately
    });

    assert.strictEqual(res.status, 200);
    assert.match(res.text, /Success/);
    assert.strictEqual(postStub.mock.callCount(), 0);
    assert.strictEqual(logged[0].reason, 'too-fast');
  });

  it('rejects a hand-edited stamp', async () => {
    const postStub = stubMailjet();
    const logged = captureLog();
    const [ts, mac] = goodStamp().split('.');
    const tampered = ts + '.' + (mac[0] === 'A' ? 'B' : 'A') + mac.slice(1);

    const res = await request(app).post('/contact-us').type('form')
      .send({ ...GOOD_BODY, formTs: tampered });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(postStub.mock.callCount(), 0);
    assert.strictEqual(logged[0].reason, 'bad-stamp');
  });

  it('records the endpoint, email and an excerpt so a campaign is recognisable', async () => {
    stubMailjet();
    const logged = captureLog();

    await request(app).post('/contact-us').type('form').send({
      ...GOOD_BODY,
      contactQuery: 'X'.repeat(500),
      contactUrl: 'filled',
      formTs: goodStamp(),
    });

    assert.strictEqual(logged[0].endpoint, '/contact-us');
    assert.strictEqual(logged[0].email, 'real.person@example.com');
    // Truncated: enough to recognise a campaign, not a message archive.
    assert.strictEqual(logged[0].excerpt.length, 500);
    assert.ok(typeof logged[0].userAgent === 'string');
  });
});

describe('spamGate — what it must NOT reject', () => {
  it('lets a submission with no stamp at all through the gate', async () => {
    // Caches and autofill mean a missing stamp is not evidence of anything. It must reach
    // the normal validation path rather than being silently dropped.
    const logged = captureLog();
    stubMailjet();

    const res = await request(app).post('/contact-us').type('form').send({ ...GOOD_BODY });

    assert.strictEqual(res.status, 200);
    // Whatever the outcome, it must not have been a gate rejection.
    const gateReasons = ['honeypot', 'too-fast', 'bad-stamp', 'blocked-ip'];
    if (logged.length) {
      assert.ok(!gateReasons.includes(logged[0].reason),
        `must not be a gate rejection, got ${logged[0].reason}`);
    }
  });

  it('lets a stale tab through — only the floor is enforced', async () => {
    const logged = captureLog();
    stubMailjet();

    const res = await request(app).post('/contact-us').type('form').send({
      ...GOOD_BODY,
      formTs: formStamp(Date.now() - 45 * 60 * 1000),   // opened 45 minutes ago
    });

    assert.strictEqual(res.status, 200);
    if (logged.length) {
      assert.notStrictEqual(logged[0].reason, 'too-fast');
      assert.notStrictEqual(logged[0].reason, 'bad-stamp');
    }
  });

  it('leaves the honeypot empty in the rendered form', async () => {
    // contactus_get populates the club dropdown from the DB, which isn't available here.
    setModel('Club', 'getAll', (cb) => cb(null, [{ id: 1, name: 'Aces' }]));

    const res = await request(app).get('/contact-us');
    assert.strictEqual(res.status, 200);
    // Present, named innocuously, and empty — plus a stamp to time against.
    assert.match(res.text, /name="contactUrl"/);
    assert.match(res.text, /name="formTs" value="\d+\.[A-Za-z0-9_-]+"/);
    // Not type=hidden: the better bots skip hidden inputs and fill visible ones.
    assert.doesNotMatch(res.text, /type="hidden"[^>]*name="contactUrl"/);
  });
});

describe('blocklists — must actually reject', () => {
  // Regression guard for a bug introduced during this port: these validators became async
  // when their lists moved to the DB, and express-validator 7 treats an async validator
  // that RESOLVES to false as a pass. Returning false silently disabled both blocklists
  // and every submission reached Mailjet. They must throw.
  it('rejects a blocked sender and sends no email', async () => {
    const postStub = stubMailjet();

    const res = await request(app).post('/contact-us').type('form').send({
      ...GOOD_BODY,
      contactEmail: 'spammer@example.com',
      formTs: goodStamp(),
    });

    assert.strictEqual(res.status, 200);
    assert.match(res.text, /Sorry something went wrong/,
      'a blocklist hit shows the error page, unlike a silent gate rejection');
    assert.strictEqual(postStub.mock.callCount(), 0, 'blocked sender must not be emailed');
  });

  it('rejects a blocked phrase in the message body', async () => {
    const postStub = stubMailjet();

    const res = await request(app).post('/contact-us').type('form').send({
      ...GOOD_BODY,
      contactQuery: 'We offer brokerage services for your club',
      formTs: goodStamp(),
    });

    assert.strictEqual(res.status, 200);
    assert.match(res.text, /Sorry something went wrong/);
    assert.strictEqual(postStub.mock.callCount(), 0);
  });

  it('does not reject an ordinary message that merely contains a blocked word inside another word', async () => {
    // 'SEO' is a whole-word entry, so "Seonaid" must get through.
    const postStub = stubMailjet();

    const res = await request(app).post('/contact-us').type('form').send({
      ...GOOD_BODY,
      contactQuery: 'Seonaid would like to join, and so would her class.',
      formTs: goodStamp(),
    });

    assert.strictEqual(res.status, 200);
    assert.doesNotMatch(res.text, /Sorry something went wrong/,
      'whole-word matching must not catch an ordinary message');
    assert.strictEqual(postStub.mock.callCount(), 1, 'a clean message should be sent');
  });

  it('logs a blocklist hit with its own reason, not as generic validation failure', async () => {
    // The distinction matters: a rising 'validation' count on /admin/spam means real people
    // are failing the form, which is the signal that something is over-blocking.
    stubMailjet();
    const logged = captureLog();

    await request(app).post('/contact-us').type('form').send({
      ...GOOD_BODY,
      contactEmail: 'spammer@example.com',
      formTs: goodStamp(),
    });

    assert.strictEqual(logged.length, 1);
    assert.strictEqual(logged[0].verdict, 'rejected');
    assert.strictEqual(logged[0].reason, 'blocked-email');
  });
});

describe('sitewide IP block', () => {
  // The check is mounted before routing, so the path only has to exist as far as the
  // middleware chain. A route that needs neither the DB nor Contentful keeps these tests
  // about the blocklist rather than about page rendering.
  const ANY_PATH = '/definitely-not-a-real-route';

  // app.js only enables `trust proxy` in production, so under test req.ip is the socket
  // address and clientIp() correctly returns that rather than the X-Forwarded-For header.
  // These tests therefore block the address the request genuinely resolves to; the header
  // path is covered by the clientIp unit tests in test/client-ip.test.js.
  const LOCAL = '127.0.0.1';

  it('403s a blocked address on any route', async () => {
    Spam._setCacheForTests({ ip: [LOCAL] });
    const res = await request(app).get(ANY_PATH);
    assert.strictEqual(res.status, 403);
  });

  it('does not block an ordinary visitor', async () => {
    Spam._setCacheForTests({ ip: ['203.0.113.7'] });
    const res = await request(app).get(ANY_PATH);
    // 404 is the expected answer for this path — the point is that it isn't 403.
    assert.notStrictEqual(res.status, 403);
  });

  it('still serves static assets to a blocked address', async () => {
    // The IP check is mounted below the static handlers deliberately, so one page view
    // isn't a dozen blocklist lookups. A blocked visitor getting a stylesheet is harmless.
    Spam._setCacheForTests({ ip: [LOCAL] });
    const res = await request(app).get('/static/css/modern-styles.css');
    assert.strictEqual(res.status, 200);
  });
});

describe('/admin/spam', () => {
  before(() => { process.env.DEV_MODE = 'true'; });
  after(() => { delete process.env.DEV_MODE; });

  it('renders the blocklist and the log for a superadmin', async () => {
    mock.method(Spam, 'list', async () => [
      { id: 1, kind: 'email', value: 'spammer@example.com', note: 'seeded', created_at: new Date(), created_by: 'migration', active: true },
    ]);
    mock.method(Spam, 'submissionStats', async () => [
      { verdict: 'rejected', reason: 'honeypot', n: 5, last7: 3, last24h: 1 },
    ]);
    mock.method(Spam, 'recentSubmissions', async () => [
      { id: 1, created_at: new Date(), endpoint: '/contact-us', ip: '1.2.3.4', forwarded_for: '', user_agent: 'curl', verdict: 'rejected', reason: 'honeypot', email: 'x@y.com', excerpt: 'buy now' },
    ]);

    const res = await request(app).get('/admin/spam');

    assert.strictEqual(res.status, 200);
    assert.match(res.text, /Spam controls/);
    assert.match(res.text, /spammer@example\.com/);
    assert.match(res.text, /honeypot/);
  });

  it('refuses a value too short to be safe', async () => {
    const addStub = mock.method(Spam, 'add', async () => 1);
    const res = await request(app).post('/admin/spam').type('form')
      .send({ kind: 'phrase', value: 'a' });

    assert.strictEqual(res.status, 302);
    assert.match(res.headers.location, /err=/);
    assert.strictEqual(addStub.mock.callCount(), 0, 'a 1-char phrase would block everything');
  });

  it('refuses an unknown kind', async () => {
    const addStub = mock.method(Spam, 'add', async () => 1);
    const res = await request(app).post('/admin/spam').type('form')
      .send({ kind: 'wibble', value: 'something' });

    assert.strictEqual(res.status, 302);
    assert.match(res.headers.location, /err=/);
    assert.strictEqual(addStub.mock.callCount(), 0);
  });

  it('adds a valid entry', async () => {
    const addStub = mock.method(Spam, 'add', async () => 42);
    const res = await request(app).post('/admin/spam').type('form')
      .send({ kind: 'email', value: 'new@spam.example', note: 'seen today' });

    assert.strictEqual(res.status, 302);
    assert.match(res.headers.location, /msg=/);
    assert.strictEqual(addStub.mock.callCount(), 1);
    assert.strictEqual(addStub.mock.calls[0].arguments[0].kind, 'email');
  });
});

describe('/admin/spam auth', () => {
  it('redirects to login when not authenticated', async () => {
    delete process.env.DEV_MODE;
    const res = await request(app).get('/admin/spam');
    assert.strictEqual(res.status, 302);
    assert.match(res.headers.location, /\/login/);
  });
});

describe('POST /contact-us always answers', () => {
  // The handler branches on contactType with two bare `if`s and had no else, so a post
  // without that field fell off the end of the function and never responded — the request
  // hung until something else timed it out, holding a connection. A bot posting bare fields
  // hits this every time, so on a form being hardened against bots it's the wrong failure
  // mode. These tests exist to keep every path terminating.
  for (const [label, body] of [
    ['no contactType at all', {}],
    ['unrecognised contactType', { contactType: 'Wibble' }],
    ['empty contactType', { contactType: '' }],
  ]) {
    it(`responds rather than hanging: ${label}`, async () => {
      const postStub = stubMailjet();

      const res = await request(app).post('/contact-us').type('form').send({
        contactEmail: 'real.person@example.com',
        contactQuery: 'Hello there, this is a genuine enquiry about joining.',
        formTs: goodStamp(),
        ...body,
      });

      // Any terminating status is acceptable; a hang is not. node:test would report this
      // as a timeout rather than a failed assertion if the response never arrived.
      assert.ok(res.status >= 200 && res.status < 500, `got ${res.status}`);
      assert.strictEqual(postStub.mock.callCount(), 0, 'nothing to send without a recipient');
    });
  }

  it('still sends when contactType is League with a known recipient', async () => {
    const postStub = stubMailjet();

    const res = await request(app).post('/contact-us').type('form')
      .send({ ...GOOD_BODY, formTs: goodStamp() });

    assert.strictEqual(res.status, 200);
    assert.match(res.text, /Success/);
    assert.strictEqual(postStub.mock.callCount(), 1);
  });
});
