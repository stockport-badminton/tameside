// The reads behind the nightly team-strength run, and its record (migrations/strength-run.sql).
// The model itself is utils/teamStrength.js; controllers/teamStrengthController.js joins
// the two, and tools/strength-backtest.js reads the same two inputs.
//
// Ported from Stockport's models/teamStrength.js (kysely there, plain `sql` here).

const { sql } = require('../utils/db_connect')
const seasonModel = require('./season')

// The runs kept: enough to compare a bad night with the ones before.
const KEEP_RUNS = 14

// Every league game with a score, with its fixture's teams, the season it was played in and
// the ELO each player went in with (for the backtest's comparison). Lewis Shield fixtures
// are left out: a cup tie between divisions, with a handicap, is not league form. What
// counts as a real game (no player 0, four different players, no 21-0 walkover) is the
// model's decision, made in utils/teamStrength.js usableGame.
exports.games = async function () {
  return sql`
    SELECT g.id, g.fixture, g."gameType", g."homePlayer1", g."homePlayer2", g."awayPlayer1", g."awayPlayer2",
           g."homeScore", g."awayScore",
           g."homePlayer1Start", g."homePlayer2Start", g."awayPlayer1Start", g."awayPlayer2Start",
           f.date, f."homeTeam", f."awayTeam", f."homeScore" AS "fixtureHomeScore", f."awayScore" AS "fixtureAwayScore",
           s.name AS season
    FROM game g
    JOIN fixture f ON f.id = g.fixture
    JOIN season s ON f.date > s."startDate" AND f.date < s."endDate"
    WHERE g."homeScore" IS NOT NULL AND g."awayScore" IS NOT NULL
      AND f.lewis_round IS NULL
      AND f.date <= now()
    ORDER BY f.date, g.id`
}

// Which division each player was registered in, season by season: the rank of the division
// of the team they were on. Archived seasons from player/team/division<season>, the current
// one from the live tables. A player on no team still has a gender.
exports.registrations = async function () {
  const archived = (await seasonModel.getAll())
    .map(s => s.name)
    .filter(name => seasonModel.isValidName(name) && name !== seasonModel.current())
  const parts = [
    sql`SELECT ${seasonModel.current()}::text AS season, p.id, p.gender, d.rank AS "divRank"
        FROM player p LEFT JOIN team t ON t.id = p.team LEFT JOIN division d ON d.id = t.division`,
  ]
  for (const name of archived) {
    parts.push(sql`SELECT ${name}::text AS season, p.id, p.gender, d.rank AS "divRank"
        FROM ${sql('player' + name)} p
        LEFT JOIN ${sql('team' + name)} t ON t.id = p.team
        LEFT JOIN ${sql('division' + name)} d ON d.id = t.division`)
  }
  const rows = []
  for (const q of parts) rows.push(...await q)
  return rows.map(r => ({ season: r.season, id: Number(r.id), gender: r.gender, divRank: r.divRank == null ? null : Number(r.divRank) }))
}

// Each team's division rank, season by season (archives, then the live table for the
// current season): where an unknown player in a lineup starts.
exports.teamDivisions = async function () {
  const archived = (await seasonModel.getAll())
    .map(s => s.name)
    .filter(name => seasonModel.isValidName(name) && name !== seasonModel.current())
  const rows = [...await sql`
    SELECT ${seasonModel.current()}::text AS season, t.id, d.rank AS "divRank"
    FROM team t JOIN division d ON d.id = t.division`]
  for (const name of archived) {
    rows.push(...await sql`
      SELECT ${name}::text AS season, t.id, d.rank AS "divRank"
      FROM ${sql('team' + name)} t JOIN ${sql('division' + name)} d ON d.id = t.division`)
  }
  return rows.map(r => ({ season: r.season, id: Number(r.id), divRank: Number(r.divRank) }))
}

// This season's teams in a division, with their club, and every player registered to them
// (player 0 excluded). Ranks are the roster editor's: 1..n nominated, >= 99 reserve.
exports.squads = async function () {
  const teams = await sql`
    SELECT team.id, team.name, team.rank, team."divRank", team.club AS "clubId", club.name AS "clubName",
           division.id AS "divisionId", division.name AS "divisionName", division.rank AS "divisionRank"
    FROM team
    JOIN division ON division.id = team.division
    LEFT JOIN club ON club.id = team.club
    ORDER BY division.rank, club.name, team.rank`
  const ids = teams.map(t => t.id)
  const players = ids.length ? await sql`
    SELECT id, first_name, family_name, gender, team, club, rank
    FROM player
    WHERE team IN ${sql(ids)} AND id <> 0
    ORDER BY rank NULLS LAST, id` : []
  const num = v => (v == null ? null : Number(v))
  return {
    teams: teams.map(t => ({ ...t, id: Number(t.id), clubId: num(t.clubId), divisionId: num(t.divisionId), divisionRank: num(t.divisionRank) })),
    players: players.map(p => ({ ...p, id: Number(p.id), team: num(p.team), club: num(p.club), rank: num(p.rank) })),
  }
}

// Stores a run and drops all but the latest KEEP_RUNS. `payload` through sql.json: a
// stringified one would be stored as a jsonb STRING (see CLAUDE.md, Inbound list email).
exports.save = async function ({ season, caller, games, tookMs, payload }) {
  return sql.begin(async tx => {
    const [row] = await tx`
      INSERT INTO strength_run (season, caller, games, took_ms, payload)
      VALUES (${season}, ${caller}, ${games}, ${tookMs}, ${sql.json(payload)})
      RETURNING id`
    await tx`
      DELETE FROM strength_run
      WHERE id NOT IN (SELECT id FROM strength_run ORDER BY id DESC LIMIT ${KEEP_RUNS})`
    return Number(row.id)
  })
}

// The newest run, or null before the first.
exports.latest = async function () {
  const [row] = await sql`
    SELECT id, ran_at, season, caller, games, took_ms, payload
    FROM strength_run ORDER BY id DESC LIMIT 1`
  return row || null
}

exports.KEEP_RUNS = KEEP_RUNS
