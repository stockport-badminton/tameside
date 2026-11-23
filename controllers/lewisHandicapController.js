// Lewis Shield handicaps (Nov 2026).
//
// The Lewis Shield is decided on total points with a handicap added to one side
// (utils/lewisHandicap.js has the rules and the maths). The Lewis secretary sets each tie's
// handicap in advance here, and the two teams' officers see it on the night, once the match
// should be over, never before: a captain who knew it in advance could choose a side to suit.
//
//   /lewis-shield/handicaps            the secretary: every tie, the model's suggestion from
//                                      each team's usual side, set or change the handicap
//   /lewis-shield/handicaps/:id/squads the secretary: the suggestion for named squads
//   /lewis-shield/handicap             a captain or club secretary: their club's ties, the
//                                      handicap shown from 21:30 on the match date
//
// Who is the Lewis secretary: the player named by the `lewis_secretary` site setting
// (/admin/site-settings), or any superadmin. Read per request, so a change takes effect at
// once — unlike a site role, which waits for the next login.
//
// Who is an officer of a tie: the captain of either team (team.captain), or the club or match
// secretary of either team's club (club."clubSec", "matchSec"). Only by those pointers: the
// legacy teamCaptain boolean cannot say which team.
//
// The release time is decided by the database (models/lewisHandicap.js `released`), and an
// unreleased handicap never reaches a captain's page at all — not hidden, not rendered.

const LewisHandicap = require('../models/lewisHandicap')
const TeamStrength = require('../models/teamStrength')
const handicapModel = require('../utils/lewisHandicap')
const authz = require('../utils/authz')

const ROUND_LABELS = { 1: 'Preliminary Round', 2: 'Round 1', 3: 'Quarter-Final' }
const roundLabel = r => ROUND_LABELS[r] || 'Lewis Shield'

const MAX_POINTS = 400

const playerIdOf = req => {
  const t = req.user && req.user.tameside
  return t && t.playerId != null ? Number(t.playerId) : null
}

function forbidden(message) {
  const err = new Error(message)
  err.status = 403
  return err
}

// The Lewis secretary, or a superadmin.
async function mayManage(req) {
  if (authz.isSuperAdmin(req)) return true
  const me = playerIdOf(req)
  if (me == null) return false
  return me === await LewisHandicap.secretaryId()
}

// The latest team-strength run's payload, or null: no run yet, or the read failed. A
// suggestion is advice; its absence must not stop a handicap being set.
async function latestPayload() {
  try {
    const run = await TeamStrength.latest()
    return run ? { ranAt: run.ran_at, payload: run.payload } : null
  } catch (err) {
    console.log('[lewis-handicap] no team-strength run:', err.message)
    return null
  }
}

const noStore = res => res.set('Cache-Control', 'private, no-store')

const played = t => t.homeScore != null || t.status === 'complete' || t.status === 'conceded'

// GET /lewis-shield/handicaps
exports.list = async function (req, res, next) {
  try {
    if (!await mayManage(req)) throw forbidden('Only the Lewis secretary can see the handicaps before the night.')
    const [ties, run] = await Promise.all([LewisHandicap.all(), latestPayload()])
    const rows = ties.map(t => {
      const s = run && handicapModel.forTie(run.payload, t.home.id, t.away.id)
      const set = t.handicap
      // With the handicap as set, P(the side receiving it wins), from the usual sides.
      const signed = set ? (set.to === 'home' ? set.points : -set.points) : null
      const pHome = s && set ? s.pHomeWith(signed) : null
      return {
        ...t, roundLabel: roundLabel(t.round), played: played(t),
        suggestion: s ? { to: s.to, points: s.points, pHome: s.pHome } : null,
        withSet: pHome == null ? null : { pHome },
      }
    })
    noStore(res)
    res.render('lewis-handicaps', {
      static_path: '/static',
      title: 'Lewis Shield handicaps',
      pageDescription: 'Set the Lewis Shield handicaps',
      rows,
      ranAt: run && run.ranAt,
      revealTime: LewisHandicap.REVEAL_TIME,
      saved: Number(req.query.saved) || null,
      maxPoints: MAX_POINTS,
    })
  } catch (err) {
    next(err)
  }
}

