// The push notification routes (controllers/pushController.js): the opt-in page, the
// subscription API it calls, the scheduled reminders and the superadmin page. The sending is
// tested in test/push.test.js. Ported from Stockport's __tests__/integration/push.test.js.
//
// Ours differs in the gate: the scheduler presents `?t=` (requireCronCaller, like our other
// jobs) and a refusal is a 404, not Stockport's 403.

const { describe, it, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { app, setModel, clearModels } = require('../helpers/app');
const push = require('../../utils/push');
const { subscriptionId } = require('../../utils/push/subscription');

const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/device-1';
const KEYS = { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u', auth: 'tBHItJI5svbpez7KI4CCXg' };
const TEAMS = [
  { id: 1, name: 'Hyde A', clubId: 1, clubName: 'Hyde', divisionName: 'Division 1' },
  { id: 4, name: 'Hyde B', clubId: 1, clubName: 'Hyde', divisionName: 'Division 1' },
  { id: 2, name: 'Shell A', clubId: 2, clubName: 'Shell', divisionName: 'Division 1' },
];

// Every write and read the routes make, recorded; nothing reaches the database.
let calls;
function stubPush() {
  calls = { upsert: [], remove: [], lookup: [] };
  setModel('Push', 'followableTeams', async () => TEAMS);
  setModel('Push', 'upsertSubscription', async s => { calls.upsert.push(s); });
  setModel('Push', 'removeSubscriptions', async ids => { calls.remove.push(ids); return ids.length; });
  setModel('Push', 'getSubscription', async id => { calls.lookup.push(id); return null; });
  setModel('Push', 'teamCounts', async () => ({ subscriptions: 3, teams: [{ id: 4, name: 'Hyde B', subscribers: 2 }] }));
  setModel('Push', 'recentSends', async () => [{ key: 'result-304', sentAt: new Date('2027-02-09T21:00:00Z'), summary: { subscribers: 2, sent: 2 } }]);
}

afterEach(() => { clearModels(); mock.restoreAll(); });

// Identity and env vars are process-global, so each test states what it runs with and
// restores what was there.
function withEnv(vars, fn) {
  return async () => {
    const saved = {};
    for (const k of Object.keys(vars)) saved[k] = process.env[k];
    for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    try { stubPush(); await fn(); } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  };
}
const anon = { DEV_MODE: undefined };
const superadmin = { DEV_MODE: 'true', DEV_ROLE: 'superadmin', DEV_CLUB: undefined };
const clubAdmin = { DEV_MODE: 'true', DEV_ROLE: 'admin', DEV_CLUB: 'Hyde' };
const VAPID = { VAPID_PUBLIC_KEY: 'BTestVapidPublicKey_0123' };

describe('GET /notifications', () => {
  it('offers every followable team, grouped by club, with the VAPID key for the browser', withEnv({ ...anon, ...VAPID }, async () => {
    const res = await request(app).get('/notifications');
    assert.strictEqual(res.status, 200);
    assert.ok(res.text.includes('data-vapid-key="BTestVapidPublicKey_0123"'));
    assert.strictEqual(res.text.match(/<summary>/g).length, 2);
    assert.match(res.text, /<summary>Hyde[\s\S]*Hyde A[\s\S]*Hyde B[\s\S]*<summary>Shell/);
    assert.match(res.text, /name="push-team" id="team-4"\s+value="4">/);
    assert.match(res.text, /\/static\/js\/push-panel\.js\?v=/);
  }));

  it('?team= ticks that team and opens its club', withEnv(anon, async () => {
    const res = await request(app).get('/notifications?team=4');
    assert.match(res.text, /value="4" checked>/);
    assert.doesNotMatch(res.text, /value="1" checked>/);
    assert.match(res.text, /<details class="mb-1" open>\s*<summary>Hyde/);
  }));

  it('a ?team= that is not a followable team ticks nothing', withEnv(anon, async () => {
    const res = await request(app).get('/notifications?team=999');
    assert.doesNotMatch(res.text, /name="push-team"[^>]*checked/);
  }));

  it('with no VAPID key the page has none to give the browser', withEnv({ ...anon, VAPID_PUBLIC_KEY: undefined }, async () => {
    const res = await request(app).get('/notifications');
    assert.strictEqual(res.status, 200);
    assert.ok(res.text.includes('data-vapid-key=""'));
  }));
});

describe('POST /api/push/subscribe', () => {
  const body = (over = {}) => ({ subscription: { endpoint: ENDPOINT, keys: KEYS }, teams: [4, 999], types: ['results'], ...over });

  it('saves the subscription under the hash of its endpoint, with only known teams', withEnv(anon, async () => {
    const res = await request(app).post('/api/push/subscribe').set('Sec-Fetch-Site', 'same-origin').send(body());
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { ok: true, teams: [4], types: ['results'] });
    assert.deepStrictEqual(calls.upsert, [{
      id: subscriptionId(ENDPOINT), endpoint: ENDPOINT, p256dh: KEYS.p256dh, auth: KEYS.auth, teams: [4], types: ['results'],
    }]);
  }));

  it('refuses a request from another site\'s page, and saves nothing', withEnv(anon, async () => {
    const cross = await request(app).post('/api/push/subscribe').set('Sec-Fetch-Site', 'cross-site').send(body());
    assert.strictEqual(cross.status, 403);
    const foreign = await request(app).post('/api/push/subscribe').set('Origin', 'https://evil.example').send(body());
    assert.strictEqual(foreign.status, 403);
    assert.strictEqual(calls.upsert.length, 0);
  }));

  it('accepts the site\'s own origin when the browser sends no Sec-Fetch-Site', withEnv(anon, async () => {
    const res = await request(app).post('/api/push/subscribe').set('Origin', 'https://tameside-badminton.co.uk').send(body());
    assert.strictEqual(res.status, 200);
  }));

  for (const [what, over, error] of [
    ['an endpoint that is not a push service', { subscription: { endpoint: 'https://evil.example/hook', keys: KEYS } }, 'unsupported push service'],
    ['no followable team', { teams: [999] }, 'pick at least one team'],
    ['no subscription', { subscription: undefined }, 'missing subscription'],
  ]) {
    it('answers 400 in JSON for ' + what, withEnv(anon, async () => {
      const res = await request(app).post('/api/push/subscribe').send(body(over));
      assert.strictEqual(res.status, 400);
      assert.deepStrictEqual(res.body, { ok: false, error });
      assert.strictEqual(calls.upsert.length, 0);
    }));
  }
});

describe('the lookup and unsubscribe', () => {
  it('POST /api/push/subscription returns what this browser is subscribed to', withEnv(anon, async () => {
    setModel('Push', 'getSubscription', async id => (id === subscriptionId(ENDPOINT) ? { teams: [4], types: [] } : null));
    const res = await request(app).post('/api/push/subscription').send({ endpoint: ENDPOINT });
    assert.deepStrictEqual(res.body, { ok: true, subscribed: true, teams: [4], types: [] });
    const none = await request(app).post('/api/push/subscription').send({ endpoint: ENDPOINT + 'x' });
    assert.deepStrictEqual(none.body, { ok: true, subscribed: false });
  }));

  it('DELETE /api/push/subscribe removes it; a missing endpoint is a 400', withEnv(anon, async () => {
    const res = await request(app).delete('/api/push/subscribe').send({ endpoint: ENDPOINT });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(calls.remove, [[subscriptionId(ENDPOINT)]]);
    const bad = await request(app).delete('/api/push/subscribe').send({});
    assert.strictEqual(bad.status, 400);
  }));
});

describe('POST /admin/push/reminders', () => {
  const TOKEN = 'a-test-push-token';

  it('refuses an anonymous caller with 404, not a redirect, and runs nothing', withEnv({ ...anon, PUSH_CRON_TOKEN: TOKEN }, async () => {
    const run = mock.method(push, 'runReminders', async () => ({}));
    const res = await request(app).post('/admin/push/reminders?when=tonight');
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.headers.location, undefined);
    assert.strictEqual(run.mock.callCount(), 0);
  }));

  it('an unset token closes the path', withEnv({ ...anon, PUSH_CRON_TOKEN: undefined }, async () => {
    const run = mock.method(push, 'runReminders', async () => ({}));
    const res = await request(app).post('/admin/push/reminders?when=tonight&t=' + TOKEN);
    assert.strictEqual(res.status, 404);
    assert.strictEqual(run.mock.callCount(), 0);
  }));

  it('the scheduler runs the reminders; it cannot pick the day or a dry run', withEnv({ ...anon, PUSH_CRON_TOKEN: TOKEN }, async () => {
    mock.method(console, 'log', () => {});
    const run = mock.method(push, 'runReminders', async () => ({ when: 'tomorrow', date: '2027-02-09', sent: 2 }));
    const res = await request(app).post(`/admin/push/reminders?when=tomorrow&date=2027-01-01&dry=1&t=${TOKEN}`);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { when: 'tomorrow', date: '2027-02-09', sent: 2 });
    assert.deepStrictEqual(run.mock.calls[0].arguments, ['tomorrow', { date: undefined, dry: false }]);
  }));

  it('a superadmin may pick the day and ask for a dry run', withEnv({ ...superadmin, PUSH_CRON_TOKEN: undefined }, async () => {
    mock.method(console, 'log', () => {});
    const run = mock.method(push, 'runReminders', async () => ({ dry: true }));
    const res = await request(app).post('/admin/push/reminders?when=tonight&date=2027-01-05&dry=1');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(run.mock.calls[0].arguments, ['tonight', { date: '2027-01-05', dry: true }]);
  }));

  it('an unknown kind is a 400; a failed run is a 500 the scheduler shows', withEnv({ ...anon, PUSH_CRON_TOKEN: TOKEN }, async () => {
    mock.method(console, 'error', () => {});
    mock.method(push, 'runReminders', async () => { throw new Error('when must be one of tonight, tomorrow'); });
    assert.strictEqual((await request(app).post(`/admin/push/reminders?when=weekly&t=${TOKEN}`)).status, 400);
    mock.method(push, 'runReminders', async () => { throw new Error('db down'); });
    assert.strictEqual((await request(app).post(`/admin/push/reminders?when=tonight&t=${TOKEN}`)).status, 500);
  }));
});

