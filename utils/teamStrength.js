// Team strength: a points-based doubles rating, fitted to every game on record.
//
// Ported from Stockport (league-site e9ea24b, d5d0149, db9bc17; utils/teamStrength.js) and
// reworked for a Tameside side: FOUR men and TWO ladies, not three and three. Pure
// functions; models/teamStrength.js loads and stores, controllers/teamStrengthController.js
// joins the two, and tools/strength-backtest.js is how every setting below was chosen.
//
// ## The model
//
// Every rally of a game is won by the home pair with probability
//
//   p = sigmoid(s_h1 + s_h2 - s_a1 - s_a2 + home [+ the four players' mixed offsets])
//
// so a 21-15 game is 36 observations, not one win. The strengths are fitted over the whole
// history at once by penalised maximum likelihood, each game weighted by its age. Fitting
// everything together is what compares the two divisions: a reserve playing up, a promoted
// team, a player moving club all link one to the other, and the fit carries those links
// through everyone they played. The ELO's fixed DIVISION_RANK_POINTS is what this replaces.
// Men's and ladies' strengths are on separate scales: mixed games pin each down only
// relative to its own gender, so a man is only ever compared with a man.
//
// ## What is different from Stockport's
//
// - The side and the card. RUBBERS below is our nine events (see utils/scorecardMatch.js
//   SLOT_EVENTS and the game rows fixtureController writes), and Open C and Open D pit one
//   side's top pair against the other's bottom pair, so a rubber picks per side.
// - The history. Our game rows start in September 2024 (Stockport's in 2018), so every
//   setting was re-chosen by tools/strength-backtest.js on our own seasons, tuned on
//   2025/26 and reported on 2026/27, which the tuning never saw. Their numbers (75.3%
//   against the ELO's 71.2%) are not ours and are not quoted as ours.
// - Lewis Shield games and player 0 ("No Player") are left out: a cup tie between
//   divisions plays to different stakes, and player 0 is a short side, not a person.

const DAY = 86400000

// Chosen by tools/strength-backtest.js — see docs/team-strength.md for the numbers. Change
// one only with a backtest run before and after.
const SETTINGS = Object.freeze({
  halfLifeDays: 365, // a game a year old counts half
  tau: 0.3,          // how far a player may sit from their division's average
  mixedSd: 0.15,     // how different a player may be at mixed
  iters: 200,
  // A fixture's own swing, on top of the players' strengths: who turned up, the hall, the
  // night. Without it the 18 games are independent and a fixture's score varies far less
  // than real ones do.
  fixtureSd: 0.2,
  // A team's form over the rest of a season, for the season projection (backlog row 8).
  formSd: 0.1,
})

// The display scale: 1500 plus 1000 per unit of strength. 100 points between two players in
// the same pair is 52.5% of rallies, or about 63% of games.
const display = s => Math.round(1500 + 1000 * s)

const sig = x => 1 / (1 + Math.exp(-x))

const HOME_VAR = 0.1 * 0.1

// P(winning a rally-point game to 21, two clear, capped at 30) from P(winning a rally).
const gameWin = (() => {
  const N = 2001, table = new Float64Array(N)
  const done = (x, y) => (x >= 21 && x - y >= 2) || x === 30
  for (let i = 0; i < N; i++) {
    const p = i / (N - 1)
    const P = Array.from({ length: 31 }, () => new Float64Array(31))
    P[0][0] = 1
    let win = 0
    for (let a = 0; a <= 30; a++) for (let b = 0; b <= 30; b++) {
      const pr = P[a][b]
      if (!pr) continue
      if (done(a, b)) { win += pr; continue }
      if (done(b, a)) continue
      if (a < 30) P[a + 1][b] += pr * p
      if (b < 30) P[a][b + 1] += pr * (1 - p)
    }
    table[i] = win
  }
  return p => {
    const x = Math.min(Math.max(p, 0), 1) * (N - 1), i = Math.min(Math.floor(x), N - 2), f = x - i
    return table[i] * (1 - f) + table[i + 1] * f
  }
})()

/**
 * @typedef {{ t: number, mixed: boolean, h1: number, h2: number, a1: number, a2: number,
 *   hs: number, as: number }} Game
 */

