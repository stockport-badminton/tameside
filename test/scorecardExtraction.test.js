// Unit tests for utils/scorecardExtraction.js against REAL cached Google
// Vision responses (test/fixtures/vision-*.json) — no API calls, no DB.
// Fixture 108: an upright card (GHAP B v GHAP A). Fixture 101: a 90°-rotated
// photo (Aerospace B v Mellor A). Run with: npm test
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { extractScorecard, splitScores, EVENT_NAMES, GAME_MAP } = require('../utils/scorecardExtraction');

const fixture = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', `vision-${n}.json`)));

describe('splitScores (merged Vision tokens -> two game scores)', () => {
  it('splits a plain merged pair: "1621" -> 16-21', () => assert.deepStrictEqual(splitScores('1621'), [16, 21]));
  it('splits a 3-digit merge: "921" -> 9-21', () => assert.deepStrictEqual(splitScores('921'), [9, 21]));
  it('uses the scoring rules to disambiguate: "121" -> 1-21 (not 12-1)', () =>
    assert.deepStrictEqual(splitScores('121'), [1, 21]));
  it('handles separators: "11/21" -> 11-21', () => assert.deepStrictEqual(splitScores('11/21'), [11, 21]));
  it('accepts the 30-cap: "3029" -> 30-29', () => assert.deepStrictEqual(splitScores('3029'), [30, 29]));
  it('peels fused games-won digits: "92102" -> 9-21 (games 0,2 discarded)', () =>
    assert.deepStrictEqual(splitScores('92102'), [9, 21]));
  it('peels a single leaked games digit: "2182" -> 21-8', () =>
    assert.deepStrictEqual(splitScores('2182'), [21, 8]));
  it('too short to be a game: "2" -> null pair', () => assert.deepStrictEqual(splitScores('2'), [null, null]));
  it('empty/garbage -> null pair', () => assert.deepStrictEqual(splitScores(''), [null, null]));
});

describe('extractScorecard — fixture 108 (upright card)', () => {
  const d = extractScorecard(fixture('108'));

  it('detects the card as upright', () => assert.strictEqual(d.rotationDegrees, 0));
  it('extracts the metadata', () => {
    assert.strictEqual(d.meta.date, '9/9/24');
    assert.strictEqual(d.meta.division, '1');
    assert.strictEqual(d.meta.playedAt, 'MCA');
    assert.strictEqual(d.meta.homeTeam, 'GHAP B');
    assert.strictEqual(d.meta.awayTeam, 'GHAP A');
  });
  it('reads all 36 scores with no warnings', () => {
    assert.strictEqual(Object.values(d.games).filter((v) => v != null).length, 36);
    assert.deepStrictEqual(d.warnings, []);
  });
  it('derives the correct RESULT (2-16)', () => assert.deepStrictEqual(d.result, { home: 2, away: 16 }));
  it('names the 9 events in card order', () =>
    assert.deepStrictEqual(d.events.map((e) => e.event), EVENT_NAMES));
  it('reads specific games correctly (Open A 16-21, 9-21)', () => {
    assert.strictEqual(d.games.Game1homeScore, 16);
    assert.strictEqual(d.games.Game1awayScore, 21);
    assert.strictEqual(d.games.Game2homeScore, 9);
    assert.strictEqual(d.games.Game2awayScore, 21);
  });
  it('recovers the boundary-straddling fused row (Mixed A g2 = 9-21)', () => {
    assert.strictEqual(d.games.Game8homeScore, 9);
    assert.strictEqual(d.games.Game8awayScore, 21);
  });
  it('derives games won per event (Mixed C = 1-1)', () =>
    assert.deepStrictEqual(d.events[5].gamesWon, { home: 1, away: 1 }));
  it('extracts raw player name text for matching', () => {
    assert.match(d.events[0].home.playersRaw, /Blowran/i);
    assert.match(d.events[0].away.playersRaw, /OWEN/i);
  });
});

