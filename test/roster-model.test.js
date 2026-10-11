// models/roster.js rank planning — pure, so tested without a database. The SQL itself is
// exercised against production, rolled back, by tools/rehearse-roster.js.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { planSection, planGender, appendRank, splitCandidates } = require('../models/roster');

const row = (id, rank) => ({ id, rank });
// Apply a plan to `current` and read back the lists, as the database would hold them.
function after(current, plan) {
  const ranks = new Map(current.map((r) => [r.id, r.rank === null ? null : Number(r.rank)]));
  for (const u of plan) ranks.set(u.id, u.rank);
  const all = [...ranks].map(([id, rank]) => ({ id, rank }));
  const sorted = (xs) => xs.sort((a, b) => a.rank - b.rank).map((r) => r.id);
  return {
    nominated: sorted(all.filter((r) => r.rank !== null && r.rank < 99)),
    reserve: sorted(all.filter((r) => r.rank >= 99)),
    ranks: Object.fromEntries(all.map((r) => [r.id, r.rank])),
  };
}

describe('planGender — a whole (team, gender) save', () => {
  const current = [row(1, 1), row(2, 2), row(3, 3), row(10, 99), row(11, 99)];

  it('reorders nominated players', () => {
    const plan = planGender(current, { nominated: [2, 1, 3], reserve: [10, 11] });
    assert.deepStrictEqual(after(current, plan).nominated, [2, 1, 3]);
  });

  it('PROMOTES a reserve — section membership comes from the payload (Stockport 06824a0)', () => {
    const plan = planGender(current, { nominated: [1, 2, 3, 10], reserve: [11] });
    const a = after(current, plan);
    assert.deepStrictEqual(a.nominated, [1, 2, 3, 10]);
    assert.deepStrictEqual(a.reserve, [11]);
    assert.strictEqual(a.ranks[10], 4);
    assert.strictEqual(a.ranks[11], 99);
  });

  it('demotes a nominated player to reserve', () => {
    const a = after(current, planGender(current, { nominated: [1, 3], reserve: [2, 10, 11] }));
    assert.deepStrictEqual(a.nominated, [1, 3]);
    assert.deepStrictEqual(a.reserve, [2, 10, 11]);
    assert.deepStrictEqual([a.ranks[2], a.ranks[10], a.ranks[11]], [99, 100, 101]);
  });

  it('numbers reserves 99, 100, 101… so their order is kept', () => {
    const a = after(current, planGender(current, { nominated: [1, 2, 3], reserve: [11, 10] }));
    assert.deepStrictEqual(a.reserve, [11, 10]);
    assert.deepStrictEqual([a.ranks[11], a.ranks[10]], [99, 100]);
  });

  it('ignores ids from another team or gender — a stale page cannot drag anyone in', () => {
    const plan = planGender(current, { nominated: [999, 1, 2, 3], reserve: [10, 11] });
    assert.ok(!plan.some((u) => u.id === 999));
  });

  it('keeps an unmentioned player in their section, at the bottom of it', () => {
    const a = after(current, planGender(current, { nominated: [3, 1] }));
    assert.deepStrictEqual(a.nominated, [3, 1, 2]);
    assert.deepStrictEqual(a.reserve, [10, 11]);
  });

  it('a player named in both lists is nominated', () => {
    const a = after(current, planGender(current, { nominated: [1, 2, 3, 10], reserve: [10, 11] }));
    assert.ok(a.nominated.includes(10));
    assert.ok(!a.reserve.includes(10));
  });

  it('writes nothing when nothing changed', () => {
    const settled = [row(1, 1), row(2, 2), row(10, 99), row(11, 100)];
    assert.deepStrictEqual(planGender(settled, { nominated: [1, 2], reserve: [10, 11] }), []);
  });

  it('closes gaps and duplicates left by the old page (1, 2, 4 and two 99s)', () => {
    const legacy = [row(1, 1), row(2, 2), row(3, 4), row(10, 99), row(11, 99)];
    const a = after(legacy, planGender(legacy, {}));
    assert.deepStrictEqual(Object.values(a.ranks).sort((x, y) => x - y), [1, 2, 3, 99, 100]);
  });

  it('gives an unranked (NULL) player a number at the bottom of nominated', () => {
    const withNull = [row(1, 1), row(5, null), row(10, 99)];
    const a = after(withNull, planGender(withNull, {}));
    assert.deepStrictEqual(a.nominated, [1, 5]);
    assert.strictEqual(a.ranks[5], 2);
  });
});

