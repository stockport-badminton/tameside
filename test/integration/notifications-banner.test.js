// The offer to turn on notifications, under the heading of the fixtures & results pages
// (views/notifications-banner.ejs), and the walkthrough video it opens
// (views/notifications-video.ejs). Ported from Stockport 4d6cf0d. Rendered hidden: the browser
// shows it unless this device is already subscribed or the banner was dismissed.

const { it, afterEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { app, setModel, clearModels } = require('../helpers/app');

afterEach(() => clearModels());

const ROW = {
  id: 7200, date: new Date('2026-10-28T00:00:00'), status: 'outstanding',
  homeTeam: 'Hyde A', awayTeam: 'Shell A', homeScore: null, awayScore: null,
  homeClub: 'Hyde', division: 8, divisionName: 'Division 1',
};

for (const page of ['/results/Division-1', '/results/All', '/results/Division-2/20242025']) {
  it(`${page} offers notifications under its heading, with the video`, async () => {
    setModel('Fixture', 'getFixtureDetails', (searchObj, done) => done(null, [ROW]));
    const res = await request(app).get(page);
    assert.strictEqual(res.status, 200);
    assert.match(res.text, /class="results-header"[\s\S]*?id="notificationsBanner" hidden[\s\S]*?id="results-table"/);
    assert.ok(res.text.includes('<a href="/notifications" class="alert-link">Turn on notifications</a>'));
    assert.match(res.text, /<a href="#" class="alert-link" data-notifications-video>/);
    assert.match(res.text, /<video id="notificationsVideoPlayer"[^>]*src="\/static\/video\/notifications-mobile\.mp4\?v=[0-9a-f]{12}"/);
    assert.match(res.text, /poster="\/static\/video\/notifications-mobile\.jpg\?v=[0-9a-f]{12}"/);
  });
}

it('the grid view carries no offer', async () => {
  setModel('Fixture', 'getFixtureDetails', (searchObj, done) => done(null, [ROW]));
  const res = await request(app).get('/results-grid/Division-1');
  assert.strictEqual(res.status, 200);
  assert.ok(!res.text.includes('notificationsBanner'));
});

it('the video is served, and with a year-long cache at its versioned URL', async () => {
  const src = require('../../utils/assets').assetUrl('/static/video/notifications-mobile.mp4');
  const res = await request(app).get(src).set('Range', 'bytes=0-99');
  assert.strictEqual(res.status, 206);
  assert.match(res.headers['content-type'], /^video\/mp4/);
  assert.match(res.headers['cache-control'], /max-age=31536000.*immutable/);
});
