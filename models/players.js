let postgres = require('postgres')
const sql = postgres(`postgres://postgres.tdsvugmbkgakgbtmoajj:${encodeURIComponent(process.env.PGPASSWORD)}@aws-0-eu-west-2.pooler.supabase.com:5432/postgres`,{ ssl : { rejectUnauthorized : false },connect_timeout:120, idle_timeout:120 })
const levenshtein = require('js-levenshtein');
const { restart } = require('nodemon');
var SEASON = '';
if (new Date().getMonth() < 7){
  SEASON = '' + new Date().getFullYear()-1 +''+ new Date().getFullYear();
  console.log(SEASON)
}
else {
  SEASON = '' + new Date().getFullYear() +''+ (new Date().getFullYear()+1);
  console.log(SEASON)
}


// POST
exports.create = async function(first_name,family_name,team,club,gender,done){
  var date_of_registration = new Date();
  let result = await sql`INSERT INTO player ("first_name","family_name","date_of_registration","team","club",gender) VALUES (${first_name},${family_name},${date_of_registration},${team},${club},${gender})`.catch(err => {
    return done(err) ;
  })
  done(null,result);

}

exports.createByName = async function(obj,done){
  if(db.isObject(obj)){
    result = await sql`insert into player (first_name, family_name, gender, club, team, date_of_registration) values (${obj.first_name}, ${obj.family_name}, ${obj.gender},(select id from club where name = ${obj.clubName}),(select id from team where name = ${obj.teamName}),${obj.date})`.catch(err => {
    return done(err) ;
    })
    done(null,result);
  }
  else {
    return done('not object');
  }
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

// PATCH
exports.updateById = async function(first_name,family_name,team,club,gender,playerId,done){
  let result = await sql`UPDATE player SET first_name = ${first_name}, family_name = ${family_name}, team = ${team}, club = ${club}, gender = ${gender} WHERE id = ${playerId}`.catch(err => {
    return done(err) ;
  })
  done(null,result);
}

exports.updateBulk = async function(BatchObj,done){
  if(typeof BatchObj.tablename !== undefined && typeof BatchObj.data !== undefined && typeof BatchObj.fields !== undefined){
    // console.log(BatchObj);
    
    // console.log(sql);
    let errsArray = []
    let succcessArray = []
    let idIndex = await BatchObj.fields.indexOf('id')
    // console.log(`idIndex:${idIndex}`)
    let fieldsSansId = await BatchObj.fields.splice(idIndex,1)
    let telIndex = await BatchObj.fields.indexOf('playerTel')
    // console.log(`telIndex:${telIndex}`)
    if (telIndex >= 0){
      let fieldsSansTel = await BatchObj.fields.splice(telIndex,1)
    }
    let emailIndex = await BatchObj.fields.indexOf('playerEmail')
    // console.log(`emailIndex:${emailIndex}`)
    if (emailIndex >= 0 ){
      let fieldsSansEmail = await BatchObj.fields.splice(emailIndex,1)
    }
    
    // console.log(idIndex)
    
    // console.log(BatchObj.fields)
    for (x in BatchObj.data){
        let idArray = await BatchObj.data[x].splice(idIndex,1)
        let telArray = telIndex >= 0 ? await BatchObj.data[x].splice(telIndex,1) : []
        // console.log("telArray")
        // console.log(telArray)
        let emailArray = emailIndex >= 0 ? await BatchObj.data[x].splice(emailIndex,1) : []
        // console.log("emailArray")
        // console.log(emailArray)
        arrayObj = Object.assign(...await BatchObj.fields.map((k, i) => ({[k]: BatchObj.data[x][i]})))
        // console.log("BathObj.data")
        // console.log(BatchObj.data)
         // console.log("arrayObj")
         // console.log(arrayObj)
        let result = await sql`
        update ${sql(BatchObj.tablename)} set ${
            sql(arrayObj, BatchObj.fields)
        }
        where id = ${ idArray[0] } returning *`.catch(err => {
            console.log('main query error')
            console.log(err.query)
            errsArray.push(err);
        })
        succcessArray.push(result) 
        // console.log(result.statement)

        if (typeof emailArray[0] !== 'undefined' && emailArray[0] != ''){
        let emailResult = await sql`update ${sql(BatchObj.tablename)} set "playerEmail" =  pgp_sym_encrypt(${emailArray[0]},${process.env.DB_ENCODE}) where id = ${ idArray[0] } returning *`.catch(err => {
          console.log('email query error')
          console.log(err)
          console.log(err.query)
          errsArray.push(err);
      })
        succcessArray.push(emailResult) 
        // console.log(emailResult.statement)
    }
    if (typeof telArray[0] !== 'undefined' && telArray[0] != ''){
        let telResult = await sql`update ${sql(BatchObj.tablename)} set "playerTel" =  pgp_sym_encrypt(${telArray[0]},${process.env.DB_ENCODE}) where id = ${ idArray[0] } returning *`.catch(err => {
          console.log('telephone query error')
          console.log(err)
          console.log(err.query)
          errsArray.push(err);
      })
        succcessArray.push(telResult) 
        // console.log(telResult)
    }

      // console.log(result.statement.string)
      /* var sql = 'UPDATE '+BatchObj.tablename+' SET ';
      updateArray = [];
      for (y in BatchObj.data[x]){
        console.log(BatchObj.data[x][y])
        if (BatchObj.fields[y] == 'id'){
          var whereCondition = ' where id = ' + BatchObj.data[x][y]
          continue;
        }
        else if (BatchObj.fields[y] == 'playerTel' || BatchObj.fields[y] == 'playerEmail'){
          updateArray.push(''+BatchObj.fields[y]+' = pgp_sym_encrypt("'+ BatchObj.data[x][y] +'","'+ process.env.DB_ENCODE +'")');    
        }
        else {
          updateArray.push(''+BatchObj.fields[y]+' = "'+ BatchObj.data[x][y] +'"');
        }
      }
      updateValuesString = updateArray.join(',')

      containerArray.push(sql + updateValuesString + whereCondition)  */
    } 
    // console.log(containerArray);
    if (errsArray.length > 0 ){
      console.log('errsArray')
      console.log(errsArray)
        return done(errsArray)
    }
    else {
      // console.log('successArray')
      // console.log(succcessArray)
        return done(null,succcessArray)
    }
  }
  else{
    return done('not object');
  }
}

// GET
exports.getAll = async function(done){
  let result = await sql`SELECT * FROM player`.catch(err => {
    return done(err) ;
  })
  done(null,result);
}

// GET
exports.getNominatedPlayers = async function(teamName,done){
  let result = await sql`SELECT CONCAT(first_name, ' ', family_name) AS name, gender FROM player JOIN team on team.id = player.team AND team.name like ${teamName} AND player.rank IS NOT NULL ORDER BY gender , player.rank`.catch(err => {
    return done(err) ;
  })
  done(null,result);
}

exports.getMatchStats = async function(fixtureId,done){
  let result = await sql`SELECT concat(player.first_name,' ',player.family_name) AS name ,team.name AS "teamName" ,b."avgPtsFor" ,b."avgPtsAgainst" ,"gamesWon" FROM ( SELECT "playerId" ,AVG("ptsFor") AS "avgPtsFor" ,AVG("ptsAgainst") AS "avgPtsAgainst" ,SUM(won) AS "gamesWon" FROM ( SELECT "homePlayer1" AS "playerId" ,"homeScore" AS "ptsFor" ,"awayScore" AS "ptsAgainst" ,CASE WHEN "homeScore" > "awayScore" THEN 1 ELSE 0 END AS won FROM game WHERE fixture = ${fixtureId} AND ("awayPlayer1" !=0 AND "awayPlayer2" != 0 AND "homePlayer2" != 0 AND "homePlayer1" !=0) UNION ALL SELECT "homePlayer2" AS "playerId" ,"homeScore" AS "ptsFor" ,"awayScore" AS "ptsAgainst" ,CASE WHEN "homeScore" > "awayScore" THEN 1 ELSE 0 END AS won FROM game WHERE fixture = ${fixtureId} AND ("awayPlayer1" !=0 AND "awayPlayer2" != 0 AND "homePlayer2" != 0 AND "homePlayer1" !=0) UNION ALL SELECT "awayPlayer1" AS "playerId" ,"awayScore" AS "ptsFor" ,"homeScore" AS "ptsAgainst" ,CASE WHEN "homeScore" < "awayScore" THEN 1 ELSE 0 END AS won FROM game WHERE fixture = ${fixtureId} AND ("awayPlayer1" !=0 AND "awayPlayer2" != 0 AND "homePlayer2" != 0 AND "homePlayer1" !=0) UNION ALL SELECT "awayPlayer2" AS "playerId" ,"awayScore" AS "ptsFor" ,"homeScore" AS "ptsAgainst" ,CASE WHEN "homeScore" < "awayScore" THEN 1 ELSE 0 END AS won FROM game WHERE fixture = ${fixtureId} AND ("awayPlayer1" !=0 AND "awayPlayer2" != 0 AND "homePlayer2" != 0 AND "homePlayer1" !=0) ) AS a GROUP BY "playerId" ) AS b JOIN player ON b."playerId" = player.id JOIN team ON player.team = team.id ORDER BY "teamName", "gamesWon" desc, "avgPtsAgainst" asc`.catch(err => {
    return done(err) ;
  })
  done(null,result);
}


exports.getNamesClubsTeams = async function(searchTerms,done){
    
    let result = await sql`select * from (select "playerId", a.name, gender, date_of_registration, a.rank, club.id as "clubId", club.name as "clubName", "teamName", "teamId" from (SELECT player.id as "playerId", concat(first_name, ' ', family_name) as name, gender, date_of_registration, player.rank, team.id as "teamId", team.name as "teamName", player.club as "clubId" from player join team on team.id = player.team
    ${
        searchTerms.name !== undefined 
        ? sql`AND (player.first_name like ${searchTerms.name.substr(0,1)+"%"} OR player.family_name like ${searchTerms.name.substr(0,1)+"%"})`
        : sql``
    }
    ) as a join club on a."clubId" = club.id ) as b where
    ${
        searchTerms.club !== undefined 
        ? sql`"clubName" like ${searchTerms.club}`
        : sql`"clubName" like '%'`
    }
    ${
        searchTerms.team !== undefined 
        ? sql`AND "teamName" like ${searchTerms.team}`
        : sql``
    }
    ${
        searchTerms.gender !== undefined 
        ? sql`AND gender = ${searchTerms.gender}`
        : sql``
    }
    order by "teamName", gender,rank`.catch(err => {
    return done(err) ;
    })
    // console.log(result.statement.string)
    done(null,result);
}

exports.getPlayerGameData = async function(id,done){
  let result = await sql`with playerGames as (select game.*, fixture.date from game 
join fixture on game.fixture = fixture.id 
where 
(array["homePlayer1","homePlayer2","awayPlayer1","awayPlayer2"] && array[${id}::int]) and (
  "homePlayer1End" is not null and
  "homePlayer2End" is not null and
  "awayPlayer1End" is not null and
  "awayPlayer2End" is not null
)
order by date desc, id),
"allGames" as (
  select 
  id,
  date,
  case when "homePlayer1" = ${id} then "homePlayer1"
  when "homePlayer2" = ${id} then "homePlayer2"
  when "awayPlayer1" = ${id} then "awayPlayer1"
  when "awayPlayer2" = ${id} then "awayPlayer2"
  end as "playerName",
  case when "homePlayer1" = ${id} then "homePlayer2"
  when "homePlayer2" = ${id} then "homePlayer1"
  when "awayPlayer1" = ${id} then "awayPlayer2"
  when "awayPlayer2" = ${id} then "awayPlayer1"
  end as "partner",
  case when "homePlayer1" = ${id} then "awayPlayer1"
  when "homePlayer2" = ${id} then "awayPlayer1"
  when "awayPlayer1" = ${id} then "homePlayer1"
  when "awayPlayer2" = ${id} then "homePlayer1"
  end as "oppo1",
  case when "homePlayer1" = ${id} then "awayPlayer2"
  when "homePlayer2" = ${id} then "awayPlayer2"
  when "awayPlayer1" = ${id} then "homePlayer2"
  when "awayPlayer2" = ${id} then "homePlayer2"
  end as "oppo2",
  case when "homePlayer1" = ${id} then "homeScore"
  when "homePlayer2" = ${id} then "homeScore"
  when "awayPlayer1" = ${id} then "awayScore"
  when "awayPlayer2" = ${id} then "awayScore"
  end as "score",
  case when "homePlayer1" = ${id} then "awayScore"
  when "homePlayer2" = ${id} then "awayScore"
  when "awayPlayer1" = ${id} then "homeScore"
  when "awayPlayer2" = ${id} then "homeScore"
  end as "vsScore",
  "gameType",
  case when "homePlayer1" = ${id} then "homePlayer1Start"
  when "homePlayer2" = ${id} then "homePlayer2Start"
  when "awayPlayer1" = ${id} then "awayPlayer1Start"
  when "awayPlayer2" = ${id} then "awayPlayer2Start"
  end as "before",
  case when "homePlayer1" = ${id} then "homePlayer1End"
  when "homePlayer2" = ${id} then "homePlayer2End"
  when "awayPlayer1" = ${id} then "awayPlayer1End"
  when "awayPlayer2" = ${id} then "awayPlayer2End"
  end as "after",
  case when "homePlayer1" = ${id} then "homePlayer1End" - "homePlayer1Start"
  when "homePlayer2" = ${id} then "homePlayer2End" - "homePlayer2Start"
  when "awayPlayer1" = ${id} then "awayPlayer1End" - "awayPlayer1Start"
  when "awayPlayer2" = ${id} then "awayPlayer2End" - "awayPlayer2Start"
  end as "adjustment"
  from playerGames
)
select
"allGames".id,
date, 
player.first_name || ' ' || player.family_name as "playerName",
partner.first_name || ' ' || partner.family_name as "partnerName",
oppo1.first_name || ' ' || oppo1.family_name as "oppName1",
oppo2.first_name || ' ' || oppo2.family_name as "oppName2",
"score",
"vsScore",
"gameType",
"before",
"after",
"adjustment"
from "allGames" join 
player on player.id = "allGames"."playerName" join
player partner on partner.id = "allGames".partner join
player oppo1 on oppo1.id = "allGames".oppo1  join
player oppo2 on oppo2.id = "allGames".oppo2
`.catch(err => {
    console.log(`err: ${err.query}`)
    return done(err) ;
  })
  done(null,result);
}


exports.newGetPlayerStats = async function(searchObj,done){
  const filterArray = ['season','division','club','team','gameType','gender']
  // console.log("passed to getFixtureDetails")
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
        // console.log(sqlParams)
      }
    }
    
  }
  
  let season = ""
  let seasonString = SEASON
  let whereTerms = ""
  let whereValue = []
  searchArray = []
  const checkSeason = async function(season){
    
    let firstYear = parseInt(season.slice(0,4))
    let secondYear = parseInt(season.slice(4))
    console.log(firstYear+ " "+ secondYear)
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

  if (searchObj.season === undefined || !await checkSeason(searchObj.season)){
    seasonVal = seasonString
    season = ""
    console.log("no season");
  }
  else {
    season = searchObj.season;
    seasonVal = searchObj.season;
  }
  if (!searchObj.division){
    console.log("no division id");
    whereValue.push("%");
  }
  else {
    whereValue.push(searchObj.division)
  }
  console.log(whereTerms)
  console.log(whereValue);

  if (whereTerms.length > 0) {
    var conditions = whereTerms.join(' AND ');
    console.log(conditions);
    conditions = ' WHERE '+ conditions
  }
  var seasonArray = [seasonVal,seasonVal,seasonVal,seasonVal]
  whereValue = seasonArray.concat(whereValue)
  console.log(whereValue)
  
  let result = await sql`with
  "seasonFixture" as (
    SELECT
      "fixture".id,
      "fixture"."homeTeam",
      "fixture"."awayTeam"
    FROM
      "fixture"
      JOIN "season" ON "season".name like ${seasonVal}
      AND "fixture".date > "season"."startDate"
      AND "fixture".date < "season"."endDate"
      JOIN team on team.id = fixture."homeTeam"
      ${
        searchObj.division !== undefined 
        ? sql`AND team.division = ${searchObj.division}`
        : sql``
      }
  ),
  "seasonFixtureGame" as (
    SELECT
      game.id,
      game."homePlayer1",
      game."homePlayer2",
      game."awayPlayer1",
      game."awayPlayer2",
      game."homeScore",
      game."awayScore",
      game."fixture",
      "seasonFixture"."homeTeam",
      "seasonFixture"."awayTeam"
    FROM
      "seasonFixture"
      JOIN game ON game."fixture" = "seasonFixture".id
      AND (
        game."homePlayer1" != 0
        OR game."homePlayer2" != 0
        or game."awayPlayer1" != 0
        or game."awayPlayer2" != 0
      )
  ),
  "gameTypeGender" as (
    SELECT
      "seasonFixtureGame".*,
      CASE
        WHEN "homePlayer1"."gender" = "homePlayer2"."gender"
        AND "homePlayer1"."gender" = 'Male' THEN 'Mens'
        WHEN "homePlayer1"."gender" = "homePlayer2"."gender"
        AND "homePlayer1"."gender" = 'Female' THEN 'Ladies'
        ELSE 'Mixed'
      END AS "gameType"
    FROM
      "seasonFixtureGame"
      JOIN ${sql ("player" + season)} "homePlayer1" ON "seasonFixtureGame"."homePlayer1" = "homePlayer1".id
      AND "seasonFixtureGame"."homePlayer1" != 0
      JOIN ${sql ("player" + season)} "homePlayer2" ON "seasonFixtureGame"."homePlayer2" = "homePlayer2".id
      AND "seasonFixtureGame"."homePlayer2" != 0
      AND "homePlayer2" != 0
  ),
  "gameSummary" as (
    SELECT
      "gameTypeGender".id,
      "gameTypeGender"."homePlayer1" AS "playerId",
      "gameTypeGender"."homeScore" AS "forPoints",
      "gameTypeGender"."awayScore" AS "againstPoints",
      CASE
        WHEN "gameTypeGender"."homeScore" > "gameTypeGender"."awayScore" THEN 1
        ELSE 0
      END AS "gamesWon",
      CASE
        WHEN "gameTypeGender"."homeScore" IS NOT NULL THEN 1
        ELSE 0
      END AS "gamesPlayed",
      "gameTypeGender"."fixture",
      "gameTypeGender"."homeTeam" AS team,
      "gameTypeGender"."awayTeam" AS "opposition",
      "gameTypeGender"."gameType",
      team."division"
    FROM
      "gameTypeGender"
      join ${sql ("team" + season)} team on "homeTeam" = team.id
    UNION all
    SELECT
      "gameTypeGender".id,
      "gameTypeGender"."homePlayer2" AS "playerId",
      "gameTypeGender"."homeScore" AS "forPoints",
      "gameTypeGender"."awayScore" AS "againstPoints",
      CASE
        WHEN "gameTypeGender"."homeScore" > "gameTypeGender"."awayScore" THEN 1
        ELSE 0
      END AS "gamesWon",
      CASE
        WHEN "gameTypeGender"."homeScore" IS NOT NULL THEN 1
        ELSE 0
      END AS "gamesPlayed",
      "gameTypeGender"."fixture",
      "gameTypeGender"."homeTeam" AS team,
      "gameTypeGender"."awayTeam" AS "opposition",
      "gameTypeGender"."gameType",
      team."division"
    FROM
      "gameTypeGender"
      join ${sql ("team" + season)} team on "homeTeam" = team.id
    UNION all
    select
      "gameTypeGender".id,
      "gameTypeGender"."awayPlayer1" AS "playerId",
      "gameTypeGender"."awayScore" AS "forPoints",
      "gameTypeGender"."homeScore" AS "againstPoints",
      CASE
        WHEN "gameTypeGender"."awayScore" > "gameTypeGender"."homeScore" THEN 1
        ELSE 0
      END AS "gamesWon",
      CASE
        WHEN "gameTypeGender"."homeScore" IS NOT NULL THEN 1
        ELSE 0
      END AS "gamesPlayed",
      "gameTypeGender"."fixture",
      "gameTypeGender"."awayTeam" AS team,
      "gameTypeGender"."homeTeam" AS "opposition",
      "gameTypeGender"."gameType",
      team."division"
    FROM
      "gameTypeGender"
      join ${sql ("team" + season)} team on "homeTeam" = team.id
    UNION all
    select
      "gameTypeGender".id,
      "gameTypeGender"."awayPlayer2" AS "playerId",
      "gameTypeGender"."awayScore" AS "forPoints",
      "gameTypeGender"."homeScore" AS "againstPoints",
      CASE
        WHEN "gameTypeGender"."awayScore" > "gameTypeGender"."homeScore" THEN 1
        ELSE 0
      END AS "gamesWon",
      CASE
        WHEN "gameTypeGender"."homeScore" IS NOT NULL THEN 1
        ELSE 0
      END AS "gamesPlayed",
      "gameTypeGender"."fixture",
      "gameTypeGender"."awayTeam" AS team,
      "gameTypeGender"."homeTeam" AS "opposition",
      "gameTypeGender"."gameType",
      team."division"
    FROM
      "gameTypeGender"
      join ${sql ("team" + season)} team on "homeTeam" = team.id
  )
SELECT
  CONCAT(
    "player"."first_name",
    ' ',
    "player"."family_name"
  ) AS playername,
  "playerId",
  "player"."gender" as playergender,
  string_agg("gameType", ','),
  MIN("gameSummary"."division"),
  SUM("forPoints") AS "forPoints",
  SUM("againstPoints") AS "againstPoints",
  SUM("gamesWon") AS "gamesWon",
  SUM("gamesPlayed") AS "gamesPlayed",
  (sum("gamesPlayed") + sum("gamesWon")) - (sum("gamesPlayed") - sum("gamesWon")) as "Points",
  club.name AS "clubName",
  MIN(team.name) AS "teamName",
  "player"."rating"
FROM
  "gameSummary"
  JOIN ${sql ("player" + season)} "player" ON "playerId" = "player".id
  ${
    searchObj.gender !== undefined 
    ? sql`AND "player"."gender" Like ${searchObj.gender}`
    : sql`AND "player"."gender" Like '%'`
}
  JOIN "team" team ON team.id = "gameSummary".team
  ${
    searchObj.team !== undefined 
    ? sql`AND team.name LIKE ${searchObj.team}`
    : sql`AND team.name LIKE '%'`
}${
  searchObj.division !== undefined 
  ? sql`AND team.division = ${searchObj.division}`
  : sql``
}
  JOIN ${sql ("club" + season)} club ON club.id = "player".club
  ${
    searchObj.club !== undefined 
    ? sql`AND club.name LIKE ${searchObj.club}`
    : sql`AND club.name LIKE '%'`
}
WHERE
${
  searchObj.gameType !== undefined 
  ? sql`"gameType" LIKE ${searchObj.gameType}`
  : sql`"gameType" like '%'`
}
 
GROUP BY
  "playerId",
  "playername",
  "playergender",
  "clubName",
  "rating"
ORDER BY
  "Points" DESC;
`.catch(err => {
  console.log(err.query)
  return done(err)
  
   ;
  })
  // console.log(result)
  // console.log(result.statement.string)
  done(null,result);


}


