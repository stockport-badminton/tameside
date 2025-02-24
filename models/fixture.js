let postgres = require('postgres')
const sql = postgres(`postgres://postgres.tdsvugmbkgakgbtmoajj:${encodeURIComponent(process.env.PGPASSWORD)}@aws-0-eu-west-2.pooler.supabase.com:5432/postgres`,{ ssl : { rejectUnauthorized : false }})
var request = require('request');
/*

finding mixedcase column names in sql queries:

find: (?!JOIN|join|oin|concat|oncat)([tamevgsortsinnplyIdhcwvuMkLfx_]{2,20})([uTUkSvwchtNCbamevDgLPsFortsAinWnplyId12]{3,20})
replace: "$1$2"
*/
let  SEASON = '';
 if (new Date().getMonth() < 6){
   SEASON = '' + new Date().getFullYear()-1 +''+ new Date().getFullYear();
 }
 else {
   SEASON = '' + new Date().getFullYear() +''+ (new Date().getFullYear()+1);
 }

 //console.log(SEASON)

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

exports.getRecent = async function(done){
  let result = await sql`SELECT a.date, a."homeTeam", team.name AS "awayTeam", a.address, a."venueName", a."mapLink", a."Lat", a."Lng", a."homeScore", a."awayScore" FROM (SELECT fixture.date, team.name AS "homeTeam", venue.address as address, venue.name as "venueName", venue."gMapUrl" as "mapLink", venue."Lat", venue."Lng", fixture."homeScore", fixture."awayScore", fixture."awayTeam" FROM fixture JOIN team on fixture."homeTeam" = team.id join venue on team.venue = venue.id) AS a JOIN team on a."awayTeam" = team.id AND "homeScore" IS NOT NULL AND date BETWEEN (current_date - 30) AND current_date ORDER BY date`.catch(err => {
      return done(err)
    })
    console.log(result.statement.query)
    done(null,result);
}

exports.getOutstandingResults = async function(done){
  let result = await sql`SELECT a.id, a.date, a."homeTeam", a."homeTeamId", team.name AS "awayTeam", team.id AS "awayTeamId", a."homeScore", a."awayScore" FROM (SELECT fixture.id, fixture.date, team.name AS "homeTeam", team.id AS "homeTeamId", fixture."homeScore", fixture."awayScore", fixture."awayTeam" FROM fixture JOIN team WHERE fixture."homeTeam" = team.id AND fixture.status NOT IN ('rearranged' , 'rearranging')) AS a JOIN team WHERE a."awayTeam" = team.id AND "homeScore" IS NULL AND date BETWEEN ADDDATE(NOW(), - 7) AND ADDDATE(NOW(), 1) ORDER BY date`.catch(err => {
      return done(err)
    })
    console.log(result.statement.query)
    done(null,result);
}




exports.getCardsDueToday = async function(done){
  let result = await sql`select "fixId", date, status, "homeTeam", team.name as "awayTeam", "homeScore", "awayScore" from  (select fixture.id as "fixId", fixture.date, fixture.status, team.name as "homeTeam", fixture."homeScore", fixture."awayScore", fixture."awayTeam" from fixture join team where fixture."homeTeam" = team.id AND fixture.status not in ('rearranged','rearranging')) as a join team where a."awayTeam" = team.id AND "homeScore" is null AND date between (current_date -7) and (current_date -6) order by date`.catch(err => {
      return done(err)
    })
    console.log(result.statement.query)
    done(null,result);
}

