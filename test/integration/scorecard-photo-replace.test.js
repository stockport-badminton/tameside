// Attaching and replacing a filed scorecard's photo.
//
// POST /add-scorecard-photo/:id was `secured` and nothing else: any logged-in member could
// point any scorecard's photo at any url, and the results mailbox was emailed about it.
// Now a captain may only fill an EMPTY photo on a scorecard filed under their own login,
// and only with one of our own objects; a superadmin may replace any — the "Replace
// photo" panel on the confirmation page, which replaced blanking the column in the DB.
//
// Every refusal asserts that nothing was written and nothing was mailed, not just the
// status: a gate that answers 403 after writing would pass a status-only test.
const { describe, it, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { app, setModel, clearModels } = require('../helpers/app');
const mailer = require('../../utils/mailer');

afterEach(() => { clearModels(); mock.restoreAll(); });

function asUser({ role } = {}, fn) {
  return async () => {
    const saved = { DEV_MODE: process.env.DEV_MODE, DEV_ROLE: process.env.DEV_ROLE };
    if (role === undefined) delete process.env.DEV_MODE;
    else { process.env.DEV_MODE = 'true'; process.env.DEV_ROLE = role; }
    try { await fn(); } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  };
}
const SUPERADMIN = { role: 'superadmin' };
const MEMBER = { role: 'none' };
// middleware/devMode.js's mock profile.
const ME = 'dev@local.test';

const BUCKET = `https://${process.env.S3_BUCKET_NAME}.s3.eu-west-1.amazonaws.com`;
const NEW_URL = `${BUCKET}/tameside-scorecard-2176-1761818400000-photo.jpg`;
const OLD_URL = `${BUCKET}/tameside-20262027-Hyde%20B-GHAP%20A.pdf`;

function row(overrides = {}) {
  return Object.assign({ id: 2176, email: ME, homeTeam: 55, awayTeam: 56, division: 8, 'scoresheet-url': '' }, overrides);
}

// Records every write and every mail.
function harness(stored) {
  const writes = [];
  const sent = [];
  setModel('Fixture', 'getScorecardById', (id, cb) => cb(null, stored ? [stored] : []));
  setModel('Fixture', 'updateScorecardPhoto', (id, url, cb) => { writes.push([String(id), url]); cb(null, []); });
  setModel('Team', 'getById', (id, cb) => cb(null, [{ id, name: id === 55 ? 'Hyde B' : 'GHAP A' }]));
  setModel('Division', 'getById', (id, cb) => cb(null, [{ id, name: 'Division 1' }]));
  mock.method(mailer.client, 'post', () => ({
    request: (payload) => { sent.push(payload); return Promise.resolve({ body: {} }); },
  }));
  return { writes, sent };
}

const post = (id, imgURL) => request(app).post(`/add-scorecard-photo/${id}`).send({ imgURL });

describe('POST /add-scorecard-photo/:id', () => {
  it('anonymous: redirects to login', asUser({}, async () => {
    const { writes } = harness(row());
    const res = await post(2176, NEW_URL);
    assert.strictEqual(res.status, 302);
    assert.strictEqual(writes.length, 0);
  }));

  // Without this a member could point a scorecard at anything — another match's photo, or
  // an object the photo route would then refuse.
  it('refuses a url that is not one of our objects, before looking anything up', asUser(SUPERADMIN, async () => {
    const { writes, sent } = harness(row());
    for (const url of ['', 'https://evil.example/x.jpg', `${BUCKET}/canute-a-b.jpg`, `${BUCKET}/tameside-x.html`]) {
      const res = await post(2176, url);
      assert.strictEqual(res.status, 400, url);
    }
    assert.strictEqual(writes.length, 0);
    assert.strictEqual(sent.length, 0);
  }));

  it('a member cannot touch a scorecard someone else filed', asUser(MEMBER, async () => {
    const { writes, sent } = harness(row({ email: 'another.captain@example.com' }));
    const res = await post(2176, NEW_URL);
    assert.strictEqual(res.status, 403);
    assert.strictEqual(writes.length, 0);
    assert.strictEqual(sent.length, 0);
  }));

  it('a member cannot replace a photo that is already there', asUser(MEMBER, async () => {
    const { writes, sent } = harness(row({ 'scoresheet-url': OLD_URL }));
    const res = await post(2176, NEW_URL);
    assert.strictEqual(res.status, 409);
    assert.match(res.body.error, /results secretary/);
    assert.strictEqual(writes.length, 0);
    assert.strictEqual(sent.length, 0);
  }));

  // The legitimate member path: the list on /email-scorecard offers exactly these rows.
  it('a member fills the empty photo on their own scorecard, and the results mailbox hears', asUser(MEMBER, async () => {
    const { writes, sent } = harness(row({ email: '  DEV@local.test ' }));
    const res = await post(2176, NEW_URL);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(writes, [['2176', NEW_URL]]);
    assert.strictEqual(sent.length, 1);
    assert.match(sent[0].Messages[0].Subject, /Hyde B vs GHAP A/);
  }));

  it('a superadmin replaces any scorecard\'s photo, and is not emailed about it', asUser(SUPERADMIN, async () => {
    const { writes, sent } = harness(row({ email: 'another.captain@example.com', 'scoresheet-url': OLD_URL }));
    const res = await post(2176, NEW_URL);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(writes, [['2176', NEW_URL]]);
    assert.strictEqual(sent.length, 0);
  }));

  it('404s an id with no scorecard', asUser(SUPERADMIN, async () => {
    const { writes } = harness(null);
    const res = await post(99999, NEW_URL);
    assert.strictEqual(res.status, 404);
    assert.strictEqual(writes.length, 0);
  }));
});

describe('GET /email-scorecard — the "add scorecard photos" list', () => {
  function listHarness() {
    const calls = [];
    setModel('Division', 'getAllByLeague', (league, cb) => cb(null, []));
    setModel('Fixture', 'getMissingScorecardPhotos', (email, seeAll, cb) => { calls.push({ email, seeAll }); cb(null, []); });
    return calls;
  }

  // It used to show everything only to `stockport.badders.results@` — the other league's
  // mailbox — so from Tameside's own a blanked photo never appeared.
  it('a superadmin sees every scorecard missing a photo', asUser(SUPERADMIN, async () => {
    const calls = listHarness();
    const res = await request(app).get('/email-scorecard');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(calls, [{ email: ME, seeAll: true }]);
  }));

  it('a member sees only their own', asUser(MEMBER, async () => {
    const calls = listHarness();
    await request(app).get('/email-scorecard');
    assert.deepStrictEqual(calls, [{ email: ME, seeAll: false }]);
  }));
});

describe('GET /populated-scorecard-beta/:id — the photo panel', () => {
  function confirmationHarness(stored) {
    setModel('Fixture', 'getScorecardById', (id, cb) => cb(null, stored ? [stored] : []));
    setModel('Division', 'getAllAndSelectedById', (l, s, cb) => cb(null, [{ id: 8, name: 'Division 1', selected: 1 }]));
    setModel('Team', 'getAllAndSelectedById', (t, d, cb) => cb(null, [{ id: Number(t), name: 'Hyde B', selected: 1 }]));
    setModel('Player', 'getEligiblePlayersAndSelectedById', (a, b, t, g, cb) => cb(null, []));
  }
  const page = (id) => request(app).get(`/populated-scorecard-beta/${id}`);

  it('shows the current photo, versioned by its url, and the replace control', asUser(SUPERADMIN, async () => {
    confirmationHarness(row({ 'scoresheet-url': `${BUCKET}/tameside-20262027-Hyde%20B-GHAP%20A-photo.jpg` }));
    const res = await page(2176);
    assert.strictEqual(res.status, 200);
    assert.match(res.text, /id="scorecard-photo-panel" class="mt-4" data-scorecard-id="2176"/);
    assert.match(res.text, /<img src="\/scorecard-photo\/2176\?v=[0-9a-f]{10}"/);
    assert.match(res.text, /id="replace-photo-file"/);
    assert.match(res.text, /scorecard-photo-replace\.js/);
  }));

  // A new photo must not be hidden behind the old one's five-minute private cache.
  it('the version changes when the photo is replaced', asUser(SUPERADMIN, async () => {
    const version = async (url) => {
      confirmationHarness(row({ 'scoresheet-url': url }));
      return /\/scorecard-photo\/2176\?v=([0-9a-f]+)/.exec((await page(2176)).text)[1];
    };
    assert.notStrictEqual(await version(`${BUCKET}/tameside-a.jpg`), await version(`${BUCKET}/tameside-b.jpg`));
  }));

  // A pdf is served as a download by the photo route, so it is offered as one.
  it('offers a document as a download', asUser(SUPERADMIN, async () => {
    confirmationHarness(row({ 'scoresheet-url': OLD_URL }));
    const res = await page(2176);
    assert.match(res.text, /Download the attached file/);
    assert.doesNotMatch(res.text, /<img src="\/scorecard-photo/);
  }));

  it('with no photo, offers to attach one', asUser(SUPERADMIN, async () => {
    confirmationHarness(row());
    const res = await page(2176);
    assert.match(res.text, /No photo attached/);
    assert.match(res.text, /Attach a photo/);
  }));

  it('404s an id with no scorecard rather than 500ing', asUser(SUPERADMIN, async () => {
    confirmationHarness(null);
    const res = await page(99999);
    assert.strictEqual(res.status, 404);
  }));
});
