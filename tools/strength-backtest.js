#!/usr/bin/env node
//
// Walk-forward backtest of the team-strength rating (utils/teamStrength.js) on our own
// results. Read-only: it runs two SELECTs and writes nothing.
//
//   node tools/strength-backtest.js            # the report: defaults, tuned on 2025/26,
//                                              # reported on 2026/27, against the ELO
//   node tools/strength-backtest.js --tune     # also searches the fit settings and the
//                                              # fixture swing on the tuning season
//   node tools/strength-backtest.js --json out.json
//   node tools/strength-backtest.js --points   # the Lewis Shield handicap instead
//                                              # (utils/lewisHandicap.js): league fixtures'
//                                              # points margins against the prediction
//
// Every Monday the rating is refitted to the games before it and predicts that week's
// games, exactly as the nightly run would have. Nothing about a game is known to the fit
// that predicts it.
//
// The split matters. Stockport's 75.3% (league-site e9ea24b) came from no committed tool,
// and its test season overlapped the one used to size the model. Here every setting is
// chosen on TUNE and the numbers that count are on TEST, which the choice never saw:
//
//   TUNE  2025/26  (fits from Sep 2024 onwards)
//   TEST  2026/27 to date
//   (2024/25 from January is shown for interest: four months of history at most.)
//
// The ELO comparison uses the ratings stored on each game row (homePlayer1Start…), i.e.
// what the ELO actually believed going in. Its probability is the logistic on the pair
// averages, as models/game.js calculateRating, without the division-rank offset (zero
// whenever all four play in the fixture's division).
//
// Fixtures are predicted twice: from the players who actually played (how good is the
// model given the lineup) and from each team's USUAL players at that date — who has played
// most for it so far this season, then last season — which is what a prediction made in
// advance has to use.

require('dotenv').config()
const fs = require('fs')
const model = require('../utils/teamStrength')
const lewisHandicap = require('../utils/lewisHandicap')
const TeamStrength = require('../models/teamStrength')
const seasonModel = require('../models/season')
const { sql } = require('../utils/db_connect')

const args = process.argv.slice(2)
const TUNE = args.includes('--tune')
const POINTS = args.includes('--points')
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null

const PERIODS = [
  { key: 'early', label: '2024/25 from Jan', season: '20242025', from: new Date(2025, 0, 1).getTime() },
  { key: 'tune', label: 'TUNE 2025/26', season: '20252026' },
  { key: 'test', label: 'TEST 2026/27', season: '20262027' },
]

const LEVEL_SLOTS = {
  FirstMens: ['men', 0, 1], SecondMens: ['men', 2, 3], FirstLadies: ['ladies', 0, 1],
}

function mondayOf(ms) {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return d.getTime()
}
const nextMonday = m => { const d = new Date(m); d.setDate(d.getDate() + 7); return d.getTime() }

const eloProb = r => {
  const h = (Number(r.homePlayer1Start) + Number(r.homePlayer2Start)) / 2
  const a = (Number(r.awayPlayer1Start) + Number(r.awayPlayer2Start)) / 2
  return 1 / (1 + Math.pow(10, (a - h) / 400))
}
const hasElo = r => [r.homePlayer1Start, r.homePlayer2Start, r.awayPlayer1Start, r.awayPlayer2Start].every(v => Number(v) > 0)

const clamp = p => Math.min(Math.max(p, 1e-6), 1 - 1e-6)
const pct = x => `${(100 * x).toFixed(1)}%`

async function load() {
  await seasonModel.init()
  const [rows, regs, teamDivs] = await Promise.all([TeamStrength.games(), TeamStrength.registrations(), TeamStrength.teamDivisions()])
  await sql.end()
  return { rows, regs, teamDivs }
}

