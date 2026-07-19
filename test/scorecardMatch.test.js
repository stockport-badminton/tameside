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
  it('slot ids resolve to roster players (Mixed B has Blowman, so he is Man 2)', () => {
    assert.strictEqual(m.slots.home.men[0].id, byName('Ian Lucas-Bond').id);
    assert.strictEqual(m.slots.home.men[1].id, byName('Ben Blowman').id);
  });
});

describe('matchTeamName (card header -> DB team)', () => {
  const { matchTeamName } = require('../utils/scorecardMatch');
  const teams = [
    { id: 1, name: 'Mellor A', division: 9 },
    { id: 2, name: 'Mellor B', division: 9 },
    { id: 3, name: 'Manchester Edgeley A', division: 8 },
    { id: 4, name: 'GHAP B', division: 8 },
    { id: 5, name: 'Hyde High B', division: 9 },
    { id: 6, name: 'Syddal Park A', division: 9 },
  ];
  it('exact name matches with top score', () => {
    const m = matchTeamName('GHAP B', teams);
    assert.strictEqual(m.id, 4);
  });
  it('handwriting misread resolves: "Mella A" -> Mellor A', () => {
    assert.strictEqual(matchTeamName('Mella A', teams).id, 1);
  });
  it('abbreviated header resolves: "HYDE B" -> Hyde High B', () => {
    assert.strictEqual(matchTeamName('HYDE B', teams).id, 5);
  });
  it('club initials resolve: "MEBC A" -> Manchester Edgeley A', () => {
    const m = matchTeamName('MEBC A', teams);
    assert.ok(m && m.id === 3, JSON.stringify(m));
  });
  it('returns division with the match (for the handoff URL)', () => {
    assert.strictEqual(matchTeamName('Syddal Park A', teams).division, 9);
  });
  it('garbage returns null', () => {
    assert.strictEqual(matchTeamName('zzzzz qqqq', teams), null);
    assert.strictEqual(matchTeamName('', teams), null);
  });
});

describe('matchTeamName — real Tameside names (UAT feedback cases)', () => {
  const { matchTeamName } = require('../utils/scorecardMatch');
  // The actual current team names from the DB.
  const teams = [
    { id: 53, name: 'Aerospace B', division: 9 },
    { id: 62, name: 'Alderley Park TS', division: 9 },
    { id: 12, name: 'College Green A', division: 8 },
    { id: 23, name: 'College Green B', division: 9 },
    { id: 55, name: 'Hyde A', division: 8 },
    { id: 56, name: 'Hyde B', division: 8 },
    { id: 57, name: 'Hyde C', division: 9 },
    { id: 5, name: 'Manchester Edgeley A', division: 8 },
    { id: 29, name: 'Mellor A', division: 9 },
    { id: 6, name: 'Shell A', division: 8 },
  ];
  it('"CG A" -> College Green A (club initials)', () => assert.strictEqual(matchTeamName('CG A', teams).id, 12));
  it('"CG B" -> College Green B', () => assert.strictEqual(matchTeamName('CG B', teams).id, 23));
  it('"C.G. B" (with dots) -> College Green B', () => assert.strictEqual(matchTeamName('C.G. B', teams).id, 23));
  it('"Hyde High B" (renamed team, old key/card style) -> Hyde B', () =>
    assert.strictEqual(matchTeamName('Hyde High B', teams).id, 56));
  it('"HYDE HIGH C" -> Hyde C', () => assert.strictEqual(matchTeamName('HYDE HIGH C', teams).id, 57));
  it('"MEBC A" -> Manchester Edgeley A (still works)', () => assert.strictEqual(matchTeamName('MEBC A', teams).id, 5));
});

