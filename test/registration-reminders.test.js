// The registration chase: the pure parts, and the two send decisions.
//
// Nothing here touches the database or Mailjet. The model is stubbed at the module object
// (require caches it, so the controller sees the same instance), and the Mailjet client is
// stubbed through the _mailjetClientForTesting seam every other controller exposes — it
// MUST be mailer.client, or the stub intercepts nothing and real mail goes out.

const { describe, it, mock, afterEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const ejs = require('ejs');

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
for (const [k, v] of Object.entries({
  MAILJET_KEY: 'test-key', MAILJET_SECRET: 'test-secret', DB_ENCODE: 'test-encode',
  PGPASSWORD: 'test-placeholder',
})) if (!process.env[k]) process.env[k] = v;

const ClubRegistration = require('../models/clubRegistration');
const seasonModel = require('../models/season');
const mailer = require('../utils/mailer');
const Player = require('../models/players');
const controller = require('../controllers/registrationReminderController');

afterEach(() => mock.restoreAll());

// Capture what would have gone to Mailjet.
function stubMailjet() {
  const sent = [];
  mock.method(mailer.client, 'post', () => ({
    request: (payload) => { sent.push(payload.Messages[0]); return Promise.resolve({ body: {} }); },
  }));
  return sent;
}

const club = (over = {}) => ({
  id: 47, name: 'Hyde', season: '20262027', teams: 3,
  firstFixture: new Date('2026-09-02T00:00:00.000Z'), daysAway: -3,
  receivedAt: null, chasedAt: null, chaseCount: 0, note: null, updatedBy: null,
  received: false, chased: false,
  officers: [{ name: 'Jill Jackson', email: 'jill@example.com', role: 'club secretary' }],
  ...over,
});

/* ------------------------------------------------------------------ */

describe('officer de-duplication', () => {
  // Two player rows can carry the same address — there are eight duplicated display names
  // in this table — and both would otherwise be emailed. Matched case-insensitively,
  // because the addresses are free text a human typed.
  it('merges two rows carrying the same address into one recipient', () => {
    const merged = ClubRegistration.mergeOfficers([
      { clubId: 47, name: 'Jill Jackson', email: 'jill@example.com', role: 'club secretary' },
      { clubId: 47, name: 'Jill Jackson', email: 'JILL@example.com', role: 'match secretary' },
    ]);
    assert.strictEqual(merged.length, 1);
    assert.strictEqual(merged[0].email, 'jill@example.com');
    assert.match(merged[0].role, /club secretary and match secretary/);
  });

  it('keeps two genuinely different people', () => {
    const merged = ClubRegistration.mergeOfficers([
      { clubId: 51, name: 'Natalie Clemmit', email: 'nat@example.com', role: 'club secretary' },
      { clubId: 51, name: 'Julian Cherryman', email: 'jules@example.com', role: 'club secretary' },
    ]);
    assert.strictEqual(merged.length, 2);
  });

  // Somebody with no address on file still belongs on the screen — that is the reason
  // their club cannot be chased, and the worklist says so rather than showing an
  // inexplicably disabled button.
  it('keeps an officer with no email, after the ones that have one', () => {
    const merged = ClubRegistration.mergeOfficers([
      { clubId: 39, name: 'No Address', email: null, role: 'club secretary' },
      { clubId: 39, name: 'Roger Holmes', email: 'roger@example.com', role: 'match secretary' },
    ]);
    assert.strictEqual(merged.length, 2);
    assert.strictEqual(merged[0].email, 'roger@example.com');
    assert.strictEqual(merged[1].email, null);
  });
});

describe('deadline wording', () => {
  it('reads as English either side of the fixture', () => {
    assert.strictEqual(controller._dueLabel(0), 'today');
    assert.strictEqual(controller._dueLabel(1), 'tomorrow');
    assert.strictEqual(controller._dueLabel(3), 'in 3 days');
    assert.strictEqual(controller._dueLabel(-1), 'was yesterday');
    assert.strictEqual(controller._dueLabel(-8), 'was 8 days ago');
  });

  // A DATE column arrives as a JS Date at UTC midnight. Formatted in a local zone west of
  // Greenwich that renders as the day before — the same class of bug as reading
  // fixture.date through a local Date, which prints league nights on a Sunday.
  it('does not slip a day when the process is in a western timezone', () => {
    const previous = process.env.TZ;
    try {
      process.env.TZ = 'America/New_York';
      assert.strictEqual(controller._formatDate(new Date('2026-09-02T00:00:00.000Z')),
        'Wed 2 Sep 2026');
    } finally {
      if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
    }
  });

  it('degrades rather than printing Invalid Date', () => {
    assert.strictEqual(controller._formatDate(null), null);
    assert.strictEqual(controller._formatDate('not a date'), null);
  });

  it('spells a season name out for a human', () => {
    assert.strictEqual(controller._seasonLabel('20262027'), '2026/2027');
  });
});

describe('the daily digest', () => {
  it('sends nothing when there is nothing due and nothing chased', async () => {
    mock.method(seasonModel, 'current', () => '20262027');
    mock.method(ClubRegistration, 'getDigest', async () => ({
      season: '20262027', withinDays: 3, dueSoon: [], chased: [],
      outstanding: 0, received: 12, total: 12,
    }));
    const sent = stubMailjet();

    const result = await controller.sendDigest();
    assert.strictEqual(result.sent, false);
    assert.strictEqual(sent.length, 0, 'a quiet day must not produce an email');
    // The run still reports what it decided, so a quiet day is distinguishable from a
    // broken scheduler by anyone who looks.
    assert.strictEqual(result.total, 12);
  });

  it('sends when a club is due, to the results mailbox by default', async () => {
    mock.method(seasonModel, 'current', () => '20262027');
    mock.method(ClubRegistration, 'getDigest', async () => ({
      season: '20262027', withinDays: 3,
      dueSoon: [club()], chased: [], outstanding: 1, received: 11, total: 12,
    }));
    const sent = stubMailjet();

    const previousTo = process.env.REGISTRATION_DIGEST_TO;
    delete process.env.REGISTRATION_DIGEST_TO;
    try {
      const result = await controller.sendDigest();
      assert.strictEqual(result.sent, true);
      assert.strictEqual(sent.length, 1);
      assert.strictEqual(sent[0].To[0].Email, mailer.RESULTS_MAILBOX);
      assert.match(sent[0].Subject, /1 due/);
      // Every league email needs a plain-text part; send() throws without one, but the
      // content matters too — a text-only client shows this and nothing else.
      assert.match(sent[0].TextPart, /Hyde — first fixture Wed 2 Sep 2026 \(was 3 days ago\)/);
      assert.match(sent[0].HTMLPart, /Hyde/);
    } finally {
      if (previousTo !== undefined) process.env.REGISTRATION_DIGEST_TO = previousTo;
    }
  });

  it('sends a club that has been chased and is still outstanding', async () => {
    mock.method(seasonModel, 'current', () => '20262027');
    mock.method(ClubRegistration, 'getDigest', async () => ({
      season: '20262027', withinDays: 3, dueSoon: [],
      chased: [club({ daysAway: 18, chased: true, chaseCount: 2,
        chasedAt: new Date('2026-08-31T09:00:00.000Z') })],
      outstanding: 1, received: 11, total: 12,
    }));
    const sent = stubMailjet();

    const result = await controller.sendDigest();
    assert.strictEqual(result.sent, true);
    assert.match(sent[0].TextPart, /chased 2x/);
  });
});

describe('chasing one club', () => {
  it('refuses a club with no officer email rather than sending to nobody', async () => {
    const sent = stubMailjet();
    const result = await controller.sendChase(
      club({ officers: [{ name: 'Nobody', email: null, role: 'club secretary' }] }), 'me@x');
    assert.strictEqual(result.sent, false);
    assert.match(result.reason, /no club or match secretary with an email/);
    assert.strictEqual(sent.length, 0);
  });

  it('refuses a club with no players, rather than attaching an empty form', async () => {
    mock.method(Player, 'getNamesClubsTeams', (params, done) => done(null, []));
    const sent = stubMailjet();
    const result = await controller.sendChase(club(), 'me@x');
    assert.strictEqual(result.sent, false);
    assert.match(result.reason, /No players are registered/);
    assert.strictEqual(sent.length, 0);
  });

  it('attaches the pre-filled .docx and records the chase', async () => {
    mock.method(Player, 'getNamesClubsTeams', (params, done) => done(null, [
      { teamName: 'Hyde A', teamId: 1, name: 'Andrew Capewell', gender: 'Male', rank: 1 },
      { teamName: 'Hyde A', teamId: 1, name: 'Alice Cooper', gender: 'Female', rank: 1 },
      { teamName: 'Hyde A', teamId: 1, name: 'Gareth Perrins', gender: 'Male', rank: 99 },
    ]));
    const chases = [];
    mock.method(ClubRegistration, 'recordChase', async (...args) => { chases.push(args); return { id: 1, chaseCount: 1 }; });
    const sent = stubMailjet();

    const result = await controller.sendChase(club(), 'me@example.com');
    assert.strictEqual(result.sent, true);
    assert.deepStrictEqual(result.recipients, ['jill@example.com']);

    const message = sent[0];
    assert.strictEqual(message.Attachments.length, 1);
    assert.strictEqual(message.Attachments[0].Filename, 'Hyde Registrations.docx');
    assert.strictEqual(message.Attachments[0].ContentType,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    // A .docx is a zip; "PK" is its first two bytes. This is what catches the attachment
    // being sent as "[object Object]" or as a double-encoded string.
    assert.strictEqual(
      Buffer.from(message.Attachments[0].Base64Content, 'base64').subarray(0, 2).toString(),
      'PK');
    // Copied to the results mailbox so there is a record of what a club was sent.
    assert.strictEqual(message.Bcc[0].Email, mailer.RESULTS_MAILBOX);
    assert.deepStrictEqual(chases, [['20262027', 47, 'me@example.com']]);
  });

  // The chase is recorded only after Mailjet accepts. Ticking first would leave a club
  // looking chased when nothing reached it — worse than looking un-chased, because the
  // digest would then stop reporting it as due.
  it('does not record a chase that failed to send', async () => {
    mock.method(Player, 'getNamesClubsTeams', (params, done) => done(null, [
      { teamName: 'Hyde A', teamId: 1, name: 'Andrew Capewell', gender: 'Male', rank: 1 },
    ]));
    let recorded = 0;
    mock.method(ClubRegistration, 'recordChase', async () => { recorded += 1; });
    mock.method(mailer.client, 'post', () => ({
      request: () => Promise.reject(new Error('Mailjet is down')),
    }));

    await assert.rejects(() => controller.sendChase(club(), 'me@x'), /Mailjet is down/);
    assert.strictEqual(recorded, 0);
  });
});

describe('the digest template guards', () => {
  const render = (data) => new Promise((resolve, reject) =>
    ejs.renderFile(path.join(__dirname, '..', 'views', 'emails', 'registration-digest.ejs'),
      data, (err, html) => (err ? reject(err) : resolve(html))));

  const base = {
    withinDays: 3, received: 12, total: 12, seasonLabel: '2026/2027',
    worklistUrl: 'https://tameside-badminton.co.uk/admin/registration-reminders',
  };

  // An EJS tag sitting directly between two MJML components is DISCARDED by the compiler
  // and the content it guarded then renders unconditionally — silently. Both blocks here
  // are guarded, so an empty list must produce no heading. tools/build-emails.js counts
  // tags either side of the build; this checks the rendered result.
  it('prints no heading for an empty list', async () => {
    const html = await render({ ...base, dueSoon: [], chased: [] });
    assert.ok(!/Due within/.test(html), 'the due-soon heading rendered with an empty list');
    assert.ok(!/still nothing back/.test(html), 'the chased heading rendered with an empty list');
  });

  it('prints only the block that has clubs in it', async () => {
    const html = await render({
      ...base,
      dueSoon: [{ name: 'Hyde', firstFixtureLabel: 'Wed 2 Sep 2026', dueLabel: 'was 3 days ago', daysAway: -3, chaseCount: 0 }],
      chased: [],
    });
    assert.match(html, /Due within/);
    assert.ok(!/still nothing back/.test(html));
    assert.match(html, /Hyde/);
  });
});
