const { sql, withRetry } = require('../utils/db_connect');
/*

finding mixedcase column names in sql queries:

find: (?!JOIN|join|oin|concat|oncat)([tamevgsortsinnplyIdhcwvuMkLfx_]{2,20})([uTUkSvwchtNCbamevDgLPsFortsAinWnplyId12]{3,20})
replace: "$1$2"
*/
const seasonModel = require('./season');
const { absoluteUrl } = require('../utils/siteUrl');
const { resultImagePath } = require('../utils/socialPaths');

 exports.createBatch = async function(BatchObj,done){
  if(db.isObject(BatchObj)){
    let bulkobj = BatchObj.data.map(row => {
      // Use reduce() to create an object for each row
      return row.reduce((obj, value, index) => {
          obj[BatchObj.fields[index]] = value; // Assign value to corresponding key
          return obj;
      }, {});
    })
    
    let rows = sql`insert into ${BatchObj.tablename} ${ sql(bulkobj) }`.catch(err => {
      return done(err)
    })
    done(null,rows);
  }
  else{
    return done('not object');
  }
}

// Homepage. Retried on a dead connection — see withRetry in utils/db_connect.js.
exports.getRecent = async function(done){
 try {
  const result = await withRetry(() => sql`SELECT a.date, a."homeTeam", team.name AS "awayTeam", a.address, a."venueName", a."mapLink", a."Lat", a."Lng", a."homeScore", a."awayScore" FROM (SELECT fixture.date, team.name AS "homeTeam", venue.address as address, venue.name as "venueName", venue."gMapUrl" as "mapLink", venue."Lat", venue."Lng", fixture."homeScore", fixture."awayScore", fixture."awayTeam" FROM fixture JOIN team on fixture."homeTeam" = team.id join venue on team.venue = venue.id) AS a JOIN team on a."awayTeam" = team.id AND "homeScore" IS NOT NULL AND date BETWEEN (current_date - 30) AND current_date ORDER BY date`);
  // try/catch rather than the `.catch(err => done(err))` idiom used elsewhere in this
  // file. With that idiom a failure called done(err) and then carried on to
  // done(null, undefined), so the controller took its success branch and rendered
  // after next(err) had already begun the 500 — and being outside the request chain,
  // the resulting throw killed the process rather than producing an error page. The
  // `if (!result) return` guard that used to sit here patched that; try/catch removes
  // the path instead, and is also what lets withRetry's rejection be caught at all.
  done(null,result);
 } catch (err) { done(err); }
}


// Homepage. Retried on a dead connection — see withRetry in utils/db_connect.js.
exports.getOutstandingScorecards = async function(done){
 try {
  const result = await withRetry(() => sql`select * from
(select "homeTeam".name as "homeTeam", "homeTeam".id as "homeId", "awayTeam".name as "awayTeam", "awayTeam".id as "awayId", fixture.date,fixture.status, scorecardstore.id as "scoreCardId" from 
fixture join 
season on fixture.date > season."startDate" AND fixture.date < season."endDate" join 
team "homeTeam" on fixture."homeTeam" = "homeTeam".id join 
team "awayTeam" on fixture."awayTeam" = "awayTeam".id left join
scorecardstore on (fixture.date = scorecardstore.date AND fixture."homeTeam" = scorecardstore."homeTeam" AND fixture."awayTeam" = scorecardstore."awayTeam")
where season.name = ${seasonModel.current()} AND fixture.status not in ('rearranged','rearranging','conceded','void','complete')
order by date) as a 
where date < NOW() and "scoreCardId" is null`);
  done(null,result);
 } catch (err) { done(err); }
}





// Homepage. Retried on a dead connection — see withRetry in utils/db_connect.js.
exports.getupComing = async function(done){
 try {
  const result = await withRetry(() => sql`SELECT distinct on (date, "fixture".id)
    "fixture".id,
    "fixture".date,
    "homeTeam".name AS "homeTeam",
    "homeTeam"."starttime",
    "homeTeam"."endtime",
    "homeClub".name AS "homeClub",
    "homeClub"."clubWebsite",
    "awayTeam".name AS "awayTeam",
    "awayClub".name AS "awayClub",
    "division".name as "divisionName",
    "venue"."Lat",
    "venue"."Lng",
    "venue".name AS "venueName",
    "venue"."address" AS "venueAddress",
    "venue"."gMapUrl" AS "venueLink",
    "fixture"."status",
    "fixture"."homeScore",
    "fixture"."awayScore",
    concat("teamCaptain"."first_name",' ',"teamCaptain"."family_name") as "teamCaptain",
    "teamCaptain".id as "teamCaptainId",
    concat("matchSecretary"."first_name",' ',"matchSecretary"."family_name") as "matchSecretary",
    "matchSecretary".id as "matchSecretaryId"
FROM
    "fixture"
        JOIN
    team "homeTeam" ON "fixture"."homeTeam" = "homeTeam".id
        JOIN
    club "homeClub" ON "homeTeam".club = "homeClub".id
        JOIN
    "venue" ON "homeTeam"."venue" = "venue".id
        JOIN
    team "awayTeam" ON "fixture"."awayTeam" = "awayTeam".id
        JOIN
    club "awayClub" ON "awayTeam".club = "awayClub".id
        JOIN
    "season" ON ("fixture".date > "season"."startDate"
        AND "fixture".date < "season"."endDate")
	left join "player" "teamCaptain" on ("homeTeam".id = "teamCaptain".team AND "teamCaptain"."teamCaptain" = 1)
    left join "player" "matchSecretary" on ("homeClub".id = "matchSecretary".club AND "matchSecretary"."matchSecrertary" = 1)
    join "division" on "homeTeam"."division" = "division".id
WHERE
    "fixture"."homeScore" IS NULL
        AND "fixture"."status" NOT IN ('rearranged' , 'rearranging')
        AND "fixture".date BETWEEN (current_date -1) AND (current_date + 7)
ORDER BY date`);
  done(null,result);
 } catch (err) { done(err); }
}

