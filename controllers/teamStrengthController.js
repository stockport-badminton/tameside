// Team strength (/admin/team-strength): the nightly run and the pages that show it.
//
// The run fits utils/teamStrength.js's rating to every league game on record, then works out
// the coming week's fixtures, plays out the rest of the season and checks every club's team
// order, and stores the lot as one row (models/teamStrength.js). The page only reads the
// latest row, so it costs nothing to open. Nightly rather than on each publish: nothing here
// needs to be fresher than a day, and the publish path already works to our 60s ceiling.
//
// Ported from Stockport's controllers/teamStrengthController.js (e9ea24b, d5d0149, 750637a,
// 2cc3b7b, 99716c7, 6801d52), reworked for a side of four men and two ladies. Not ported:
// other leagues' games (63504e2) and the weekly snapshots (88de0ee) — both on the
// off-season list in docs/backlog/README.md.
//
// The pages and everything naming a player are superadmin only. The one published part is
// the run's `public` block: a nameless forecast for each remaining fixture and a profile of
// each team, which the public event pages read (TeamStrength.forecastFor). Nothing with a
// name or a player id goes in it.
//
// Predictions field each team's usual players: the four men and two ladies who have played
// most for it this season (utils/teamStrength.js usualPlayers), then its nominated players
// by rank, then its reserves, then an unnamed player at the division's average.

const TeamStrength = require('../models/teamStrength')
const League = require('../models/league')
const seasonModel = require('../models/season')
const model = require('../utils/teamStrength')
const playerCase = require('../utils/playerCase')

const DAY = model.DAY

const fullName = p => `${(p.first_name || '').trim()} ${(p.family_name || '').trim()}`.trim()

// A nominated player has rank 1..98; reserves are >= 99 (utils/rosterRank.js), NULL is
// unplaced and counts as nominated, as everywhere else.
const isNominated = p => p.rank == null || p.rank < model.RESERVE_BASE

const GENDERS = [['men', 'Male'], ['ladies', 'Female']]

