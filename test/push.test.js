// utils/push: checking subscriptions, what a notification says, the fan-out, and the
// at-most-once rules around it. Ported from Stockport's __tests__/unit/push.test.js (jest
// there). The model is stubbed with mock.method, which works because utils/push calls it
// (and web-push) through the module object.

const { describe, it, afterEach, mock } = require('node:test');
const assert = require('node:assert');

const webpush = require('web-push');
const Push = require('../models/push');
const { validateSubscription, validateTypes, validateTeams, subscriptionId } = require('../utils/push/subscription');
const N = require('../utils/push/notifications');
const { sendNotifications } = require('../utils/push/send');
const push = require('../utils/push');

const savedEnv = { ...process.env };
const withKeys = () => {
  process.env.VAPID_PUBLIC_KEY = 'BPublicKeyForTests';
  process.env.VAPID_PRIVATE_KEY = 'private-key-for-tests';
};

// Every model call stubbed, so nothing here can reach the database.
let calls;
function stubModel({ subscribers = [], claim = true, result = null, reminders = [] } = {}) {
  calls = { subscribersFor: [], removeSubscriptions: [], markSent: [], claimSend: [], recordSummary: [], remindersFor: [] };
  const rec = (name, ret) => mock.method(Push, name, async (...args) => { calls[name].push(args); return typeof ret === 'function' ? ret(...args) : ret; });
  rec('subscribersFor', subscribers);
  rec('removeSubscriptions', ids => ids.length);
  rec('markSent', undefined);
  rec('claimSend', claim);
  rec('recordSummary', undefined);
  rec('remindersFor', reminders);
  mock.method(Push, 'resultFor', async () => result);
}
function stubSend(impl = async () => ({})) {
  return mock.method(webpush, 'sendNotification', impl);
}

afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  mock.restoreAll();
});

const KEYS = { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' };

describe('validateSubscription', () => {
  it('accepts a real push service endpoint and keeps only endpoint and keys', () => {
    const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { ...KEYS, extra: 1 }, expirationTime: null };
    assert.deepStrictEqual(validateSubscription(sub), { endpoint: sub.endpoint, keys: KEYS });
    assert.match(validateSubscription({ endpoint: 'https://web.push.apple.com/QG', keys: KEYS }).endpoint, /apple/);
  });

  for (const [what, sub, message] of [
    ['an arbitrary host', { endpoint: 'https://evil.example.com/x', keys: KEYS }, /unsupported push service/],
    ['a lookalike host', { endpoint: 'https://fcm.googleapis.com.evil.example/x', keys: KEYS }, /unsupported/],
    ['plain http', { endpoint: 'http://fcm.googleapis.com/fcm/send/abc', keys: KEYS }, /invalid endpoint/],
    ['not a URL', { endpoint: 'nope', keys: KEYS }, /invalid endpoint/],
    ['bad keys', { endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'has space', auth: 'a' } }, /invalid keys/],
    ['no keys', { endpoint: 'https://fcm.googleapis.com/x' }, /invalid keys/],
    ['nothing', undefined, /missing subscription/],
  ]) {
    it('refuses ' + what, () => assert.throws(() => validateSubscription(sub), message));
  }

  it('ids a subscription by the hash of its endpoint', () => {
    assert.match(subscriptionId('https://a'), /^[0-9a-f]{64}$/);
    assert.strictEqual(subscriptionId('https://a'), subscriptionId('https://a'));
    assert.notStrictEqual(subscriptionId('https://a'), subscriptionId('https://b'));
  });
});

describe('validateTypes and validateTeams', () => {
  it('keeps known types once each; none means all', () => {
    assert.deepStrictEqual(validateTypes(['results', 'spam', 'results']), ['results']);
    assert.deepStrictEqual(validateTypes(undefined), []);
    assert.throws(() => validateTypes('results'), /invalid types/);
  });

  it('keeps allowed team ids once each, and needs at least one', () => {
    assert.deepStrictEqual(validateTeams([3, '4', 4, 99, 'x'], [3, 4, 5]), [3, 4]);
    assert.throws(() => validateTeams([99], [3]), /at least one team/);
    assert.throws(() => validateTeams([], [3]), /at least one team/);
    assert.throws(() => validateTeams('3', [3]), /invalid teams/);
  });
});

const fixture = (over = {}) => ({
  id: 304, date: new Date(2027, 1, 9), status: 'outstanding', homeScore: null, awayScore: null, lewisRound: null,
  homeTeamId: 4, awayTeamId: 3, homeTeam: 'Hyde B', awayTeam: 'Shell A',
  startTime: '19:30', divisionName: 'Division 2', venueName: 'Hyde Leisure Pool', ...over,
});