// Fits the model to `games` as seen at `now`. `divisionOf(id)` is the division rank a
// player was last registered in, `genderOf(id)` their gender: together they give a player
// with few games a starting point at their division's average.
function fit(games, now, genderOf, divisionOf, opts = {}) {
  const o = { ...SETTINGS, ...opts }
  const s = new Map(), m = new Map()
  let home = 0
  const W = games.map(g => Math.pow(0.5, (now - g.t) / (o.halfLifeDays * DAY)))
  for (const g of games) for (const p of [g.h1, g.h2, g.a1, g.a2]) s.set(p, 0)

  const mu = {}
  const muKey = p => `${genderOf(p)}:${divisionOf(p) || 0}`
  const prior = p => mu[muKey(p)] || 0
  const get = (M, k) => M.get(k) || 0
  const lin = g => {
    let x = get(s, g.h1) + get(s, g.h2) - get(s, g.a1) - get(s, g.a2) + home
    if (g.mixed) x += get(m, g.h1) + get(m, g.h2) - get(m, g.a1) - get(m, g.a2)
    return x
  }
  const t2 = o.tau * o.tau, m2 = o.mixedSd * o.mixedSd

  // Block coordinate ascent: a damped diagonal-Newton step on the strengths (and home edge),
  // then on the mixed offsets, each from fresh gradients. One step over both blocks on one
  // gradient overshoots and diverges.
  for (let it = 0; it < o.iters; it++) {
    for (const block of ['s', 'm']) {
      const G = new Map(), H = new Map()
      let gHome = 0, hHome = 0
      const add = (k, gv, hv) => { G.set(k, (G.get(k) || 0) + gv); H.set(k, (H.get(k) || 0) + hv) }
      for (let i = 0; i < games.length; i++) {
        const g = games[i]
        if (block === 'm' && !g.mixed) continue
        const n = g.hs + g.as, q = sig(lin(g))
        const gr = W[i] * (g.hs - n * q), hv = W[i] * n * q * (1 - q)
        add(g.h1, gr, hv); add(g.h2, gr, hv); add(g.a1, -gr, hv); add(g.a2, -gr, hv)
        gHome += gr; hHome += hv
      }
      // Each rally's prediction moves five numbers together (four strengths and the home
      // edge), so a step on the diagonal curvature converges only below 2/5 (Stockport
      // db9bc17: at 0.5 four players meeting over and over oscillated and diverged).
      const STEP = 0.35
      if (block === 's') {
        for (const [p, v] of s) s.set(p, v + STEP * ((G.get(p) || 0) - (v - prior(p)) / t2) / ((H.get(p) || 0) + 1 / t2))
        // A prior on the home edge (sd 0.1): without one, a set of games the home side all
        // won pushes it towards infinity and every strength with it.
        home += STEP * (gHome - home / HOME_VAR) / (hHome + 1 / HOME_VAR)
      } else {
        for (const [p, gv] of G) { const v = get(m, p); m.set(p, v + STEP * (gv - v / m2) / ((H.get(p) || 0) + 1 / m2)) }
      }
    }
    // The division averages, refreshed as the strengths settle, shrunk a little towards 0.
    if (it % 10 === 9) {
      const acc = {}
      for (const [p, v] of s) { const k = muKey(p); acc[k] = acc[k] || [0, 0]; acc[k][0] += v; acc[k][1]++ }
      for (const k in acc) mu[k] = acc[k][0] / (acc[k][1] + 5)
    }
  }

  // A standard error per player, from the curvature at the answer, for "how sure are we".
  const curv = new Map()
  for (let i = 0; i < games.length; i++) {
    const g = games[i], n = g.hs + g.as, q = sig(lin(g)), hv = W[i] * n * q * (1 - q)
    for (const p of [g.h1, g.h2, g.a1, g.a2]) curv.set(p, (curv.get(p) || 0) + hv)
  }
  const se = new Map([...s.keys()].map(p => [p, 1 / Math.sqrt((curv.get(p) || 0) + 1 / t2)]))
  return { s, se, mixed: m, home, mean: (gender, divRank) => mu[`${gender}:${divRank || 0}`] || 0 }
}

// P(the home pair wins one game) under a fit. Used by the backtest, game by game.
function gameProb(f, g) {
  const get = (M, k) => M.get(k) || 0
  let x = get(f.s, g.h1) + get(f.s, g.h2) - get(f.s, g.a1) - get(f.s, g.a2) + f.home
  if (g.mixed) x += get(f.mixed, g.h1) + get(f.mixed, g.h2) - get(f.mixed, g.a1) - get(f.mixed, g.a2)
  return gameWin(sig(x))
}

// ---------------------------------------------------------------------------
// The games

