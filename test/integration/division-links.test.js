// Social posts link to the page the post is about, not the homepage, and the results pages
// link to their own division's table. Ported from Stockport c482fc3 (Nov 2026).
//
// Every caption used to end with the bare site address, so a reader who tapped through from a
// Division 2 result landed on the homepage and had to find Division 2 themselves.

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { app, setModel, clearModels } = require('../helpers/app');
const { divisionResultsPath, divisionTablePath } = require('../../utils/siteUrl');
const Fixture = require('../../models/fixture');

const SITE = 'https://tameside-badminton.co.uk';

afterEach(() => clearModels());

describe('divisionResultsPath / divisionTablePath', () => {
  it('hyphenates the division name, which is what the routes turn back into a name', () => {
    assert.strictEqual(divisionResultsPath('Division 2'), '/results/Division-2');
    assert.strictEqual(divisionTablePath('Division 1'), '/tables/Division-1');
  });

  it('adds an archived season', () => {
    assert.strictEqual(divisionTablePath('Division 1', '20242025'), '/tables/Division-1/20242025');
  });

  it('means every division when there is no name', () => {
    assert.strictEqual(divisionResultsPath(null), '/results/All');
    assert.strictEqual(divisionTablePath('All'), '/tables/All');
  });
});

describe('the captions', () => {
  it("a result links to its division's results", () => {
    const c = Fixture.resultPostContent({
      homeTeam: 'Hyde A', awayTeam: 'Manchester Edgeley B', homeScore: 13, awayScore: 5,
      division: 'Division 2',
    });
    assert.ok(c.message.endsWith(` ${SITE}/results/Division-2`), c.message);
  });

  it('the weekly tables post links to the tables', async () => {
    setModel('Club', 'getInstagramHandles', async () => []);
    const text = await require('../../controllers/weeklyTablesController').captions();
    assert.ok(text.facebook.includes(`${SITE}/tables/All\n`), text.facebook);
    assert.ok(text.instagram.includes(`${SITE}/tables/All\n`), text.instagram);
  });

  it('the results video says "Full tables at" the tables', () => {
    const text = require('../../utils/socialVideo').captions('16 - 20 Sep');
    assert.ok(text.facebook.includes(`Full tables at ${SITE}/tables/All\n`), text.facebook);
  });
});

describe('the results page', () => {
  const ROW = {
    id: 7200, date: new Date('2026-10-28T00:00:00'), status: 'complete',
    homeTeam: 'Hyde A', awayTeam: 'Shell A', homeScore: 10, awayScore: 8,
    homeClub: 'Hyde', division: 8, divisionName: 'Division 1',
  };

  for (const [page, table] of [
    ['/results/Division-1', '/tables/Division-1'],
    ['/results/Division-2/20242025', '/tables/Division-2/20242025'],
    ['/results/All', '/tables/All'],
    ['/results-grid/Division-1', '/tables/Division-1'],
  ]) {
    it(`${page} links to ${table}`, async () => {
      setModel('Fixture', 'getFixtureDetails', (searchObj, done) => done(null, [ROW]));
      const res = await request(app).get(page);
      assert.strictEqual(res.status, 200);
      assert.match(res.text, new RegExp(`<a [^>]*href="${table}"[^>]*aria-label="League table"`));
    });
  }
});