exports.newGetPairStats = async function(searchObj,done){
  const filterArray = ['season','division','club','team','gameType','gender']
  // console.log("passed to getFixtureDetails")
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
        // console.log(sqlParams)
      }
    }
    
  }
  
  let season = ""
  let seasonString = SEASON
  searchArray = []
  const checkSeason = async function(season){
    let firstYear = parseInt(season.slice(0,4))
    let secondYear = parseInt(season.slice(4))
    console.log(firstYear+ " "+ secondYear)
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

  if (searchObj.season === undefined || !checkSeason(searchObj.season)){
    seasonVal = seasonString
    console.log("no season");
  }
  else {
    season = searchObj.season;
    seasonVal = searchObj.season;
  }

  
    let result = await sql`with
  "seasonFixture" as (
    SELECT
      "fixture".id,
      "fixture"."homeTeam",
      "fixture"."awayTeam"
    FROM
      "fixture"
      JOIN "season" ON "season".name like ${seasonVal}
      AND "fixture".date > "season"."startDate"
      AND "fixture".date < "season"."endDate"
  ),
  "seasonFixtureGame" as (
    SELECT
      game.id,
      game."homePlayer1",
      game."homePlayer2",
      game."awayPlayer1",
      game."awayPlayer2",
      game."homeScore",
      game."awayScore",
      game."fixture",
      "seasonFixture"."homeTeam",
      "seasonFixture"."awayTeam"
    FROM
      "seasonFixture"
      JOIN game ON game."fixture" = "seasonFixture".id
      AND (
        game."homePlayer1" != 0
        OR game."homePlayer2" != 0
        or game."awayPlayer1" != 0
        or game."awayPlayer2" != 0
      )
  ),
  "gameTypeGender" as (
    SELECT
      "seasonFixtureGame".*,
      CASE
        WHEN "homePlayer1"."gender" = "homePlayer2"."gender"
        AND "homePlayer1"."gender" = 'Male' THEN 'Mens'
        WHEN "homePlayer1"."gender" = "homePlayer2"."gender"
        AND "homePlayer1"."gender" = 'Female' THEN 'Ladies'
        ELSE 'Mixed'
      END AS "gameType",
      "homePlayer1"."gender" AS "playergender"
    FROM
      "seasonFixtureGame"
      JOIN ${sql ("player" + season)} "homePlayer1" ON "seasonFixtureGame"."homePlayer1" = "homePlayer1".id
      AND "seasonFixtureGame"."homePlayer1" != 0
      JOIN ${sql ("player" + season)} "homePlayer2" ON "seasonFixtureGame"."homePlayer2" = "homePlayer2".id
      AND "seasonFixtureGame"."homePlayer2" != 0
      AND "homePlayer2" != 0
  ),
  "PairsgameSummary" as (
    SELECT
      "gameTypeGender".id,
      least(
        "gameTypeGender"."homePlayer1",
        "gameTypeGender"."homePlayer2"
      ) AS "player1Id",
      greatest(
        "gameTypeGender"."homePlayer1",
        "gameTypeGender"."homePlayer2"
      ) AS "player2Id",
      "gameTypeGender"."homeScore" AS "forPoints",
      "gameTypeGender"."awayScore" AS "againstPoints",
      CASE
        WHEN "gameTypeGender"."homeScore" > "gameTypeGender"."awayScore" THEN 1
        ELSE 0
      END AS "gamesWon",
      CASE
        WHEN "gameTypeGender"."homeScore" IS NOT NULL THEN 1
        ELSE 0
      END AS "gamesPlayed",
      "gameTypeGender"."fixture",
      "gameTypeGender"."homeTeam" AS team,
      "gameTypeGender"."awayTeam" AS "opposition",
      "gameTypeGender"."gameType",
      team."division"
    FROM
      "gameTypeGender"
      JOIN ${sql ("team" + season)} team ON "homeTeam" = team.id
    UNION ALL
    SELECT
      "gameTypeGender".id,
      least(
        "gameTypeGender"."awayPlayer1",
        "gameTypeGender"."awayPlayer2"
      ) AS "player1Id",
      greatest(
        "gameTypeGender"."awayPlayer2",
        "gameTypeGender"."awayPlayer1"
      ) AS "player2Id",
      "gameTypeGender"."awayScore" AS "forPoints",
      "gameTypeGender"."homeScore" AS "againstPoints",
      CASE
        WHEN "gameTypeGender"."awayScore" > "gameTypeGender"."homeScore" THEN 1
        ELSE 0
      END AS "gamesWon",
      CASE
        WHEN "gameTypeGender"."homeScore" IS NOT NULL THEN 1
        ELSE 0
      END AS "gamesPlayed",
      "gameTypeGender"."fixture",
      "gameTypeGender"."awayTeam" AS team,
      "gameTypeGender"."homeTeam" AS "opposition",
      "gameTypeGender"."gameType",
      team."division"
    FROM
      "gameTypeGender"
      JOIN ${sql ("team" + season)} team ON "homeTeam" = team.id
  )
SELECT
  concat(
    "Player1"."first_name",
    ' ',
    "Player1"."family_name",
    ' & ',
    "Player2"."first_name",
    ' ',
    "Player2"."family_name"
  ) as "Pairing",
  "player1Id",
  "player2Id",
  ("Player1"."rating" + "Player2"."rating") / 2 as "pairRating",
  SUM("forPoints") AS "forPoints",
  SUM("againstPoints") AS "againstPoints",
  SUM("gamesWon") AS "gamesWon",
  SUM("gamesPlayed") AS "gamesPlayed",
  SUM("gamesWon") / SUM("gamesPlayed") As "winRate",
  (sum("gamesWon") + sum("gamesPlayed")) - (sum("gamesPlayed") - sum("gamesWon")) as "Points",
  club.name AS "clubName",
  MIN(team.name) AS "teamName",
  "gameType"
FROM
  (
    SELECT
      *
    FROM
      "PairsgameSummary"
  ) AS a
  JOIN ${sql ("player" + season)} "Player1" ON "Player1".id = a."player1Id"
  JOIN ${sql ("player" + season)} "Player2" ON "Player2".id = a."player2Id"
  JOIN ${sql ("team" + season)} team ON team.id = a.team
   ${
    searchObj.division !== undefined 
    ? sql`AND team.division = ${searchObj.division}`
    : sql``
}
  ${
    searchObj.team !== undefined 
    ? sql`AND team.name LIKE ${searchObj.team}`
    : sql`AND team.name LIKE '%'`
}
  JOIN ${sql ("club" + season)} club ON club.id = "Player1".club
  ${
    searchObj.club !== undefined 
    ? sql`AND club.name LIKE ${searchObj.club}`
    : sql`AND club.name LIKE '%'`
}
${
  searchObj.gameType !== undefined 
  ? sql`AND "gameType" LIKE ${searchObj.gameType}`
  : sql`AND "gameType" LIKE '%'`
}
GROUP BY
  "Pairing",
  "pairRating",
  "player1Id",
  "player2Id",
  "clubName",
  "gameType"
ORDER BY
  "winRate" DESC,
  "Points" DESC`.catch(err => {
    console.log(`err: ${err}, ${err.query}`)
    return done(err) ;
    })
     // console.log(result.statement.string)
    done(null,result);

}

