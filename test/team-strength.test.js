// utils/teamStrength.js: the 4+2 card, the fit, and the fixture arithmetic. Pure; no DB.
const { describe, it } = require('node:test')
const assert = require('node:assert')
const model = require('../utils/teamStrength')

const slot = (id, s = 0, mx = 0) => ({ id, name: `p${id}`, s, mx })
const side = (base, s = 0) => ({
  men: [1, 2, 3, 4].map(i => slot(base + i, s)),
  ladies: [5, 6].map(i => slot(base + i, s)),
})

describe('the card', () => {
  it('has our nine game types, each once', () => {
    assert.deepStrictEqual(model.RUBBERS.map(r => r.type).sort(), [
      'FirstLadies', 'FirstMens', 'FirstMixed', 'FourthMens', 'FourthMixed',
      'SecondMens', 'SecondMixed', 'ThirdMens', 'ThirdMixed',
    ])
    assert.deepStrictEqual(model.SIDE, { men: 4, ladies: 2 })
  })

  it('gives every one of the six players on each side exactly six games', () => {
    const home = side(100), away = side(200)
    const games = new Map()
    for (const r of model.RUBBERS) {
      for (const p of [...r.home(home), ...r.away(away)]) games.set(p.id, (games.get(p.id) || 0) + model.GAMES_PER_RUBBER)
    }
    assert.strictEqual(games.size, 12)
    for (const [id, n] of games) assert.strictEqual(n, 6, `player ${id}`)
  })

  it('crosses the order in Open C and Open D, as the entry form writes them', () => {
    const home = side(100), away = side(200)
    const ids = type => { const r = model.RUBBERS.find(x => x.type === type); return [r.home(home), r.away(away)].map(ps => ps.map(p => p.id)) }
    assert.deepStrictEqual(ids('ThirdMens'), [[101, 102], [203, 204]])
    assert.deepStrictEqual(ids('FourthMens'), [[103, 104], [201, 202]])
    assert.deepStrictEqual(ids('ThirdMixed'), [[103, 105], [203, 205]])
    assert.deepStrictEqual(ids('FourthMixed'), [[104, 106], [204, 206]])
  })
})

describe('the fixture arithmetic', () => {
  it('a score distribution over 0..18 that sums to 1', () => {
    const dist = model.scoreDistribution(model.rubberProbs(side(100, 0.1), side(200), 0))
    assert.strictEqual(dist.length, 19)
    assert.ok(Math.abs(dist.reduce((a, b) => a + b, 0) - 1) < 1e-9)
  })

  it('two equal sides with no home edge are a coin toss', () => {
    const pr = model.predictFixture(side(100), side(200), 0)
    assert.ok(Math.abs(pr.pHome - pr.pAway) < 1e-9)
    assert.ok(Math.abs(pr.expected - 9) < 1e-9)
  })

  it('a stronger home side is favoured, and the swing widens the spread', () => {
    const narrow = model.fixtureDistribution(side(100, 0.1), side(200), 0, 0)
    const wide = model.fixtureDistribution(side(100, 0.1), side(200), 0, 0.3)
    const variance = d => { const e = d.reduce((a, v, k) => a + v * k, 0); return d.reduce((a, v, k) => a + v * (k - e) ** 2, 0) }
    assert.ok(narrow.reduce((a, v, k) => a + v * k, 0) > 9)
    assert.ok(variance(wide) > variance(narrow))
  })

  it('gameWin is 0.5 at an even rally and rises with it', () => {
    assert.ok(Math.abs(model.gameWin(0.5) - 0.5) < 1e-6)
    assert.ok(model.gameWin(0.55) > 0.7)
  })
})