function prepare({ rows, regs, teamDivs }) {
  const input = model.collectGames(rows, regs)
  const latest = model.latestEntries(rows)
  const rowById = new Map(latest.map(r => [Number(r.id), r]))
  const teamDiv = new Map(teamDivs.map(t => [`${t.season}:${t.id}`, t.divRank]))

  // Fixtures, with their rows, actual lineups and actual score.
  const fixtures = new Map()
  for (const r of latest) {
    const id = Number(r.fixture)
    if (!fixtures.has(id)) {
      fixtures.set(id, {
        id, t: new Date(r.date).getTime(), season: r.season, home: Number(r.homeTeam), away: Number(r.awayTeam),
        hs: r.fixtureHomeScore == null ? null : Number(r.fixtureHomeScore), as: r.fixtureAwayScore == null ? null : Number(r.fixtureAwayScore),
        rows: [], lineup: { home: { men: [], ladies: [] }, away: { men: [], ladies: [] } },
      })
    }
    const f = fixtures.get(id)
    f.rows.push(r)
    const at = LEVEL_SLOTS[r.gameType]
    if (at) {
      const [g, i, j] = at
      f.lineup.home[g][i] = Number(r.homePlayer1); f.lineup.home[g][j] = Number(r.homePlayer2)
      f.lineup.away[g][i] = Number(r.awayPlayer1); f.lineup.away[g][j] = Number(r.awayPlayer2)
    }
  }
  // The fixture's own score when it has one, else counted from its games.
  for (const f of fixtures.values()) {
    if (f.hs == null || f.hs + f.as !== 18) {
      f.hs = f.rows.filter(r => Number(r.homeScore) > Number(r.awayScore)).length
      f.as = f.rows.length - f.hs
    }
  }
  // Appearances: team → season → player → fixtures.
  const apps = new Map()
  for (const f of fixtures.values()) {
    for (const side of ['home', 'away']) {
      const key = `${f[side]}:${f.season}`
      const m = apps.get(key) || []
      for (const p of [...f.lineup[side].men, ...f.lineup[side].ladies]) if (p) m.push({ p, t: f.t, fixture: f.id })
      apps.set(key, m)
    }
  }
  return { input, rowById, fixtures: [...fixtures.values()].sort((a, b) => a.t - b.t), teamDiv, apps }
}

const seasons = ['20232024', '20242025', '20252026', '20262027']
const prevSeason = s => seasons[seasons.indexOf(s) - 1]

// The usual n players of a gender for a team at time `at`: most fixtures this season so
// far, then last season, as of `at`.
function usual(data, team, season, gender, n, at) {
  const out = []
  for (const s of [season, prevSeason(season)]) {
    if (!s) continue
    const counts = new Map()
    for (const a of data.apps.get(`${team}:${s}`) || []) {
      if (a.t >= at || data.input.genderOf(a.p) !== gender) continue
      counts.set(a.p, (counts.get(a.p) || 0) + 1)
    }
    for (const [p] of [...counts].sort((x, y) => y[1] - x[1])) {
      if (out.length < n && !out.includes(p)) out.push(p)
    }
  }
  return out
}

function slotsFor(fit, data, ids, gender, n, divRank) {
  const out = ids.slice(0, n).map(p => ({ id: p, name: String(p), s: fit.s.has(p) ? fit.s.get(p) : fit.mean(gender, divRank), mx: fit.mixed.get(p) || 0 }))
  while (out.length < n) out.push({ id: null, name: '-', s: fit.mean(gender, divRank), mx: 0 })
  return out
}

function lineupOf(fit, data, f, side, kind) {
  const team = f[side], divRank = data.teamDiv.get(`${f.season}:${team}`) || 0
  const pick = (gender, key, n) => {
    if (kind === 'actual') {
      const ids = []
      for (let i = 0; i < n; i++) ids.push(f.lineup[side][key][i] || null)
      return ids.map(p => (p ? { id: p, name: String(p), s: fit.s.has(p) ? fit.s.get(p) : fit.mean(gender, divRank), mx: fit.mixed.get(p) || 0 }
        : { id: null, name: '-', s: fit.mean(gender, divRank), mx: 0 }))
    }
    const ids = usual(data, team, f.season, gender, n, mondayOf(f.t))
    return slotsFor(fit, data, ids, gender, n, divRank).sort((a, b) => b.s - a.s)
  }
  return { men: pick('Male', 'men', 4), ladies: pick('Female', 'ladies', 2) }
}

