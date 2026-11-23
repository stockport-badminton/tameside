// Team strength (/admin/team-strength): the nightly run and the page that shows it.
//
// The run fits utils/teamStrength.js's rating to every league game on record and stores the
// result as one row (models/teamStrength.js), so the page costs one read to open. Nightly
// rather than on each publish: nothing here needs to be fresher than a day, and the publish
// path already works to our 60-second request ceiling.
//
// Ported from Stockport's controllers/teamStrengthController.js (e9ea24b, d5d0149) — the
// rating and the run only. Their week's predictions, projected tables, order checks and the
// public forecast block are backlog row 8 and are not here yet; neither are their other-
// league games (63504e2, the off-season list). Each team's USUAL players are worked out
// and stored now, because row 8's predictions field them and they are worth seeing first.
//
// Everything here names players, so the page is superadmin only and nothing in the payload
// is read by a public page.

const TeamStrength = require('../models/teamStrength')
const seasonModel = require('../models/season')
const model = require('../utils/teamStrength')

const DAY = model.DAY

const fullName = p => `${(p.first_name || '').trim()} ${(p.family_name || '').trim()}`.trim()

// A nominated player has rank 1..98; reserves are >= 99 (utils/rosterRank.js), NULL is
// unplaced and counts as nominated, as everywhere else.
const isNominated = p => p.rank == null || p.rank < 99

/** Builds everything the page shows. @param {number} now ms */
async function build(now) {
  const [rows, regs, { teams, players }] = await Promise.all([
    TeamStrength.games(), TeamStrength.registrations(), TeamStrength.squads(),
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

  // This season's fixtures each player has played for each team: `${team}:${player}`.
  const season = seasonModel.current()
  const turnedOut = new Map()
  for (const g of games) {
    if (g.season !== season) continue
    ;[[g.h1, g.homeTeam], [g.h2, g.homeTeam], [g.a1, g.awayTeam], [g.a2, g.awayTeam]].forEach(([p, team]) => {
      const k = `${team}:${p}`
      const set = turnedOut.get(k) || new Set()
      set.add(g.fixture)
      turnedOut.set(k, set)
    })
  }

  const teamById = new Map(teams.map(t => [t.id, t]))
  const rated = players.map(p => {
    const s = fit.s.get(p.id), st = seen.get(p.id)
    return {
      id: p.id, name: fullName(p), gender: p.gender, team: p.team, rank: p.rank,
      s: s ?? null, se: s == null ? null : fit.se.get(p.id) ?? null,
      r: s == null ? null : model.display(s), mixed: Math.round(1000 * (fit.mixed.get(p.id) || 0)),
      games: st ? st.games : 0, recent: st ? st.recent : 0,
      last: st ? new Date(st.last).toISOString().slice(0, 10) : null,
    }
  })

  // Each team's usual four men and two ladies. Only players still registered at the club
  // count as regulars: one who has left keeps their history, not a place.
  const usualOf = t => {
    const pick = (gender, n) => {
      const slot = p => ({ id: p.id, name: p.name, s: p.s ?? fit.mean(gender, t.divisionRank), mx: fit.mixed.get(p.id) || 0 })
      const squad = rated.filter(p => p.team === t.id && p.gender === gender)
      const played = rated
        .filter(p => p.gender === gender && teamById.get(p.team)?.clubId === t.clubId && turnedOut.has(`${t.id}:${p.id}`))
        .map(p => ({ slot: slot(p), fixtures: turnedOut.get(`${t.id}:${p.id}`).size }))
      const picked = model.usualPlayers(n, squad.filter(isNominated).map(slot), squad.filter(p => !isNominated(p)).map(slot), played)
      return picked.map(p => p.id)
    }
    return { men: pick('Male', model.SIDE.men), ladies: pick('Female', model.SIDE.ladies) }
  }

  const slim = p => ({ id: p.id, name: p.name, rank: p.rank, r: p.r,
    se: p.se == null ? null : Math.round(1000 * p.se), mixed: p.mixed, games: p.games, recent: p.recent, last: p.last })
  const payload = {
    settings: model.SETTINGS,
    home: Math.round(1000 * fit.home),
    divisionMeans: [...new Set(teams.map(t => t.divisionRank))].sort().map(rank => ({
      rank, men: model.display(fit.mean('Male', rank)), ladies: model.display(fit.mean('Female', rank)),
    })),
    teams: teams.map(t => {
      const squad = rated.filter(p => p.team === t.id)
      return {
        id: t.id, name: t.name, club: t.clubName, division: t.divisionName, divisionRank: t.divisionRank,
        men: squad.filter(p => p.gender === 'Male').map(slim),
        ladies: squad.filter(p => p.gender === 'Female').map(slim),
        usual: usualOf(t),
      }
    }),
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
    res.json({ ok: true, runId: id, games, tookMs })
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
      pageDescription: 'Points-based player ratings from the nightly run',
      run,
      data: run ? run.payload : null,
    })
  } catch (err) {
    next(err)
  }
}

exports.build = build