describe('slot solver — mixed pairs decide slot order (card reproduced exactly)', () => {
  const mini = [
    { id: 101, first_name: 'Xavier', family_name: 'Cross', gender: 'Male' },
    { id: 102, first_name: 'Yuri', family_name: 'Stone', gender: 'Male' },
    { id: 103, first_name: 'Zack', family_name: 'Field', gender: 'Male' },
    { id: 104, first_name: 'Will', family_name: 'Grant', gender: 'Male' },
    { id: 201, first_name: 'Lena', family_name: 'Marsh', gender: 'Female' },
    { id: 202, first_name: 'Nora', family_name: 'Quill', gender: 'Female' },
  ];
  // Card: Open A = Cross+Stone, Open B = Field+Grant, Ladies = Marsh+Quill.
  // Mixed A on the card = STONE + QUILL -> so Stone must be Man1 and Quill
  // Lady1 (the form derives Mixed A from Man1+Lady1), flipping score order.
  const extraction = {
    events: [
      { event: 'Open A', home: { playersRaw: 'X Cross Y Stone' }, away: { playersRaw: '' } },
      { event: 'Ladies', home: { playersRaw: 'L Marsh N Quill' }, away: { playersRaw: '' } },
      { event: 'Open B', home: { playersRaw: 'Z Field W Grant' }, away: { playersRaw: '' } },
      { event: 'Mixed A', home: { playersRaw: 'Y Stone N Quill' }, away: { playersRaw: '' } },
      { event: 'Mixed B', home: { playersRaw: 'X Cross L Marsh' }, away: { playersRaw: '' } },
      { event: 'Mixed C', home: { playersRaw: 'W Grant N Quill' }, away: { playersRaw: '' } },
      { event: 'Mixed D', home: { playersRaw: 'Z Field L Marsh' }, away: { playersRaw: '' } },
      { event: 'Open C', home: { playersRaw: 'Y Stone X Cross' }, away: { playersRaw: '' } },
      { event: 'Open D', home: { playersRaw: 'W Grant Z Field' }, away: { playersRaw: '' } },
    ],
  };
  const { matchScorecard } = require('../utils/scorecardMatch');
  const m = matchScorecard(extraction, mini, []);
  const men = m.slots.home.men.map((p) => p && p.name);
  const ladies = m.slots.home.ladies.map((p) => p && p.name);

  it('Man 1 is the Open A player who played Mixed A (Stone)', () => assert.strictEqual(men[0], 'Yuri Stone'));
  it('Man 2 is the other Open A player (Cross, plays Mixed B)', () => assert.strictEqual(men[1], 'Xavier Cross'));
  it('Man 3 is the Open B player who played Mixed C (Grant)', () => assert.strictEqual(men[2], 'Will Grant'));
  it('Man 4 is the other Open B player (Field, plays Mixed D)', () => assert.strictEqual(men[3], 'Zack Field'));
  it('Lady 1 is the lady from Mixed A/C (Quill), Lady 2 from B/D (Marsh)', () =>
    assert.deepStrictEqual(ladies, ['Nora Quill', 'Lena Marsh']));
});

describe('matchTeamName — safety rules (UAT round 2)', () => {
  const { matchTeamName } = require('../utils/scorecardMatch');
  const teams = [
    { id: 55, name: 'Hyde A', division: 8 },
    { id: 56, name: 'Hyde B', division: 8 },
    { id: 5, name: 'Manchester Edgeley A', division: 8 },
    { id: 32, name: 'Disley A', division: 9 },
    { id: 61, name: 'Syddal Park A', division: 9 },
    { id: 62, name: 'Alderley Park TS', division: 9 },
    { id: 12, name: 'College Green A', division: 8 },
    { id: 23, name: 'College Green B', division: 9 },
  ];
  it('shared distinctive word: "EDGELEY A" -> Manchester Edgeley A (not Disley A)', () => {
    assert.strictEqual(matchTeamName('EDGELEY A', teams).id, 5);
  });
  it('mangled header with no suffix returns null, not a sibling guess ("AYOEA" was "HYDE A"-ish)', () => {
    assert.strictEqual(matchTeamName('AYOEA', teams), null);
  });
  it('tie-break: "Syde Park Park" -> Syddal Park A (both park clubs share the word)', () => {
    assert.strictEqual(matchTeamName('Syde Park Park', teams).id, 61);
  });
  it('suffix-less club shorthand is ambiguous between siblings -> null ("CG")', () => {
    assert.strictEqual(matchTeamName('CG', teams), null);
  });
});