// One walk forward: refit every Monday, predict the week. Returns per-game and per-fixture
// predictions for the weeks in `periods`.
function walk(data, opts, { fixtureSds = [model.SETTINGS.fixtureSd] } = {}) {
  const inPeriod = (season, t) => PERIODS.find(p => p.season === season && (!p.from || t >= p.from))
  const games = [], fixtures = []
  const targets = data.input.games.filter(g => inPeriod(g.season, g.t))
  if (!targets.length) return { games, fixtures }
  const weeks = [...new Set(targets.map(g => mondayOf(g.t)))].sort((a, b) => a - b)
  for (const m of weeks) {
    const end = nextMonday(m)
    const { fit } = model.fitAt(data.input, m, opts)
    for (const g of targets) {
      if (g.t < m || g.t >= end) continue
      const r = data.rowById.get(g.id)
      games.push({ period: inPeriod(g.season, g.t).key, p: model.gameProb(fit, g), won: g.hs > g.as,
        elo: r && hasElo(r) ? eloProb(r) : null, home: 1 })
    }
    for (const f of data.fixtures) {
      if (f.t < m || f.t >= end || !inPeriod(f.season, f.t)) continue
      const out = { period: inPeriod(f.season, f.t).key, hs: f.hs, as: f.as, by: {} }
      for (const kind of ['actual', 'usual']) {
        const home = lineupOf(fit, data, f, 'home', kind), away = lineupOf(fit, data, f, 'away', kind)
        out.by[kind] = {}
        for (const sd of fixtureSds) {
          const dist = model.fixtureDistribution(home, away, fit.home, sd)
          out.by[kind][sd] = dist
        }
      }
      // The ELO's fixture call: its game probabilities summed, actual players.
      const rows = f.rows.filter(hasElo)
      out.eloExpected = rows.length === f.rows.length ? rows.reduce((a, r) => a + eloProb(r), 0) : null
      fixtures.push(out)
    }
  }
  return { games, fixtures }
}

function gameMetrics(list, key = 'p') {
  const xs = list.filter(x => x[key] != null)
  if (!xs.length) return null
  let right = 0, ll = 0, brier = 0
  for (const x of xs) {
    const p = clamp(x[key])
    if ((p > 0.5) === x.won) right++
    ll += -(x.won ? Math.log(p) : Math.log(1 - p))
    brier += (p - (x.won ? 1 : 0)) ** 2
  }
  return { n: xs.length, acc: right / xs.length, logLoss: ll / xs.length, brier: brier / xs.length }
}

const outcome = (h, a) => (h > a ? 'H' : h < a ? 'A' : 'D')
function fixtureMetrics(list, kind, sd) {
  if (!list.length) return null
  let right = 0, ll = 0, abs = 0, sq = 0, pit = []
  for (const f of list) {
    const dist = f.by[kind][sd]
    const pH = dist.reduce((a, v, k) => a + (k > 9 ? v : 0), 0), pA = dist.reduce((a, v, k) => a + (k < 9 ? v : 0), 0), pD = dist[9]
    const call = pH >= pA && pH >= pD ? 'H' : pA >= pD ? 'A' : 'D'
    if (call === outcome(f.hs, f.as)) right++
    ll += -Math.log(Math.max(dist[f.hs], 1e-9))
    const e = dist.reduce((a, v, k) => a + v * k, 0)
    const v = dist.reduce((a, p, k) => a + p * (k - e) ** 2, 0)
    abs += Math.abs(f.hs - e); sq += (f.hs - e) ** 2 / v
  }
  return { n: list.length, acc: right / list.length, scoreLL: ll / list.length, mae: abs / list.length, z2: sq / list.length }
}
function eloFixtureMetrics(list) {
  const xs = list.filter(f => f.eloExpected != null)
  if (!xs.length) return null
  let right = 0, abs = 0
  for (const f of xs) {
    const call = f.eloExpected > 9.5 ? 'H' : f.eloExpected < 8.5 ? 'A' : 'D'
    if (call === outcome(f.hs, f.as)) right++
    abs += Math.abs(f.hs - f.eloExpected)
  }
  return { n: xs.length, acc: right / xs.length, mae: abs / xs.length }
}

