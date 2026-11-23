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

describe('projectSeason', () => {
  const uncertain = s => ({ men: [0, 1, 2, 3].map(i => ({ ...slot(i, s), se: 0.05 })), ladies: [0, 1].map(i => ({ ...slot(10 + i, s), se: 0.05 })) })
  const division = (teams, extra = {}) => ({ id: 1, name: 'Division 1', rank: 2, promotes: true, relegates: true, teams, ...extra })
  const team = (id, gamesWon, divRank = id) => ({ id, name: `T${id}`, divRank, gamesWon, played: 5, remaining: 2 })
  const lineups = new Map([[1, uncertain(0)], [2, uncertain(0)], [3, uncertain(0)], [4, uncertain(0)]])
  const remaining = [{ home: 1, away: 2 }, { home: 3, away: 4 }, { home: 2, away: 1 }, { home: 4, away: 3 }]

  it('gives each team a distribution over the places, and repeats exactly with the same seed', () => {
    const d = [division([team(1, 60), team(2, 50), team(3, 45), team(4, 40)])]
    const a = model.projectSeason(d, remaining, lineups, 0, { sims: 400 })
    const b = model.projectSeason(d, remaining, lineups, 0, { sims: 400 })
    assert.deepStrictEqual(a, b)
    for (const t of a[0].teams) assert.ok(Math.abs(t.positions.reduce((s, v) => s + v, 0) - 1) < 1e-9)
  })

  it('cannot take the title from a team out of reach', () => {
    const [proj] = model.projectSeason([division([team(1, 200), team(2, 50), team(3, 45), team(4, 40)])], remaining, lineups, 0, { sims: 400 })
    const t1 = proj.teams.find(t => t.id === 1)
    assert.strictEqual(t1.pWinner, 1)
    assert.ok(t1.expectedWon >= 200 && t1.expectedWon <= 236)
  })

  it('takes the number going up and down from its caller', () => {
    const d = [division([team(1, 60), team(2, 50), team(3, 45), team(4, 40)])]
    const [one] = model.projectSeason(d, remaining, lineups, 0, { sims: 300, moving: 1 })
    assert.ok(Math.abs(one.teams.reduce((a, t) => a + t.pUp, 0) - 1) < 1e-9)
    const [two] = model.projectSeason(d, remaining, lineups, 0, { sims: 300, moving: 2 })
    assert.ok(Math.abs(two.teams.reduce((a, t) => a + t.pDown, 0) - 2) < 1e-9)
  })

  it('promotes nobody from the top division and relegates nobody from the bottom', () => {
    const d = [division([team(1, 60), team(2, 50), team(3, 45), team(4, 40)], { promotes: false, relegates: false })]
    const [proj] = model.projectSeason(d, remaining, lineups, 0, { sims: 200 })
    assert.ok(proj.teams.every(t => t.pUp === 0 && t.pDown === 0))
  })

  it('plays only fixtures between teams of the same division with lineups', () => {
    const [proj] = model.projectSeason([division([team(1, 0), team(2, 0)])], [{ home: 1, away: 3 }, { home: 1, away: 2 }], lineups, 0, { sims: 200 })
    assert.ok(Math.abs(proj.teams.reduce((s, t) => s + t.expectedWon, 0) - 18) < 1e-9)
  })

  it('a team\'s form wanders more the more of the season is left (sized by the backtest)', () => {
    assert.ok(Math.abs(model.formSdFor(1) - 0.15) < 1e-9)
    assert.ok(Math.abs(model.formSdFor(0.45) - 0.1) < 1e-9)
    assert.ok(Math.abs(model.formSdFor(0) - 0.1) < 1e-9)
  })
})

