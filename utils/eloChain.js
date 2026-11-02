// Re-rates the ELO of a fixture and of every later fixture its result reaches.
//
// Ported from Stockport (e32f745, 6d95d0a), where it was found 21 Oct 2026. A game's
// rating depends on every game its four players played before it, so a result published
// out of date order leaves everything after it computed without it. The publish path rated
// the late fixture and never looked forward, so its players' later games — and therefore
// their current rating — carried on as if it had not been played, until somebody ran a
// full backfill.
//
// The publish path's own first answer was wrong in two more ways, which re-rating the
// published fixture itself fixes:
//   - Player.getPrevRating carries no games-played count, so perPlayerK(undefined) rated
//     every player at the established K=32 and never the provisional 40;
//   - it reads only the current season's games, and `date <` the fixture, so a player's
//     first match of a season, or the second fixture of a night, started from the wrong
//     rating.
//
// A full backfill is far more work than a late result can change: its own players, then
// anyone who later plays a game whose outcome moved. So this walks the season forward from
// the fixture and re-rates only a fixture containing a player whose history has changed
// ("dirty"), and a player whose games come out identical is clean again from the database.
//
// It has to agree exactly with recalcSeasonElo (controllers/playerController.js), which is
// what /players/eloBackfillAll produces: the same fixture order (Fixture.getFixtureDetails,
// date then id), the same per-game arithmetic (rateFixtureGames, which recalcSeasonElo also
// uses), and the same starting state (getRatingStateBefore, which carries the lifetime
// games-played count the backfill holds in memory). Like the backfill it skips Lewis Shield
// fixtures, and rates only the latest 18 games of a fixture whose scorecard was re-entered.

const { sql } = require('./db_connect')
const Fixture = require('../models/fixture')
const Game = require('../models/game')
const Player = require('../models/players')

// Beyond this the walk stops and writes nothing: a result entered months late can reach
// most of the season, and that is a backfill's job, not a publish's.
const MAX_CHAIN_FIXTURES = 40

// Two results published at once can reach the same fixtures. One walk at a time.
const LOCK_KEY = 20261102

const GAMES_PER_FIXTURE = 18

const SLOTS = [
  ['homePlayer1', 'homePlayer1End'],
  ['homePlayer2', 'homePlayer2End'],
  ['awayPlayer1', 'awayPlayer1End'],
  ['awayPlayer2', 'awayPlayer2End'],
]

const ELO_COLUMNS = [
  'homePlayer1Start', 'homePlayer2Start', 'awayPlayer1Start', 'awayPlayer2Start',
  'homePlayer1End', 'homePlayer2End', 'awayPlayer1End', 'awayPlayer2End',
]

const isPlayer = pid => pid != null && pid != 0

function playersIn(games) {
  const out = new Set()
  for (const g of games) for (const [slot] of SLOTS) if (isPlayer(g[slot])) out.add(Number(g[slot]))
  return [...out]
}

// A re-entered scorecard appends another 18 rows to the same fixture; the backfill rates
// only the latest entry and leaves the older rows at End = 0. `games` is ordered by id.
const latestEntry = games => games.length > GAMES_PER_FIXTURE ? games.slice(-GAMES_PER_FIXTURE) : games

// Rates one fixture's games in order and returns [{ id, ...the eight ELO columns }].
// `fixturePlayers` is { [pid]: { rating, date, gamesCount, rank } } going in, and is
// advanced game by game. A game with no players at all is left unrated, as the backfill
// has always left it.
function rateFixtureGames(games, fixturePlayers, fixture) {
  const rated = []
  for (const game of games) {
    if (!SLOTS.some(([slot]) => game[slot] != 0)) continue
    const { updateObj } = Game.calculateRating(game, fixturePlayers, fixture.date, fixture.rank)
    for (const [slot, endKey] of SLOTS) {
      const pid = game[slot]
      if (!isPlayer(pid) || !fixturePlayers[pid]) continue
      fixturePlayers[pid].rating = updateObj[endKey]
      fixturePlayers[pid].date = fixture.date
      fixturePlayers[pid].gamesCount = (fixturePlayers[pid].gamesCount || 0) + 1
    }
    rated.push({ id: game.id, ...updateObj })
  }
  return rated
}

