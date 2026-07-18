// Unit tests for the badminton scorecard scoring rules in
// utils/scorecardValidation.js. Pure functions — no DB. Run with: npm test
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { hasWinner, hasValidMargin, isValidGameScore } = require('../utils/scorecardValidation');

describe('hasWinner (a side must reach 21)', () => {
  it('true when the home side reaches 21', () => assert.strictEqual(hasWinner(21, 15), true));
  it('true when the away side reaches 21', () => assert.strictEqual(hasWinner(15, 21), true));
  it('true for a 21-0 whitewash', () => assert.strictEqual(hasWinner(21, 0), true));
  it('false when neither side reaches 21', () => assert.strictEqual(hasWinner(20, 18), false));
  it('false for 0-0', () => assert.strictEqual(hasWinner(0, 0), false));
  it('accepts numeric strings (form values)', () => assert.strictEqual(hasWinner('21', '0'), true));
});

describe('hasValidMargin (win by >=2, or 30-cap)', () => {
  it('true for a clean 2-point win (21-19)', () => assert.strictEqual(hasValidMargin(21, 19), true));
  it('true for a big margin (21-5)', () => assert.strictEqual(hasValidMargin(21, 5), true));
  it('false for a 1-point win below the cap (21-20)', () => assert.strictEqual(hasValidMargin(21, 20), false));
  it('true for the 30-29 cap (margin 1 allowed at 30)', () => assert.strictEqual(hasValidMargin(30, 29), true));
  it('true for 29-30 (cap either side)', () => assert.strictEqual(hasValidMargin(29, 30), true));
  it('accepts numeric strings', () => assert.strictEqual(hasValidMargin('21', '19'), true));
});

describe('isValidGameScore (full single-game rule)', () => {
  const valid = [[21, 15], [21, 19], [21, 0], [30, 29], [30, 28], [24, 22]];
  const invalid = [
    [20, 18], // no winner
    [21, 20], // margin < 2 below cap
    [31, 20], // out of range (>30)
    [21, -1], // out of range (<0)
    [21, 20.5], // non-integer
  ];
  for (const [h, a] of valid) {
    it(`${h}-${a} is valid`, () => assert.strictEqual(isValidGameScore(h, a), true));
  }
  for (const [h, a] of invalid) {
    it(`${h}-${a} is invalid`, () => assert.strictEqual(isValidGameScore(h, a), false));
  }
});
