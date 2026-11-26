// The scorecard form's match date must be in the season and not in the future
// (league-site 1796ff6: Stockport filed two cards as 2016 off a misread photo, Nov 2026).
// No DB: the season window is computed from rows, and the validator is called directly.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');

require('./helpers/app'); // test env (Mailjet keys etc.) before the controller loads
const seasonModel = require('../models/season');

// Season rows as the DB returns them: UK midnights, so BST dates are 23:00 UTC the day before.
const S2627 = { name: '20262027', startDate: new Date('2026-06-29T23:00:00Z'), endDate: new Date('2027-07-30T23:00:00Z') };
const S2526 = { name: '20252026', startDate: new Date('2025-06-29T23:00:00Z'), endDate: new Date('2026-07-30T23:00:00Z') };

describe('season match-date window', () => {
  it('is the current season once the previous one has closed', () => {
    assert.deepStrictEqual(seasonModel._matchDatesFrom([S2627, S2526], new Date('2026-11-26T12:00:00Z')),
      { from: '2026-06-30', to: '2027-07-31' });
  });

  it('reaches back into last season during the June/July overlap', () => {
    assert.deepStrictEqual(seasonModel._matchDatesFrom([S2627, S2526], new Date('2026-07-10T12:00:00Z')),
      { from: '2025-06-30', to: '2027-07-31' });
  });

  it('is null when the season has no end date', () => {
    assert.strictEqual(seasonModel._matchDatesFrom([{ ...S2627, endDate: null }], new Date()), null);
  });
});

describe('scorecard form: match date is plausible', () => {
  const { _matchDateIsPlausible: check } = require('../controllers/fixtureController');
  const iso = (offsetDays) => new Date(Date.now() + offsetDays * 86400e3).toISOString().slice(0, 10);
  const original = seasonModel.matchDateWindow;
  afterEach(() => { seasonModel.matchDateWindow = original; });

  it('accepts today and a recent date', () => {
    seasonModel.matchDateWindow = () => null;
    assert.strictEqual(check(iso(0)), true);
    assert.strictEqual(check(iso(-20)), true);
  });

  it('refuses a date in the future, beyond a day of grace', () => {
    seasonModel.matchDateWindow = () => null;
    assert.throws(() => check(iso(3)), /can't be in the future/);
  });

  it('refuses a date outside the season, naming it so the captain checks the year', () => {
    seasonModel.matchDateWindow = () => ({ from: '2026-06-30', to: '2027-07-31' });
    assert.throws(() => check('2016-11-24'), /must be in this season \(30\/06\/2026 to 31\/07\/2027\)/);
    assert.strictEqual(check('2026-09-10'), true);
  });

  it('is synchronous, so a refusal cannot become a silent pass', () => {
    assert.notStrictEqual(check.constructor.name, 'AsyncFunction');
  });
});