// The ELO rescaled: P = sigmoid(a + b * logit(P_elo)), a and b fitted on TUNE only, so its
// log loss is not penalised merely for being on the wrong scale. Winners called are
// unchanged unless the intercept moves a game across 50%.
function calibrateElo(res) {
  const xs = res.games.filter(g => g.period === 'tune' && g.elo != null)
  const logit = p => Math.log(clamp(p) / (1 - clamp(p)))
  let best = { a: 0, b: 1, ll: Infinity }
  for (let b = 0.5; b <= 2.5; b += 0.05) for (let a = -0.4; a <= 0.4; a += 0.02) {
    let ll = 0
    for (const g of xs) { const p = clamp(model.sig(a + b * logit(g.elo))); ll -= g.won ? Math.log(p) : Math.log(1 - p) }
    if (ll < best.ll) best = { a, b, ll }
  }
  for (const g of res.games) if (g.elo != null) g.eloCal = model.sig(best.a + best.b * logit(g.elo))
  return { a: +best.a.toFixed(2), b: +best.b.toFixed(2) }
}

// Where the two disagree on the winner, who was right (McNemar's test on the pairs).
function paired(list) {
  let modelOnly = 0, eloOnly = 0
  for (const g of list) {
    const m = (g.p > 0.5) === g.won, e = (g.elo > 0.5) === g.won
    if (m && !e) modelOnly++
    if (e && !m) eloOnly++
  }
  const n = modelOnly + eloOnly
  return { modelOnly, eloOnly, z: n ? (modelOnly - eloOnly) / Math.sqrt(n) : 0 }
}

function report(res, sds) {
  const out = {}
  for (const p of PERIODS) {
    const games = res.games.filter(g => g.period === p.key), fx = res.fixtures.filter(f => f.period === p.key)
    const withElo = games.filter(g => g.elo != null)
    out[p.key] = {
      label: p.label,
      games: { model: gameMetrics(games), modelOnEloGames: gameMetrics(withElo), elo: gameMetrics(withElo, 'elo'), eloCalibrated: gameMetrics(withElo, 'eloCal'), paired: paired(withElo),
        homeAlways: gameMetrics(games, 'home') },
      fixtures: { elo: eloFixtureMetrics(fx) },
    }
    for (const kind of ['actual', 'usual']) for (const sd of sds) out[p.key].fixtures[`${kind}@${sd}`] = fixtureMetrics(fx, kind, sd)
  }
  return out
}