describe('orderFlags (4+2)', () => {
  const rated = (name, rank, r, recent = 20) => ({ id: rank, name, rank, r, s: (r - 1500) / 1000, se: 0.03, recent })
  const squad = (nominated, reserves = [], unset = false) => ({ name: '', nominated, reserves, unset })
  const team = (name, men, ladies = squad([])) => ({ name, men, ladies })
  const four = (prefix, rs) => rs.map((r, i) => rated(`${prefix}${i + 1}`, i + 1, r))

  it('flags a man in the bottom pair well above one in the top pair', () => {
    const flags = model.orderFlags([team('A', squad(four('M', [1500, 1480, 1700, 1300])))])
    assert.deepStrictEqual(flags.map(f => [f.kind, f.text]), [
      ['order', 'M3 (man 3) looks stronger than M1 (man 1)'],
      ['order', 'M3 (man 3) looks stronger than M2 (man 2)'],
    ])
  })

  it('does not flag a swap within a pair: man 2 over man 1 plays the same level games', () => {
    assert.deepStrictEqual(model.orderFlags([team('A', squad(four('M', [1500, 1800, 1300, 1290])))]), [])
    assert.deepStrictEqual(model.orderFlags([team('A', squad([]), squad([rated('L1', 1, 1400), rated('L2', 2, 1700)]))]), [])
  })

  it('flags a nominee beyond the side who rates above one who plays', () => {
    const flags = model.orderFlags([team('A', squad([...four('M', [1600, 1590, 1580, 1570]), rated('M5', 5, 1900)]))])
    assert.strictEqual(flags.length, 4)
    assert.ok(flags.every(f => f.kind === 'order' && f.stronger.name === 'M5'))
  })

  it('leaves alone a gap it cannot be sure of, and players with few recent games', () => {
    assert.deepStrictEqual(model.orderFlags([team('A', squad(four('M', [1500, 1500, 1520, 1500])))]), [])
    assert.deepStrictEqual(model.orderFlags([team('A', squad([...four('M', [1500, 1500, 1500, 1500]).slice(0, 2), rated('M3', 3, 1800, 3)]))]), [])
  })

  it('compares a reserve with the team above\'s man 4 (not man 3)', () => {
    const a = team('A', squad(four('A', [1800, 1750, 1700, 1500])))
    const b = team('B', squad(four('B', [1400, 1390, 1380, 1370]), [rated('BR', 99, 1650)]))
    const flags = model.orderFlags([a, b])
    assert.deepStrictEqual(flags.map(f => [f.kind, f.text]), [['reserveTooLow', 'BR (reserve, B) looks stronger than A\'s man 4, A4']])
  })

  it('compares a reserve lady with the team above\'s lady 2', () => {
    const a = team('A', squad([]), squad([rated('L1', 1, 1700), rated('L2', 2, 1400)]))
    const b = team('B', squad([]), squad([rated('K1', 1, 1300), rated('K2', 2, 1290)], [rated('KR', 99, 1650)]))
    assert.deepStrictEqual(model.orderFlags([a, b]).map(f => f.text), ['KR (reserve, B) looks stronger than A\'s lady 2, L2'])
  })

  it('skips a team whose nominations are not set (more than twice a side)', () => {
    assert.deepStrictEqual(model.MAX_NOMINATED, { men: 8, ladies: 4 })
    assert.deepStrictEqual(model.orderFlags([team('A', squad(four('M', [1300, 1300, 1900, 1900]), [], true))]), [])
  })
})

describe('levelPositions (4+2)', () => {
  it('places each pair of a level game on the card, per side, and says nothing for a mixed', () => {
    assert.deepStrictEqual(model.levelPositions('FirstMens'), { home: [1, 2], away: [1, 2] })
    assert.deepStrictEqual(model.levelPositions('SecondMens'), { home: [3, 4], away: [3, 4] })
    assert.deepStrictEqual(model.levelPositions('ThirdMens'), { home: [1, 2], away: [3, 4] })
    assert.deepStrictEqual(model.levelPositions('FourthMens'), { home: [3, 4], away: [1, 2] })
    assert.deepStrictEqual(model.levelPositions('FirstLadies'), { home: [1, 2], away: [1, 2] })
    assert.strictEqual(model.levelPositions('FirstMixed'), null)
    assert.strictEqual(model.levelPositions(null), null)
  })

  it('agrees with RUBBERS on every level event', () => {
    const home = side(100), away = side(200)
    for (const r of model.RUBBERS.filter(x => !x.mixed)) {
      const at = model.levelPositions(r.type)
      const pos = (l, p) => (l.men.includes(p) ? l.men.indexOf(p) : l.ladies.indexOf(p)) + 1
      assert.deepStrictEqual(r.home(home).map(p => pos(home, p)), at.home, r.type)
      assert.deepStrictEqual(r.away(away).map(p => pos(away, p)), at.away, r.type)
    }
  })
})