exports.getFixtureDetails = async function(searchObj, done){
    
    const filterArray = ['season','division','club','team','status','endDate','startDate']
    console.log("passed to getFixtureDetails")
    console.log(searchObj)
    let fixtureObj = {}
    let searchTerms = [];
    let sqlArray = []
    let titleString = ""
    if (searchObj !== undefined){
      for (filter of filterArray){
        //console.log(filter)
        //console.log(Object.entries(searchObj))
        let sqlParams = Object.entries(searchObj).filter(obj => obj[0] === filter)
        if (sqlParams.length > 0){
          fixtureObj[filter] = sqlParams[0][1]
          titleString += sqlParams[0][1]
          //console.log(sqlParams)
        }
      }
      
    }
    
    let season = ""
    let seasonString = seasonModel.current()
    let whereTerms = ""
    searchArray = []
    const checkSeason = function(season){
      let firstYear = parseInt(season.slice(0,4))
      let secondYear = parseInt(season.slice(4))
      // console.log(firstYear+ " "+ secondYear)
      if (secondYear - firstYear != 1){
        return false
      }
      else {
        if (firstYear < 2012 || season == seasonModel.current()){
          return false
        }
        else return true
      }
    }
    if (fixtureObj.season === undefined || !checkSeason(fixtureObj.season)){
      sqlArray.push(seasonModel.current())
    }
    else {
      // checkSeason only checks the name looks like consecutive years since 2012 — it
      // says nothing about whether that season was ever archived. Snapshots only exist
      // from 2023-24, so /results/season-20302031 (or any plausible name in the gap)
      // passed the check, suffixed team20302031, and Postgres answered 42P01. That took
      // the whole process down, not just the request: see the done guard below.
      season = await seasonModel.hasSnapshot(fixtureObj.season) ? fixtureObj.season : ''
      seasonString = fixtureObj.season
      sqlArray.push(fixtureObj.season)
    }
    if (fixtureObj.division !== undefined){
      searchTerms.push('homeTeam.division = ?')
      sqlArray.push(fixtureObj.division)
    }
    if (fixtureObj.club !== undefined){
      searchTerms.push('(homeClub.name = ? OR awayClub.name = ?)')
      sqlArray.push(fixtureObj.club)
      sqlArray.push(fixtureObj.club)
    }
    if (fixtureObj.team !== undefined){
      searchTerms.push('(homeTeam.name = ? OR awayTeam.name = ?)')
      sqlArray.push(fixtureObj.team)
      sqlArray.push(fixtureObj.team)
    }
    if (sqlArray.length > 1){
      whereTerms = " AND " + searchTerms.join(" AND ")
    }
    else {
      whereTerms = ""
    }
    // console.log(`${fixtureObj.endDate.replaceAll('|','-') + ' 00:00:00'}`)
    let result = await sql`select
      fixture."id",
      fixture."date",
      fixture."homeMan1",
      fixture."homeMan2",
      fixture."homeMan3",
      fixture."homeMan4",
      fixture."homeLady1",
      fixture."homeLady2",
      fixture."awayMan1",
      fixture."awayMan2",
      fixture."awayMan3",
      fixture."awayMan4",
      fixture."awayLady1",
      fixture."awayLady2",
      "homeTeam".name as "homeTeam",
      "homeClub".name as "homeClub",
      "homeClub".id as "homeClubId",
      "awayTeam".name as "awayTeam",
      "awayClub".name as "awayClub",
      "homeTeam".division as division,
      division.rank,
      venue."address" as "venueName",
      venue."gMapUrl" as "venueLink",
      fixture."status",
      fixture."homeScore",
      fixture."awayScore",
      fixture."homeTeam" as hometeamid,
      fixture."awayTeam" as awayteamid,
      fixture.lewis_round
      from
      fixture
      ${
        fixtureObj.type == 'eloSetting' 
        ? sql`join game on game.fixture = fixture.id`
        : sql``
      } 
      join ${sql("team" + season)} "homeTeam" on fixture."homeTeam" = "homeTeam".id
      join ${sql("club" + season)} "homeClub" on "homeTeam".club = "homeClub".id
      join venue on "homeTeam".venue = venue.id
      join ${sql("team" + season)} "awayTeam" on fixture."awayTeam" = "awayTeam".id
      join ${sql("club" + season)} "awayClub" on "awayTeam".club = "awayClub".id
      join division on "homeTeam".division = division.id
      join season on (
        fixture."date" > season."startDate"
        and fixture."date" < season."endDate"
      )
      where
      fixture.status in (
        'complete',
        'outstanding',
        'rearranging',
        'rearranged',
        'conceded'
      )
      and season.name = ${ seasonString }
    ${
      fixtureObj.type == 'eloSetting' 
      ? sql`and ((("homePlayer1End" + "homePlayer2End" + "awayPlayer1End" + "awayPlayer2End") = 0) OR ("homePlayer1Start" < 700 OR "homePlayer2Start" < 700 OR "awayPlayer1Start" < 700 OR "awayPlayer2Start" < 700))`
      : sql``
    } 
    ${
        fixtureObj.club !== undefined 
        ? sql`and ("homeClub".name = ${fixtureObj.club} OR "awayClub".name = ${fixtureObj.club})`
        : sql``
    }
    ${
        fixtureObj.team !== undefined 
        ? sql`and ("homeTeam".name = ${fixtureObj.team} OR "awayTeam".name = ${fixtureObj.team})`
        : sql``
    }
    ${
        fixtureObj.division !== undefined 
        ? sql`and "homeTeam".division = ${fixtureObj.division}`
        : sql``
    }
    ${
        fixtureObj.status !== undefined 
        ? sql`and fixture.status = ${fixtureObj.status}`
        : sql``
    }
    ${
        fixtureObj.endDate !== undefined 
        ? sql`and fixture.date < ${fixtureObj.endDate.replaceAll('|','-') + ' 00:00:00'}`
        : sql``
    }
    ${
        fixtureObj.startDate !== undefined 
        ? sql`and fixture.date > ${fixtureObj.startDate.replaceAll('|','-') + ' 00:00:00'}`
        : sql``
    }
    ${
      fixtureObj.type == 'eloSetting' 
      ? sql`group by fixture.id`
      : sql``
    } 
    order by fixture.date asc`.catch(err => {
      console.log(err.query)
      return done(err)
    })
    // The catch above has already called done(err). Without this guard done fired again
    // as done(null, undefined) and every caller took the success branch on nothing:
    // fixtureController's `result.filter(...)` threw, and being in a model callback
    // rather than the request chain that throw escaped Express and killed the process.
    // This is the other half of Sentry TAMESIDE-NODE-1 — commit 35e76358 guarded
    // `result` being an empty array, which is a different case from `result` being
    // undefined, and only the first was reachable from an empty filter combination.
    if (!result) { return; }
    done(null,result);
}

    
exports.createScorecard = async function(fixtureObj,done){
  console.log(fixtureObj)
  if (fixtureObj.date === undefined || fixtureObj.homeTeam === undefined || fixtureObj.awayTeam === undefined){
    return done(new Error("createScorecard: missing required fields (date, homeTeam, awayTeam)"));
  }
  let result;
  try {
    result = await sql`insert into scorecardstore ${sql(fixtureObj)} returning id`;
  } catch (err) {
    return done(err);
  }
  console.log(result.statement.string)
  done(null,result);
}

