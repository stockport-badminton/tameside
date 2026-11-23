// utils/lewisHandicap.js: the points maths, and line-ups from a team-strength run.
const { describe, it } = require('node:test')
const assert = require('node:assert')

const lh = require('../utils/lewisHandicap')

const side = (s, mx = 0) => ({ men: [0, 1, 2, 3].map(i => ({ id: i + 1, name: `M${i + 1}`, s, mx })), ladies: [0, 1].map(i => ({ id: i + 10, name: `L${i + 1}`, s, mx })) })

describe('points per game', () => {
  it('an even rally is an even game', () => {
    assert.ok(Math.abs(lh.gameMargin(0.5).mean) < 1e-9)
  })
  it('is antisymmetric, and grows with the rally edge', () => {
    for (const p of [0.52, 0.55, 0.6, 0.7]) assert.ok(Math.abs(lh.gameMargin(p).mean + lh.gameMargin(1 - p).mean) < 1e-6)
    assert.ok(lh.gameMargin(0.55).mean > lh.gameMargin(0.52).mean)
  })
  it('a certain winner wins 21-0', () => {
    assert.ok(Math.abs(lh.gameMargin(1).mean - 21) < 1e-9)
    assert.ok(lh.gameMargin(1).variance < 1e-9)
  })
})

describe('handicap', () => {
  it('equal sides with no home edge are scratch', () => {
    const h = lh.handicap(side(0), side(0), 0, 0.2)
    assert.strictEqual(h.to, null)
    assert.strictEqual(h.points, 0)
  })
  it('goes to the weaker side and evens the tie', () => {
    const h = lh.handicap(side(0.05), side(0), 0, 0.2)
    assert.strictEqual(h.to, 'away')
    assert.ok(h.points > 20 && h.points < 80, String(h.points))
    assert.ok(h.pHome > 0.6)
    assert.ok(Math.abs(h.pHomeWith(-h.points) - 0.5) < 0.01)
    const r = lh.handicap(side(0), side(0.05), 0, 0.2)
    assert.strictEqual(r.to, 'home')
    assert.strictEqual(r.points, h.points)
  })
  it('the home edge alone gives the away side points', () => {
    assert.strictEqual(lh.handicap(side(0), side(0), 0.05, 0.2).to, 'away')
  })
})

describe('line-ups from a run', () => {
  const player = (id, name, r, extra = {}) => ({ id, name, r, mixed: 0, games: 10, ...extra })
  const payload = {
    home: 0, settings: { fixtureSd: 0.2 },
    divisionMeans: [{ rank: 1, men: 1600, ladies: 1550 }, { rank: 2, men: 1400, ladies: 1450 }],
    teams: [
      { id: 1, name: 'Hyde A', club: 'Hyde', divisionRank: 1,
        men: [1, 2, 3, 4, 5].map(i => player(i, `Hyde man ${i}`, 1600)), ladies: [player(11, 'Hyde lady 1', 1550), player(12, 'Hyde lady 2', null)],
        usual: { men: [1, 2, 3, 4], ladies: [11, 12] } },
      { id: 2, name: 'Hyde B', club: 'Hyde', divisionRank: 2,
        men: [player(6, 'Hyde B man', 1450)], ladies: [], usual: { men: [6], ladies: [] } },
      { id: 3, name: 'Medlock A', club: 'Medlock', divisionRank: 2,
        men: [player(21, 'Medlock man', 1400)], ladies: [], usual: { men: [21], ladies: [] } },
    ],
  }

  it('without picks, the usual side; an unrated player is the division average', () => {
    const l = lh.lineupFor(payload, 1)
    assert.deepStrictEqual(l.men.map(p => p.id), [1, 2, 3, 4])
    assert.strictEqual(l.ladies[1].id, 12)
    assert.ok(Math.abs(l.ladies[1].s - 0.05) < 1e-9)
  })

  it('a short usual side is padded with the division average', () => {
    const l = lh.lineupFor(payload, 2)
    assert.strictEqual(l.men[0].id, 6)
    assert.deepStrictEqual(l.men.slice(1).map(p => p.id), [null, null, null])
    assert.ok(Math.abs(l.men[1].s - (-0.1)) < 1e-9)
  })

  it('picks take any player of the club, in card order', () => {
    const l = lh.lineupFor(payload, 1, { men: [6, 1, 2, 3], ladies: [11, 0] })
    assert.deepStrictEqual(l.men.map(p => p.id), [6, 1, 2, 3])
    assert.strictEqual(l.ladies[1].id, null)
  })

  it("another club's player is never picked: the slot is the average", () => {
    const l = lh.lineupFor(payload, 1, { men: [21, 1, 2, 3], ladies: [11, 12] })
    assert.strictEqual(l.men[0].id, null)
  })

  it('forTie answers null for a team the run does not have', () => {
    assert.strictEqual(lh.forTie(payload, 1, 99), null)
    const t = lh.forTie(payload, 1, 3)
    assert.strictEqual(t.to, 'away')
    assert.strictEqual(t.rubbers.length, 9)
  })
})
