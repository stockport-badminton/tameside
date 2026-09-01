// Cross-referencing a club's returned registration form against the database.
//
// utils/registrationDiff.js is pure, so these are the real thing rather than a mock: the
// shapes below are the shapes the live queries return. The cases are drawn from what the
// seven real returned documents actually produced when diffed against production
// (2026-09-01), because every awkward branch in that module exists for a case that showed
// up in the real data rather than one imagined in advance.

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { diffRegistration, RESERVE_RANK, APPLICABLE_KINDS, BLOCKED_KINDS } = require('../utils/registrationDiff');

const CLUB = { id: 47, name: 'Hyde' };
const TEAMS = [
  { id: 1, name: 'Hyde A', club: 47 },
  { id: 2, name: 'Hyde B', club: 47 },
  { id: 3, name: 'Hyde C', club: 47 },
];

const p = (id, first, family, gender, team, teamName, rank, extra = {}) =>
  Object.assign({ id, first_name: first, family_name: family, gender, team, teamName, rank, club: 47 }, extra);

// One nominated man in Hyde A at no. 1, and one reserve in Hyde B.
const ROSTER = [
  p(10, 'Andrew', 'Capewell', 'Male', 1, 'Hyde A', 1),
  p(11, 'David', 'Kennon', 'Male', 1, 'Hyde A', 2),
  p(12, 'Alice', 'Cooper', 'Female', 1, 'Hyde A', 1),
  p(13, 'Adil', 'Khan', 'Male', 3, 'Hyde C', 4),
  p(14, 'Jamie', 'Saint', 'Male', 2, 'Hyde B', RESERVE_RANK),
];

const entry = (name, gender, teamLetter, { reserve = false, block = null } = {}) =>
  ({ name, gender, teamLetter, reserve, block: block || teamLetter, row: 0 });

const doc = (entries, club = 'Hyde') => ({ club, source: 'docx', entries, warnings: [] });

const kindOf = (result, name) => (result.changes.find(c => c.name === name) || {}).kind;
const changeOf = (result, name) => result.changes.find(c => c.name === name);

describe('the three change types the form is meant to capture', () => {
  it('spots a change in order', () => {
    // Andrew and David swap. Rank comes from ROW ORDER within team+gender — that is what
    // "order" means on this form, there is no rank column.
    const r = diffRegistration(doc([
      entry('David Kennon', 'Male', 'A'),
      entry('Andrew Capewell', 'Male', 'A'),
    ]), { club: CLUB, teams: TEAMS, roster: ROSTER, otherPlayers: [] });
    assert.strictEqual(kindOf(r, 'David Kennon'), 'order');
    assert.strictEqual(changeOf(r, 'David Kennon').targetRank, 1);
    assert.strictEqual(kindOf(r, 'Andrew Capewell'), 'order');
    assert.strictEqual(changeOf(r, 'Andrew Capewell').targetRank, 2);
  });

  it('spots a change of team', () => {
    const r = diffRegistration(doc([entry('Adil Khan', 'Male', 'B')]),
      { club: CLUB, teams: TEAMS, roster: ROSTER, otherPlayers: [] });
    const c = changeOf(r, 'Adil Khan');
    assert.strictEqual(c.kind, 'team');
    assert.strictEqual(c.targetTeamId, 2);
    assert.strictEqual(c.targetRank, 1);
  });

  it('spots a nominated player being made a reserve, and back', () => {
    const down = diffRegistration(doc([entry('Andrew Capewell', 'Male', null, { reserve: true, block: 'A' })]),
      { club: CLUB, teams: TEAMS, roster: ROSTER, otherPlayers: [] });
    assert.strictEqual(kindOf(down, 'Andrew Capewell'), 'reserve');
    assert.strictEqual(changeOf(down, 'Andrew Capewell').targetRank, RESERVE_RANK);

    const up = diffRegistration(doc([entry('Jamie Saint', 'Male', 'B')]),
      { club: CLUB, teams: TEAMS, roster: ROSTER, otherPlayers: [] });
    assert.strictEqual(kindOf(up, 'Jamie Saint'), 'reserve');
    assert.strictEqual(changeOf(up, 'Jamie Saint').targetRank, 1);
  });

  it('a reserve keeps the team of the block it is listed under', () => {
    // The .docx writes 'R' in the letter column, so the block heading is the ONLY place a
    // reserve's team appears — and the database keeps a team for reserves (rank 99).
    const r = diffRegistration(doc([entry('Andrew Capewell', 'Male', null, { reserve: true, block: 'C' })]),
      { club: CLUB, teams: TEAMS, roster: ROSTER, otherPlayers: [] });
    const c = changeOf(r, 'Andrew Capewell');
    assert.strictEqual(c.targetTeamId, 3, 'should follow the block, not stay on Hyde A');
    assert.strictEqual(c.targetRank, RESERVE_RANK);
  });

  it('leaves an unchanged player alone', () => {
    const r = diffRegistration(doc([
      entry('Andrew Capewell', 'Male', 'A'),
      entry('David Kennon', 'Male', 'A'),
    ]), { club: CLUB, teams: TEAMS, roster: ROSTER, otherPlayers: [] });
    assert.strictEqual(kindOf(r, 'Andrew Capewell'), 'unchanged');
    assert.strictEqual(kindOf(r, 'David Kennon'), 'unchanged');
  });
});

