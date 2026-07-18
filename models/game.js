const { sql } = require('../utils/db_connect');
const seasonModel = require('./season');

// POST
exports.create = function(gameObj,done){
  if (db.isObject(gameObj)){
    var sql = 'INSERT INTO `game` (';
    var updateArray = [];
    var updateArrayVars = [];
    var updateArrayValues = []
    for (x in gameObj){
      // console.log(gameObj[x]);
      updateArray.push('`'+ x +'`');
      updateArrayVars.push(gameObj[x]);
      updateArrayValues.push('?');
    }
    var updateVars = updateArray.join(',');
    var updateValues = updateArrayValues.join(',');
    // console.log(updateVars);
    sql = sql + updateVars + ') VALUES (' + updateValues + ')';
    // console.log(sql);
    db.get().query(sql,updateArrayVars,function(err,result){
      if (err) return done(err);
      done(null,result);
    });
  }
  else {
    return done(err);
  }
}

exports.createBatch = async function(BatchObj,done){
    if(typeof BatchObj.fields !== undefined){
      // console.log(BatchObj)
      /* let bulkobj = BatchObj.data.map(row => {
        // Use reduce() to create an object for each row
        console.log(row)
        return row.reduce((obj, value, index) => {
            obj[BatchObj.fields[index]] = value; // Assign value to corresponding key
            return obj;
        }, {});
      }) */
      
      let rows = sql`insert into ${sql(BatchObj.tablename)} ${ sql(BatchObj.data) }`.catch(err => {
        return done(err)
      })
      console.log(rows)
      done(null,rows);
    }
    else{
      return done('not object');
    }
  }

// GET
exports.getAll = async function(done){
    let rows = await sql`SELECT * FROM "game"`.catch(err => {
          return done(err)
      })
      done(null,rows);
    }

// GET
exports.getById = async function(gameId,done){
    let rows = await sql`SELECT * FROM "game" WHERE "id" = ${gameId}`.catch(err => {
          return done(err)
      })
      done(null,rows);
    }

exports.getByFixture = async function(fixtureId,done){
  let rows = await sql`SELECT * FROM "game" WHERE "fixture" = ${fixtureId} order by id asc`.catch(err => {
        return done(err)
    })
    done(null,rows);
  }

// DELETE
exports.getById = async function(gameId,done){
    let rows = await sql`DELETE FROM "game" WHERE "id" = ${gameId}`.catch(err => {
          return done(err)
      })
      done(null,rows);
    }

// PATCH
exports.updateById = async function(gameObj,gameId,done){
  /* console.log(Object.values(gameObj))
  console.log(Object.keys(gameObj))
  console.log(gameId) */
    if (typeof gameObj !== 'undefined' && typeof gameId !== 'undefined'){
      let rows = await sql`
        update game set ${
          sql(gameObj, Object.keys(gameObj))
        }
        where id = ${ gameId }
      `.catch(err => {
        console.log(Object.values(gameObj))
        console.log(Object.keys(gameObj))
        console.log(`${gameId} : ${JSON.stringify(gameObj)}`)
        console.log(JSON.stringify(err))
        // console.log(err.query)
        return done(err)
      })
      // console.log(rows)
      // console.log(rows.statement.query)
      return done(null,rows);
    }
    else {
      console.error(`no gameobj or id: ${JSON.stringify(gameObj)}, ${gameId}`)
      return done(err);
    }
  
  }

// ── ELO tuning constants ──────────────────────────────────────────────────
// Points added per division-rank of gap between a player's registered
// division and the division this fixture is actually being played in
// (i.e. how much a reserve-up/down player shifts their opponent's effective
// rating). Calibrated against the real rating stddev (~186) rather than the
// original 500, which was ~2.7x that spread and swamped genuine skill signal
// for any reserve spanning more than one division.
const DIVISION_RANK_POINTS = 150

// K-factor: higher while a player's rating is still converging, standard
// once established. gamesCount reflects games played BEFORE this one.
const PROVISIONAL_K = 40
const PROVISIONAL_GAMES_THRESHOLD = 15
const ESTABLISHED_K = 32

// Margin-of-victory scaling: a 21-2 blowout should move rating a bit more
// than a 22-20 nail-biter. Bounded so no single game swings wildly.
const MARGIN_MULTIPLIER_MIN = 0.85
const MARGIN_MULTIPLIER_MAX = 1.15
const MAX_GAME_MARGIN = 21

// Smooths how a pair's total rating change is split between two partners
// with different ratings — a gap of one stddev meaningfully skews the
// split toward the weaker partner; a near-zero gap barely skews it at all.
const PARTNER_SKEW_SCALE = 186

function perPlayerK(gamesCount) {
  const played = typeof gamesCount === 'number' ? gamesCount : Infinity
  return played < PROVISIONAL_GAMES_THRESHOLD ? PROVISIONAL_K : ESTABLISHED_K
}