exports.getEmails = async function(searchTerms,done){
  console.log(searchTerms);
  var sql = "SELECT DISTINCT b.playerEmail FROM (SELECT a.*, CAST(AES_DECRYPT(player.playerEmail, '"+process.env.DB_ENCODE+"') AS CHAR) AS playerEmail FROM (SELECT club.id, club.name AS clubName, team.id AS teamId, team.name AS teamName, club.matchSec, club.clubSec, team.captain, team.division, 'match Sec' AS role FROM club JOIN team ON team.club = club.id) AS a JOIN player ON a.matchSec = player.id OR (player.matchSecrertary = 1 AND a.id = player.club) UNION ALL SELECT a.*, CAST(AES_DECRYPT(player.playerEmail, '"+process.env.DB_ENCODE+"') AS CHAR) AS playerEmail FROM (SELECT club.id, club.name AS clubName, team.id AS teamId, team.name AS teamName, club.matchSec, club.clubSec, team.captain, team.division, 'club Sec' AS role FROM club JOIN team ON team.club = club.id) AS a JOIN player ON a.clubSec = player.id OR (player.clubSecretary = 1 AND a.id = player.club) UNION ALL SELECT a.*, CAST(AES_DECRYPT(player.playerEmail, '"+process.env.DB_ENCODE+"') AS CHAR) AS playerEmail FROM (SELECT club.id, club.name AS clubName, team.id AS teamId, team.name AS teamName, club.matchSec, club.clubSec, team.captain, team.division, 'team Captain' AS role FROM club JOIN team ON team.club = club.id) AS a JOIN player ON (player.teamCaptain = 1 AND a.teamId = player.team) or a.captain = player.id UNION ALL SELECT a.*, CAST(AES_DECRYPT(player.playerEmail, '"+process.env.DB_ENCODE+"') AS CHAR) AS playerEmail FROM (SELECT club.id, club.name AS clubName, team.id AS teamId, team.name AS teamName, club.matchSec, club.clubSec, team.captain, team.division, 'treasurer' AS role FROM club JOIN team ON team.club = club.id) AS a JOIN player ON (player.treasurer = 1 AND a.teamId = player.team) UNION ALL SELECT a.*, CAST(AES_DECRYPT(player.playerEmail, '"+process.env.DB_ENCODE+"') AS CHAR) AS playerEmail FROM (SELECT club.id, club.name AS clubName, team.id AS teamId, team.name AS teamName, club.matchSec, club.clubSec, team.captain, team.division, 'otherComms' AS role FROM club JOIN team ON team.club = club.id) AS a JOIN player ON (player.otherComms = 1 AND a.teamId = player.team)) AS b"
  var whereTerms = [];
  if (!searchTerms.role){
    console.log("no role selected");
  }
  else {
    whereTerms.push('b.role = "'+searchTerms.role+'"');
  }
  if (!searchTerms.division){
    console.log("no division");
  }
  else {
    whereTerms.push('b.division = '+searchTerms.division );
  }
  if (!searchTerms.club){
    console.log("no club id");
  }
  else {
    whereTerms.push('b.id = "'+searchTerms.club + '"');
  }
  if (!searchTerms.teamName){
    console.log("no teamName");
  }
  else {
    whereTerms.push('b.teamName = "'+searchTerms.teamName + '"');
  }
  console.log(whereTerms)

  if (whereTerms.length > 0) {
    var conditions = whereTerms.join(' AND ');
    conditions = ' WHERE ' + conditions;
    // console.log(conditions);
    sql = sql + conditions
  }
  db.get().query(sql, function (err, rows){
    if (err) return done(err);
    else {
      // console.log(rows)
      var emailArray = rows.map(row => {const {playerEmail} = row; return playerEmail})
      tempArray = emailArray
      emailArray = tempArray.filter(email => email.indexOf("@") != -1)
      console.log(emailArray)
    }
    done(null, emailArray);
  })
}

