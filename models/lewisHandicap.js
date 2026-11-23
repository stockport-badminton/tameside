// Lewis Shield handicaps (migrations/lewis-handicap.sql) and the ties they belong to.
// controllers/lewisHandicapController.js decides who sees what; utils/lewisHandicap.js
// works out a suggestion.

const { sql } = require('../utils/db_connect')
const seasonModel = require('./season')

// When a tie's handicap may be shown: this time, UK, on the night of the match. A match
// starts around 19:30-20:00 and is about done by then, and a captain learning the figure
// before the match could pick a side to suit it.
const REVEAL_TIME = '21:30'

// The site setting naming the Lewis secretary (a player id). Set on /admin/site-settings.
const SECRETARY_KEY = 'lewis_secretary'

const num = v => (v == null ? null : Number(v))

const shape = r => ({
  id: Number(r.id), ymd: r.ymd, dayLabel: r.dayLabel, status: r.status, round: num(r.lewis_round),
  home: { id: Number(r.homeTeam), name: r.homeName, club: r.homeClub, captain: num(r.homeCaptain) },
  away: { id: Number(r.awayTeam), name: r.awayName, club: r.awayClub, captain: num(r.awayCaptain) },
  homeScore: num(r.homeScore), awayScore: num(r.awayScore),
  revealAt: r.revealAt, released: !!r.released,
  handicap: r.points == null ? null : {
    points: Number(r.points), toTeam: num(r.to_team),
    to: r.to_team == null ? null : Number(r.to_team) === Number(r.homeTeam) ? 'home' : 'away',
    setBy: r.set_by, setAt: r.set_at,
  },
})

// Every Lewis tie this season, oldest first, with its handicap (if set) and whether it is
// released. `released` is decided here, by the database clock, so no page can disagree.
// `where` narrows it (a fragment), e.g. to one fixture or one person's ties.
function ties(where = sql``) {
  return sql`
    SELECT f.id, to_char(f.date, 'YYYY-MM-DD') AS ymd, to_char(f.date, 'Dy FMDD Mon YYYY') AS "dayLabel",
           f.status, f.lewis_round, f."homeTeam", f."awayTeam", f."homeScore", f."awayScore",
           h.name AS "homeName", a.name AS "awayName", hc.name AS "homeClub", ac.name AS "awayClub",
           h.captain AS "homeCaptain", a.captain AS "awayCaptain",
           (f.date::date + ${REVEAL_TIME}::time) AT TIME ZONE 'Europe/London' AS "revealAt",
           now() >= (f.date::date + ${REVEAL_TIME}::time) AT TIME ZONE 'Europe/London' AS released,
           lh.points, lh.to_team, lh.set_by, lh.set_at
    FROM fixture f
    JOIN season s ON f.date > s."startDate" AND f.date < s."endDate"
    JOIN team h ON h.id = f."homeTeam"
    JOIN team a ON a.id = f."awayTeam"
    LEFT JOIN club hc ON hc.id = h.club
    LEFT JOIN club ac ON ac.id = a.club
    LEFT JOIN lewis_handicap lh ON lh.fixture = f.id
    WHERE s.name = ${seasonModel.current()}
      AND f.lewis_round IS NOT NULL
      AND f.status <> 'rearranged'
      ${where}
    ORDER BY f.date, f.id`
}

/** Every tie this season. */
exports.all = async function () {
  return (await ties()).map(shape)
}

/** One tie this season, or null. */
exports.byId = async function (id) {
  const [row] = await ties(sql`AND f.id = ${id}`)
  return row ? shape(row) : null
}

/**
 * The ties `playerId` is an officer for: captain of either team, or club or match secretary
 * of either team's club. Each carries `role`, for the page to say why it is listed.
 */
exports.forOfficer = async function (playerId) {
  const rows = await ties(sql`
    AND (h.captain = ${playerId} OR a.captain = ${playerId}
      OR hc."clubSec" = ${playerId} OR hc."matchSec" = ${playerId}
      OR ac."clubSec" = ${playerId} OR ac."matchSec" = ${playerId})`)
  return rows.map(shape)
}

/** The Lewis secretary's player id, or null when none is set. */
exports.secretaryId = async function () {
  const [row] = await sql`SELECT value FROM site_setting WHERE key = ${SECRETARY_KEY}`
  const id = row && Number(row.value)
  return Number.isInteger(id) && id > 0 ? id : null
}

/** Sets the secretary (a player id), or clears it with null. */
exports.setSecretary = async function (playerId) {
  if (playerId == null) {
    await sql`DELETE FROM site_setting WHERE key = ${SECRETARY_KEY}`
    return
  }
  await sql`
    INSERT INTO site_setting (key, value) VALUES (${SECRETARY_KEY}, ${String(playerId)})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`
}

/** Who can be picked as secretary: every player at a real club (not No Club), by name. */
exports.candidates = async function () {
  const rows = await sql`
    SELECT p.id, trim(p.first_name) || ' ' || trim(p.family_name) AS name, c.name AS club
    FROM player p JOIN club c ON c.id = p.club
    WHERE p.id <> 0 AND c.name <> 'No Club'
    ORDER BY p.first_name, p.family_name`
  return rows.map(r => ({ id: Number(r.id), name: r.name, club: r.club }))
}

/** The secretary's name, for the page. */
exports.playerName = async function (id) {
  const [row] = await sql`SELECT trim(first_name) || ' ' || trim(family_name) AS name FROM player WHERE id = ${id}`
  return row ? row.name : null
}

/** Sets a tie's handicap: `points` to team `toTeam` (null with 0 points: scratch). */
exports.set = async function (fixtureId, toTeam, points, setBy) {
  await sql`
    INSERT INTO lewis_handicap (fixture, to_team, points, set_by, set_at)
    VALUES (${fixtureId}, ${points ? toTeam : null}, ${points}, ${setBy || null}, now())
    ON CONFLICT (fixture) DO UPDATE SET to_team = EXCLUDED.to_team, points = EXCLUDED.points,
      set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at`
}

/** Removes a tie's handicap: none set, which is not the same as scratch. */
exports.clear = async function (fixtureId) {
  await sql`DELETE FROM lewis_handicap WHERE fixture = ${fixtureId}`
}

exports.REVEAL_TIME = REVEAL_TIME