// The `.catch(err => done(err))` idiom this used to use called done(err) and then fell
// through to `result.statement.string` on an undefined result — so a DB error threw
// outside the request chain and killed the process, and on the happy path it logged the
// full SQL on every call. try/catch removes the path rather than guarding it.
exports.getScorecardById = async function(fixtureId,done){
  try {
    const result = await sql`SELECT * FROM scorecardstore WHERE "id" = ${fixtureId}`;
    done(null, result);
  } catch (err) {
    done(err);
  }
}

// All seasons oldest-first — used by the ELO backfill and season pickers.
exports.getAllSeasons = async function(){
  return await sql`SELECT name, "startDate", "endDate" FROM season ORDER BY "startDate" ASC`
}

exports.getOutstandingFixtureId = async function(obj,done){
  if(typeof obj.homeTeam !== undefined && typeof obj.awayTeam !== undefined){
    // var sql = 'select id from (select fixture.id, homeTeam, awayTeam, status from fixture join season where season.name=? AND fixture.date > season.startDate) as a where awayTeam = ? AND homeTeam = ? AND status = "outstanding"';
    console.log(`select a.id, division.name, division.rank from (SELECT id, homeTeam FROM (SELECT fixture.id, homeTeam, awayTeam, status FROM fixture JOIN season on season.name = ${seasonModel.current()} AND fixture.date > season.startDate) AS a WHERE awayTeam = ${obj.awayTeam} AND homeTeam = ${obj.homeTeam} AND status like 'outstanding') as a join team on a.homeTeam = team.id join division on team.division = division.id`)
    let result = await sql`select a.id, division.name, division.rank, a.lewis_round from (SELECT id, "homeTeam", lewis_round FROM (SELECT fixture.id, "homeTeam", "awayTeam", status, lewis_round FROM fixture JOIN season on season.name like ${seasonModel.current()} AND fixture.date > season."startDate") AS a WHERE "awayTeam" = ${obj.awayTeam} AND "homeTeam" = ${obj.homeTeam} AND status like 'outstanding') as a join team on a."homeTeam" = team.id join division on team.division = division.id`.catch(err => {
      return done(err)
    })
    console.log(result.statement.string)
    if (!result.length){
        return done("no matching fixtures")
    }
    else if (!result[0].id){
      return done("no matching fixtures")
    }
    else {
        // console.log(result);
        done(null,result);
    }
    }
    else {
      return done(err);
    }
  }

  exports.updateById = async function(fixtureObj,fixtureId,done){
    if (typeof fixtureObj !== undefined){
      let rows = await sql`
        update fixture set ${
          sql(fixtureObj, Object.keys(fixtureObj))
        }
        where id = ${ fixtureId }
      `.catch(err => {
        console.log(err.query)
        console.log(err)
        return done(err)
      })
      done(null,rows);
    }
    else {
      return done(err);
    }
  
  }

  exports.getFixtureDetailsById = async function(fixtureId,done){
    let rows = await sql`Select a."fixtureId", a.date, a."homeTeam",  team.name as "awayTeam", a.status, a."homeScore", a."awayScore" from (select team.name as "homeTeam", fixture.id as "fixtureId", fixture.date as date, fixture."awayTeam", fixture.status, fixture."homeScore",fixture."awayScore" from  fixture join team on team.id = fixture."homeTeam") as a join team on team.id = a."awayTeam" AND "fixtureId" = ${fixtureId}`.catch(err => {
        return done(err)
      })
      done(null,rows);
  }

  // Fixture header: the date, the two team names and the final score, and nothing else.
  // Deliberately LEFT JOINs, and deliberately separate from getFixtureEventById and
  // getScorecardDataById — both of those INNER JOIN their way to zero rows for fixtures
  // that do exist (see the notes on each), which makes "fixture does not exist"
  // indistinguishable from "a joined row is missing". A heavyweight query with inner
  // joins can't be used as an existence check. This one can: zero rows here means the
  // fixture genuinely isn't there, and the caller can 404 on that.
  exports.getFixtureSummaryById = async function(fixtureId,done){
    let rows = await sql`SELECT
      fixture.id,
      fixture.date,
      fixture.status,
      fixture."homeScore",
      fixture."awayScore",
      "homeTeam".name AS "homeTeam",
      "awayTeam".name AS "awayTeam"
    FROM fixture
    LEFT JOIN team "homeTeam" ON fixture."homeTeam" = "homeTeam".id
    LEFT JOIN team "awayTeam" ON fixture."awayTeam" = "awayTeam".id
    WHERE fixture.id = ${fixtureId}`.catch(err => {
      return done(err)
    })
    if (!rows) { return; }
    done(null,rows);
  }

  // NOTE: every join below is an INNER join against the LIVE team/club/division tables.
  // Archived seasons live in suffixed snapshots (team20232024, club20232024, ...), so
  // every fixture from a past season returns zero rows here — 98 of 652 fixtures at the
  // time of writing, all of them 2023-24. Callers must not read [0] unguarded (that was
  // Sentry TAMESIDE-NODE-2, 308 events). Making the archive render properly means
  // resolving the season from fixture.date and joining the suffixed tables; LEFT JOINing
  // instead would only produce an event page with blank team and venue names.
  exports.getFixtureEventById = async function(fixtureId,done){
    let rows = await sql`SELECT 
    "fixture".id,
    "fixture".date,
    "homeTeam".name AS "homeTeam",
    "homeTeam"."starttime" as "startTime",
    "homeTeam"."endtime" as "endTime",
    "homeClub".name AS "homeClub",
    "homeClub"."clubWebsite",
    "awayTeam".name AS "awayTeam",
    "awayClub".name AS "awayClub",
    "division".name as "divisionName",
    "venue".name AS "venueName",
    "venue"."address" AS "venueAddress",
    "venue"."gMapUrl" AS "venueLink",
    "venue"."Lat",
    "venue"."Lng",
    "venue"."placeId",
    "fixture"."status",
    "fixture"."homeScore",
    "fixture"."awayScore",
    concat("teamCaptain"."first_name",' ',"teamCaptain"."family_name") as "teamCaptain",
    "teamCaptain".id as "teamCaptainId",
    concat("matchSecretary"."first_name",' ',"matchSecretary"."family_name") as "matchSecretary",
    "matchSecretary".id as "matchSecretaryId"
FROM
    "fixture"
        JOIN
    team "homeTeam" ON "fixture"."homeTeam" = "homeTeam".id
        JOIN
    club "homeClub" ON "homeTeam".club = "homeClub".id
        JOIN
    "venue" ON "homeTeam"."venue" = "venue".id
        JOIN
    team "awayTeam" ON "fixture"."awayTeam" = "awayTeam".id
        JOIN
    club "awayClub" ON "awayTeam".club = "awayClub".id
        JOIN
    "season" ON ("fixture".date > "season"."startDate"
        AND "fixture".date < "season"."endDate")
	left join "player" "teamCaptain" on ("homeTeam".id = "teamCaptain".team AND "teamCaptain"."teamCaptain" = 1)
    left join "player" "matchSecretary" on ("homeClub".id = "matchSecretary".club AND "matchSecretary"."matchSecrertary" = 1)
    join "division" on "homeTeam"."division" = "division".id
WHERE
    "fixture".id = ${fixtureId}`.catch(err => {
        return done(err)
      })
      if (!rows) { return; }
      done(null,rows);
  }

  exports.getMatchPlayerOrderDetails = async function(fixtureObj,done){
    var searchTerms = [];
    var sqlArray = []
    // Excluding the current season isn't enough — a name can look valid and still have
    // no team<season>/club<season> snapshot (snapshots start at 2023-24). Same 42P01
    // process-kill as getFixtureDetails above.
    var seasonName = await seasonModel.hasSnapshot(fixtureObj.season) ? fixtureObj.season : ''
    let rows = await sql`SELECT c.*
FROM (SELECT "fixturePlayers".*, club.name
    FROM (SELECT "playerNames".id, "playerNames".date, "homeTeam".name as "teamName", "homeTeam".id as "teamId", "homeTeam".club as "clubId", "awayTeam".name as "oppositionName", "playerNames"."Man1", "playerNames"."Man1Rank", "Man1Team".name as "Man1TeamName", "playerNames"."Man2", "playerNames"."Man2Rank", "Man2Team".name as "Man2TeamName", "playerNames"."Man3", "playerNames"."Man3Rank", "Man3Team".name as "Man3TeamName", "playerNames"."Man4", "playerNames"."Man4Rank", "Man4Team".name as "Man4TeamName", "playerNames"."Lady1", "playerNames"."Lady1Rank", "Lady1Team".name as "Lady1TeamName", "playerNames"."Lady2", "playerNames"."Lady2Rank", "Lady2Team".name as "Lady2TeamName"
        FROM (                
            SELECT fixture.id, fixture.date, fixture."homeTeam" AS "Team", fixture."awayTeam" AS "Opposition", CONCAT("homeMan1".first_name, ' ', "homeMan1".family_name) AS "Man1", "homeMan1".rank AS "Man1Rank", "homeMan1".team AS "Man1TeamId", CONCAT("homeMan2".first_name, ' ', "homeMan2".family_name) AS "Man2", "homeMan2".rank AS "Man2Rank", "homeMan2".team AS "Man2TeamId", CONCAT("homeMan3".first_name, ' ', "homeMan3".family_name) AS "Man3", "homeMan3".rank AS "Man3Rank", "homeMan3".team AS "Man3TeamId", CONCAT("homeMan4".first_name, ' ', "homeMan4".family_name) AS "Man4", "homeMan4".rank AS "Man4Rank", "homeMan4".team AS "Man4TeamId", CONCAT("homeLady1".first_name, ' ', "homeLady1".family_name) AS "Lady1", "homeLady1".rank AS "Lady1Rank", "homeLady1".team AS "Lady1TeamId", CONCAT("homeLady2".first_name, ' ', "homeLady2".family_name) AS "Lady2", "homeLady2".rank AS "Lady2Rank", "homeLady2".team AS "Lady2TeamId"
                FROM fixture JOIN player "homeMan1" ON fixture."homeMan1" = "homeMan1".id JOIN player "homeMan2" ON fixture."homeMan2" = "homeMan2".id JOIN player "homeMan3" ON fixture."homeMan3" = "homeMan3".id JOIN player "homeMan4" ON fixture."homeMan4" = "homeMan4".id JOIN player "homeLady1" ON fixture."homeLady1" = "homeLady1".id JOIN player "homeLady2" ON fixture."homeLady2" = "homeLady2".id
            UNION ALL
                SELECT fixture.id, fixture.date, fixture."awayTeam" AS "Team", fixture."homeTeam" AS "Opposition", CONCAT("awayMan1".first_name, ' ', "awayMan1".family_name) AS "Man1", "awayMan1".rank AS "Man1Rank", "awayMan1".team AS "Man1TeamId", CONCAT("awayMan2".first_name, ' ', "awayMan2".family_name) AS "Man2", "awayMan2".rank AS "Man2Rank", "awayMan2".team AS "Man2TeamId", CONCAT("awayMan3".first_name, ' ', "awayMan3".family_name) AS "Man3", "awayMan3".rank AS "Man3Rank", "awayMan3".team AS "Man3TeamId", CONCAT("awayMan4".first_name, ' ', "awayMan4".family_name) AS "Man4", "awayMan4".rank AS "Man4Rank", "awayMan4".team AS "Man4TeamId", CONCAT("awayLady1".first_name, ' ', "awayLady1".family_name) AS "Lady1", "awayLady1".rank AS "Lady1Rank", "awayLady1".team AS "Lady1TeamId", CONCAT("awayLady2".first_name, ' ', "awayLady2".family_name) AS "Lady2", "awayLady2".rank AS "Lady2Rank", "awayLady2".team AS "Lady2TeamId"
                FROM fixture JOIN player "awayMan1" ON fixture."awayMan1" = "awayMan1".id JOIN player "awayMan2" ON fixture."awayMan2" = "awayMan2".id JOIN player "awayMan3" ON fixture."awayMan3" = "awayMan3".id JOIN player "awayMan4" ON fixture."awayMan4" = "awayMan4".id JOIN player "awayLady1" ON fixture."awayLady1" = "awayLady1".id JOIN player "awayLady2" ON fixture."awayLady2" = "awayLady2".id) AS "playerNames" join ${sql("team" + seasonName)}  "homeTeam" ON "playerNames"."Team" = "homeTeam".id join ${sql("team" + seasonName)}  "awayTeam" ON "playerNames"."Opposition" = "awayTeam".id join ${sql("team" + seasonName)}  "Man1Team" on "playerNames"."Man1TeamId" = "Man1Team".id join ${sql("team" + seasonName)}  "Man2Team" on "playerNames"."Man2TeamId" = "Man2Team".id join ${sql("team" + seasonName)}  "Man3Team" on "playerNames"."Man3TeamId" = "Man3Team".id join ${sql("team" + seasonName)}  "Man4Team" on "playerNames"."Man4TeamId" = "Man4Team".id join ${sql("team" + seasonName)}  "Lady1Team" on "playerNames"."Lady1TeamId" = "Lady1Team".id join ${sql("team" + seasonName)}  "Lady2Team" on "playerNames"."Lady2TeamId" = "Lady2Team".id) AS "fixturePlayers" join ${sql("club" + seasonName)} club ON club.id = "fixturePlayers"."clubId") AS c join season on
    ${
      fixtureObj.club !== undefined 
        ? sql` c.name like ${fixtureObj.club}`
        : sql` c.name like '%'`
    }
    ${
      fixtureObj.team !== undefined 
        ? sql` and c."teamName" like ${fixtureObj.team}`
        : sql``
    }
    ${
      !fixtureObj.season || fixtureObj.season == seasonModel.current() 
      ? sql` and season.name = ${seasonModel.current()} AND c.date > season."startDate" AND c.date < season."endDate"`
      : sql` and season.name = ${fixtureObj.season} AND c.date > season."startDate" AND c.date < season."endDate"`
    }
    ORDER BY "teamName" , date DESC
    ${
      !fixtureObj.limit
      ? sql``
      : sql` limit ${fixtureObj.limit}`
    }
    `.catch(err => {
      // console.log(err)
      // console.log(err.query)
      return done(err)
    })
    // See the note on the same guard in getFixtureDetails: without it a failed query
    // called done twice and the controller's row.map killed the process.
    if (!rows) { return; }
    done(null,rows);
  }

  /**
   * Post one result to the league's own Facebook page and Instagram account.
   *
   * Each target succeeds or fails on its own — `publishEverywhere` collects rather than
   * throwing on the first failure — because **a post that reached Facebook and not
   * Instagram has still reached Facebook**, and a retry that re-posted it would be worse
   * than the gap.
   *
   * Throws only when EVERY target failed, or when none is configured at all.
   */
  async function publishResultToMeta({ imgGen, message }) {
    const meta = require('../utils/metaPublisher');
    const configured = meta.configuredTargets();

    // **No targets is a failure, not a quiet success.** `SOCIAL_POST_DIRECT` lives in the
    // Cloud Run service config and the credentials live in `.env`, which is gitignored and
    // never deployed — so setting the flag without copying the credentials across is the
    // easy mistake, and on the Stockport side it produced a service that took the direct
    // path, found nothing to post to, posted nowhere, and reported success. An empty target
    // list produces neither a post nor a failure, which is the shape this pair of codebases
    // keeps getting caught by: a rejection that looks like an acceptance.
    //
    // There is deliberately NO fallback to Make.com. A fallback hides the misconfiguration
    // until it bites somewhere less convenient.
    if (!configured.length) {
      throw new Error(
        'SOCIAL_POST_DIRECT is set but no Meta credentials are configured, so this result ' +
        'would have been posted nowhere. Set META_TAMESIDE_PAGE_ID and ' +
        'META_TAMESIDE_PAGE_TOKEN on the service, or unset SOCIAL_POST_DIRECT to go back ' +
        'through Make.com.');
    }

    const out = await meta.publishEverywhere(configured, { imageUrls: imgGen, message });

    for (const f of out.failed) console.error(`result post to ${f.target} failed:`, f.error.message);
    if (out.posted.length) console.log('result posted to', out.posted.map(p => p.target).join(', '));

    if (!out.posted.length && out.failed.length) throw out.failed[0].error;
    return out;
  }

  /**
   * Announce a published result — directly to Meta, or through the Make.com webhook.
   *
   * ── This never calls back with an error, and that is deliberate ─────────────
   *
   * The result is already committed by the time this runs, and the caller in
   * fixtureController is a nest of `if (err) res.send(err)` with no `return`: an error here
   * used to send a body and then carry on to `res.render`, which throws
   * ERR_HTTP_HEADERS_SENT from inside a callback — outside the request chain, so it kills
   * the process. A captain would see a failure for a submission that had worked, if the
   * container survived long enough to tell him.
   *
   * So a social-post failure is loud in the logs and in Sentry, and silent in the response.
   * The Stockport site reaches the same place via `utils/afterCommit.js`; this repo has no
   * equivalent, so the separation is made here.
   */
  exports.sendResultZap = async function(zapObject, done){
    if (typeof zapObject.homeTeam === 'undefined') {
      return done(null, { sent: false, reason: "no homeTeam — nothing to announce" });
    }
    if (zapObject.host == '127.0.0.1:8080'){
      console.log("zap not sent!");
      return done(null, { sent: false, reason: 'test env' });
    }

    // Built through the helper and percent-encoded. Interpolated raw, "Hyde A" puts a
    // literal space in the URL and Facebook answers `Missing or invalid image file
    // (324, OAuthException)` — the endpoint is fine, the URL is not. This was interpolated
    // by hand here and, separately, in views/fixtures-results.ejs, which is exactly why it
    // is a function now.
    const imgGen = absoluteUrl(resultImagePath(zapObject));
    // `#tbl`, not `#tdbl`. Two spellings were live: the result CARD draws `#tbl`
    // (controllers/social_controller.js) and this message posted `#tdbl`, so the same
    // result went out hashtagged two different ways. `#tbl` is the one the league uses.
    const message = `Result: ${zapObject.homeTeam} vs ${zapObject.awayTeam} : ${zapObject.homeScore}-${zapObject.awayScore} #tameside #badminton #tbl #result #bulutangkis #badminton🏸 #badmintonclub https://tameside-badminton.co.uk`;

    try {
      // ── Direct, or through Make.com ──────────────────────────────────────────
      //
      // `SOCIAL_POST_DIRECT=true` posts from here instead of handing the job to a Make.com
      // scenario, and turning one on turns the other off — they are the same change, not
      // two. **No Make edit is needed, now or later**: that scenario is webhook-triggered
      // and routes on `imgUrl` containing `tameside-badminton`, so when we stop sending,
      // our route simply stops firing. Stockport's already has.
      //
      // Unset keeps the old path, so a rollback is one environment variable rather than one
      // deploy — which matters because this runs when a captain publishes a result, and a
      // bad week is a week of missing posts nobody notices.
      if (process.env.SOCIAL_POST_DIRECT === 'true') {
        const out = await publishResultToMeta({ imgGen, message });
        return done(null, { sent: true, via: 'meta', posted: out.posted.map(p => p.target) });
      }

      await fetch('https://hook.integromat.com/uihmc7g54i8xrvdvpsec2f6ejfqul70g', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imgGen,
          message,
          // `imgUrl` used to name a PNG under /static/images/generated/ — the container's
          // own disk, so it 404'd for anything but the instance that drew it. Pointed at
          // `imgGen` rather than deleted, because removing a field from a live webhook
          // payload is a change to somebody else's scenario: this way a step that reads it
          // starts working instead of failing, and it still contains `tameside-badminton`,
          // which is what the scenario routes on. Drop it once Make is retired.
          imgUrl: imgGen,
        })
      });

      // The self-fetch of the image that used to sit here is gone. It pulled ~150KB back
      // as a *string* purely to make the route write its PNG to local disk, and handed that
      // string to the callback, which ignores it. Make fetches `imgGen` itself.
      return done(null, { sent: true, via: 'make.com' });
    } catch (err) {
      console.error('result announcement failed:', err.message);
      try { require('@sentry/node').captureException(err); } catch (_) { /* Sentry is a no-op without a DSN */ }
      return done(null, { sent: false, reason: err.message });
    }
  }

  exports.rearrangeByTeamNames = async function(updateObj,done){
    if(typeof updateObj !== undefined){
      let rows = await sql`
      ${
        (updateObj.date == null || updateObj.date == "")
        ? sql`UPDATE fixture SET status = 'rearranging'`
        : sql`UPDATE fixture SET status = 'rearranged'`
      } WHERE id = ( 
select fixture.id from fixture join 
season on (fixture.date > season."startDate" and fixture.date < season."endDate")
join team "homeTeam" on fixture."homeTeam" = "homeTeam".id 
join team "awayTeam" on fixture."awayTeam" = "awayTeam".id
where season.name like ${seasonModel.current()} and status = 'outstanding' and "homeTeam".name like ${updateObj.hometeam} and "awayTeam".name like ${updateObj.awayteam} limit 1);`.catch(err => {
        console.log(err)
        console.log(err.query)
        return done(err)
      })
      if (updateObj.date != null && updateObj.date != "") {
        let result = await sql`INSERT INTO fixture ("homeTeam", "awayTeam", "date", "status") VALUES ((Select id from team where name like ${updateObj.hometeam}), (SELECT id from team where name like ${updateObj.awayteam}), ${updateObj.date}, 'outstanding');`.catch(err => {
          console.log(err)
          console.log(err.query)
          return done(err)
        })
        done(null,result);
      }
      else {
        done(null,rows)
      } 
      
    }
    else {
      return done(err);
    }
  }


  // NOTE: this INNER JOINs `game`, so it returns nothing for a fixture whose individual
  // games were never recorded — 366 of 652 fixtures at the time of writing. Most are the
  // 2023-24 archive (180/180, predating game-level capture) and the unplayed 2026-27
  // season, but 42 are conceded/void fixtures in seasons that DO have game data, so this
  // keeps happening. Zero rows here does not mean the fixture is absent; use
  // getFixtureSummaryById for that. (Sentry TAMESIDE-NODE-3.)
  exports.getScorecardDataById = async function(fixtureId,done){
   let result = await sql`select "fixture".date,
"homeTeam".name as "homeTeam",
"awayTeam".name as "awayTeam",
concat("homePlayer1"."first_name", ' ',"homePlayer1"."family_name") as "homePlayer1",
concat("homePlayer2"."first_name", ' ',"homePlayer2"."family_name") as "homePlayer2",
concat("awayPlayer1"."first_name", ' ',"awayPlayer1"."family_name") as "awayPlayer1",
concat("awayPlayer2"."first_name", ' ',"awayPlayer2"."family_name") as "awayPlayer2",
game."homeScore" as "homeScore",
game."awayScore" as "awayScore",
"fixture"."homeScore" as "totalHomeScore",
"fixture"."awayScore" as "totalAwayScore"
from 
"fixture" join 
team "homeTeam" on "fixture"."homeTeam" = "homeTeam".id join
team "awayTeam" on "fixture"."awayTeam" = "awayTeam".id join
game on game."fixture" = ${fixtureId} AND game."fixture" = "fixture".id join
"player" "homePlayer1" on game."homePlayer1" = "homePlayer1".id join
"player" "homePlayer2" on game."homePlayer2" = "homePlayer2".id join
"player" "awayPlayer1" on game."awayPlayer1" = "awayPlayer1".id join
"player" "awayPlayer2" on game."awayPlayer2" = "awayPlayer2".id
order by game.id`.catch(err => {
        console.log(err)
        console.log(err.query)
        return done(err)
      })
      if (!result) { return; }
      done(null,result);
  }


  exports.getMissingScorecardPhotos = async function(email,done){
    let result = await sql`select
  fixture.id as fixtureid,
  fixture.status,
  scorecardstore.id,
  scorecardstore.date,
  scorecardstore."scoresheet-url",
  scorecardstore.email,
  "homeTeam".name as "homeTeam",
  "awayTeam".name as "awayTeam"
from
  scorecardstore
  join team "homeTeam" on scorecardstore."homeTeam" = "homeTeam".id
  join team "awayTeam" on scorecardstore."awayTeam" = "awayTeam".id
  join fixture on (
    scorecardstore.date = fixture.date
    and fixture."homeTeam" = scorecardstore."homeTeam"
    AND fixture."awayTeam" = scorecardstore."awayTeam"
  )
where
  "scoresheet-url" = ''
  ${
    email == 'stockport.badders.results@gmail.com' ? 
    sql`` :
    sql`and email = ${email} 
  and status not like 'complete'`
  }
`.catch(err => {
         console.log(err)
         console.log(err.query)
         return done(err)
       })
       done(null,result);
   }

   exports.updateScorecardPhoto = async function(id,imgurl,done){
    let result = await sql`update scorecardstore set "scoresheet-url" = ${imgurl} where id = ${id}`
    .catch(err => {
      console.log(err)
      console.log(err.query)
      return done(err)
    })
    done(null,result);
}