/** Builds everything the page shows. @param {number} now ms */
async function build(now) {
  const [rows, regs, { teams, players }, remaining, standings, moving] = await Promise.all([
    TeamStrength.games(), TeamStrength.registrations(), TeamStrength.squads(),
    TeamStrength.remainingFixtures(), League.getRunIn(), League.movingPlaces(),
  ])
  const input = model.collectGames(rows, regs)
  const { fit, games } = model.fitAt(input, now)

  // How many games each player has, how many in the last year, and the last.
  const seen = new Map()
  for (const g of games) for (const p of [g.h1, g.h2, g.a1, g.a2]) {
    const st = seen.get(p) || { games: 0, recent: 0, last: 0 }
    st.games++
    if (now - g.t < 365 * DAY) st.recent++
    st.last = Math.max(st.last, g.t)
    seen.set(p, st)
  }

  const season = seasonModel.current()
  const ownTeam = new Map(players.map(p => [p.id, p.team]))
  // This season, from every game row (player 0 and walkovers included: a player turned up):
  //   turnedOut  `${team}:${player}` → fixtures played for that team (usable games only)
  //   cardPos    player → fixture → card position in the level games for their OWN team
  //              (playing up, or for another club, is left out): the order their club
  //              actually plays them in, to set against the order it nominated
  //   played     team → fixture → who played, for the previews' "settled side"
  const turnedOut = new Map(), cardPos = new Map(), played = new Map()
  for (const g of model.latestEntries(rows)) {
    if (g.season !== season) continue
    const home = Number(g.homeTeam), away = Number(g.awayTeam), fixture = Number(g.fixture)
    for (const [team, ps] of [[home, [g.homePlayer1, g.homePlayer2]], [away, [g.awayPlayer1, g.awayPlayer2]]]) {
      const byFixture = played.get(team) || new Map()
      const f = byFixture.get(fixture) || { t: new Date(g.date).getTime(), players: new Set() }
      for (const p of ps) if (Number(p)) f.players.add(Number(p))
      byFixture.set(fixture, f)
      played.set(team, byFixture)
    }
    const at = model.levelPositions(g.gameType)
    if (at) [[g.homePlayer1, home, at.home[0]], [g.homePlayer2, home, at.home[1]],
      [g.awayPlayer1, away, at.away[0]], [g.awayPlayer2, away, at.away[1]]].forEach(([p, team, pos]) => {
      p = Number(p)
      if (!p || ownTeam.get(p) !== team) return
      const byFixture = cardPos.get(p) || new Map()
      byFixture.set(fixture, pos)
      cardPos.set(p, byFixture)
    })
    if (!model.usableGame(g)) continue
    ;[[g.homePlayer1, home], [g.homePlayer2, home], [g.awayPlayer1, away], [g.awayPlayer2, away]].forEach(([p, team]) => {
      const k = `${team}:${Number(p)}`
      const set = turnedOut.get(k) || new Set()
      set.add(fixture)
      turnedOut.set(k, set)
    })
  }

  const teamById = new Map(teams.map(t => [t.id, t]))
  const rated = players.map(p => {
    const s = fit.s.get(p.id), st = seen.get(p.id), at = [...(cardPos.get(p.id)?.values() || [])]
    return {
      id: p.id, name: fullName(p), gender: p.gender, team: p.team, rank: p.rank,
      s: s ?? null, se: s == null ? null : fit.se.get(p.id) ?? null,
      r: s == null ? null : model.display(s), mixed: Math.round(1000 * (fit.mixed.get(p.id) || 0)),
      games: st ? st.games : 0, recent: st ? st.recent : 0,
      last: st ? new Date(st.last).toISOString().slice(0, 10) : null,
      // Average card position this season for their own team, and over how many fixtures.
      pos: at.length ? Math.round(10 * at.reduce((a, b) => a + b, 0) / at.length) / 10 : null, posN: at.length,
    }
  })

  // Each team's usual four men and two ladies, as the predictions field them. Only players
  // still registered at the club count as regulars: one who has left keeps their history,
  // not a place. A gap is an unnamed player at the division's average.
  const lineups = new Map()
  for (const t of teams) {
    const side = {}
    for (const [key, gender] of GENDERS) {
      const n = model.SIDE[key]
      const slot = p => ({ id: p.id, name: p.name, s: p.s ?? fit.mean(gender, t.divisionRank),
        se: p.se ?? model.SETTINGS.tau, mx: fit.mixed.get(p.id) || 0 })
      const squad = rated.filter(p => p.team === t.id && p.gender === gender)
      const regulars = rated
        .filter(p => p.gender === gender && teamById.get(p.team)?.clubId === t.clubId && turnedOut.has(`${t.id}:${p.id}`))
        .map(p => ({ slot: slot(p), fixtures: turnedOut.get(`${t.id}:${p.id}`).size }))
      const picked = model.usualPlayers(n, squad.filter(isNominated).map(slot), squad.filter(p => !isNominated(p)).map(slot), regulars)
      while (picked.length < n) {
        picked.push({ id: null, name: `(no ${key === 'men' ? 'man' : 'lady'} ${picked.length + 1})`,
          s: fit.mean(gender, t.divisionRank), se: model.SETTINGS.tau, mx: 0 })
      }
      side[key] = picked
    }
    lineups.set(t.id, side)
  }

  // The coming week, and anything overdue.
  const week = remaining.filter(f => f.thisWeek && lineups.has(f.homeTeam) && lineups.has(f.awayTeam)).map(f => {
    const home = teamById.get(f.homeTeam), away = teamById.get(f.awayTeam)
    const { dist, ...pr } = model.predictFixture(lineups.get(f.homeTeam), lineups.get(f.awayTeam), fit.home)
    return { id: f.id, dayLabel: f.dayLabel, overdue: f.overdue, division: home.divisionName, divisionRank: home.divisionRank,
      home: home.name, away: away.name, ...pr }
  }).sort((a, b) => a.divisionRank - b.divisionRank) // stable: by date within a division

  // Divisions as League.getRunIn orders them; the top one promotes nobody, the bottom one
  // relegates nobody, as on the run-in page.
  const divs = new Map()
  for (const r of standings) {
    if (!divs.has(r.division)) divs.set(r.division, { id: r.division, name: r.divisionName, rank: r.divisionRank, teams: [] })
    divs.get(r.division).teams.push({ id: r.id, name: r.name, divRank: r.divRank, gamesWon: r.gamesWon, played: r.played, remaining: r.remaining })
  }
  const divList = [...divs.values()]
  const ranks = divList.map(d => d.rank)
  for (const d of divList) {
    d.promotes = moving > 0 && d.rank !== Math.min(...ranks)
    d.relegates = moving > 0 && d.rank !== Math.max(...ranks)
  }
  const fixturesLeft = standings.reduce((a, r) => a + r.remaining, 0) / 2
  const fixturesAll = standings.reduce((a, r) => a + r.remaining + r.played, 0) / 2
  const formSd = model.formSdFor(fixturesAll ? fixturesLeft / fixturesAll : 1)
  const projection = model.projectSeason(divList,
    remaining.map(f => ({ home: f.homeTeam, away: f.awayTeam })), lineups, fit.home, { moving, formSd })

  // The public forecast for the event pages: every fixture still to play, and each team's
  // profile. No names, no player ids (utils/teamStrength.js publicForecast).
  const fixtures = {}
  for (const f of remaining) {
    if (!lineups.has(f.homeTeam) || !lineups.has(f.awayTeam)) continue
    fixtures[f.id] = model.publicForecast(model.predictFixture(lineups.get(f.homeTeam), lineups.get(f.awayTeam), fit.home))
  }
  const forecast = { fixtures, teams: model.publicTeams(teams, lineups, played, projection) }

  // Team order, club by club, teams in club order.
  const clubs = new Map()
  for (const t of [...teams].sort((a, b) => (a.clubName || '').localeCompare(b.clubName || '') || (a.rank ?? 99) - (b.rank ?? 99))) {
    if (!clubs.has(t.clubId)) clubs.set(t.clubId, { name: t.clubName, teams: [] })
    const squad = (key, gender) => {
      const list = rated.filter(p => p.team === t.id && p.gender === gender)
      const nominated = list.filter(isNominated)
      return { nominated, reserves: list.filter(p => !isNominated(p)), unset: nominated.length > model.MAX_NOMINATED[key] }
    }
    clubs.get(t.clubId).teams.push({ id: t.id, name: t.name, division: t.divisionName,
      men: squad('men', 'Male'), ladies: squad('ladies', 'Female') })
  }
  const checks = [...clubs.values()].map(c => ({ ...c, flags: model.orderFlags(c.teams) }))

  const slim = p => ({ id: p.id, name: p.name, rank: p.rank, r: p.r, pos: p.pos, posN: p.posN,
    se: p.se == null ? null : Math.round(1000 * p.se), mixed: p.mixed, games: p.games, recent: p.recent, last: p.last })
  const payload = {
    settings: model.SETTINGS, formSd: Math.round(1000 * formSd) / 1000, moving,
    home: Math.round(1000 * fit.home),
    divisionMeans: [...new Set(teams.map(t => t.divisionRank))].sort().map(rank => ({
      rank, men: model.display(fit.mean('Male', rank)), ladies: model.display(fit.mean('Female', rank)),
    })),
    week,
    projection,
    // Read by the public event pages (TeamStrength.forecastFor): nothing in it names anyone.
    public: forecast,
    teams: teams.map(t => {
      const squad = rated.filter(p => p.team === t.id)
      const l = lineups.get(t.id)
      return {
        id: t.id, name: t.name, club: t.clubName, division: t.divisionName, divisionRank: t.divisionRank,
        men: squad.filter(p => p.gender === 'Male').map(slim),
        ladies: squad.filter(p => p.gender === 'Female').map(slim),
        usual: { men: l.men.map(p => p.id).filter(id => id != null), ladies: l.ladies.map(p => p.id).filter(id => id != null) },
      }
    }),
    checks: checks.map(c => ({
      name: c.name,
      flags: c.flags.map(f => ({ kind: f.kind, gender: f.gender, team: f.team, text: f.text, p: f.p,
        stronger: f.stronger.r, weaker: f.weaker.r, strongerId: f.stronger.id, weakerId: f.weaker.id })),
      teams: c.teams.map(t => ({ name: t.name, division: t.division,
        men: { nominated: t.men.nominated.map(slim), reserves: t.men.reserves.map(slim), unset: t.men.unset },
        ladies: { nominated: t.ladies.nominated.map(slim), reserves: t.ladies.reserves.map(slim), unset: t.ladies.unset } })),
    })),
  }
  return { games: games.length, payload }
}

