// Calibration tests for the ELO engine in models/game.js, ported from the
// Stockport site's jest suite to Node's built-in test runner (node --test).
// Run with: npm test
process.env.PGPASSWORD = process.env.PGPASSWORD || 'test-placeholder';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const Game = require('../models/game');

// gamesCount: 999 = "established" by default, so tests exercise the standard
// K=32 path unless a test explicitly opts a player into provisional K.
const makePlayers = (overrides = {}) => ({
  1: { rating: 1500, rank: 1, date: '2024-01-01', gamesCount: 999 },
  2: { rating: 1500, rank: 1, date: '2024-01-01', gamesCount: 999 },
  3: { rating: 1500, rank: 1, date: '2024-01-01', gamesCount: 999 },
  4: { rating: 1500, rank: 1, date: '2024-01-01', gamesCount: 999 },
  ...overrides,
});

const makeGame = (overrides = {}) => ({
  homePlayer1: 1, homePlayer2: 2,
  awayPlayer1: 3, awayPlayer2: 4,
  homeScore: 21, awayScore: 15,
  fixture: 999,
  ...overrides,
});

describe('Game.calculateRating', () => {
  describe('return shape', () => {
    it('returns updateObj and prevRatingDates', () => {
      const result = Game.calculateRating(makeGame(), makePlayers(), '2024-01-01', 1);
      assert.ok('updateObj' in result);
      assert.ok('prevRatingDates' in result);
    });

    it('updateObj has all eight player rating keys', () => {
      const { updateObj } = Game.calculateRating(makeGame(), makePlayers(), '2024-01-01', 1);
      for (const key of [
        'homePlayer1Start', 'homePlayer2Start', 'awayPlayer1Start', 'awayPlayer2Start',
        'homePlayer1End', 'homePlayer2End', 'awayPlayer1End', 'awayPlayer2End',
      ]) {
        assert.strictEqual(typeof updateObj[key], 'number', `${key} should be a number`);
      }
    });
  });

  describe('home win', () => {
    it('increases home ratings and decreases away ratings', () => {
      const { updateObj } = Game.calculateRating(makeGame(), makePlayers(), '2024-01-01', 1);
      assert.ok(updateObj.homePlayer1End > 1500);
      assert.ok(updateObj.homePlayer2End > 1500);
      assert.ok(updateObj.awayPlayer1End < 1500);
      assert.ok(updateObj.awayPlayer2End < 1500);
    });

    it('applies symmetric ±15 point swing for equal-rated players (K=32, scaled by margin 21-15)', () => {
      // margin 6/21 -> multiplier 0.85 + 0.30*(6/21) = 0.9357; effectiveK = 32*0.9357 = 29.94
      // E=0.5 for equal ratings -> round(29.94*0.5) = 15
      const { updateObj } = Game.calculateRating(makeGame(), makePlayers(), '2024-01-01', 1);
      assert.strictEqual(updateObj.homePlayer1End - 1500, 15);
      assert.strictEqual(updateObj.awayPlayer1End - 1500, -15);
    });

    it('records correct start ratings', () => {
      const { updateObj } = Game.calculateRating(makeGame(), makePlayers(), '2024-01-01', 1);
      assert.strictEqual(updateObj.homePlayer1Start, 1500);
      assert.strictEqual(updateObj.awayPlayer1Start, 1500);
    });
  });

  describe('away win', () => {
    it('increases away ratings and decreases home ratings', () => {
      const game = makeGame({ homeScore: 15, awayScore: 21 });
      const { updateObj } = Game.calculateRating(game, makePlayers(), '2024-01-01', 1);
      assert.ok(updateObj.awayPlayer1End > 1500);
      assert.ok(updateObj.homePlayer1End < 1500);
    });

    it('applies symmetric ±15 point swing for equal-rated players (same margin, reversed)', () => {
      const game = makeGame({ homeScore: 15, awayScore: 21 });
      const { updateObj } = Game.calculateRating(game, makePlayers(), '2024-01-01', 1);
      assert.strictEqual(updateObj.awayPlayer1End - 1500, 15);
      assert.strictEqual(updateObj.homePlayer1End - 1500, -15);
    });
  });

  describe('Elo expectation scaling', () => {
    it('strong team beating weak team earns fewer points than equal match', () => {
      // 1700 vs 1300: homeExpect ≈ 0.91 → effectiveK (margin 21-15) ≈ 29.94 → round(29.94*0.09) = 3
      const players = makePlayers({
        1: { rating: 1700, rank: 1, date: '2024-01-01' },
        2: { rating: 1700, rank: 1, date: '2024-01-01' },
        3: { rating: 1300, rank: 1, date: '2024-01-01' },
        4: { rating: 1300, rank: 1, date: '2024-01-01' },
      });
      const { updateObj } = Game.calculateRating(makeGame(), players, '2024-01-01', 1);
      const gain = updateObj.homePlayer1End - updateObj.homePlayer1Start;
      assert.ok(gain > 0);
      assert.ok(gain < 16);
    });

    it('weak team upsetting strong team earns more points than equal match', () => {
      // 1300 vs 1700: homeExpect ≈ 0.09 → effectiveK (margin 21-15) ≈ 29.94 → round(29.94*0.91) = 27
      const players = makePlayers({
        1: { rating: 1300, rank: 1, date: '2024-01-01' },
        2: { rating: 1300, rank: 1, date: '2024-01-01' },
        3: { rating: 1700, rank: 1, date: '2024-01-01' },
        4: { rating: 1700, rank: 1, date: '2024-01-01' },
      });
      const { updateObj } = Game.calculateRating(makeGame(), players, '2024-01-01', 1);
      const gain = updateObj.homePlayer1End - updateObj.homePlayer1Start;
      assert.ok(gain > 16);
      assert.ok(gain <= 32);
    });
  });

  describe('player id 0 (walkover / bye)', () => {
    it('returns unchanged ratings when any player id is 0', () => {
      const players = { ...makePlayers(), 0: { rating: 1500, date: '2024-01-01' } };
      const game = makeGame({ homePlayer1: 0 });
      const { updateObj } = Game.calculateRating(game, players, '2024-01-01', 1);
      assert.strictEqual(updateObj.homePlayer1End, updateObj.homePlayer1Start);
      assert.strictEqual(updateObj.awayPlayer1End, updateObj.awayPlayer1Start);
    });

    it('falls back to 1500 when player id 0 has no entry in fixturePlayers', () => {
      const game = makeGame({ homePlayer1: 0 });
      const { updateObj } = Game.calculateRating(game, makePlayers(), '2024-01-01', 1);
      assert.strictEqual(updateObj.homePlayer1Start, 1500);
      assert.strictEqual(updateObj.homePlayer1End, 1500);
    });
  });

  describe('division rank adjustment', () => {
    it('higher-division away players make home appear more favored, reducing their gain on a win', () => {
      // Away rank 2, division 1: (rank-div)*150 = +150 added to home adjusted start
      // → homePairStart 1650 vs awayPairStart 1500 → home more favored → gains less
      const players = makePlayers({
        3: { rating: 1500, rank: 2, date: '2024-01-01' },
        4: { rating: 1500, rank: 2, date: '2024-01-01' },
      });
      const { updateObj: adjusted } = Game.calculateRating(makeGame(), players, '2024-01-01', 1);
      const { updateObj: baseline } = Game.calculateRating(makeGame(), makePlayers(), '2024-01-01', 1);
      assert.ok(
        (adjusted.homePlayer1End - adjusted.homePlayer1Start)
        < (baseline.homePlayer1End - baseline.homePlayer1Start)
      );
    });
  });

  describe('partner rating-gap split', () => {
    it('weaker partner gains more and stronger partner gains less on a win, summing to the same pair total as an equal pair', () => {
      const mismatched = makePlayers({
        1: { rating: 1300, rank: 1, date: '2024-01-01', gamesCount: 999 }, // weaker home partner
        2: { rating: 1700, rank: 1, date: '2024-01-01', gamesCount: 999 }, // stronger home partner
      });
      const { updateObj } = Game.calculateRating(makeGame(), mismatched, '2024-01-01', 1);
      const weakGain = updateObj.homePlayer1End - updateObj.homePlayer1Start;
      const strongGain = updateObj.homePlayer2End - updateObj.homePlayer2Start;
      assert.ok(weakGain > strongGain);

      // The pair's average (1500) matches the equal-rated baseline exactly, so the
      // pool being split should be identical — only its distribution differs.
      const { updateObj: baseline } = Game.calculateRating(makeGame(), makePlayers(), '2024-01-01', 1);
      const baselineTotal = (baseline.homePlayer1End - baseline.homePlayer1Start) + (baseline.homePlayer2End - baseline.homePlayer2Start);
      assert.strictEqual(weakGain + strongGain, baselineTotal);
    });

    it('equal-rated partners split (near) evenly', () => {
      const { updateObj } = Game.calculateRating(makeGame(), makePlayers(), '2024-01-01', 1);
      const p1Gain = updateObj.homePlayer1End - updateObj.homePlayer1Start;
      const p2Gain = updateObj.homePlayer2End - updateObj.homePlayer2Start;
      assert.ok(Math.abs(p1Gain - p2Gain) <= 1); // at most a 1-point rounding difference
    });
  });

  describe('zero-sum home/away split', () => {
    it("the away side's total change is always the exact negative of the home side's", () => {
      const cases = [
        makePlayers(),
        makePlayers({ 1: { rating: 1520, rank: 1, date: '2024-01-01', gamesCount: 999 } }),
        makePlayers({ 3: { rating: 1613, rank: 1, date: '2024-01-01', gamesCount: 999 } }),
      ];
      for (const players of cases) {
        const { updateObj } = Game.calculateRating(makeGame(), players, '2024-01-01', 1);
        const homeTotal = (updateObj.homePlayer1End - updateObj.homePlayer1Start) + (updateObj.homePlayer2End - updateObj.homePlayer2Start);
        const awayTotal = (updateObj.awayPlayer1End - updateObj.awayPlayer1Start) + (updateObj.awayPlayer2End - updateObj.awayPlayer2Start);
        assert.strictEqual(homeTotal, -awayTotal);
      }
    });
  });

  describe('provisional K-factor', () => {
    it("a newer player's game moves the pool further than an otherwise-identical established game", () => {
      const newer = makePlayers({ 1: { rating: 1500, rank: 1, date: '2024-01-01', gamesCount: 3 } });
      const established = makePlayers();
      const { updateObj: withNewer } = Game.calculateRating(makeGame(), newer, '2024-01-01', 1);
      const { updateObj: withEstablished } = Game.calculateRating(makeGame(), established, '2024-01-01', 1);
      const newerGain = withNewer.homePlayer1End - withNewer.homePlayer1Start;
      const establishedGain = withEstablished.homePlayer1End - withEstablished.homePlayer1Start;
      assert.ok(newerGain > establishedGain);
    });
  });

  describe('margin of victory', () => {
    it('a blowout moves rating further than a narrow win, all else equal', () => {
      const players = makePlayers();
      const blowout = makeGame({ homeScore: 21, awayScore: 2 });
      const narrow = makeGame({ homeScore: 22, awayScore: 20 });
      const { updateObj: blowoutResult } = Game.calculateRating(blowout, players, '2024-01-01', 1);
      const { updateObj: narrowResult } = Game.calculateRating(narrow, players, '2024-01-01', 1);
      const blowoutGain = blowoutResult.homePlayer1End - blowoutResult.homePlayer1Start;
      const narrowGain = narrowResult.homePlayer1End - narrowResult.homePlayer1Start;
      assert.ok(blowoutGain > narrowGain);
    });
  });
});
