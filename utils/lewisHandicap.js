// The Lewis Shield handicap: how many points to add to one side's total so the tie is even.
//
// The Lewis Shield is decided on POINTS, not games: every rally point of the 18 games is
// added up for each side, the handicap is added to one side's total, and the higher total
// wins. (Manchester Edgeley A beat College Green A 13-5 on 2 Sep 2026, 351-285 on points;
// with 70 to College Green they would have won 355-351.) The Lewis secretary has always set
// it by judgement. This gives a starting figure from the team-strength rating
// (utils/teamStrength.js), whose model is already per rally: every rally of a game is won by
// the home pair with probability p, so the points each side scores in a game to 21 (two
// clear, capped at 30) follow from p exactly.
//
// The handicap is the MEDIAN of the points margin, not its mean: with it, each side is as
// likely as the other to win. The margin is summed over the 18 games (independent given p)
// and over the fixture's own swing (SETTINGS.fixtureSd, Gauss-Hermite, as predictFixture
// does), each node a normal with the summed mean and variance. tools/strength-backtest.js
// --points checks that on real league fixtures. Pure functions; no I/O.

const model = require('./teamStrength')

// Per game, from P(home wins a rally): the expected home-minus-away points margin and its
// variance, by the same exact recursion as model.gameWin, tabulated once.
const gameMargin = (() => {
  const N = 1001, mean = new Float64Array(N), sq = new Float64Array(N)
  const done = (x, y) => (x >= 21 && x - y >= 2) || x === 30
  for (let i = 0; i < N; i++) {
    const p = i / (N - 1)
    const P = Array.from({ length: 31 }, () => new Float64Array(31))
    P[0][0] = 1
    let m = 0, m2 = 0
    for (let a = 0; a <= 30; a++) for (let b = 0; b <= 30; b++) {
      const pr = P[a][b]
      if (!pr) continue
      if (done(a, b) || done(b, a)) { m += pr * (a - b); m2 += pr * (a - b) ** 2; continue }
      if (a < 30) P[a + 1][b] += pr * p
      if (b < 30) P[a][b + 1] += pr * (1 - p)
    }
    mean[i] = m; sq[i] = m2
  }
  const at = (table, p) => {
    const x = Math.min(Math.max(p, 0), 1) * (N - 1), i = Math.min(Math.floor(x), N - 2), f = x - i
    return table[i] * (1 - f) + table[i + 1] * f
  }
  return p => { const m = at(mean, p); return { mean: m, variance: Math.max(at(sq, p) - m * m, 0) } }
})()

// Same nodes as utils/teamStrength.js fixtureDistribution.
const SWING_NODES = [-2.857, -1.356, 0, 1.356, 2.857]
const SWING_WEIGHTS = (w => w.map(v => v / w.reduce((a, b) => a + b, 0)))([0.0113, 0.2221, 0.5333, 0.2221, 0.0113])

// Normal CDF, Abramowitz-Stegun 26.2.17 (error < 1e-7).
function Phi(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x))
  const d = 0.3989422804014327 * Math.exp(-x * x / 2)
  const q = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  return x >= 0 ? 1 - q : q
}

// The fixture's points margin (home minus away, all 18 games) as a mixture of normals, one
// per swing node: [{ w, mean, sd }]. `home`/`away` are lineups as predictFixture takes them.
function marginMixture(home, away, homeEdge, fixtureSd = model.SETTINGS.fixtureSd) {
  return SWING_NODES.map((z, i) => {
    let mean = 0, variance = 0
    model.RUBBERS.forEach(r => {
      const [h1, h2] = r.home(home), [a1, a2] = r.away(away)
      let x = h1.s + h2.s - a1.s - a2.s + homeEdge + fixtureSd * z
      if (r.mixed) x += h1.mx + h2.mx - a1.mx - a2.mx
      const g = gameMargin(model.sig(x))
      mean += model.GAMES_PER_RUBBER * g.mean
      variance += model.GAMES_PER_RUBBER * g.variance
    })
    return { w: SWING_WEIGHTS[i], mean, sd: Math.sqrt(variance) }
  })
}

// P(home's total + `homeExtra` beats away's), from the mixture. A tie on points is left in
// the middle (counted half), which the continuous approximation does anyway.
const pHomeWins = (mix, homeExtra = 0) => mix.reduce((a, c) => a + c.w * Phi((c.mean + homeExtra) / c.sd), 0)

// The points `homeExtra` that makes the tie even: the margin's median, negated. Bisection
// over a range far wider than any real margin.
function evenAt(mix) {
  let lo = -400, hi = 400
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (pHomeWins(mix, mid) < 0.5) lo = mid; else hi = mid
  }
  return (lo + hi) / 2
}

/**
 * The handicap for one tie.
 * @returns {{ to: 'home'|'away'|null, points: number, expectedMargin: number, sd: number,
 *   pHome: number, pHomeWithHandicap: (homeExtra: number) => number }}
 * `to`: the side that gets the points (null when they round to 0). `expectedMargin`: home
 * minus away before the handicap. `pHome`: P(home wins with no handicap). `sd` is the
 * spread of the margin, for "how much does it matter".
 */