// The block the public event pages read. What matters most is what is NOT in it.
describe('the public forecast', () => {
  const named = (id, name, s) => ({ id, name, s, se: 0.1, mx: 0 })
  const lineup = (base, s) => ({
    men: [1, 2, 3, 4].map(i => named(base + i, `Mister ${base + i}`, s - 0.03 * i)),
    ladies: [5, 6].map(i => named(base + i, `Miss ${base + i}`, s - 0.03 * i)),
  })
  const lineups = new Map([[1, lineup(9100, 0.3)], [2, lineup(9200, -0.2)], [3, lineup(9300, 0)]])

  it('splits a fixture into 8 men\'s, 2 ladies\' and 8 mixed games', () => {
    assert.deepStrictEqual(model.CATEGORY_GAMES, { mens: 8, ladies: 2, mixed: 8 })
    const fc = model.publicForecast(model.predictFixture(lineups.get(1), lineups.get(2), 0.02))
    assert.ok(Math.abs(fc.pHome + fc.pDraw + fc.pAway - 1) < 0.01)
    assert.ok(fc.pHome > fc.pAway)
    assert.strictEqual(fc.likely.home + fc.likely.away, 18)
    assert.ok(Math.abs(fc.edges.mens + fc.edges.ladies + fc.edges.mixed - fc.expected) < 0.05)
    assert.ok(fc.edges.mens > 4 && fc.edges.mens <= 8 && fc.edges.ladies <= 2)
  })

  it('ranks each team\'s squad within its division and says how settled its line-up has been', () => {
    const teams = [{ id: 1, divisionId: 7 }, { id: 2, divisionId: 7 }, { id: 3, divisionId: 7 }]
    const all = base => new Set([1, 2, 3, 4, 5, 6].map(i => base + i))
    const played = new Map([
      [1, new Map([[50, { t: 1, players: all(9100) }]])],
      [2, new Map([[51, { t: 2, players: new Set([9201, 9202, 9203, 777, 778, 779]) }], [50, { t: 1, players: all(9200) }]])],
    ])
    const projection = [{ teams: [{ id: 1, expectedPosition: 1.2, pWinner: 0.8, pUp: 0, pDown: 0 }, { id: 2, expectedPosition: 2.9, pWinner: 0, pUp: 0, pDown: 0.6 }, { id: 3, expectedPosition: 2, pWinner: 0.2, pUp: 0, pDown: 0.4 }] }]
    const out = model.publicTeams(teams, lineups, played, projection)
    assert.deepStrictEqual({ ...out[1], projection: undefined }, { teams: 3, men: 1, ladies: 1, overall: 1, fixtures: 1, settled: 1, last: 6, projection: undefined })
    assert.strictEqual(out[1].projection.pWinner, 0.8)
    assert.deepStrictEqual([out[2].overall, out[2].fixtures, out[2].settled, out[2].last], [3, 2, 0.75, 3])
    assert.deepStrictEqual([out[3].overall, out[3].fixtures, out[3].settled, out[3].last], [2, 0, null, null])
  })

  it('carries no player\'s name and no player\'s id', () => {
    const teams = [{ id: 1, divisionId: 7 }, { id: 2, divisionId: 7 }]
    const played = new Map([[1, new Map([[50, { t: 1, players: new Set([9101, 9105]) }]])]])
    const block = JSON.stringify({
      fixture: model.publicForecast(model.predictFixture(lineups.get(1), lineups.get(2), 0)),
      teams: model.publicTeams(teams, lineups, played, []),
    })
    assert.doesNotMatch(block, /Mister|Miss/)
    assert.doesNotMatch(block, /9[123]0\d/)
  })
})