// Splits a pair's rating change between two partners based on the rating
// gap between them. Both partners' baseline is pairDelta itself (matching
// the old behaviour where both got the identical full delta) — the weaker
// partner gets a bonus on top for a win (and a smaller loss), the stronger
// partner the reverse, bounded so neither share can flip past 0/2x pairDelta.
// Equal-rated partners (gapA = 0) still get the identical pairDelta each,
// exactly like before. deltaB is the exact complement of the rounded deltaA
// against a 2×pairDelta total, so nothing leaks.
function splitPairDelta(pairDelta, ratingA, ratingB) {
  const pairAvg = (ratingA + ratingB) / 2
  const gapA = pairAvg - ratingA
  const skewMagnitude = (Math.abs(pairDelta) / 2) * Math.tanh(Math.abs(gapA) / PARTNER_SKEW_SCALE)
  const skewA = Math.sign(gapA) * skewMagnitude
  const deltaA = Math.round(pairDelta + skewA)
  const deltaB = (2 * pairDelta) - deltaA
  return [deltaA, deltaB]
}

exports.calculateRating = function(game, fixturePlayers, endDate, division) {
  let updateObj = {}
  let prevRatingDates = {}

  if (game.homePlayer1 == 0 || game.homePlayer2 == 0 || game.awayPlayer1 == 0 || game.awayPlayer2 == 0) {
    updateObj = {
      homePlayer1Start: (typeof fixturePlayers[game.homePlayer1] !== 'undefined' ? fixturePlayers[game.homePlayer1].rating : 1500),
      homePlayer2Start: (typeof fixturePlayers[game.homePlayer2] !== 'undefined' ? fixturePlayers[game.homePlayer2].rating : 1500),
      awayPlayer1Start: (typeof fixturePlayers[game.awayPlayer1] !== 'undefined' ? fixturePlayers[game.awayPlayer1].rating : 1500),
      awayPlayer2Start: (typeof fixturePlayers[game.awayPlayer2] !== 'undefined' ? fixturePlayers[game.awayPlayer2].rating : 1500),
      homePlayer1End: (typeof fixturePlayers[game.homePlayer1] !== 'undefined' ? fixturePlayers[game.homePlayer1].rating : 1500),
      homePlayer2End: (typeof fixturePlayers[game.homePlayer2] !== 'undefined' ? fixturePlayers[game.homePlayer2].rating : 1500),
      awayPlayer1End: (typeof fixturePlayers[game.awayPlayer1] !== 'undefined' ? fixturePlayers[game.awayPlayer1].rating : 1500),
      awayPlayer2End: (typeof fixturePlayers[game.awayPlayer2] !== 'undefined' ? fixturePlayers[game.awayPlayer2].rating : 1500),
    }
    prevRatingDates = {
      homePlayer1Start: (typeof fixturePlayers[game.homePlayer1] !== 'undefined' ? fixturePlayers[game.homePlayer1].date : '2020-01-01T00:00:00.000Z'),
      homePlayer2Start: (typeof fixturePlayers[game.homePlayer2] !== 'undefined' ? fixturePlayers[game.homePlayer2].date : '2020-01-01T00:00:00.000Z'),
      awayPlayer1Start: (typeof fixturePlayers[game.awayPlayer1] !== 'undefined' ? fixturePlayers[game.awayPlayer1].date : '2020-01-01T00:00:00.000Z'),
      awayPlayer2Start: (typeof fixturePlayers[game.awayPlayer2] !== 'undefined' ? fixturePlayers[game.awayPlayer2].date : '2020-01-01T00:00:00.000Z'),
    }
  } else {
    const homeP1 = fixturePlayers[game.homePlayer1]
    const homeP2 = fixturePlayers[game.homePlayer2]
    const awayP1 = fixturePlayers[game.awayPlayer1]
    const awayP2 = fixturePlayers[game.awayPlayer2]

    const homePairStart = ((1 * homeP1.rating + ((1 * awayP1.rank - division) * DIVISION_RANK_POINTS)) + (1 * homeP2.rating + ((1 * awayP2.rank - division) * DIVISION_RANK_POINTS))) / 2
    const awayPairStart = ((1 * awayP1.rating + ((1 * homeP1.rank - division) * DIVISION_RANK_POINTS)) + (1 * awayP2.rating + ((1 * homeP2.rank - division) * DIVISION_RANK_POINTS))) / 2
    const homeExpectOutcome = 1 / (1 + Math.pow(10, ((awayPairStart - homePairStart) / 400)))

    const avgK = (perPlayerK(homeP1.gamesCount) + perPlayerK(homeP2.gamesCount) + perPlayerK(awayP1.gamesCount) + perPlayerK(awayP2.gamesCount)) / 4
    const marginRatio = Math.min(Math.abs((1 * game.homeScore) - (1 * game.awayScore)) / MAX_GAME_MARGIN, 1)
    const marginMultiplier = MARGIN_MULTIPLIER_MIN + (MARGIN_MULTIPLIER_MAX - MARGIN_MULTIPLIER_MIN) * marginRatio
    const effectiveK = avgK * marginMultiplier

    let homeAdjustment = 0
    if (1 * game.homeScore > 1 * game.awayScore) {
      homeAdjustment = Math.round(effectiveK * (1 - homeExpectOutcome))
    } else {
      homeAdjustment = Math.round(effectiveK * (0 - homeExpectOutcome))
    }
    const awayAdjustment = -homeAdjustment

    const [homeP1Delta, homeP2Delta] = splitPairDelta(homeAdjustment, homeP1.rating, homeP2.rating)
    const [awayP1Delta, awayP2Delta] = splitPairDelta(awayAdjustment, awayP1.rating, awayP2.rating)

    updateObj = {
      homePlayer1Start: homeP1.rating,
      homePlayer2Start: homeP2.rating,
      awayPlayer1Start: awayP1.rating,
      awayPlayer2Start: awayP2.rating,
      homePlayer1End: 1 * homeP1.rating + homeP1Delta,
      homePlayer2End: 1 * homeP2.rating + homeP2Delta,
      awayPlayer1End: 1 * awayP1.rating + awayP1Delta,
      awayPlayer2End: 1 * awayP2.rating + awayP2Delta,
    }
    prevRatingDates = {
      homePlayer1Start: homeP1.date,
      homePlayer2Start: homeP2.date,
      awayPlayer1Start: awayP1.date,
      awayPlayer2Start: awayP2.date,
    }
  }

  return { updateObj, prevRatingDates }
}