// A real game: four different players, none of them player 0, and a finished score.
// 21-0 is how a walkover is entered, and says nothing about anyone's play.
function usableGame(g) {
  const ps = [g.homePlayer1, g.homePlayer2, g.awayPlayer1, g.awayPlayer2].map(Number)
  if (ps.some(p => !p) || new Set(ps).size < 4) return false
  if (g.homeScore == null || g.awayScore == null) return false
  return Math.max(g.homeScore, g.awayScore) >= 21 && Math.min(g.homeScore, g.awayScore) > 0
}

const GAMES_PER_FIXTURE = 18

// A re-entered scorecard appends another 18 rows to the same fixture (utils/eloChain.js
// latestEntry): only the latest entry is the result. `rows` ordered by date then game id.
function latestEntries(rows) {
  const byFixture = new Map()
  for (const r of rows) {
    const list = byFixture.get(r.fixture) || []
    list.push(r)
    byFixture.set(r.fixture, list)
  }
  const keep = new Set()
  for (const list of byFixture.values()) {
    const ids = list.map(r => Number(r.id)).sort((a, b) => a - b)
    for (const id of ids.slice(-GAMES_PER_FIXTURE)) keep.add(id)
  }
  return rows.filter(r => keep.has(Number(r.id)))
}

// Every usable game the rating is fitted to, oldest first. Each carries the division rank
// each player was registered in that season (`divs`), so a fit at any date can give a
// player their starting point as it was then.
// `rows`: TeamStrength.games(); `regs`: TeamStrength.registrations().
function collectGames(rows, regs) {
  const regDiv = new Map(), gender = new Map()
  for (const r of regs) {
    regDiv.set(`${r.season}:${r.id}`, r.divRank == null ? null : Number(r.divRank))
    if (r.gender) gender.set(Number(r.id), r.gender)
  }
  const games = []
  for (const g of latestEntries(rows)) {
    if (!usableGame(g)) continue
    const ps = [g.homePlayer1, g.homePlayer2, g.awayPlayer1, g.awayPlayer2].map(Number)
    games.push({
      t: new Date(g.date).getTime(), mixed: /Mixed/.test(g.gameType || ''),
      h1: ps[0], h2: ps[1], a1: ps[2], a2: ps[3], hs: Number(g.homeScore), as: Number(g.awayScore),
      divs: ps.map(p => regDiv.get(`${g.season}:${p}`)),
      id: Number(g.id), fixture: Number(g.fixture), type: g.gameType, season: g.season,
      homeTeam: Number(g.homeTeam), awayTeam: Number(g.awayTeam),
    })
  }
  games.sort((a, b) => a.t - b.t)
  return { games, genderOf: p => gender.get(p) || '' }
}

// The rating as it stood at `at`: fitted to the games before it, each player starting from
// the division they were registered in when they last played before it.
function fitAt(input, at, opts = {}) {
  const games = input.games.filter(g => g.t < at)
  const lastDiv = new Map()
  for (const g of games) [g.h1, g.h2, g.a1, g.a2].forEach((p, i) => { if (g.divs[i] != null) lastDiv.set(p, g.divs[i]) })
  return { fit: fit(games, at, input.genderOf, p => lastDiv.get(p), opts), games }
}

// ---------------------------------------------------------------------------
// Fixtures

// A Tameside side: four men and two ladies.
const SIDE = Object.freeze({ men: 4, ladies: 2 })

// The nine events of a fixture, each played twice, as fixtureController writes the game
// rows (card name in the comment). Men are numbered 1-4 and ladies 1-2 within a side; a
// rubber picks per side because Open C and D cross the order.
const RUBBERS = Object.freeze([
  { type: 'FirstMens', card: 'Open A', mixed: false, home: l => [l.men[0], l.men[1]], away: l => [l.men[0], l.men[1]] },
  { type: 'FirstLadies', card: 'Ladies', mixed: false, home: l => [l.ladies[0], l.ladies[1]], away: l => [l.ladies[0], l.ladies[1]] },
  { type: 'SecondMens', card: 'Open B', mixed: false, home: l => [l.men[2], l.men[3]], away: l => [l.men[2], l.men[3]] },
  { type: 'FirstMixed', card: 'Mixed A', mixed: true, home: l => [l.men[0], l.ladies[0]], away: l => [l.men[0], l.ladies[0]] },
  { type: 'SecondMixed', card: 'Mixed B', mixed: true, home: l => [l.men[1], l.ladies[1]], away: l => [l.men[1], l.ladies[1]] },
  { type: 'ThirdMixed', card: 'Mixed C', mixed: true, home: l => [l.men[2], l.ladies[0]], away: l => [l.men[2], l.ladies[0]] },
  { type: 'FourthMixed', card: 'Mixed D', mixed: true, home: l => [l.men[3], l.ladies[1]], away: l => [l.men[3], l.ladies[1]] },
  { type: 'ThirdMens', card: 'Open C', mixed: false, home: l => [l.men[0], l.men[1]], away: l => [l.men[2], l.men[3]] },
  { type: 'FourthMens', card: 'Open D', mixed: false, home: l => [l.men[2], l.men[3]], away: l => [l.men[0], l.men[1]] },
])
const GAMES_PER_RUBBER = 2