describe('planSection — closing the gap a departing player leaves', () => {
  it('renumbers only its own section, and cannot reclassify anyone', () => {
    const current = [row(1, 1), row(3, 3), row(10, 99), row(11, 101)];
    const plan = planSection(current, 'nominated');
    assert.deepStrictEqual(plan, [{ id: 3, rank: 2 }]);
    assert.deepStrictEqual(planSection(current, 'reserve'), [{ id: 11, rank: 100 }]);
  });

  it('ignores ids from the other section', () => {
    const current = [row(1, 1), row(10, 99)];
    assert.deepStrictEqual(planSection(current, 'nominated', [10, 1]), []);
  });
});

describe('appendRank — where a placed player goes', () => {
  it('one past the end of nominated', () => assert.strictEqual(appendRank([row(1, 1), row(2, 2), row(9, 99)], 'nominated'), 3));
  it('the first reserve is 99', () => assert.strictEqual(appendRank([row(1, 1)], 'reserve'), 99));
  it('after the last reserve', () => assert.strictEqual(appendRank([row(9, 99), row(8, 100)], 'reserve'), 101));
  it('an empty team starts at 1', () => assert.strictEqual(appendRank([], 'nominated'), 1));
  it('NULL-ranked players do not count', () => assert.strictEqual(appendRank([row(1, 1), row(2, null)], 'nominated'), 2));
});

describe('splitCandidates', () => {
  const rows = [
    { playerId: 1, name: 'Dave Lee', clubId: 47, clubName: 'Hyde' },
    { playerId: 2, name: 'Dave Lee', clubId: 63, clubName: 'No Club' },
    { playerId: 3, name: 'David Lee', clubId: 12, clubName: 'Disley' },
    { playerId: 4, name: 'Someone Else', clubId: 12, clubName: 'Disley' },
  ];
  it('splits own club / no club / other clubs', () => {
    const r = splitCandidates(rows, 'Dave Lee', 'Hyde');
    assert.deepStrictEqual(r.ownClub.map((x) => x.playerId), [1]);
    assert.deepStrictEqual(r.unattached.map((x) => x.playerId), [2]);
    assert.deepStrictEqual(r.otherClubs.map((x) => x.playerId), [3]);
  });
});

describe('the SQL keeps the shape that matters', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'models', 'roster.js'), 'utf8');
  it('rank writes are one unnest UPDATE, guarded by team and gender (Stockport NODE-13)', () => {
    assert.match(src, /UPDATE player AS p SET rank = u\.rank\s+FROM unnest\(/);
    assert.match(src, /WHERE p\.id = u\.id AND p\.team = \$\{teamId\} AND p\.gender = \$\{gender\}/);
  });
  it('every write runs in a transaction', () => {
    for (const fn of ['saveTeamOrder', 'movePlayer', 'releasePlayer', 'createPlayer']) {
      assert.match(src, new RegExp(`exports\\.${fn} = inTransaction\\(`), fn);
    }
  });
  it('player 0 is excluded from every read', () => {
    // List reads only: a lookup of one known id (`WHERE id = ${...}`) can't pick up player 0.
    const reads = (src.match(/FROM player[\s\S]*?(?=`)/g) || []).filter((q) => !/WHERE id = \$\{/.test(q));
    assert.ok(reads.length >= 5, 'expected the roster reads');
    for (const q of reads) assert.match(q, /id <> 0/, q.slice(0, 80));
  });
});