describe('notifications', () => {
  it('a result goes to both teams, links to the event page, and is tagged by fixture', () => {
    assert.deepStrictEqual(N.resultNotification(fixture({ status: 'complete', homeScore: 12, awayScore: 6 })), {
      type: 'results', teams: [4, 3],
      title: 'Hyde B 12–6 Shell A', body: 'Result · Division 2',
      url: '/event/304/09022027-Hyde%20B-Shell%20A', tag: 'result-304',
    });
  });

  it('no result notification without a completed score', () => {
    assert.strictEqual(N.resultNotification(fixture()), null);
    assert.strictEqual(N.resultNotification(fixture({ status: 'complete', homeScore: 12 })), null);
    assert.strictEqual(N.resultNotification(fixture({ status: 'conceded', homeScore: 18, awayScore: 0 })), null);
  });

  it('a reminder says when, where and which division, with a tag per kind', () => {
    const tonight = N.reminderNotification(fixture(), 'tonight');
    assert.deepStrictEqual(
      { type: tonight.type, teams: tonight.teams, title: tonight.title, body: tonight.body, tag: tonight.tag },
      { type: 'reminders', teams: [4, 3], title: 'Tonight: Hyde B v Shell A', body: '7:30pm · Hyde Leisure Pool · Division 2', tag: 'reminder-tonight-304' });
    const tomorrow = N.reminderNotification(fixture(), 'tomorrow');
    assert.strictEqual(tomorrow.title, 'Tomorrow: Hyde B v Shell A');
    assert.strictEqual(tomorrow.tag, 'reminder-tomorrow-304');
  });

  it('a Lewis Shield tie says Lewis Shield, not the home team\'s division (ours alone)', () => {
    assert.strictEqual(N.reminderNotification(fixture({ lewisRound: 2 }), 'tonight').body, '7:30pm · Hyde Leisure Pool · Lewis Shield');
    assert.strictEqual(N.resultNotification(fixture({ lewisRound: 3, status: 'complete', homeScore: 9, awayScore: 9 })).body, 'Result · Lewis Shield');
  });

  it('a reminder leaves out what is not known', () => {
    assert.strictEqual(N.reminderNotification(fixture({ startTime: null, venueName: null }), 'tonight').body, 'Division 2');
  });

  for (const [t, text] of [['19:30', '7:30pm'], ['20:00', '8pm'], ['18.45', '6:45pm'], ['12:00', '12pm'], ['9:15', '9:15am'], [' 7.30pm ', '7.30pm'], [null, '']]) {
    it(`start time ${JSON.stringify(t)} reads ${JSON.stringify(text)}`, () => assert.strictEqual(N.startTimeText(t), text));
  }

  it('the reminder date is the UK date, the next one for "tomorrow", across a clock change', () => {
    // 17:00 UK on Sat 25 Oct 2025 (BST, 16:00Z); the clocks went back that night.
    assert.strictEqual(N.reminderDate('tonight', new Date('2025-10-25T16:00:00Z')), '2025-10-25');
    assert.strictEqual(N.reminderDate('tomorrow', new Date('2025-10-25T17:00:00Z')), '2025-10-26');
    // 18:00 UK on Sat 28 Mar 2026 (GMT); the clocks went forward that night.
    assert.strictEqual(N.reminderDate('tomorrow', new Date('2026-03-28T18:00:00Z')), '2026-03-29');
    // 23:30 UTC in summer is already the next UK day.
    assert.strictEqual(N.reminderDate('tonight', new Date('2026-07-01T23:30:00Z')), '2026-07-02');
  });
});

const subRow = id => ({ id, endpoint: `https://fcm.googleapis.com/fcm/send/${id}`, p256dh: 'p', auth: 'a' });
const note = { type: 'results', teams: [1], title: 'T', body: 'B', url: '/x', tag: 't' };

describe('sendNotifications', () => {
  it('sends nothing without the VAPID key', async () => {
    stubModel();
    const sent = stubSend();
    const out = await sendNotifications([note]);
    assert.strictEqual(out.skipped, 'no VAPID key');
    assert.strictEqual(out.sent, 0);
    assert.strictEqual(calls.subscribersFor.length, 0);
    assert.strictEqual(sent.mock.callCount(), 0);
  });

  it('sends each match, removes subscriptions that are gone, counts other failures', async () => {
    withKeys();
    stubModel({ subscribers: [subRow('ok'), subRow('gone'), subRow('expired'), subRow('flaky')] });
    mock.method(console, 'warn', () => {});
    const sent = stubSend(async s => {
      if (s.endpoint.endsWith('gone')) throw Object.assign(new Error('gone'), { statusCode: 410 });
      if (s.endpoint.endsWith('expired')) throw Object.assign(new Error('nf'), { statusCode: 404 });
      if (s.endpoint.endsWith('flaky')) throw Object.assign(new Error('busy'), { statusCode: 503 });
    });

    assert.deepStrictEqual(await sendNotifications([note]), { notifications: 1, subscribers: 4, sent: 1, failed: 1, removed: 2 });
    assert.deepStrictEqual(calls.subscribersFor[0], [{ teams: [1], type: 'results' }]);
    assert.deepStrictEqual(calls.removeSubscriptions[0], [['gone', 'expired']]);
    assert.deepStrictEqual(calls.markSent[0], [['ok']]);

    const [sub, payload, options] = sent.mock.calls[0].arguments;
    assert.deepStrictEqual(sub, { endpoint: 'https://fcm.googleapis.com/fcm/send/ok', keys: { p256dh: 'p', auth: 'a' } });
    assert.deepStrictEqual(JSON.parse(payload), { title: 'T', body: 'B', url: '/x', tag: 't' });
    // The VAPID subject is the site's own address, from SITE_URL, never a request's Host.
    assert.deepStrictEqual(options.vapidDetails, { subject: 'https://tameside-badminton.co.uk', publicKey: 'BPublicKeyForTests', privateKey: 'private-key-for-tests' });
  });

  it('only: sends to the named subscription and nobody else', async () => {
    withKeys();
    stubModel({ subscribers: [subRow('mine'), subRow('theirs')] });
    const sent = stubSend();
    const out = await sendNotifications([note], { only: ['mine'] });
    assert.strictEqual(out.subscribers, 1);
    assert.strictEqual(out.sent, 1);
    assert.strictEqual(sent.mock.callCount(), 1);
  });
});