/**
 * A player as the predictions see them: a strength and a mixed offset.
 * @typedef {{ id: number | null, name: string, s: number, mx: number }} Slot
 * @typedef {{ men: Slot[], ladies: Slot[] }} Lineup  men[0..3], ladies[0..1]
 */

// P(home wins each of the nine rubbers' games), with the home advantage the fit found and
// `swing`, this fixture's own shift towards the home side.
function rubberProbs(home, away, homeEdge, swing = 0) {
  return RUBBERS.map(r => {
    const [h1, h2] = r.home(home), [a1, a2] = r.away(away)
    let x = h1.s + h2.s - a1.s - a2.s + homeEdge + swing
    if (r.mixed) x += h1.mx + h2.mx - a1.mx - a2.mx
    return gameWin(sig(x))
  })
}

// The fixture's score distribution: P(home wins k of the 18 games), k = 0..18.
function scoreDistribution(probs) {
  let dist = [1]
  for (const q of probs) for (let g = 0; g < GAMES_PER_RUBBER; g++) {
    const next = new Array(dist.length + 1).fill(0)
    dist.forEach((v, k) => { next[k] += v * (1 - q); next[k + 1] += v * q })
    dist = next
  }
  return dist
}

// Gauss-Hermite nodes and weights for a standard normal: the fixture's swing, integrated.
const SWING_NODES = [-2.857, -1.356, 0, 1.356, 2.857]
const SWING_WEIGHTS = (w => w.map(v => v / w.reduce((a, b) => a + b, 0)))([0.0113, 0.2221, 0.5333, 0.2221, 0.0113])

// The score distribution with the fixture's swing integrated out.
function fixtureDistribution(home, away, homeEdge, fixtureSd = SETTINGS.fixtureSd) {
  const dist = new Array(GAMES_PER_RUBBER * RUBBERS.length + 1).fill(0)
  SWING_NODES.forEach((z, i) => {
    scoreDistribution(rubberProbs(home, away, homeEdge, fixtureSd * z)).forEach((v, k) => { dist[k] += SWING_WEIGHTS[i] * v })
  })
  return dist
}

function predictFixture(home, away, homeEdge, fixtureSd = SETTINGS.fixtureSd) {
  const probs = rubberProbs(home, away, homeEdge)
  const dist = fixtureDistribution(home, away, homeEdge, fixtureSd)
  const total = dist.length - 1, half = total / 2
  const likely = dist.indexOf(Math.max(...dist))
  return {
    pHome: dist.reduce((a, v, k) => a + (k > half ? v : 0), 0),
    pDraw: dist[half] || 0,
    pAway: dist.reduce((a, v, k) => a + (k < half ? v : 0), 0),
    expected: dist.reduce((a, v, k) => a + v * k, 0),
    likely: { home: likely, away: total - likely },
    dist,
    rubbers: RUBBERS.map((r, i) => ({
      type: r.type, card: r.card, home: r.home(home).map(p => p.name), away: r.away(away).map(p => p.name), p: probs[i],
    })),
  }
}

// The players of one gender a team is expected to field (`n`: 4 men or 2 ladies): whoever
// has played most for it this season, then its nominated players in order, then its
// reserves. Paired strongest first, as teams mostly do. Stockport found the usual players
// predict far better than the nominated ones (d5d0149); tools/strength-backtest.js
// measures the same on ours.
function usualPlayers(n, nominated, reserves, played) {
  const regulars = [...played].sort((a, b) => b.fixtures - a.fixtures || b.slot.s - a.slot.s).map(x => x.slot)
  const out = []
  const seen = new Set()
  for (const p of [...regulars, ...nominated, ...reserves]) {
    if (out.length === n) break
    if (seen.has(p.id)) continue
    seen.add(p.id)
    out.push(p)
  }
  return out.sort((a, b) => b.s - a.s)
}

module.exports = {
  SETTINGS, SIDE, RUBBERS, GAMES_PER_RUBBER, DAY,
  display, sig, gameWin, fit, gameProb, usableGame, latestEntries, collectGames, fitAt,
  rubberProbs, scoreDistribution, fixtureDistribution, predictFixture, usualPlayers,
}
