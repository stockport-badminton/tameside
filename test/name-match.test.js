// Ported from Stockport's __tests__/unit/name-match.test.js (Jest -> node:test).
// utils/nameMatch.js — what "is this person already registered?" means. Each case is a
// name that was hard to find with the old `ILIKE '%term%'`, or a stranger the looser
// rules tried along the way would have offered instead.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { matchName, rankByName, normalise } = require('../utils/nameMatch');

const kind = (q, name) => (matchName(q, name) || {}).kind || null;

describe('matchName', () => {
  it('finds a one-letter typo in the stored name (the case that started this)', () => {
    assert.strictEqual(kind('Mary Whitle', 'Marry Whitle'), 'close');
  });

  it('ignores word order', () => {
    assert.strictEqual(kind('Whitle Mary', 'Marry Whitle'), 'close');
  });

  it('still finds a literal fragment, as the old search did', () => {
    assert.strictEqual(kind('rry Whi', 'Marry Whitle'), 'contains');
    assert.strictEqual(kind('Whitle', 'Marry Whitle'), 'contains');
  });

  it('matches a prefix of each word, for someone still typing', () => {
    assert.strictEqual(kind('Mar Whit', 'Marry Whitle'), 'close');
  });

  it('knows common nicknames', () => {
    assert.strictEqual(kind('Andrew Bates', 'Andy Bates'), 'close');
    assert.strictEqual(kind('Mike Hayes', 'Michael Hayes'), 'close');
    assert.strictEqual(kind('Kathryn Melling', 'Kat Melling'), 'close');
  });

  it('ignores case, accents, apostrophes and hyphens', () => {
    assert.strictEqual(kind('zoe', 'Zoë Siu'), 'contains');
    assert.strictEqual(kind('OBrien', "Sean O'Brien"), 'contains');
    assert.strictEqual(kind('Prem Chandar Anandan', 'Prem Chandar-Anandan'), 'exact');
  });

  it('matches words split differently', () => {
    assert.strictEqual(kind('Dave McDonald', 'Dave Mc Donald'), 'close');
  });

  it('gives short words no slack', () => {
    // One edit is the whole of a three-letter word.
    assert.strictEqual(kind('Tom Long', 'Tim Long'), null);
    assert.strictEqual(kind('Sam Roe', 'Sam Ray'), null);
  });

  it('does not let the whole name\'s slack stand in for one word\'s', () => {
    // Two edits over "tomlong"/"tomtang" is small; two edits in a four-letter word is not.
    assert.strictEqual(kind('Tom Long', 'Tom Tang'), null);
  });

  it('requires every typed word to match a different stored word', () => {
    assert.strictEqual(kind('Bates Bates', 'Andy Bates'), null);
    assert.strictEqual(kind('Andy Bates Smith', 'Andy Bates'), null);
  });

  // Tuned against the live table: two edits from five letters paired these strangers.
  for (const [a, b] of [
    ['Ryan Fox', 'Brian Fox'],
    ['Rob Wilson', 'Rob Timson'],
    ['Alex Mason', 'Alex Watson'],
  ]) {
    it(`does not pair ${a} with ${b}`, () => {
      assert.strictEqual(kind(a, b), null);
    });
  }

  it('matches nothing to an empty query', () => {
    assert.strictEqual(matchName('', 'Andy Bates'), null);
    assert.strictEqual(matchName('  ', 'Andy Bates'), null);
  });
});

describe('rankByName', () => {
  const rows = [
    { id: 1, name: 'Graham White' },
    { id: 2, name: 'Marry Whitle' },
    { id: 3, name: 'Sylvia Ellis-Jones' },
    { id: 4, name: 'John Cave' },
  ];

  it('puts literal matches above close ones', () => {
    assert.deepStrictEqual(rankByName(rows, 'Whitle', r => r.name).map(r => r.id), [2, 1]);
  });

  it('puts a match at the start of a word above one inside it', () => {
    assert.deepStrictEqual(rankByName(rows, 'jo', r => r.name).map(r => r.id), [3, 4]);
    assert.deepStrictEqual(rankByName(rows, 'ohn', r => r.name).map(r => r.id), [4]);
  });

  it('keeps the caller\'s order among equals and applies the limit after ranking', () => {
    const many = [{ id: 1, name: 'Ann Smyth' }, { id: 2, name: 'Bo Smith' }, { id: 3, name: 'Cy Smith' }];
    assert.deepStrictEqual(rankByName(many, 'smith', r => r.name, 2).map(r => r.id), [2, 3]);
  });

  it('labels each row with how it matched, without changing the row', () => {
    const [top] = rankByName(rows, 'Mary Whitle', r => r.name);
    assert.deepStrictEqual(top, { id: 2, name: 'Marry Whitle', match: 'close' });
    assert.ok(!('match' in rows[1]));
  });
});

describe('normalise', () => {
  it('collapses the stray whitespace a third of stored names carry', () => {
    assert.strictEqual(normalise('  Chris   Petty '), 'chris petty');
  });
});
