// Unit tests for utils/scorecardMatch.js — fuzzy roster matching. Pure, no DB.
// Roster names mirror the real card-108 cases the matcher was validated on
// (Vision raw text like "Ian was bond" -> Ian Lucas-Bond).
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { matchPair, matchScorecard, normalise, tokenise } = require('../utils/scorecardMatch');

let nextId = 1;
const P = (first, family, gender) => ({ id: nextId++, first_name: first, family_name: family, gender });

const roster = [
  P('Ben', 'Blowman', 'Male'),
  P('Ian', 'Lucas-Bond', 'Male'),
  P('Ben', 'Chow', 'Male'),
  P('Kaiya', 'Eeles', 'Male'),
  P('Casey', 'Lashley', 'Female'),
  P('Maria', 'Tran', 'Female'),
  P('Danny', 'Eason', 'Male'),      // decoy
  P('Ursula', 'Norman', 'Female'),  // decoy
];
const byName = (n) => roster.find((p) => `${p.first_name} ${p.family_name}` === n);

describe('normalise / tokenise', () => {
  it('lowercases and strips non-letters (dots, digits, cyrillic)', () => {
    assert.strictEqual(normalise('T.HUGGON'), 'thuggon');
    assert.strictEqual(normalise('Lucas-Bond'), 'lucasbond');
    assert.strictEqual(normalise('т.нискот'), '');
  });
  it('builds consecutive-token joins to recover split surnames', () => {
    assert.ok(tokenise('Ian was bond').joins.includes('wasbond'));
  });
});

describe('matchPair', () => {
  it('matches messy Vision text to the right pair: "Ben Blowran Ian was bond"', () => {
    const { pair } = matchPair('Ben Blowran Ian was bond', roster, 'open');
    const names = pair.map((p) => p && p.name).sort();
    assert.deepStrictEqual(names, ['Ben Blowman', 'Ian Lucas-Bond']);
    assert.ok(pair.every((p) => p.confident), 'both matches should be confident');
  });
  it('matches initial+surname style: "CHOW GELES K." -> Chow + Eeles', () => {
    const { pair } = matchPair('CHOW GELES K.', roster, 'open');
    const names = pair.map((p) => p && p.name).sort();
    assert.deepStrictEqual(names, ['Ben Chow', 'Kaiya Eeles']);
  });
  it('ladies spec only picks Female players', () => {
    const { pair } = matchPair('Clashley M Tran', roster, 'ladies');
    assert.ok(pair.every((p) => p.gender === 'Female'));
    // pair is score-ordered, so assert the set
    assert.deepStrictEqual(pair.map((p) => p.name).sort(), ['Casey Lashley', 'Maria Tran']);
  });
  it('mixed spec picks one Male and one Female', () => {
    const { pair } = matchPair('Blowman B Lashley C', roster, 'mixed');
    assert.deepStrictEqual(pair.map((p) => p.gender).sort(), ['Female', 'Male']);
  });
  it('marks weak matches as not confident', () => {
    const { pair } = matchPair('zzz qqq', roster, 'open');
    assert.ok(pair.every((p) => !p || !p.confident));
  });
});

describe('matchScorecard slot assignment', () => {
  // Minimal extraction shape: Open A pair -> Man 1/2, Open B pair -> Man 3/4,
  // Ladies pair -> Lady 1/2 (form convention).
  const extraction = {
    events: [
      { event: 'Open A', home: { playersRaw: 'Ben Blowran Ian was bond' }, away: { playersRaw: '' } },
      { event: 'Ladies', home: { playersRaw: 'Clashley M Tran' }, away: { playersRaw: '' } },
      { event: 'Open B', home: { playersRaw: 'B Chow K Geles' }, away: { playersRaw: '' } },
      { event: 'Mixed A', home: { playersRaw: 'K Geles M Tran' }, away: { playersRaw: '' } },
      { event: 'Mixed B', home: { playersRaw: 'Blowman Lashley' }, away: { playersRaw: '' } },
      { event: 'Mixed C', home: { playersRaw: 'Tran Chow' }, away: { playersRaw: '' } },
      { event: 'Mixed D', home: { playersRaw: 'Lucas Bond Lashley' }, away: { playersRaw: '' } },
      { event: 'Open C', home: { playersRaw: 'Blowman Lucas Bond' }, away: { playersRaw: '' } },
      { event: 'Open D', home: { playersRaw: 'Chow Geles' }, away: { playersRaw: '' } },
    ],
  };
  const m = matchScorecard(extraction, roster, []);

  it('assigns Open A pair to Man 1/2 and Open B pair to Man 3/4', () => {
    const men = m.slots.home.men.map((p) => p && p.name);
    assert.deepStrictEqual(men.slice(0, 2).sort(), ['Ben Blowman', 'Ian Lucas-Bond']);
    assert.deepStrictEqual(men.slice(2).sort(), ['Ben Chow', 'Kaiya Eeles']);
  });
  it('assigns the Ladies pair to Lady 1/2', () => {
    assert.deepStrictEqual(m.slots.home.ladies.map((p) => p && p.name).sort(), ['Casey Lashley', 'Maria Tran']);
  });
  it('never assigns the same player to two slots', () => {
    const ids = [...m.slots.home.men, ...m.slots.home.ladies].filter(Boolean).map((p) => p.id);
    assert.strictEqual(new Set(ids).size, ids.length);
  });
  it('leaves unmatched sides as nulls (empty away roster)', () => {
    assert.deepStrictEqual(m.slots.away.men, [null, null, null, null]);
    assert.deepStrictEqual(m.slots.away.ladies, [null, null]);
  });
  it('slot ids resolve to roster players', () => {
    assert.strictEqual(m.slots.home.men[0].id, byName('Ben Blowman').id);
  });
});