// Returns all ELO-processed games for a season in chronological order.
// Used by the audit tool to check rating chain consistency. Lewis Shield
// games never carry ratings (End = 0) so the filter excludes them naturally.
exports.getSeasonGamesOrdered = async function(seasonName) {
  const sName = seasonName || seasonModel.current()
  return await sql`
    SELECT
      game.id,
      game."homePlayer1", game."homePlayer2", game."awayPlayer1", game."awayPlayer2",
      game."homePlayer1Start"::int AS "homePlayer1Start",
      game."homePlayer1End"::int   AS "homePlayer1End",
      game."homePlayer2Start"::int AS "homePlayer2Start",
      game."homePlayer2End"::int   AS "homePlayer2End",
      game."awayPlayer1Start"::int AS "awayPlayer1Start",
      game."awayPlayer1End"::int   AS "awayPlayer1End",
      game."awayPlayer2Start"::int AS "awayPlayer2Start",
      game."awayPlayer2End"::int   AS "awayPlayer2End",
      fixture.date,
      fixture.id AS "fixtureId"
    FROM game
    JOIN fixture ON game.fixture = fixture.id
    JOIN season ON (fixture.date > season."startDate" AND fixture.date < season."endDate" AND season.name = ${sName})
    WHERE game."homePlayer1End" IS NOT NULL AND game."homePlayer1End" != 0
    ORDER BY fixture.date ASC, game.id ASC
  `
}

// Zeros out ELO start/end values across every game in the DB. Used before a
// full backfill so no stale values from previous runs influence new calculations.
exports.resetAllElo = async function() {
  await sql`
    UPDATE game SET
      "homePlayer1Start" = 0, "homePlayer2Start" = 0,
      "awayPlayer1Start" = 0, "awayPlayer2Start" = 0,
      "homePlayer1End"   = 0, "homePlayer2End"   = 0,
      "awayPlayer1End"   = 0, "awayPlayer2End"   = 0
  `
}

// Zeros out all ELO start/end values for a season so it can be recalculated
// from scratch in date order. Defaults to the current season. Deliberately
// includes Lewis Shield fixtures so any ratings written to them by older
// code are wiped — the recalc skips them, leaving the End = 0 sentinel.
exports.resetSeasonElo = async function(seasonName) {
  const sName = seasonName || seasonModel.current()
  await sql`
    UPDATE game SET
      "homePlayer1Start" = 0, "homePlayer2Start" = 0,
      "awayPlayer1Start" = 0, "awayPlayer2Start" = 0,
      "homePlayer1End"   = 0, "homePlayer2End"   = 0,
      "awayPlayer1End"   = 0, "awayPlayer2End"   = 0
    WHERE fixture IN (
      SELECT fixture.id FROM fixture
      JOIN season ON (
        fixture.date > season."startDate"
        AND fixture.date < season."endDate"
        AND season.name = ${sName}
      )
      WHERE fixture.status = 'complete'
    )
  `
}