describe('a name that is not in the club roster', () => {
  const dormant = [{ id: 90, first_name: 'Ben', family_name: 'Holcome', gender: 'Male',
    club: 63, clubName: 'No Club', team: 52, teamName: 'No Team', rank: RESERVE_RANK }];
  const elsewhere = [{ id: 91, first_name: 'Tony', family_name: 'Mooney', gender: 'Male',
    club: 39, clubName: 'Mellor', team: 7, teamName: 'Mellor A', rank: 2 }];

  it('is "new" only when nobody in the whole table matches', () => {
    const r = diffRegistration(doc([entry('Brand New Person', 'Male', 'A')]),
      { club: CLUB, teams: TEAMS, roster: ROSTER, otherPlayers: dormant.concat(elsewhere) });
    assert.strictEqual(kindOf(r, 'Brand New Person'), 'new');
  });

  it('is "reactivate" for a dormant player, not "new"', () => {
    // 486 of 1,138 players sit at "No Club". A name missing from the roster is more often
    // a dormant player than a new one, so concluding "new" without searching everyone
    // would create duplicate rows as a matter of routine.
    const r = diffRegistration(doc([entry('Ben Holcome', 'Male', null, { reserve: true, block: 'A' })]),
      { club: CLUB, teams: TEAMS, roster: ROSTER, otherPlayers: dormant });
    const c = changeOf(r, 'Ben Holcome');
    assert.strictEqual(c.kind, 'reactivate');
    assert.strictEqual(c.player.id, 90);
    assert.strictEqual(c.targetTeamId, 1);
  });

  it('is "transfer" for someone at another club, and transfers are never applicable', () => {
    const r = diffRegistration(doc([entry('Tony Mooney', 'Male', 'A')]),
      { club: CLUB, teams: TEAMS, roster: ROSTER, otherPlayers: elsewhere });
    const c = changeOf(r, 'Tony Mooney');
    assert.strictEqual(c.kind, 'transfer');
    assert.strictEqual(c.player.clubName, 'Mellor');
    assert.ok(!APPLICABLE_KINDS.has('transfer'), 'transfer must not be applicable');
    assert.ok(BLOCKED_KINDS.has('transfer'));
  });
});