describe('the games', () => {
  const g = (o = {}) => ({ id: 1, fixture: 9, homePlayer1: 1, homePlayer2: 2, awayPlayer1: 3, awayPlayer2: 4, homeScore: 21, awayScore: 15, ...o })

  it('leaves out player 0, a repeated player, a walkover and an unfinished game', () => {
    assert.strictEqual(model.usableGame(g()), true)
    assert.strictEqual(model.usableGame(g({ awayPlayer2: 0 })), false)
    assert.strictEqual(model.usableGame(g({ awayPlayer2: 1 })), false)
    assert.strictEqual(model.usableGame(g({ awayScore: 0 })), false)
    assert.strictEqual(model.usableGame(g({ homeScore: 18 })), false)
  })

  it('keeps only the latest 18 rows of a re-entered scorecard', () => {
    const rows = Array.from({ length: 36 }, (_, i) => g({ id: i + 1 })).concat([g({ id: 99, fixture: 10 })])
    const kept = model.latestEntries(rows)
    assert.strictEqual(kept.length, 19)
    assert.ok(kept.filter(r => r.fixture === 9).every(r => r.id > 18))
  })

  it('gives each player the division they were registered in that season', () => {
    const rows = [{ ...g(), date: '2025-10-01', season: '20252026', gameType: 'FirstMens', homeTeam: 1, awayTeam: 2 }]
    const regs = [
      { season: '20252026', id: 1, gender: 'Male', divRank: 1 }, { season: '20262027', id: 1, gender: 'Male', divRank: 2 },
    ]
    const { games, genderOf } = model.collectGames(rows, regs)
    assert.deepStrictEqual(games[0].divs, [1, undefined, undefined, undefined])
    assert.strictEqual(genderOf(1), 'Male')
  })
})

describe('the fit', () => {
  // Four men of known strength, every pairing against every other, scores at their expected
  // share of 36 rallies. The fit should put them back in order.
  const truth = new Map([[1, 0.3], [2, 0.1], [3, -0.1], [4, -0.3]])
  const games = []
  const pairs = [[1, 2, 3, 4], [1, 3, 2, 4], [1, 4, 2, 3]]
  let t = Date.UTC(2025, 9, 1)
  for (let rep = 0; rep < 20; rep++) for (const [h1, h2, a1, a2] of pairs) for (const flip of [false, true]) {
    const [A, B, C, D] = flip ? [a1, a2, h1, h2] : [h1, h2, a1, a2]
    const p = model.sig(truth.get(A) + truth.get(B) - truth.get(C) - truth.get(D))
    const hs = Math.round(40 * p), as = 40 - hs
    games.push({ t: t += 86400000, mixed: false, h1: A, h2: B, a1: C, a2: D, hs, as })
  }
  const now = t + 86400000

  it('recovers the order of four players', () => {
    const f = model.fit(games, now, () => 'Male', () => 1)
    const order = [...f.s].sort((a, b) => b[1] - a[1]).map(([id]) => id)
    assert.deepStrictEqual(order, [1, 2, 3, 4])
    assert.ok(Math.abs(f.home) < 0.05)
    for (const [, se] of f.se) assert.ok(se > 0 && se < 0.3)
  })

  it('stays finite when the home side wins everything (Stockport db9bc17)', () => {
    const allHome = games.map(g => ({ ...g, hs: 21, as: 10 }))
    const f = model.fit(allHome, now, () => 'Male', () => 1)
    assert.ok(Number.isFinite(f.home) && f.home < 1)
    for (const [, s] of f.s) assert.ok(Number.isFinite(s) && Math.abs(s) < 2)
  })

  it('a player with no games starts at their division\'s average', () => {
    const f = model.fit(games, now, () => 'Male', () => 1)
    assert.ok(Number.isFinite(f.mean('Male', 1)))
    assert.strictEqual(f.mean('Female', 1), 0)
  })

  it('fitAt sees only the games before its date', () => {
    const input = { games: games.map(g => ({ ...g, divs: [1, 1, 1, 1] })), genderOf: () => 'Male' }
    const { games: seen } = model.fitAt(input, games[10].t)
    assert.strictEqual(seen.length, 10)
  })
})

describe('usual players', () => {
  it('regulars first, then nominated, then reserves; n of them, strongest first', () => {
    const nominated = [slot(1, 0.1), slot(2, 0.2), slot(3, 0)]
    const reserves = [slot(9, 0.5)]
    const played = [{ slot: slot(7, -0.1), fixtures: 5 }, { slot: slot(2, 0.2), fixtures: 3 }]
    assert.deepStrictEqual(model.usualPlayers(4, nominated, reserves, played).map(p => p.id), [2, 1, 3, 7])
    assert.deepStrictEqual(model.usualPlayers(2, [], reserves, []).map(p => p.id), [9])
  })
})