describe('notifyResult', () => {
  const played = fixture({ status: 'complete', homeScore: 10, awayScore: 8 });

  it('without the key it claims nothing, so the result can still be sent once the key is set', async () => {
    stubModel({ result: played });
    assert.deepStrictEqual(await push.notifyResult(304), { skipped: 'no VAPID key' });
    assert.strictEqual(calls.claimSend.length, 0);
  });

  it('claims result-<id>, sends, and records what happened', async () => {
    withKeys();
    stubModel({ result: played, subscribers: [subRow('a')] });
    stubSend();
    mock.method(console, 'log', () => {});
    const out = await push.notifyResult(304);
    assert.strictEqual(out.sent, 1);
    assert.deepStrictEqual(calls.claimSend[0], ['result-304']);
    assert.strictEqual(calls.recordSummary[0][0], 'result-304');
    assert.strictEqual(calls.recordSummary[0][1].sent, 1);
  });

  it('a republished result sends nothing the second time', async () => {
    withKeys();
    stubModel({ result: played, claim: false });
    const sent = stubSend();
    assert.deepStrictEqual(await push.notifyResult(304), { skipped: 'already sent' });
    assert.strictEqual(sent.mock.callCount(), 0);
  });

  it('claims nothing for a fixture without a result', async () => {
    withKeys();
    stubModel({ result: fixture() });
    assert.deepStrictEqual(await push.notifyResult(304), { skipped: 'no result' });
    assert.strictEqual(calls.claimSend.length, 0);
  });
});

describe('runReminders', () => {
  const at = new Date('2027-02-08T18:00:00Z'); // 18:00 UK, Monday 8 Feb 2027

  it('reads tomorrow\'s fixtures, claims the day and kind, and sends one per fixture', async () => {
    withKeys();
    stubModel({ reminders: [fixture()], subscribers: [subRow('a')] });
    stubSend();
    mock.method(console, 'log', () => {});
    const out = await push.runReminders('tomorrow', { now: at });
    assert.deepStrictEqual(calls.remindersFor[0], ['2027-02-09']);
    assert.deepStrictEqual(calls.claimSend[0], ['reminders-2027-02-09-tomorrow']);
    assert.strictEqual(out.date, '2027-02-09');
    assert.strictEqual(out.fixtures, 1);
    assert.strictEqual(out.sent, 1);
    assert.deepStrictEqual(out.titles, ['Tomorrow: Hyde B v Shell A']);
  });

  it('a second run for the same day and kind sends nothing', async () => {
    withKeys();
    stubModel({ reminders: [fixture()], claim: false });
    const sent = stubSend();
    const out = await push.runReminders('tonight', { date: '2027-02-09' });
    assert.strictEqual(out.skipped, 'reminders-2027-02-09-tonight already sent');
    assert.strictEqual(sent.mock.callCount(), 0);
  });

  it('a day with no fixtures claims nothing; a dry run claims and sends nothing', async () => {
    withKeys();
    stubModel({ reminders: [] });
    const sent = stubSend();
    assert.strictEqual((await push.runReminders('tonight', { now: at })).note, 'no fixtures');
    mock.method(Push, 'remindersFor', async () => [fixture()]);
    const dry = await push.runReminders('tonight', { date: '2027-02-09', dry: true });
    assert.strictEqual(dry.dry, true);
    assert.strictEqual(dry.fixtures, 1);
    assert.strictEqual(calls.claimSend.length, 0);
    assert.strictEqual(sent.mock.callCount(), 0);
  });

  it('refuses an unknown kind', async () => {
    await assert.rejects(push.runReminders('weekly'), /tonight, tomorrow/);
  });
});

describe('pushNote', () => {
  it('says what the publish did, including when it failed', () => {
    assert.match(push.pushNote(null), /could not be sent/);
    assert.match(push.pushNote({ skipped: 'no VAPID key' }), /not configured/);
    assert.match(push.pushNote({ skipped: 'already sent' }), /already sent/);
    assert.match(push.pushNote({ subscribers: 0, sent: 0 }), /Nobody follows/);
    assert.strictEqual(push.pushNote({ subscribers: 3, sent: 2, failed: 1 }), 'Push notification sent to 2 of 3 devices (1 failed).');
  });
});