describe('extractScorecard — fixture 101 (90°-rotated photo)', () => {
  const d = extractScorecard(fixture('101'));

  it('detects and corrects the 90° rotation', () => assert.strictEqual(d.rotationDegrees, 90));
  it('extracts the metadata', () => {
    assert.strictEqual(d.meta.division, '2');
    assert.strictEqual(d.meta.playedAt, 'Aerospace B');
    assert.strictEqual(d.meta.homeTeam, 'Aerospace B');
    assert.match(d.meta.awayTeam, /Mella|Mellor/); // handwriting: roster match resolves the team
  });
  it('reads at least 30 of 36 scores and flags the unread rows', () => {
    const read = Object.values(d.games).filter((v) => v != null).length;
    assert.ok(read >= 30, `read ${read}/36`);
    assert.ok(d.warnings.length >= 1, 'expected warnings for unread rows');
  });
  it('recovers the leaked-games-digit row (Ladies g1 = 21-8)', () => {
    assert.strictEqual(d.games.Game3homeScore, 21);
    assert.strictEqual(d.games.Game3awayScore, 8);
  });
  it('reads specific rotated-card games (Open B 21-15, 13-21)', () => {
    assert.strictEqual(d.games.Game5homeScore, 21);
    assert.strictEqual(d.games.Game5awayScore, 15);
    assert.strictEqual(d.games.Game6homeScore, 13);
    assert.strictEqual(d.games.Game6awayScore, 21);
  });
});

describe('GAME_MAP', () => {
  it('maps 9 events onto games 1..18 exactly once', () => {
    const flat = GAME_MAP.flat();
    assert.deepStrictEqual([...flat].sort((a, b) => a - b), Array.from({ length: 18 }, (_, i) => i + 1));
  });
});

describe('divisionDigit (handwritten 1/2 with OCR lookalikes)', () => {
  const { divisionDigit } = require('../utils/scorecardExtraction');
  it('plain digits pass through', () => {
    assert.strictEqual(divisionDigit('1'), '1');
    assert.strictEqual(divisionDigit('2'), '2');
  });
  it('handwritten-1 lookalikes resolve to 1 (| I l / parens)', () => {
    for (const t of ['|', 'I', 'l', '/', '(', ')', '!']) assert.strictEqual(divisionDigit(t), '1', t);
  });
  it('handwritten-2 lookalikes resolve to 2 (z Z)', () => {
    assert.strictEqual(divisionDigit('z'), '2');
    assert.strictEqual(divisionDigit('Z'), '2');
  });
  it('merged label tokens resolve ("Div:1", ":2")', () => {
    assert.strictEqual(divisionDigit('Div:1'), '1');
    assert.strictEqual(divisionDigit(':2'), '2');
  });
  it('anything else is null (3, words, empty)', () => {
    assert.strictEqual(divisionDigit('3'), null);
    assert.strictEqual(divisionDigit('Division'), null);
    assert.strictEqual(divisionDigit(''), null);
  });
});

describe('parseCardDate (handwritten d/m/y -> yyyy-mm-dd)', () => {
  const { parseCardDate } = require('../utils/scorecardExtraction');
  it('parses 2-digit years: "9/9/24" -> 2024-09-09', () => assert.strictEqual(parseCardDate('9/9/24'), '2024-09-09'));
  it('parses 4-digit years and dashes: "17-12-2024"', () => assert.strictEqual(parseCardDate('17-12-2024'), '2024-12-17'));
  it('parses dots: "21.4.26"', () => assert.strictEqual(parseCardDate('21.4.26'), '2026-04-21'));
  it('rejects garbage and impossible dates', () => {
    assert.strictEqual(parseCardDate('H212182121'), null);
    assert.strictEqual(parseCardDate('32/13/24'), null);
    assert.strictEqual(parseCardDate(''), null);
  });
});

describe('extractScorecard — fixture hydeshell (current card revision)', () => {
  // This card revision prints "Men's A-D" instead of "Open A-D", and Vision
  // missed the tiny handwritten "v" between the team names entirely — the
  // header is split at the largest horizontal gap instead.
  const d = extractScorecard(fixture('hydeshell'));

  it('anchors all 9 event rows despite the Men\'s labels', () => {
    assert.strictEqual(d.events.length, 9);
  });
  it('reads the header teams without a "v" token', () => {
    assert.strictEqual(d.meta.homeTeam, 'HYDE A');
    assert.strictEqual(d.meta.awayTeam, 'SHELL A');
  });
  it('reads all 36 scores', () => {
    assert.strictEqual(Object.values(d.games).filter((v) => v != null).length, 36);
  });
  it('derives the correct RESULT (5-13)', () => assert.deepStrictEqual(d.result, { home: 5, away: 13 }));
  it('excludes the venue (also handwritten "HYDE") from the team names', () => {
    assert.doesNotMatch(d.meta.homeTeam + d.meta.awayTeam, /HYDE.*HYDE/);
  });
});