exports.search = async function(searchTerms,done){
  console.log(searchTerms);
  var sql = 'SELECT * FROM player';
  var whereTerms = [];
  if (!searchTerms.teamid){
    console.log("no team id");
  }
  else {
    whereTerms.push('team = '+searchTerms.teamid);
  }
  if (!searchTerms.gender){
    console.log("no gender");
  }
  else {
    whereTerms.push('gender = "'+searchTerms.gender + '"');
  }
  if (!searchTerms.clubid){
    console.log("no club id");
  }
  else {
    whereTerms.push('club = '+searchTerms.clubid);
  }
  console.log(whereTerms)

  if (whereTerms.length > 0) {
    var conditions = whereTerms.join(' AND ');
    conditions = ' WHERE ' + conditions + ' order by teamName,gender,rank';
    // console.log(conditions);
    sql = sql + conditions
  }
  db.get().query(sql, function (err, rows){
    if (err) return done(err);
    done(null, rows);
  })
}

exports.findElgiblePlayersFromTeamId = async function(id,gender,done){
  let result = await sql`select player.id, player.first_name, player.family_name, b.rank as "teamRank", player.rank as "playerRank" from (select team.id, team.name, team.rank from (SELECT club.id, club.name, team.rank as "originalRank" FROM team JOIN club on team.club = club.id AND team.id = ${id}) as a join team on a.id = team.club AND team.rank >= "originalRank") as b join player on player.team = b.id AND player.gender like ${gender} order by b.rank asc,player.rank asc, player.first_name`.catch(err => {
    console.log(err.query)
    return done(err) ;
  })
  // console.log(result.statement.string)
  done(null,result);
}