// Each player's ELO state going into a fixture: { [pid]: { rating, date, gamesCount, rank } },
// matching what the backfill would hold for them at that point:
//   - rating and date: their latest rated game in backfill order — fixture date, then
//     fixture id, then game id — across every season, as eloBackfillAll carries ratings over;
//   - gamesCount: every rated game before this fixture (End > 0 is "rated": the backfill
//     zeroes everything first and leaves Lewis Shield and superseded rows at 0);
//   - rank: their current team's division, as Player.getPrevRatingBatch gives the backfill.
// A player with no rated game starts at 1500 with nothing played, as the backfill starts them.
async function getRatingStateBefore(fixtureId, playerIds, q = sql) {
  const ids = [...new Set((playerIds || []).map(n => parseInt(n, 10)).filter(n => n > 0))]
  if (ids.length === 0) return {}
  const rated = await q`
    SELECT s.pid,
           (array_agg(s.rating ORDER BY f.date DESC, f.id DESC, g.id DESC, s.slot DESC))[1] AS rating,
           (array_agg(f.date ORDER BY f.date DESC, f.id DESC, g.id DESC, s.slot DESC))[1] AS date,
           COUNT(*)::int AS "gamesCount"
    FROM game g
    JOIN fixture f ON f.id = g.fixture
    -- slot: if one id fills two slots of a game, the backfill keeps the last one's End.
    CROSS JOIN LATERAL (VALUES
      (1, g."homePlayer1", g."homePlayer1End"), (2, g."homePlayer2", g."homePlayer2End"),
      (3, g."awayPlayer1", g."awayPlayer1End"), (4, g."awayPlayer2", g."awayPlayer2End")
    ) AS s(slot, pid, rating)
    WHERE s.pid = ANY(${ids}::int[])
      AND s.rating > 0
      AND f.status = 'complete'
      AND f.lewis_round IS NULL
      AND (f.date, f.id) < (SELECT date, id FROM fixture WHERE id = ${fixtureId})
    GROUP BY s.pid`
  const ranks = await q`
    SELECT player.id, division.rank
    FROM player JOIN team ON team.id = player.team JOIN division ON division.id = team.division
    WHERE player.id = ANY(${ids}::int[])`
  const rankById = Object.fromEntries(ranks.map(r => [Number(r.id), Number(r.rank)]))
  const ratedById = Object.fromEntries(rated.map(r => [Number(r.pid), r]))
  return Object.fromEntries(ids.map(id => {
    const r = ratedById[id]
    return [id, {
      rating: r ? Number(r.rating) : 1500,
      date: r ? r.date : '2020-01-01 00:00:00',
      gamesCount: r ? r.gamesCount : 0,
      rank: id in rankById ? rankById[id] : 1,
    }]
  }))
}

// Writes the eight ELO columns for many games in one statement.
async function writeElo(rows, q = sql) {
  if (!rows.length) return
  const values = rows.map(r => [r.id, ...ELO_COLUMNS.map(k => r[k])])
  await q`
    UPDATE game g SET ${q.unsafe(ELO_COLUMNS.map(k => `"${k}" = v."${k}"::int`).join(', '))}
    FROM (VALUES ${q(values)}) AS v(id, ${q.unsafe(ELO_COLUMNS.map(k => `"${k}"`).join(', '))})
    WHERE g.id = v.id::int`
}

const currentSeasonFixtures = () => new Promise((resolve, reject) =>
  Fixture.getFixtureDetails({ status: 'complete' }, (err, rows) => err ? reject(err) : resolve(rows || [])))