function handicap(home, away, homeEdge, fixtureSd) {
  const mix = marginMixture(home, away, homeEdge, fixtureSd)
  const extra = Math.round(evenAt(mix))
  const mean = mix.reduce((a, c) => a + c.w * c.mean, 0)
  const variance = mix.reduce((a, c) => a + c.w * (c.sd ** 2 + c.mean ** 2), 0) - mean ** 2
  return {
    to: extra > 0 ? 'home' : extra < 0 ? 'away' : null,
    points: Math.abs(extra),
    expectedMargin: mean,
    sd: Math.sqrt(variance),
    pHome: pHomeWins(mix, 0),
    pHomeWith: homeExtra => pHomeWins(mix, homeExtra),
  }
}

// ---------------------------------------------------------------------------
// Line-ups from the nightly run
//
// The pages read the latest strength_run payload (controllers/teamStrengthController.js
// build) rather than refitting: `teams[]` carries every registered player's rating (`r`, on
// the display scale), mixed offset (x1000) and each team's usual four men and two ladies,
// and `home` / `divisionMeans` the rest. Rounding to the display scale costs nothing that
// shows: a point of display is 0.1% of a rally.

const fromDisplay = r => (r - 1500) / 1000

// The division's average player, as an unrated player or an empty slot gets.
function averageOf(payload, divisionRank, key) {
  const d = (payload.divisionMeans || []).find(x => Number(x.rank) === Number(divisionRank))
  return d ? fromDisplay(d[key]) : 0
}

const slotOf = (payload, team, key) => p => ({
  id: Number(p.id), name: p.name, team: team.name,
  s: p.r == null ? averageOf(payload, team.divisionRank, key) : fromDisplay(p.r),
  mx: (p.mixed || 0) / 1000, rated: p.r != null, games: p.games || 0,
})

const averageSlot = (payload, team, key, i) => ({
  id: null, name: `(average ${key === 'men' ? 'man' : 'lady'})`, team: team.name,
  s: averageOf(payload, team.divisionRank, key), mx: 0, rated: false, games: 0,
})

/**
 * Everyone a team could field, from the run: its club's players on every team, own team
 * first. `{ team, men: Slot[], ladies: Slot[] }`, or null when the run has no such team.
 */
function clubPlayers(payload, teamId) {
  const teams = (payload && payload.teams) || []
  const team = teams.find(t => Number(t.id) === Number(teamId))
  if (!team) return null
  const club = teams.filter(t => t.club === team.club)
    .sort((a, b) => (Number(a.id) === Number(teamId) ? -1 : Number(b.id) === Number(teamId) ? 1 : a.name.localeCompare(b.name)))
  const out = { team, men: [], ladies: [] }
  for (const t of club) for (const key of ['men', 'ladies']) out[key].push(...(t[key] || []).map(slotOf(payload, t, key)))
  return out
}

/**
 * A team's line-up for the handicap: `picks` = { men: [id x4], ladies: [id x2] } in card
 * order (man 1 and 2 play Open A), where an id that is missing, 0 or not one of the club's
 * players is the division's average player. Without `picks`, the usual side from the run.
 * Returns { men, ladies } as utils/teamStrength.js predictFixture takes them, or null.
 */
function lineupFor(payload, teamId, picks) {
  const club = clubPlayers(payload, teamId)
  if (!club) return null
  const { team } = club
  const ids = picks || { men: (team.usual && team.usual.men) || [], ladies: (team.usual && team.usual.ladies) || [] }
  const out = {}
  for (const key of ['men', 'ladies']) {
    const n = model.SIDE[key]
    out[key] = []
    for (let i = 0; i < n; i++) {
      const id = Number(ids[key] && ids[key][i])
      out[key].push((id && club[key].find(p => p.id === id)) || averageSlot(payload, team, key, i))
    }
  }
  return out
}

/** The handicap for a tie from the run's payload, or null when either team is not in it. */
function forTie(payload, homeId, awayId, picks = {}) {
  const home = lineupFor(payload, homeId, picks.home), away = lineupFor(payload, awayId, picks.away)
  if (!home || !away) return null
  const homeEdge = (payload.home || 0) / 1000
  const fixtureSd = (payload.settings && payload.settings.fixtureSd) || model.SETTINGS.fixtureSd
  return { home, away, ...handicap(home, away, homeEdge, fixtureSd), rubbers: rubberMargins(home, away, homeEdge) }
}

// Where the points come from: each of the nine rubbers' expected margin per game (home
// minus away), with no swing. Only for showing; the handicap integrates the swing.
function rubberMargins(home, away, homeEdge) {
  return model.RUBBERS.map(r => {
    const [h1, h2] = r.home(home), [a1, a2] = r.away(away)
    let x = h1.s + h2.s - a1.s - a2.s + homeEdge
    if (r.mixed) x += h1.mx + h2.mx - a1.mx - a2.mx
    return { card: r.card, home: [h1.name, h2.name], away: [a1.name, a2.name], margin: gameMargin(model.sig(x)).mean }
  })
}

module.exports = { gameMargin, marginMixture, pHomeWins, evenAt, handicap, Phi, clubPlayers, lineupFor, forTie, rubberMargins }