function print(rep) {
  for (const k of Object.keys(rep)) {
    const r = rep[k]
    console.log(`\n== ${r.label}`)
    const g = r.games
    if (g.model) {
      console.log(`  games ${g.model.n}: model ${pct(g.model.acc)} right, log loss ${g.model.logLoss.toFixed(4)}, Brier ${g.model.brier.toFixed(4)}`)
      if (g.elo) {
        console.log(`  same ${g.elo.n} games with an ELO: model ${pct(g.modelOnEloGames.acc)} (LL ${g.modelOnEloGames.logLoss.toFixed(4)}) vs ELO ${pct(g.elo.acc)} (LL ${g.elo.logLoss.toFixed(4)}; rescaled ${pct(g.eloCalibrated.acc)}, LL ${g.eloCalibrated.logLoss.toFixed(4)})`)
        console.log(`  where they disagree: model right ${g.paired.modelOnly}, ELO right ${g.paired.eloOnly} (z ${g.paired.z.toFixed(1)})`)
      }
      console.log(`  "home always wins": ${pct(g.homeAlways.acc)}`)
    }
    for (const [name, m] of Object.entries(r.fixtures)) {
      if (!m) continue
      const extra = m.scoreLL != null ? `, score log-lik ${(-m.scoreLL).toFixed(3)}, z² ${m.z2.toFixed(2)}` : ''
      console.log(`  fixtures ${name.padEnd(12)} n=${m.n}: result ${pct(m.acc)}, MAE ${m.mae.toFixed(2)} games${extra}`)
    }
  }
}