describe('ambiguity is asked about, never guessed', () => {
  // The live case: Hyde holds two "Richard Jakeman" rows and two "Dave Lee" rows — the
  // same people entered twice, one row dormant. Eight display names in the player table
  // are not unique.
  const twins = ROSTER.concat([
    p(20, 'Richard', 'Jakeman', 'Male', null, null, 1),
    p(21, 'Richard', 'Jakeman', 'Male', 1, 'Hyde A', RESERVE_RANK),
  ]);

  it('reports two identical names as ambiguous with both candidates', () => {
    const r = diffRegistration(doc([entry('Richard Jakeman', 'Male', 'A')]),
      { club: CLUB, teams: TEAMS, roster: twins, otherPlayers: [] });
    const c = changeOf(r, 'Richard Jakeman');
    assert.strictEqual(c.kind, 'ambiguous');
    assert.strictEqual(c.player, null);
    assert.deepStrictEqual(c.candidates.map(x => x.id).sort(), [20, 21]);
    assert.ok(!APPLICABLE_KINDS.has('ambiguous'));
  });

  it('does NOT also offer both candidates for removal', () => {
    // Without this, both halves of a duplicate pair fall through to `remove`, and ticking
    // them parks the real player at "No Club" on the strength of a duplicate nobody has
    // noticed. Confirmed against production: it dropped Hyde's removals from 26 to 20.
    const r = diffRegistration(doc([entry('Richard Jakeman', 'Male', 'A')]),
      { club: CLUB, teams: TEAMS, roster: twins, otherPlayers: [] });
    const removedIds = r.changes.filter(c => c.kind === 'remove').map(c => c.player.id);
    assert.ok(!removedIds.includes(20), 'candidate 20 must not be up for removal');
    assert.ok(!removedIds.includes(21), 'candidate 21 must not be up for removal');
  });

  it('gender is a hard filter, so a same-named woman is not a candidate', () => {
    const mixed = ROSTER.concat([p(30, 'Sam', 'Roe', 'Male', 1, 'Hyde A', 3), p(31, 'Sam', 'Roe', 'Female', 1, 'Hyde A', 2)]);
    const r = diffRegistration(doc([entry('Sam Roe', 'Male', 'A')]),
      { club: CLUB, teams: TEAMS, roster: mixed, otherPlayers: [] });
    const c = changeOf(r, 'Sam Roe');
    assert.notStrictEqual(c.kind, 'ambiguous');
    assert.strictEqual(c.player.id, 30);
  });
});

describe('things that must not be applied quietly', () => {
  it('flags a team letter the club does not have', () => {
    const r = diffRegistration(doc([entry('Andrew Capewell', 'Male', 'D')]),
      { club: CLUB, teams: TEAMS, roster: ROSTER, otherPlayers: [] });
    assert.strictEqual(kindOf(r, 'Andrew Capewell'), 'no-such-team');
    assert.ok(!APPLICABLE_KINDS.has('no-such-team'));
  });

  it('warns when the document names a different club than the one selected', () => {
    // A club sending the wrong file is an ordinary accident, and silently applying it
    // would be the worst outcome this feature could have.
    const r = diffRegistration(doc([entry('Andrew Capewell', 'Male', 'A')], 'Mellor'),
      { club: CLUB, teams: TEAMS, roster: ROSTER, otherPlayers: [] });
    assert.ok(r.warnings.some(w => /Mellor/.test(w) && /Hyde/.test(w)), r.warnings.join('; '));
  });

  it('does not warn when the club names differ only in punctuation', () => {
    // The real club row is "G.H.A.P" and its teams are "GHAP A"/"GHAP B".
    const ghap = { id: 53, name: 'G.H.A.P' };
    const r = diffRegistration(doc([], 'GHAP'), { club: ghap, teams: [], roster: [], otherPlayers: [] });
    assert.ok(!r.warnings.some(w => /you are importing/.test(w)), r.warnings.join('; '));
  });

  it('lists roster players missing from the form as removals', () => {
    const r = diffRegistration(doc([entry('Andrew Capewell', 'Male', 'A')]),
      { club: CLUB, teams: TEAMS, roster: ROSTER, otherPlayers: [] });
    const removed = r.changes.filter(c => c.kind === 'remove').map(c => c.player.id).sort();
    assert.deepStrictEqual(removed, [11, 12, 13, 14]);
  });
});

describe('change keys', () => {
  it('are stable and unique, because the apply route looks changes up by them', () => {
    const r = diffRegistration(doc([
      entry('Andrew Capewell', 'Male', 'A'),
      entry('Adil Khan', 'Male', 'B'),
    ]), { club: CLUB, teams: TEAMS, roster: ROSTER, otherPlayers: [] });
    const keys = r.changes.map(c => c.key);
    assert.strictEqual(new Set(keys).size, keys.length, 'keys must be unique: ' + keys.join(','));
    assert.ok(keys.every(k => /^[er]\d+$/.test(k)), keys.join(','));
  });
});