exports.getupComing = async function(done){
  let result = await sql`SELECT distinct on (date, "fixture".id)
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
	join "player" "teamCaptain" on ("homeTeam".id = "teamCaptain".team AND "teamCaptain"."teamCaptain" = 1)
    join "player" "matchSecretary" on ("homeClub".id = "matchSecretary".club AND "matchSecretary"."matchSecrertary" = 1)
    join "division" on "homeTeam"."division" = "division".id
WHERE
    "fixture"."homeScore" IS NULL
        AND "fixture"."status" NOT IN ('rearranged' , 'rearranging')
        AND "fixture".date BETWEEN (current_date -1) AND (current_date + 7)
ORDER BY date`.catch(err => {
      return done(err)
    })
    // console.log(result.statement.query)
    done(null,result);
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
    let seasonString = SEASON
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
        if (firstYear < 2012 || season == SEASON){
          return false
        }
        else return true
      }
    }
    if (fixtureObj.season === undefined || !checkSeason(fixtureObj.season)){
      sqlArray.push(SEASON)
    }
    else {
      season = fixtureObj.season
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
      fixture."awayTeam" as awayteamid
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
    //console.log(result.statement.string)
    done(null,result);
}

exports.createBatch = async function(BatchObj,done){
  if(db.isObject(BatchObj)){
    let bulkobj = BatchObj.data.map(row => {
      // Use reduce() to create an object for each row
      return row.reduce((obj, value, index) => {
          obj[BatchObj.fields[index]] = value; // Assign value to corresponding key
          return obj;
      }, {});
    })
    
    let rows = sql`insert into ${sql(BatchObj.tablename)} ${ sql(bulkobj) }`.catch(err => {
      return done(err)
    })
    done(null,rows);
  }
  else{
    return done('not object');
  }
}
    
exports.createScorecard = async function(fixtureObj,done){
  console.log(fixtureObj)
  if (typeof fixtureObj.date !== undefined && typeof fixtureObj.homeTeam !== undefined && typeof fixtureObj.awayTeam !== undefined){
    let result = await sql`insert into scorecardstore ${sql(fixtureObj)} returning id`.catch(err => {
      return done(err)
    })
    console.log(result.statement.string)
    done(null,result);
  }
  else {
    return done(err);
  }
}

exports.getScorecardById = async function(fixtureId,done){
  let result = await sql`SELECT * FROM scorecardstore WHERE "id" = ${fixtureId}`.catch(err => {
    return done(err)
  })
  console.log(result.statement.string)
  done(null,result);
  
}