// opts.dryRun computes everything and writes nothing, for checking what a re-rate would
// change before it does; `perFixture` then lists what moved where.
//
// opts.everyFixture treats every player as dirty from the start, so every fixture from
// here to now is re-rated — a backfill of the rest of the season. For a fault that is in
// every fixture (the publish path's K, until this), not one that spreads from this one.
// opts.maxFixtures raises the cap for that.
//
// opts.tx runs inside a caller's transaction instead of its own, and leaves the player
// ratings alone; tools/elo-rerate.js --rehearse uses it to check a re-rate and roll back.
async function rerateFrom(fixtureId, opts = {}) {
  const season = (await currentSeasonFixtures()).filter(f => f.lewis_round == null)
  const start = season.findIndex(f => f.id == fixtureId)
  if (start < 0) return { fixtures: 0, games: 0, players: 0, skipped: 'not a complete league fixture this season' }
  const chain = season.slice(start)

  const inTransaction = fn => opts.tx ? fn(opts.tx) : sql.begin(fn)
  const result = await inTransaction(async tx => {
    await tx`SELECT pg_advisory_xact_lock(${LOCK_KEY}::bigint)`

    const rows = await tx`SELECT * FROM game WHERE fixture = ANY(${chain.map(f => Number(f.id))}::int[]) ORDER BY id ASC`
    const gamesByFixture = {}
    for (const g of rows) (gamesByFixture[g.fixture] = gamesByFixture[g.fixture] || []).push(g)
    for (const id of Object.keys(gamesByFixture)) gamesByFixture[id] = latestEntry(gamesByFixture[id])
    const storedById = {}
    for (const games of Object.values(gamesByFixture)) for (const g of games) storedById[g.id] = g

    const dirty = new Set(playersIn(opts.everyFixture ? Object.values(gamesByFixture).flat() : (gamesByFixture[chain[0].id] || [])))
    const cap = opts.maxFixtures || MAX_CHAIN_FIXTURES
    const known = {}  // dirty players only: their state after the last fixture re-rated here
    const writes = []
    const perFixture = []
    let rerated = 0

    for (const fixture of chain) {
      const games = gamesByFixture[fixture.id] || []
      const pids = playersIn(games)
      if (!pids.some(p => dirty.has(p))) continue
      if (++rerated > cap) {
        throw new Error(`ELO chain from fixture ${fixtureId} reaches more than ${cap} fixtures; nothing re-rated — run a full backfill`)
      }

      // A clean player's history up to here is unchanged, so the database is right about
      // them; a dirty one's is not, and only memory has it.
      const loaded = await getRatingStateBefore(fixture.id, pids.filter(p => !(p in known)), tx)
      const fixturePlayers = {}
      for (const p of pids) fixturePlayers[p] = { ...(known[p] || loaded[p]) }

      let changed = 0
      for (const row of rateFixtureGames(games, fixturePlayers, fixture)) {
        const stored = storedById[row.id]
        if (ELO_COLUMNS.some(k => Number(stored[k]) !== row[k])) { writes.push(row); changed++ }
        for (const [slot, endKey] of SLOTS) {
          if (isPlayer(stored[slot]) && Number(stored[endKey]) !== row[endKey]) dirty.add(Number(stored[slot]))
        }
      }
      for (const p of pids) {
        if (dirty.has(p)) known[p] = { ...fixturePlayers[p] }
      }
      perFixture.push({ id: Number(fixture.id), date: fixture.date, gamesChanged: changed })
    }

    const maxShift = writes.reduce((m, row) => Math.max(m, ...SLOTS.map(([, e]) => Math.abs(row[e] - Number(storedById[row.id][e])))), 0)
    const summary = { fixtures: rerated, games: writes.length, players: dirty.size, maxShift }
    if (opts.dryRun) return { ...summary, dryRun: true, perFixture }

    await writeElo(writes, tx)
    return { ...summary, playerIds: [...dirty] }
  })

  // After the commit: refreshRatings reads the games back, so it must see the new values.
  const { playerIds, ...out } = result
  if (playerIds && out.games > 0 && !opts.tx) await Player.refreshRatings(playerIds)
  if (out.games > 0 && out.fixtures > 1) console.log(`[elo-chain] fixture ${fixtureId}: re-rated ${out.fixtures} fixtures, ${out.games} games, ${out.players} players`)
  return out
}

module.exports = { rerateFrom, rateFixtureGames, getRatingStateBefore, writeElo, latestEntry, MAX_CHAIN_FIXTURES }
