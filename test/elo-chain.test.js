// utils/eloChain: a late result re-rates the fixtures after it (Stockport e32f745, 6d95d0a).
//
// The walk itself needs the database, and there is no local one, so it is proved against
// production by `node tools/elo-rerate.js --rehearse` (re-rate the season, then a chain
// from every fixture must find nothing left to change; rolled back). What is tested here
// is the arithmetic the chain shares with the backfill, and the wiring that has to stay
// in place for the two to agree.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

process.env.PGPASSWORD = process.env.PGPASSWORD || 'test-placeholder';
const { rateFixtureGames, latestEntry } = require('../utils/eloChain');
const Game = require('../models/game');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const game = (id, h1, h2, a1, a2, hs, as) =>
  ({ id, homePlayer1: h1, homePlayer2: h2, awayPlayer1: a1, awayPlayer2: a2, homeScore: hs, awayScore: as });
const state = (rating, gamesCount, rank = 1) => ({ rating, gamesCount, rank, date: '2026-09-01' });

describe('rateFixtureGames', () => {
  it('carries each player forward game by game and counts their games', () => {
    const fp = { 1: state(1500, 20), 2: state(1500, 20), 3: state(1500, 20), 4: state(1500, 20) };
    const rated = rateFixtureGames([game(10, 1, 2, 3, 4, 21, 15), game(11, 1, 2, 3, 4, 21, 15)], fp, { date: '2026-10-01', rank: 1 });
    assert.strictEqual(rated.length, 2);
    assert.strictEqual(rated[1].homePlayer1Start, rated[0].homePlayer1End, 'second game starts where the first ended');
    assert.strictEqual(fp[1].rating, rated[1].homePlayer1End);
    assert.strictEqual(fp[1].gamesCount, 22);
  });

  it('a game with no players at all is left unrated', () => {
    const rated = rateFixtureGames([game(12, 0, 0, 0, 0, 21, 0)], {}, { date: '2026-10-01', rank: 1 });
    assert.deepStrictEqual(rated, []);
  });

  // The second bug: getPrevRating has no games count, so the publish path rated everyone at
  // the established K. The chain knows the count, so a new player moves further.
  it('a provisional player moves further than an established one', () => {
    const run = count => {
      const fp = { 1: state(1500, count), 2: state(1500, count), 3: state(1500, count), 4: state(1500, count) };
      return rateFixtureGames([game(13, 1, 2, 3, 4, 21, 10)], fp, { date: '2026-10-01', rank: 1 })[0];
    };
    const provisional = run(2), established = run(50);
    assert.ok(provisional.homePlayer1End - 1500 > established.homePlayer1End - 1500,
      `${provisional.homePlayer1End} vs ${established.homePlayer1End}`);
  });

  it('agrees with Game.calculateRating on every column', () => {
    const fp = { 1: state(1610, 30, 1), 2: state(1450, 4, 2), 3: state(1720, 60, 1), 4: state(1500, 0, 1) };
    const copy = JSON.parse(JSON.stringify(fp));
    const g = game(14, 1, 2, 3, 4, 19, 21);
    const [rated] = rateFixtureGames([g], fp, { date: '2026-10-01', rank: 1 });
    const { updateObj } = Game.calculateRating(g, copy, '2026-10-01', 1);
    assert.deepStrictEqual(rated, { id: 14, ...updateObj });
  });
});

describe('latestEntry', () => {
  it('a re-entered scorecard is rated from its latest 18 games, as the backfill does', () => {
    const games = Array.from({ length: 36 }, (_, i) => ({ id: i + 1 }));
    assert.deepStrictEqual(latestEntry(games).map(g => g.id), games.slice(18).map(g => g.id));
    assert.strictEqual(latestEntry(games.slice(0, 18)).length, 18);
  });
});

describe('wiring that keeps the chain equal to a backfill', () => {
  it('the backfill rates with the shared function, and writes in batches', () => {
    const src = read('controllers/playerController.js');
    assert.match(src, /eloChain\.rateFixtureGames\(games, fixturePlayers, fixture\)/);
    assert.match(src, /eloChain\.latestEntry\(/);
    assert.match(src, /eloChain\.writeElo\(rated\)/);
    assert.doesNotMatch(src, /Game\.calculateRating\(/, 'a second copy of the per-game loop would drift');
  });

  it('fixtures on the same night are ordered by id, in both the backfill and the chain', () => {
    assert.match(read('models/fixture.js'), /order by fixture\.date asc, fixture\.id asc/);
  });

  it("a player's state is read in backfill order, from rated league games only", () => {
    const src = read('utils/eloChain.js');
    assert.match(src, /ORDER BY f\.date DESC, f\.id DESC, g\.id DESC, s\.slot DESC/);
    assert.match(src, /AND s\.rating > 0/);
    assert.match(src, /AND f\.status = 'complete'/);
    assert.match(src, /AND f\.lewis_round IS NULL/);
    assert.match(src, /\(f\.date, f\.id\) < \(SELECT date, id FROM fixture WHERE id = /);
  });

  it('publishing a league result runs the chain, and its failure never fails the publish', () => {
    const src = read('controllers/fixtureController.js');
    const i = src.indexOf('eloChain.rerateFrom(FixtureIdResult[0].id)');
    assert.ok(i > 0, 'the publish path calls the chain');
    assert.ok(src.lastIndexOf('if (!isLewisFixture){', i) > src.lastIndexOf('Game.createBatch(gameObject', i),
      'after the games are written, and only for a league fixture');
    assert.match(src.slice(i, i + 600), /\.catch\(chainErr =>[\s\S]*Sentry\.captureException[\s\S]*\.then\(\(\) => Player\.refreshRatings\(ratedIds\)\)/);
  });
});