/* ------------------------------------------------------------------ *
 * The two weekly social posts.
 *
 * Both return a promise rather than taking a `done` callback, because both
 * callers are `async` controllers. The callback style in the rest of this
 * file exists for the older render paths; there is nothing to be gained by
 * wrapping a promise in a callback and then promisifying it again at the
 * other end.
 *
 * **Both windows are computed in SQL, in Europe/London, and neither goes
 * anywhere near a JS Date.** `fixture.date` is a timestamp at local midnight,
 * so a JS-side window built with `new Date()` slips a day under BST — the
 * same trap the registration digest's hand-rolled date formatting exists to
 * avoid. `date_trunc('day', NOW() AT TIME ZONE 'Europe/London')` gives the
 * calendar day the league is actually on.
 * ------------------------------------------------------------------ */

/**
 * The coming week's fixtures, for the Sunday fixtures post.
 *
 * `dayLabel` is formatted in SQL for the same reason the window is: the card
 * groups its rows under a night heading and prints a date range in the
 * header, and both have to agree with the rows underneath them. Formatting
 * in Postgres means one answer, in one timezone, with no ICU version of
 * Node able to change its shape underneath the picture.
 *
 * Unplayed only (`homeScore IS NULL`) and never a fixture that is being
 * moved: announcing a match that has already been rearranged away is worse
 * than announcing nothing.
 */