exports.findElgiblePlayersFromTeamIdAndSelected = async function(teamName,gender, first, second, third,done){
  let result = await sql`SELECT player.id, player.first_name, player.family_name, CASE WHEN LEVENSHTEIN(CONCAT(player.first_name, " ", player.family_name), ?) < 6 THEN TRUE ELSE FALSE END AS first, CASE WHEN LEVENSHTEIN(CONCAT(player.first_name, " ", player.family_name), ?) < 6 THEN TRUE ELSE FALSE END AS second, CASE WHEN LEVENSHTEIN(CONCAT(player.first_name, " ", player.family_name), ?) < 6 THEN TRUE ELSE FALSE END AS third FROM (SELECT team.id, team.name, team.rank FROM (SELECT club.id, club.name, team.rank AS originalRank FROM team JOIN club on team.club = club.id AND levenshtein(team.name,?) < 1) AS a JOIN team on a.id = team.club AND team.rank >= originalRank) AS b JOIN player on player.team = b.id AND player.gender = ?',[first, second, third, teamName, gender]`.catch(err => {
    return done(err) ;
  })
  done(null,result);
}

exports.getEligiblePlayersAndSelectedById = async function(first, second, teamId,gender,done,third = 0, fourth = 0){
  console.log(`SELECT player.id ,player.first_name ,player.family_name, case when player.id = ${first} then 1 else 0 end as first, case when player.id = ${second} then 1 else 0 end as second, case when player.id = ${third} then 1 else 0 end as third, case when player.id = ${fourth} then 1 else 0 end as fourth FROM ( SELECT team.id ,team.name ,team.rank FROM ( SELECT club.id ,club.name ,team.rank AS originalRank FROM team JOIN club on team.club = club.id AND team.id = ${teamId} ) AS a JOIN team on a.id = team.club AND team.rank >= originalRank ) AS b JOIN player on player.team = b.id AND player.gender like ${gender}`)
  let result = await sql`SELECT player.id ,player.first_name ,player.family_name, case when player.id = ${first} then 1 else 0 end as first, case when player.id = ${second} then 1 else 0 end as second, case when player.id = ${third} then 1 else 0 end as third, case when player.id = ${fourth} then 1 else 0 end as fourth FROM ( SELECT team.id ,team.name ,team.rank FROM ( SELECT club.id ,club.name ,team.rank AS originalRank FROM team JOIN club on team.club = club.id AND team.id = ${teamId} ) AS a JOIN team on a.id = team.club AND team.rank >= originalRank ) AS b JOIN player on player.team = b.id AND player.gender like ${gender}`.catch(err => {
    console.log(err.query)
    return done(err) ;
  })
  done(null,result);
}

