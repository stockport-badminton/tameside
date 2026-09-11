// GET /club/:id — the club contact page (views/club-contact.ejs).
//
// Two things this pins that the query tests can't reach:
//
//  1. An unknown club id used to be a 500. The controller lumped "the query failed"
//     together with "the query returned nothing" and called next(err) with err
//     undefined, so an id that simply isn't in the table rendered the error page and
//     spent a Sentry event on an expected outcome.
//
//  2. A role the league has never recorded resolves to null. The page must say so
//     rather than emitting an empty name inside `mailto:` and `tel:` links — which is
//     what Mellor's missing club secretary did, having first spent two seasons showing
//     the "No Player" placeholder row's real phone number and email address.

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { app, setModel, clearModels } = require('../helpers/app');

afterEach(() => clearModels());

// The shape getContactDetailsById returns: one row per team, club-level fields repeated.
function row(overrides = {}) {
  return Object.assign({
    clubName: 'Mellor',
    teamName: 'Mellor A',
    venueId: 4, venueName: 'Mellor Sports Club', address: '1 Mellor Road',
    matchVenueId: 4, matchVenueName: 'Mellor Sports Club', matchVenueAddress: '1 Mellor Road',
    matchNight: 'Tuesday',
    matchSecretary: 'Roger Holmes', matchSecTel: '07700 900001', matchSecEmail: 'roger@example.com',
    clubSecretary: null, clubSecTel: null, clubSecEmail: null,
    teamCaptain: 'Darrel Gough', teamCaptainTel: '07700 900002', teamCaptainEmail: 'darrel@example.com',
  }, overrides);
}

describe('GET /club/:id — gating and missing clubs', () => {
  before(() => { process.env.DEV_MODE = 'true'; });
  after(() => { delete process.env.DEV_MODE; });

  it('sends an anonymous visitor to log in', async () => {
    delete process.env.DEV_MODE;
    const res = await request(app).get('/club/52');
    assert.strictEqual(res.status, 302);
    process.env.DEV_MODE = 'true';
  });

  it('404s an id that is not in the club table', async () => {
    setModel('Club', 'getContactDetailsById', (id, cb) => cb(null, []));
    const res = await request(app).get('/club/999999');
    assert.strictEqual(res.status, 404, 'an unknown club is not a server error');
  });

  it('does not cache the 404', async () => {
    // Firebase's edge applies a default 10-minute cache to a cookie-less response with
    // no Cache-Control, which would pin the 404 to a club that gets created later.
    setModel('Club', 'getContactDetailsById', (id, cb) => cb(null, []));
    const res = await request(app).get('/club/999999');
    assert.match(res.headers['cache-control'] || '', /no-store/);
  });

  it('still 500s a genuine query failure', async () => {
    setModel('Club', 'getContactDetailsById', (id, cb) => cb(new Error('connection reset')));
    const res = await request(app).get('/club/52');
    assert.strictEqual(res.status, 500);
  });
});

describe('GET /club/:id — one card per team', () => {
  before(() => { process.env.DEV_MODE = 'true'; });
  after(() => { delete process.env.DEV_MODE; });

  it('renders exactly as many captain cards as the query returned rows', async () => {
    setModel('Club', 'getContactDetailsById', (id, cb) => cb(null, [
      row({ teamName: 'Mellor A', teamCaptain: 'Darrel Gough' }),
      row({ teamName: 'Mellor B', teamCaptain: 'Roger Holmes' }),
    ]));
    const res = await request(app).get('/club/52');
    assert.strictEqual(res.status, 200);
    const cards = res.text.match(/class="team-captain-card"/g) || [];
    assert.strictEqual(cards.length, 2);
    // The Disley symptom: the same team name repeated because the query multiplied.
    const mellorA = res.text.match(/>Mellor A</g) || [];
    assert.strictEqual(mellorA.length, 1, 'a team must appear once');
  });
});

describe('GET /club/:id — an unrecorded role', () => {
  before(() => { process.env.DEV_MODE = 'true'; });
  after(() => { delete process.env.DEV_MODE; });

  it('says "Not recorded" instead of an empty contact link', async () => {
    setModel('Club', 'getContactDetailsById', (id, cb) => cb(null, [row()]));
    const res = await request(app).get('/club/52');
    assert.strictEqual(res.status, 200);
    assert.match(res.text, /Not recorded/);
    assert.doesNotMatch(res.text, /href="mailto:"/, 'empty mailto link');
    assert.doesNotMatch(res.text, /href="tel:"/, 'empty tel link');
    // The roles that ARE recorded still render.
    assert.match(res.text, /Roger Holmes/);
    assert.match(res.text, /mailto:roger@example\.com/);
  });

  it('does not offer a phone link for an officer with no number', async () => {
    setModel('Club', 'getContactDetailsById', (id, cb) => cb(null, [
      row({ matchSecTel: null, matchSecEmail: 'roger@example.com' }),
    ]));
    const res = await request(app).get('/club/52');
    assert.doesNotMatch(res.text, /href="tel:null"/);
    assert.doesNotMatch(res.text, /href="tel:"/);
    assert.match(res.text, /mailto:roger@example\.com/);
  });

  it('renders a club with no venue at all', async () => {
    // Both venue joins are LEFT now, so this reaches the view rather than 500ing.
    setModel('Club', 'getContactDetailsById', (id, cb) => cb(null, [
      row({ venueId: null, venueName: null, address: null,
            matchVenueId: null, matchVenueName: null, matchVenueAddress: null }),
    ]));
    const res = await request(app).get('/club/52');
    assert.strictEqual(res.status, 200);
    assert.match(res.text, /Not recorded/);
  });

  it('escapes a name that contains markup', async () => {
    // officerCard builds markup as a string, so it is emitted unescaped and has to do
    // its own escaping. Player names are free text in the admin form.
    setModel('Club', 'getContactDetailsById', (id, cb) => cb(null, [
      row({ teamCaptain: '<script>alert(1)</script>' }),
    ]));
    const res = await request(app).get('/club/52');
    assert.doesNotMatch(res.text, /<script>alert\(1\)<\/script>/);
    assert.match(res.text, /&lt;script&gt;/);
  });
});