exports.getOutstandingFixtureId = async function(obj,done){
  if(typeof obj.homeTeam !== undefined && typeof obj.awayTeam !== undefined){
    // var sql = 'select id from (select fixture.id, homeTeam, awayTeam, status from fixture join season where season.name=? AND fixture.date > season.startDate) as a where awayTeam = ? AND homeTeam = ? AND status = "outstanding"';
    console.log(`select a.id, division.name, division.rank from (SELECT id, homeTeam FROM (SELECT fixture.id, homeTeam, awayTeam, status FROM fixture JOIN season on season.name = ${SEASON} AND fixture.date > season.startDate) AS a WHERE awayTeam = ${obj.awayTeam} AND homeTeam = ${obj.homeTeam} AND status like 'outstanding') as a join team on a.homeTeam = team.id join division on team.division = division.id`)
    let result = await sql`select a.id, division.name, division.rank from (SELECT id, "homeTeam" FROM (SELECT fixture.id, "homeTeam", "awayTeam", status FROM fixture JOIN season on season.name like ${SEASON} AND fixture.date > season."startDate") AS a WHERE "awayTeam" = ${obj.awayTeam} AND "homeTeam" = ${obj.homeTeam} AND status like 'outstanding') as a join team on a."homeTeam" = team.id join division on team.division = division.id`.catch(err => {
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
	join "player" "teamCaptain" on ("homeTeam".id = "teamCaptain".team AND "teamCaptain"."teamCaptain" = 1)
    join "player" "matchSecretary" on ("homeClub".id = "matchSecretary".club AND "matchSecretary"."matchSecrertary" = 1)
    join "division" on "homeTeam"."division" = "division".id
WHERE
    "fixture".id = ${fixtureId}`.catch(err => {
        return done(err)
      })
      done(null,rows);
  }

  exports.getMatchPlayerOrderDetails = async function(fixtureObj,done){
    var searchTerms = [];
    var sqlArray = []
    var seasonName = (!fixtureObj.season || fixtureObj.season == SEASON)? '' : fixtureObj.season
    // console.log(fixtureObj)
    let rows = await sql`SELECT c.*
FROM (SELECT "fixturePlayers".*, ${sql("club" + seasonName)}.name
    FROM (SELECT "playerNames".id, "playerNames".date, "homeTeam".name as "teamName", "homeTeam".id as "teamId", "homeTeam".club as "clubId", "awayTeam".name as "oppositionName", "playerNames"."Man1", "playerNames"."Man1Rank", "Man1Team".name as "Man1TeamName", "playerNames"."Man2", "playerNames"."Man2Rank", "Man2Team".name as "Man2TeamName", "playerNames"."Man3", "playerNames"."Man3Rank", "Man3Team".name as "Man3TeamName", "playerNames"."Man4", "playerNames"."Man4Rank", "Man4Team".name as "Man4TeamName", "playerNames"."Lady1", "playerNames"."Lady1Rank", "Lady1Team".name as "Lady1TeamName", "playerNames"."Lady2", "playerNames"."Lady2Rank", "Lady2Team".name as "Lady2TeamName"
        FROM (                
            SELECT fixture.id, fixture.date, fixture."homeTeam" AS "Team", fixture."awayTeam" AS "Opposition", CONCAT("homeMan1".first_name, ' ', "homeMan1".family_name) AS "Man1", "homeMan1".rank AS "Man1Rank", "homeMan1".team AS "Man1TeamId", CONCAT("homeMan2".first_name, ' ', "homeMan2".family_name) AS "Man2", "homeMan2".rank AS "Man2Rank", "homeMan2".team AS "Man2TeamId", CONCAT("homeMan3".first_name, ' ', "homeMan3".family_name) AS "Man3", "homeMan3".rank AS "Man3Rank", "homeMan3".team AS "Man3TeamId", CONCAT("homeMan4".first_name, ' ', "homeMan4".family_name) AS "Man4", "homeMan4".rank AS "Man4Rank", "homeMan4".team AS "Man4TeamId", CONCAT("homeLady1".first_name, ' ', "homeLady1".family_name) AS "Lady1", "homeLady1".rank AS "Lady1Rank", "homeLady1".team AS "Lady1TeamId", CONCAT("homeLady2".first_name, ' ', "homeLady2".family_name) AS "Lady2", "homeLady2".rank AS "Lady2Rank", "homeLady2".team AS "Lady2TeamId"
                FROM fixture JOIN player "homeMan1" ON fixture."homeMan1" = "homeMan1".id JOIN player "homeMan2" ON fixture."homeMan2" = "homeMan2".id JOIN player "homeMan3" ON fixture."homeMan3" = "homeMan3".id JOIN player "homeMan4" ON fixture."homeMan4" = "homeMan4".id JOIN player "homeLady1" ON fixture."homeLady1" = "homeLady1".id JOIN player "homeLady2" ON fixture."homeLady2" = "homeLady2".id
            UNION ALL
                SELECT fixture.id, fixture.date, fixture."awayTeam" AS "Team", fixture."homeTeam" AS "Opposition", CONCAT("awayMan1".first_name, ' ', "awayMan1".family_name) AS "Man1", "awayMan1".rank AS "Man1Rank", "awayMan1".team AS "Man1TeamId", CONCAT("awayMan2".first_name, ' ', "awayMan2".family_name) AS "Man2", "awayMan2".rank AS "Man2Rank", "awayMan2".team AS "Man2TeamId", CONCAT("awayMan3".first_name, ' ', "awayMan3".family_name) AS "Man3", "awayMan3".rank AS "Man3Rank", "awayMan3".team AS "Man3TeamId", CONCAT("awayMan4".first_name, ' ', "awayMan4".family_name) AS "Man4", "awayMan4".rank AS "Man4Rank", "awayMan4".team AS "Man4TeamId", CONCAT("awayLady1".first_name, ' ', "awayLady1".family_name) AS "Lady1", "awayLady1".rank AS "Lady1Rank", "awayLady1".team AS "Lady1TeamId", CONCAT("awayLady2".first_name, ' ', "awayLady2".family_name) AS "Lady2", "awayLady2".rank AS "Lady2Rank", "awayLady2".team AS "Lady2TeamId"
                FROM fixture JOIN player "awayMan1" ON fixture."awayMan1" = "awayMan1".id JOIN player "awayMan2" ON fixture."awayMan2" = "awayMan2".id JOIN player "awayMan3" ON fixture."awayMan3" = "awayMan3".id JOIN player "awayMan4" ON fixture."awayMan4" = "awayMan4".id JOIN player "awayLady1" ON fixture."awayLady1" = "awayLady1".id JOIN player "awayLady2" ON fixture."awayLady2" = "awayLady2".id) AS "playerNames" join ${sql("team" + seasonName)}  "homeTeam" ON "playerNames"."Team" = "homeTeam".id join ${sql("team" + seasonName)}  "awayTeam" ON "playerNames"."Opposition" = "awayTeam".id join ${sql("team" + seasonName)}  "Man1Team" on "playerNames"."Man1TeamId" = "Man1Team".id join ${sql("team" + seasonName)}  "Man2Team" on "playerNames"."Man2TeamId" = "Man2Team".id join ${sql("team" + seasonName)}  "Man3Team" on "playerNames"."Man3TeamId" = "Man3Team".id join ${sql("team" + seasonName)}  "Man4Team" on "playerNames"."Man4TeamId" = "Man4Team".id join ${sql("team" + seasonName)}  "Lady1Team" on "playerNames"."Lady1TeamId" = "Lady1Team".id join ${sql("team" + seasonName)}  "Lady2Team" on "playerNames"."Lady2TeamId" = "Lady2Team".id) AS "fixturePlayers" join ${sql("club" + seasonName)} ON club.id = "fixturePlayers"."clubId") AS c join season on
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
      !fixtureObj.season || fixtureObj.season == SEASON 
      ? sql` and season.name = ${SEASON} AND c.date > season."startDate" AND c.date < season."endDate"`
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
    // console.log(rows.statement)
    done(null,rows);
  }

  exports.sendResultZap = function(zapObject,done){
    if (typeof zapObject.homeTeam !== 'undefined' && (zapObject.host !== '127.0.0.1:8080' || typeof zapObject.host === 'undefined')){
      var options = {
        method:'POST',
        url:'https://hook.integromat.com/uihmc7g54i8xrvdvpsec2f6ejfqul70g',
        headers:{
          'content-type':'application/json'
        },
        body:{
          "imgGen":"https://tameside-badminton.co.uk/resultImage/"+zapObject.homeTeam+"/"+zapObject.awayTeam+"/"+zapObject.homeScore+"/"+zapObject.awayScore+"/"+zapObject.division,
          "message" : "Result: "+zapObject.homeTeam+" vs "+zapObject.awayTeam+" : "+zapObject.homeScore+"-"+zapObject.awayScore+" #tameside #badminton #tdbl #result #bulutangkis #badminton🏸 #badmintonclub https://tameside-badminton.co.uk",
          "imgUrl":"https://tameside-badminton.co.uk/static/images/generated/"+ zapObject.homeTeam.replace(/([\s]{1,})/g,'-') + zapObject.awayTeam.replace(/([\s]{1,})/g,'-') +".png"
        },
        json:true
      };
      request(options,function(err,res,body){
        if(err){
          // console.log(err)
          return done(err);
        }
        else { 
            // console.log(body); 
            request(`https://tameside-badminton.co.uk/resultImage/${zapObject.homeTeam}/${zapObject.awayTeam}/${zapObject.homeScore}/${zapObject.awayScore}/${zapObject.division}`,function(err,res,body){
              if(err){
                return done(err);
              }
              else { 
                return done(null,body)
              }
            })
          }
       })
    }
    else if (zapObject.host == '127.0.0.1:8080'){
      console.log("zap not sent!");
      return done(null,'test env');
    }
    else {
      return done("you've not supplied a valid object");
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
where season.name like ${SEASON} and status = 'outstanding' and "homeTeam".name like ${updateObj.hometeam} and "awayTeam".name like ${updateObj.awayteam} limit 1);`.catch(err => {
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