exports.findElgiblePlayersFromTeamNameAndSelectedSansLevenshtein = async function(teamName,gender,first, second,third,done){
  let row = await sql`SELECT player.id ,player.first_name ,player.family_name FROM ( SELECT team.id ,team.name ,team.rank FROM ( SELECT club.id ,club.name ,team.rank AS originalRank FROM team JOIN club on team.club = club.id AND team.name like ? ) AS a JOIN team on a.id = team.club AND team.rank >= originalRank ) AS b JOIN on player.team = b.id AND player.gender = ?',[teamName, gender]`.catch(err => {
    return done(err) ;
    })
      rows[0].first = 1;
      rows[0].second = 1;
      rows[0].third = 1;
      let lowestFirstIndex = [0,levenshtein(rows[0].first_name + " " + rows[0].family_name,first)];
      let lowestSecondIndex = [0,levenshtein(rows[0].first_name + " " + rows[0].family_name,second)];
      let lowestThirdIndex = [0,levenshtein(rows[0].first_name + " " + rows[0].family_name,third)]
      for (let i = 1; i < rows.length; i++){ 
        rowFirstLevenshtein = levenshtein(rows[i].first_name + " " + rows[i].family_name,first);
        rowSecondLevenshtein = levenshtein(rows[i].first_name + " " + rows[i].family_name,second);
        rowThirdLevenshtein = levenshtein(rows[i].first_name + " " + rows[i].family_name,third);
        if (lowestFirstIndex[1] > rowFirstLevenshtein) {
          rows[lowestFirstIndex[0]].first = 0;
          rows[i].first = 1;
          lowestFirstIndex[0] = i;
          lowestFirstIndex[1] = rowFirstLevenshtein;
        } 
        else {
          rows[i].first = 0;
        }
        if (lowestSecondIndex[1] > rowSecondLevenshtein) {
          rows[lowestSecondIndex[0]].second = 0;
          rows[i].second = 1;
          lowestSecondIndex[0] = i;
          lowestSecondIndex[1] = rowSecondLevenshtein;
        } 
        else {
          rows[i].second = 0;
        }

        if (lowestThirdIndex[1] > rowThirdLevenshtein) {
          rows[lowestThirdIndex[0]].third = 0;
          rows[i].third = 1;
          lowestThirdIndex[0] = i;
          lowestThirdIndex[1] = rowThirdLevenshtein;
        } 
        else {
          rows[i].third = 0;
        }
      }
      
      done(null,rows)
    
    
  }