// Team form, for the season projection (backlog row 8): from a cutoff, play the rest of the
// season many times with each team's usual players at the cutoff, and compare each team's
// final games won (over fixtures with game rows) with the spread the simulation gives. With
// the right formSd the squared z-scores average about 1. One season, ~18 teams: a rough
// sizing, and said so.
function formCheck(data, settings, season, cutoff, sds, { fixtureSd = model.SETTINGS.fixtureSd, sims = 3000 } = {}) {
  const { fit } = model.fitAt(data.input, cutoff, settings)
  const fx = data.fixtures.filter(f => f.season === season)
  const teams = [...new Set(fx.flatMap(f => [f.home, f.away]))]
  const actual = new Map(teams.map(t => [t, 0])), before = new Map(teams.map(t => [t, 0]))
  for (const f of fx) {
    actual.set(f.home, actual.get(f.home) + f.hs); actual.set(f.away, actual.get(f.away) + f.as)
    if (f.t < cutoff) { before.set(f.home, before.get(f.home) + f.hs); before.set(f.away, before.get(f.away) + f.as) }
  }
  const rest = fx.filter(f => f.t >= cutoff)
  const lineups = new Map()
  for (const f of rest) for (const side of ['home', 'away']) {
    if (!lineups.has(f[side])) lineups.set(f[side], lineupOf(fit, data, { ...f, t: cutoff }, side, 'usual'))
  }
  let seed = 12345
  const rand = () => { seed = (seed + 0x6D2B79F5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand())
  const out = {}
  for (const formSd of sds) {
    const sum = new Map(teams.map(t => [t, 0])), sq = new Map(teams.map(t => [t, 0]))
    for (let n = 0; n < sims; n++) {
      const form = new Map(teams.map(t => [t, formSd * gauss()]))
      const won = new Map(before)
      for (const f of rest) {
        const swing = fixtureSd * gauss() + form.get(f.home) - form.get(f.away)
        let hw = 0
        for (const q of model.rubberProbs(lineups.get(f.home), lineups.get(f.away), fit.home, swing)) for (let g = 0; g < 2; g++) if (rand() < q) hw++
        won.set(f.home, won.get(f.home) + hw); won.set(f.away, won.get(f.away) + 18 - hw)
      }
      for (const t of teams) { sum.set(t, sum.get(t) + won.get(t)); sq.set(t, sq.get(t) + won.get(t) ** 2) }
    }
    let z2 = 0, abs = 0
    for (const t of teams) {
      const mean = sum.get(t) / sims, sd = Math.sqrt(Math.max(1e-9, sq.get(t) / sims - mean ** 2))
      z2 += ((actual.get(t) - mean) / sd) ** 2; abs += Math.abs(actual.get(t) - mean)
    }
    out[formSd] = { teams: teams.length, fixtures: rest.length, z2: z2 / teams.length, mae: abs / teams.length }
  }
  return out
}

// Coordinate search on the tuning season's game log loss, one setting at a time.
function tune(data) {
  const grid = {
    halfLifeDays: [120, 180, 365, 730, 100000],
    tau: [0.15, 0.2, 0.3, 0.4, 0.5],
    mixedSd: [0.0001, 0.08, 0.15, 0.25],
  }
  let best = { ...model.SETTINGS }
  const score = opts => {
    const res = walk(data, opts, { fixtureSds: [] })
    return gameMetrics(res.games.filter(g => g.period === 'tune'))
  }
  let bestScore = score(best)
  console.log(`tune: defaults → LL ${bestScore.logLoss.toFixed(4)} acc ${pct(bestScore.acc)}`)
  const trail = []
  for (let pass = 0; pass < 2; pass++) {
    for (const [key, values] of Object.entries(grid)) {
      for (const v of values) {
        if (v === best[key]) continue
        const cand = { ...best, [key]: v }
        const m = score(cand)
        trail.push({ [key]: v, logLoss: m.logLoss, acc: m.acc })
        console.log(`  ${key}=${v}: LL ${m.logLoss.toFixed(4)} acc ${pct(m.acc)}`)
        if (m.logLoss < bestScore.logLoss - 1e-4) { best = cand; bestScore = m }
      }
    }
  }
  console.log(`tune: best ${JSON.stringify({ halfLifeDays: best.halfLifeDays, tau: best.tau, mixedSd: best.mixedSd })} → LL ${bestScore.logLoss.toFixed(4)} acc ${pct(bestScore.acc)}`)
  return { best, trail }
}

// The Lewis Shield handicap, checked on league fixtures (Lewis ties are too few, and their
// players are the same people): refit every Monday, and for each fixture with all 18 games
// scored, set the handicap from the usual (or actual) players and see what it would have
// done. A fair handicap leaves the side it favours winning half the time, and the actual
// margin should land inside the model's central 50% band half the time (90% band: 90%).
function pointsCheck(data, settings, sds) {
  const inPeriod = (season, t) => PERIODS.find(p => p.season === season && (!p.from || t >= p.from))
  const rows = []
  const weeks = [...new Set(data.fixtures.filter(f => inPeriod(f.season, f.t)).map(f => mondayOf(f.t)))].sort((a, b) => a - b)
  for (const m of weeks) {
    const end = nextMonday(m)
    const { fit } = model.fitAt(data.input, m, settings)
    for (const f of data.fixtures) {
      if (f.t < m || f.t >= end || !inPeriod(f.season, f.t)) continue
      if (f.rows.length !== 18 || f.rows.some(r => r.homeScore == null)) continue
      const margin = f.rows.reduce((a, r) => a + Number(r.homeScore) - Number(r.awayScore), 0)
      const out = { period: inPeriod(f.season, f.t).key, margin, by: {} }
      for (const kind of ['actual', 'usual']) {
        const home = lineupOf(fit, data, f, 'home', kind), away = lineupOf(fit, data, f, 'away', kind)
        out.by[kind] = {}
        for (const sd of sds) {
          const mix = lewisHandicap.marginMixture(home, away, fit.home, sd)
          const extra = Math.round(lewisHandicap.evenAt(mix))
          // P(margin < actual) under the model: where the result fell in the prediction.
          const pit = 1 - lewisHandicap.pHomeWins(mix, -margin)
          out.by[kind][sd] = { extra, pit }
        }
      }
      rows.push(out)
    }
  }
  for (const p of PERIODS) {
    const xs = rows.filter(r => r.period === p.key)
    if (!xs.length) continue
    const mae0 = xs.reduce((a, r) => a + Math.abs(r.margin), 0) / xs.length
    console.log(`\n== ${p.label}: ${xs.length} fixtures, actual margin |mean| ${mae0.toFixed(1)} points (the error of "no handicap")`)
    for (const kind of ['actual', 'usual']) for (const sd of sds) {
      const ys = xs.map(r => ({ margin: r.margin, ...r.by[kind][sd] }))
      const mae = ys.reduce((a, y) => a + Math.abs(y.margin + y.extra), 0) / ys.length
      const bias = ys.reduce((a, y) => a + y.margin + y.extra, 0) / ys.length
      // Of the fixtures given a handicap, how often the side receiving it won (ties: half).
      const given = ys.filter(y => y.extra !== 0)
      const recWon = given.reduce((a, y) => { const m = y.margin + y.extra; const r = y.extra > 0 ? m : -m; return a + (r > 0 ? 1 : r === 0 ? 0.5 : 0) }, 0) / (given.length || 1)
      const in50 = ys.filter(y => y.pit > 0.25 && y.pit < 0.75).length / ys.length
      const in90 = ys.filter(y => y.pit > 0.05 && y.pit < 0.95).length / ys.length
      console.log(`  ${kind.padEnd(6)} fixtureSd ${String(sd).padEnd(4)}: off by ${mae.toFixed(1)} pts (bias ${bias >= 0 ? '+' : ''}${bias.toFixed(1)} to home), receiver won ${pct(recWon)}, inside 50% band ${pct(in50)}, 90% band ${pct(in90)}`)
    }
  }
}

;(async () => {
  const started = Date.now()
  const data = prepare(await load())
  if (POINTS) {
    pointsCheck(data, { ...model.SETTINGS }, [0.1, 0.2, 0.3])
    console.log(`(${((Date.now() - started) / 1000).toFixed(1)}s)`)
    return
  }
  console.log(`${data.input.games.length} usable games, ${data.fixtures.length} fixtures, loaded in ${Date.now() - started}ms`)

  let settings = { ...model.SETTINGS }, tuned = null
  if (TUNE) { tuned = tune(data); settings = tuned.best }

  const sds = [0, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4]
  const res = walk(data, settings, { fixtureSds: sds })
  const eloScale = calibrateElo(res)
  console.log(`ELO rescaled on TUNE: sigmoid(${eloScale.a} + ${eloScale.b} * logit(p))`)
  const rep = report(res, sds)
  print(rep)

  // The fixture swing: the one that best predicts the tuning season's exact scores from the
  // usual players (what a prediction in advance uses).
  const bestSd = kind => sds.reduce((b, sd) => (rep.tune.fixtures[`${kind}@${sd}`].scoreLL < rep.tune.fixtures[`${kind}@${b}`].scoreLL ? sd : b), sds[0])
  console.log(`\nfixtureSd that best predicts TUNE scores: usual lineups ${bestSd('usual')}, actual lineups ${bestSd('actual')}`)
  // Team form, from the start of the season and from 1 January, both on complete seasons.
  const formSds = [0, 0.05, 0.1, 0.15, 0.2]
  const form = {}
  for (const [label, season, cutoff] of [
    ['2025/26 from its first fixture', '20252026', mondayOf(Math.min(...data.fixtures.filter(f => f.season === '20252026').map(f => f.t)))],
    ['2025/26 from 1 Jan 2026', '20252026', new Date(2026, 0, 1).getTime()],
  ]) {
    form[label] = formCheck(data, settings, season, cutoff, formSds)
    console.log(`\nteam form, ${label}:`)
    for (const [sd, m] of Object.entries(form[label])) console.log(`  formSd ${sd}: ${m.teams} teams, ${m.fixtures} fixtures to play, z² ${m.z2.toFixed(2)}, final games won off by ${m.mae.toFixed(1)}`)
  }
  console.log(`settings used: ${JSON.stringify(settings)}  (${((Date.now() - started) / 1000).toFixed(1)}s)`)
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ settings, tuned, eloScale, report: rep, bestFixtureSd: { usual: bestSd('usual'), actual: bestSd('actual') }, form }, null, 2))
})().catch(err => { console.error(err); process.exit(1) })