exports.getUpcomingWeek = async function () {
  return await sql`SELECT
      fixture.id,
      fixture.date,
      to_char(fixture.date, 'Dy FMDD Mon') AS "dayLabel",
      "homeTeam".name AS "homeTeam",
      "awayTeam".name AS "awayTeam",
      "homeClub".name AS "homeClub",
      "awayClub".name AS "awayClub",
      division.name AS "divisionName"
    FROM fixture
      JOIN team "homeTeam" ON fixture."homeTeam" = "homeTeam".id
      JOIN team "awayTeam" ON fixture."awayTeam" = "awayTeam".id
      LEFT JOIN club "homeClub" ON "homeTeam".club = "homeClub".id
      LEFT JOIN club "awayClub" ON "awayTeam".club = "awayClub".id
      LEFT JOIN division ON "homeTeam".division = division.id
    WHERE fixture."homeScore" IS NULL
      AND fixture.status NOT IN ('rearranged', 'rearranging')
      AND fixture.date >= date_trunc('day', NOW() AT TIME ZONE 'Europe/London')
      AND fixture.date <  date_trunc('day', NOW() AT TIME ZONE 'Europe/London') + INTERVAL '7 days'
    ORDER BY fixture.date, "homeTeam".name`;
};

/**
 * The week just gone, for the results video.
 *
 * The seven days ENDING today, so a result published this morning is in
 * the video that goes out this afternoon.
 *
 * **`- 6 days`, not `- 7`.** Today counts as one of the seven, so seven
 * days back from the start of today spans eight calendar days and
 * consecutive weekly runs overlap by one. Checked against the real
 * schedule: a run on Mon 21 Sep covered 14-21 Sep and a run on Mon 28
 * covered 21-28, so a Monday result entered before the 18:00 post
 * appeared in two consecutive videos. Most of this league's fixtures
 * are played Monday to Wednesday, so the overlapping day is not a
 * quiet one.
 *
 * `homeScore IS NOT NULL` rather than a status test. A conceded match has a
 * score and belongs in the video; a match sitting at 'complete' with no score
 * entered is a card reading "null - null", which is precisely the class of
 * silent wrongness that produced the `NaN` column on the league tables.
 */
exports.getWeekResults = async function () {
  return await sql`SELECT
      fixture.id,
      fixture.date,
      to_char(fixture.date, 'Dy FMDD Mon') AS "dayLabel",
      "homeTeam".name AS "homeTeam",
      "awayTeam".name AS "awayTeam",
      fixture."homeScore",
      fixture."awayScore",
      division.name AS "divisionName"
    FROM fixture
      JOIN team "homeTeam" ON fixture."homeTeam" = "homeTeam".id
      JOIN team "awayTeam" ON fixture."awayTeam" = "awayTeam".id
      LEFT JOIN division ON "homeTeam".division = division.id
    WHERE fixture."homeScore" IS NOT NULL
      AND fixture."awayScore" IS NOT NULL
      AND fixture.status NOT IN ('rearranged', 'rearranging', 'void')
      AND fixture.date >= date_trunc('day', NOW() AT TIME ZONE 'Europe/London') - INTERVAL '6 days'
      AND fixture.date <  date_trunc('day', NOW() AT TIME ZONE 'Europe/London') + INTERVAL '1 day'
    ORDER BY fixture.date, "homeTeam".name`;
};