// POST /admin/team-strength/run — Cloud Scheduler nightly, or the page's button.
exports.run = async function (req, res, next) {
  const started = Date.now()
  try {
    const caller = req.strengthCaller || 'unknown'
    const { games, payload } = await build(started)
    const tookMs = Date.now() - started
    const id = await TeamStrength.save({ season: seasonModel.current(), caller, games, tookMs, payload })
    console.log('[team-strength] run stored', JSON.stringify({ runId: id, games, tookMs, caller }))
    if (caller === 'superadmin') return res.redirect(303, '/admin/team-strength')
    res.json({ ok: true, runId: id, games, tookMs, week: payload.week.length })
  } catch (err) {
    next(err)
  }
}

// GET /admin/team-strength — the latest run.
exports.page = async function (req, res, next) {
  try {
    const run = await TeamStrength.latest()
    res.render('admin/team-strength', {
      static_path: '/static',
      title: 'Team strength',
      pageDescription: 'Points-based ratings: this week\'s predictions, the projected tables and team order checks',
      run,
      data: run ? run.payload : null,
      season: seasonModel.current(),
      side: model.SIDE,
      tiers: model.ORDER_TIERS,
    })
  } catch (err) {
    next(err)
  }
}

// The evidence windows the compare page offers: this season, this and last, or everything.
const WINDOWS = { 1: 'this season', 2: 'this season and last', all: 'every season' }