exports.findElgiblePlayersFromTeamIdAndSelectedNew = async function(teamName,gender, first, second, third,done){
  let result = await sql`SELECT player.id, player.first_name, player.family_name, LEVENSHTEIN(CONCAT(player.first_name, ' ', player.family_name), ?) AS first, LEVENSHTEIN(CONCAT(player.first_name, ' ', player.family_name), ?) AS second, LEVENSHTEIN(CONCAT(player.first_name, ' ', player.family_name), ?) AS third, (LEVENSHTEIN(CONCAT(player.first_name,' ',player.family_name),?) + LEVENSHTEIN(CONCAT(player.first_name,' ',player.family_name),?) + LEVENSHTEIN(CONCAT(player.first_name,' ',player.family_name),?)) as totalLev FROM (SELECT team.id, team.name, team.rank FROM (SELECT club.id, club.name, team.rank AS originalRank FROM team JOIN club on team.club = club.id AND LEVENSHTEIN(team.name, ?) < 1) AS a JOIN team on a.id = team.club AND team.rank >= originalRank) AS b JOIN player on player.team = b.id AND player.gender = ? Order by totalLev asc, first asc, second asc, third asc",[first, second, third, first, second, third,teamName, gender]`.catch(err => {
    return done(err) ;
  })
  done(null,result);
}

