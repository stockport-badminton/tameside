// Unit coverage for models/season.isValidName — the shared format guard for season
// names arriving from URLs.
//
// It exists because season names get appended to table names (`team<season>`,
// `lewis<season>`), so a bad one becomes a missing-relation error rather than a clean
// rejection. playerController used to carry its own copy of this regex and year
// arithmetic; these tests pin the behaviour now that both call one implementation.
const { describe, it } = require('node:test');
const assert = require('node:assert');

const seasonModel = require('../models/season');

describe('season.isValidName', () => {
  it('accepts consecutive four-digit years from 2012 on', () => {
    for (const name of ['20122013', '20242025', '20252026', '20992100']) {
      assert.strictEqual(seasonModel.isValidName(name), true, `${name} should be valid`);
    }
  });

  it('rejects the values that actually reached production', () => {
    // "null" is the one from Sentry TAMESIDE-NODE-4 — a truthy string, which is why
    // the old `if (!season)` guard let it through.
    for (const name of ['null', 'undefined', 'NaN', '']) {
      assert.strictEqual(seasonModel.isValidName(name), false, `${name} should be rejected`);
    }
  });

  it('rejects non-consecutive or reversed year pairs', () => {
    for (const name of ['20242026', '20242024', '20252024', '20242023']) {
      assert.strictEqual(seasonModel.isValidName(name), false, `${name} should be rejected`);
    }
  });

  it('rejects anything before the 2012 floor', () => {
    // The DB has never held a season earlier than this, so an earlier name is a typo
    // or a probe, not data.
    assert.strictEqual(seasonModel.isValidName('20112012'), false);
    assert.strictEqual(seasonModel.isValidName('19992000'), false);
  });

  it('rejects wrong lengths and non-digits', () => {
    for (const name of ['2024', '202420255', '2024-2025', '2024 2025', 'abcdefgh', '2024202a']) {
      assert.strictEqual(seasonModel.isValidName(name), false, `${name} should be rejected`);
    }
  });

  it('rejects non-string inputs without throwing', () => {
    // Express gives strings, but the model is called from several places and a
    // validator that throws is worse than one that says "no".
    for (const value of [null, undefined, 0, {}, [], NaN, true]) {
      assert.doesNotThrow(() => seasonModel.isValidName(value));
      assert.strictEqual(seasonModel.isValidName(value), false);
    }
  });

  it('rejects a path-traversal attempt', () => {
    // postgres.js escapes identifiers, so this was never an injection route — but it
    // must still not become a table name.
    assert.strictEqual(seasonModel.isValidName('../../etc/passwd'), false);
    assert.strictEqual(seasonModel.isValidName('20242025; DROP TABLE team'), false);
  });
});