// GET /admin/team-strength/compare?a=&b=&seasons= — the case for putting player a above
// player b (utils/playerCase.js): their ratings from the latest run, then the results.
exports.compare = async function (req, res, next) {
  try {
    const window = Object.hasOwn(WINDOWS, String(req.query.seasons)) ? String(req.query.seasons) : '2'
    const ids = [req.query.a, req.query.b].map(v => Number.parseInt(String(v), 10))
    const { teams, players } = await TeamStrength.squads()
    const teamById = new Map(teams.map(t => [t.id, t]))
    const picker = teams.map(t => ({ team: t.name, players: players.filter(p => p.team === t.id)
      .map(p => ({ id: p.id, name: fullName(p), gender: p.gender })) }))
    const view = { static_path: '/static', title: 'Make the case',
      pageDescription: 'The results behind a team-order flag: the case for swapping two players',
      picker, window, windows: WINDOWS, ids, minGames: playerCase.MIN_GAMES, margin: playerCase.MARGIN, error: null, result: null }

    const [a, b] = ids.map(id => players.find(p => p.id === id))
    if (!a || !b || a.id === b.id) {
      if (req.query.a || req.query.b) view.error = 'Pick two different players registered to a team this season.'
      return res.render('admin/team-strength-compare', view)
    }
    if (a.gender !== b.gender) {
      view.error = 'Pick two men or two ladies: the order is set for each separately.'
      return res.render('admin/team-strength-compare', view)
    }

    const seasons = window === 'all' ? null : [seasonModel.current(), seasonModel.previous()].slice(0, Number(window))
    const [rows, run] = await Promise.all([TeamStrength.pairGames([a.id, b.id], seasons), TeamStrength.latest()])
    const nameOf = new Map(players.map(p => [p.id, fullName(p)]))
    const day = d => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}` }

    const games = rows.map(g => ({ league: playerCase.OURS, fixture: Number(g.fixture), date: day(g.date),
      season: g.season, mixed: /Mixed/.test(g.gameType || ''), hs: Number(g.homeScore), as: Number(g.awayScore),
      home: { name: g.homeTeamName, division: null, players: [Number(g.homePlayer1), Number(g.homePlayer2)] },
      away: { name: g.awayTeamName, division: null, players: [Number(g.awayPlayer1), Number(g.awayPlayer2)] } }))
      // Player 0 is a short side, not a partner or an opponent.
      .filter(g => ![...g.home.players, ...g.away.players].includes(0))

    const who = p => ({ id: p.id, name: fullName(p) })
    const c = playerCase.build(who(a), who(b), games, id => nameOf.get(id) || `#${id}`)

    // Their ratings, from the latest run's order checks.
    const ratedById = new Map()
    for (const club of run?.payload?.checks || []) for (const t of club.teams) for (const g of ['men', 'ladies']) {
      for (const p of [...t[g].nominated, ...t[g].reserves]) if (p.id) ratedById.set(p.id, p)
    }
    const ra = ratedById.get(a.id), rb = ratedById.get(b.id)
    const asRated = p => ({ s: (p.r - 1500) / 1000, se: p.se / 1000 })
    const rating = ra && rb && ra.r != null && rb.r != null
      ? { a: ra.r, b: rb.r, p: model.pStronger(asRated(ra), asRated(rb)), ra, rb }
      : null

    view.result = { case: c, rating, ranAt: run?.ran_at || null,
      teams: { a: teamById.get(a.team)?.name, b: teamById.get(b.team)?.name },
      ranks: { a: a.rank, b: b.rank },
      text: playerCase.caseText(c, { window: WINDOWS[window], rating: rating || undefined }) }
    res.render('admin/team-strength-compare', view)
  } catch (err) {
    next(err)
  }
}

exports.build = build
exports.WINDOWS = WINDOWS