exports.count = async function(searchTerm,done){
  if (searchTerm == ""){
    let result = await sql`SELECT COUNT(*) as players FROM player`.catch(err => {
    return done(err) ;
  })
  done(null,result);
    }
  
  else {
    let result = await sql`SELECT COUNT(*) as players FROM player WHERE gender = ?`.catch(err => {
    return done(err) ;
  })
  done(null,result);
  }
}

// GET
exports.getByName = async function(playerName,done){
  let result = await sql`SELECT * FROM player where levenshtein(concat(first_name," ",family_name), ?) < 4',playerName`.catch(err => {
    return done(err) ;
  })
  done(null,result);
}

exports.getByNameAndTeam = async function(playerName,teamId,distance,done){
  let result = await sql`select * from (select player.id as playerId, concat(first_name," ",family_name) as playerName, team.id as teamId, team.name as teamName from player join team where player.team = team.id) as playerClub where teamId=? AND levenshtein(playerName,?) < ?',[teamid,playerName,distance]`.catch(err => {
    return done(err) ;
  })
  done(null,result);
}

exports.getById = async function(playerId,done){
  let result = await sql`SELECT * FROM player WHERE id = ${ playerId }`.catch(err => {
    return done(err) ;
  })
  done(null,result);
}

exports.getPlayerDetailsbyId = async function(playerId, done){
  let result = await sql`select id, first_name, family_name, pgp_sym_decrypt("playerEmail",${process.env.DB_ENCODE}) as "playerEmail", pgp_sym_decrypt("playerTel",${process.env.DB_ENCODE}) as "playerTel", gender, "teamCaptain", "clubSecretary", treasurer, "matchSecrertary" from player where id = ${playerId}`.catch(err =>{
    return done(err);
  })
  done(null,result)
}

exports.getPlayerClubandTeamById = async function(playerId,done){
  let result = await sql`select "playerId", "playerName", "clubName", team.name as "teamName", date_of_registration from (select "playerId", "playerName", club.name as "clubName", "teamId", date_of_registration from (select player.id as "playerId", concat(player.first_name, ' ', player.family_name) as "playerName", player.club as "clubId", player.team as "teamId", player.date_of_registration from player where id = ${playerId}) as a join club where "clubId" = club.id) as b join team where "teamId" = team.id`.catch(err => {
    return done(err) ;
  })
  done(null,result);
}

// GET
exports.findByName = async function(searchObject,done){
  let result = await sql`SELECT * FROM player WHERE id = ?`.catch(err => {
    return done(err) ;
  })
  done(null,result);
}

// DELETE
exports.deleteById = async function(playerId,done){
  let result = await sql`DELETE FROM player WHERE id = ?`.catch(err => {
    return done(err) ;
  })
  done(null,result);
}

exports.getPrevRating = async function(player,endDate){
    let result = await sql`with "gameRows" as (select game.*, fixture.date, player.id as "playerId", division.rank as division from game 
join fixture on game.fixture = fixture.id 
join season on (fixture.date > season."startDate" and fixture.date < season."endDate")
join player on (game."homePlayer1" = player.id OR game."homePlayer2" = player.id OR game."awayPlayer1" = player.id OR game."awayPlayer2" = player.id)
join team on player.team = team.id
join division on team.division = division.id
where 
("homePlayer1" = ${player} OR
"homePlayer2" = ${player} OR
"awayPlayer1" = ${player} OR
"awayPlayer2" = ${player}) and season.name = ${SEASON} and (
  "homePlayer1End" is not null and
  "homePlayer2End" is not null and
  "awayPlayer1End" is not null and
  "awayPlayer2End" is not null
)
and date < ${endDate}
order by date desc, id desc
limit 1)
select case 
  when "homePlayer1" = ${player} then "homePlayer1End"
  when "homePlayer2" = ${player} then "homePlayer2End"
  when "awayPlayer1" = ${player} then "awayPlayer1End"
  when "awayPlayer2" = ${player} then "awayPlayer2End"
  end as "rating",
  date,
  "playerId",
  division
from "gameRows"
union all
select player.rating, ${endDate} as date, player.id as "playerId", division.rank as division from player join 
team on player.team = team.id join 
division on team.division = division.id
where player.id = ${player}
limit 1`.catch(err => {
    console.log(err.query)
    console.error(err)
    return err ;
  })
  if (result.length > 0){
    // console.log(`prevResult: ${JSON.stringify(result)}`)
    return result[0]
  }
  else {
    let result = {"rating":1500, "date":"2000-01-01 00:00:00","playerId":player,"division":1}
    // console.log(`prevResult: ${JSON.stringify(result)}`)
    return result
  }
  
}