describe('/admin/push', () => {
  it('is superadmin-only', withEnv(clubAdmin, async () => {
    const test = mock.method(push, 'sendTest', async () => ({}));
    assert.strictEqual((await request(app).get('/admin/push')).status, 403);
    assert.strictEqual((await request(app).post('/admin/push/test').type('form').send({ to: 'everyone' })).status, 403);
    assert.strictEqual(test.mock.callCount(), 0);
  }));

  it('shows followers per team and recent sends', withEnv({ ...superadmin, VAPID_PRIVATE_KEY: 'k', ...VAPID }, async () => {
    const res = await request(app).get('/admin/push');
    assert.strictEqual(res.status, 200);
    assert.ok(res.text.includes('3 devices subscribed.'));
    assert.match(res.text, /<td>Hyde B<\/td><td class="text-end">2<\/td>/);
    assert.ok(res.text.includes('<code>result-304</code>'));
    assert.ok(!res.text.includes('Not configured.'));
  }));

  it('says so when the keys are unset', withEnv({ ...superadmin, VAPID_PRIVATE_KEY: undefined }, async () => {
    const res = await request(app).get('/admin/push');
    assert.ok(res.text.includes('Not configured.'));
  }));

  it('a test to this browser goes to its subscription only', withEnv(superadmin, async () => {
    const test = mock.method(push, 'sendTest', async () => ({ subscribers: 1, sent: 1, failed: 0, removed: 0 }));
    const res = await request(app).post('/admin/push/test').type('form').send({ to: 'me', endpoint: ENDPOINT });
    assert.deepStrictEqual(test.mock.calls[0].arguments, [{ subscriptionId: subscriptionId(ENDPOINT) }]);
    assert.ok(res.text.includes('Sent 1 of 1.'));
  }));

  it('a test to this browser without a subscription sends nothing and says why', withEnv(superadmin, async () => {
    const test = mock.method(push, 'sendTest', async () => ({}));
    const res = await request(app).post('/admin/push/test').type('form').send({ to: 'me', endpoint: '' });
    assert.strictEqual(test.mock.callCount(), 0);
    assert.ok(res.text.includes('This browser has no subscription.'));
  }));

  it('a test to everyone', withEnv(superadmin, async () => {
    const test = mock.method(push, 'sendTest', async () => ({ subscribers: 3, sent: 2, failed: 0, removed: 1 }));
    const res = await request(app).post('/admin/push/test').type('form').send({ to: 'everyone' });
    assert.deepStrictEqual(test.mock.calls[0].arguments, [{}]);
    assert.ok(res.text.includes('Sent 2 of 3; 1 expired subscription(s) removed.'));
  }));
});