// POST /lewis-shield/handicaps/:id — to: home | away | scratch | clear, points.
exports.set = async function (req, res, next) {
  try {
    if (!await mayManage(req)) throw forbidden('Only the Lewis secretary can set a handicap.')
    const id = Number(req.params.id)
    const tie = await LewisHandicap.byId(id)
    if (!tie) { const e = new Error('No such Lewis Shield tie this season'); e.status = 404; throw e }
    const to = String(req.body.to || '')
    const points = Number(String(req.body.points ?? '').trim() || 0)
    if (to === 'clear') {
      await LewisHandicap.clear(id)
    } else if (to === 'scratch' || ((to === 'home' || to === 'away') && points === 0)) {
      await LewisHandicap.set(id, null, 0, authz.userEmail(req))
    } else if ((to === 'home' || to === 'away') && Number.isInteger(points) && points > 0 && points <= MAX_POINTS) {
      await LewisHandicap.set(id, tie[to].id, points, authz.userEmail(req))
    } else {
      const e = new Error(`A handicap is a whole number of points, 0 to ${MAX_POINTS}, to the home or the away team.`)
      e.status = 400
      throw e
    }
    res.redirect(303, `/lewis-shield/handicaps?saved=${id}#tie-${id}`)
  } catch (err) {
    next(err)
  }
}

// The squads a calculator request names: h1..h4, hl1, hl2 (home men, ladies) and a1..a4,
// al1, al2, each a player id or 0 for the division's average player. A side with none of
// its fields is that team's usual side.
function picksFrom(query, prefix) {
  const men = [1, 2, 3, 4].map(i => query[`${prefix}${i}`])
  const ladies = [1, 2].map(i => query[`${prefix}l${i}`])
  if ([...men, ...ladies].every(v => v === undefined)) return undefined
  const id = v => (/^\d+$/.test(String(v ?? '')) ? Number(v) : 0)
  return { men: men.map(id), ladies: ladies.map(id) }
}

// GET /lewis-shield/handicaps/:id/squads
exports.squads = async function (req, res, next) {
  try {
    if (!await mayManage(req)) throw forbidden('Only the Lewis secretary can use the handicap calculator.')
    const tie = await LewisHandicap.byId(Number(req.params.id))
    if (!tie) { const e = new Error('No such Lewis Shield tie this season'); e.status = 404; throw e }
    const run = await latestPayload()
    const payload = run && run.payload
    const picks = { home: picksFrom(req.query, 'h'), away: picksFrom(req.query, 'a') }
    const result = payload ? handicapModel.forTie(payload, tie.home.id, tie.away.id, picks) : null
    const usual = payload ? handicapModel.forTie(payload, tie.home.id, tie.away.id) : null
    noStore(res)
    res.render('lewis-handicap-squads', {
      static_path: '/static',
      title: `Lewis handicap: ${tie.home.name} v ${tie.away.name}`,
      pageDescription: 'Work out a Lewis Shield handicap from named squads',
      tie: { ...tie, roundLabel: roundLabel(tie.round) },
      ranAt: run && run.ranAt,
      result,
      usual: usual && { to: usual.to, points: usual.points },
      options: payload ? {
        home: handicapModel.clubPlayers(payload, tie.home.id),
        away: handicapModel.clubPlayers(payload, tie.away.id),
      } : null,
      maxPoints: MAX_POINTS,
    })
  } catch (err) {
    next(err)
  }
}

// GET /lewis-shield/handicap — a captain's or club secretary's view.
exports.officer = async function (req, res, next) {
  try {
    const me = playerIdOf(req)
    const [ties, manager, secretaryId] = await Promise.all([
      me == null ? [] : LewisHandicap.forOfficer(me), mayManage(req), LewisHandicap.secretaryId(),
    ])
    const secretary = secretaryId ? await LewisHandicap.playerName(secretaryId) : null
    // Released or not decides whether the figure leaves this function at all.
    const rows = ties.map(t => ({
      id: t.id, ymd: t.ymd, dayLabel: t.dayLabel, roundLabel: roundLabel(t.round),
      home: { name: t.home.name }, away: { name: t.away.name },
      released: t.released, played: played(t),
      handicap: t.released && t.handicap
        ? { points: t.handicap.points, team: t.handicap.to ? t[t.handicap.to].name : null }
        : null,
      handicapSet: t.released ? !!t.handicap : undefined,
    }))
    noStore(res)
    res.render('lewis-handicap', {
      static_path: '/static',
      title: 'Lewis Shield handicap',
      pageDescription: 'The handicap for your Lewis Shield tie, on the night',
      rows,
      linked: me != null,
      manager,
      secretary,
      revealTime: LewisHandicap.REVEAL_TIME,
    })
  } catch (err) {
    next(err)
  }
}

exports._internal = { picksFrom, roundLabel, MAX_POINTS }
