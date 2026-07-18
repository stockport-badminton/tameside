const { sql } = require('../utils/db_connect');
const seasonModel = require('./season');

// POST

  // GET
  exports.getAll = async function(done){
    let rows = await sql`SELECT * FROM "league"
    `.catch(err => {
        return done(err)
    })
    done(null,rows);
  }

  // GET
  exports.getById = async function(leagueId,done){
    let rows = await sql`SELECT * FROM "league" WHERE "id" = ${leagueId}`.catch(err => {
        return done(err)
    })
    done(null,rows);
  }

  // DELETE
  exports.deleteById = async function(leagueId,done){
    let rows = await sql`DELETE FROM "league" WHERE "id" = ${leagueId}`.catch(err => {
        return done(err)
    })
    done(null,rows);
  }

  // PATCH
  exports.updateById = async function(name, admin, url, leagueId,done){
    let rows = await sql`UPDATE "league" SET "name" = ${name}, "admin" = ${admin}, "url" = ${url} WHERE "id" = ${leagueId}`.catch(err => {
        return done(err)
    })
    done(null,rows);
  }
  

exports.getLeagueTable = async function(division,season,done){
  if (season === undefined){
    seasonName = ''
    season = seasonModel.current();
  }
  else {
    seasonName = season
  }
  division = division.replace('-',' ');

  let result = await sql`
  SELECT c."name", c."played", c."pointsFor", c."pointsAgainst"
FROM (
        SELECT team."name", b."played", b."pointsFor" - team."penalties" as "pointsFor", b."pointsAgainst", team."division"
        FROM (
                SELECT
                    SUM(a."played") AS played, SUM(a."pointsFor") AS "pointsFor", SUM(a."pointsAgainst") AS "pointsAgainst", a."teamId"
                FROM (
                        SELECT
                            fixture."date", CASE
                                WHEN fixture."homeScore" IS NOT NULL THEN 1
                                ELSE 0
                            END AS played, CASE
                                WHEN fixture."homeScore" > 9 THEN 1
                                ELSE 0
                            END AS "gamesWon", CASE
                                WHEN fixture."homeScore" = 9 THEN 1
                                ELSE 0
                            END AS "gamesDrawn", "homeScore" AS "pointsFor", "awayScore" AS "pointsAgainst", fixture."homeTeam" AS "teamId"
                        FROM fixture
                            join season  
                            on (fixture."date" > season."startDate"
                            AND fixture."date" < season."endDate")
                        where
                            season."name" = ${ season }
                        UNION ALL
                        SELECT
                            fixture."date", CASE
                                WHEN fixture."awayScore" IS NOT NULL THEN 1
                                ELSE 0
                            END AS played, CASE
                                WHEN fixture."awayScore" > 9 THEN 1
                                ELSE 0
                            END AS "gamesWon", CASE
                                WHEN fixture."awayScore" = 9 THEN 1
                                ELSE 0
                            END AS "gamesDrawn", "awayScore" AS "pointsFor", "homeScore" AS "pointsAgainst", fixture."awayTeam" AS "teamId"
                        FROM fixture
                            join season on
                            (fixture."date" > season."startDate"
                            AND fixture."date" < season."endDate")
                        where
                            season."name" = ${ season }
                    ) AS a
                GROUP BY
                    a."teamId"
            ) AS b
            JOIN
            ${
                seasonName != "" 
                ? sql`${sql("team"+seasonName+" as team")}`
                : sql`team`
            }
        on
            team."id" = b."teamId"
    ) AS c
    JOIN division
on
    c."division" = division."id"
    where
    (division."name" = ${ division }
    AND division."league" = 1)
ORDER BY "pointsFor" DESC
  `.catch(err =>{
    return done(err)
  }
  )
  done(null,result);
}

exports.getAllLeagueTables = async function(season,done){
  if (season === undefined){
    seasonName = ''
    season = seasonModel.current()
  }
  else {
    seasonName = season
  }
  let result = await sql`select
  min(division.name) as "divisionName",
  min(division.id) as division,
  team.name,
  coalesce(
  sum(
    CASE
      WHEN fixture."homeTeam" = team.id THEN fixture."homeScore"
      when fixture."awayTeam" = team.id then fixture."awayScore"
      else 0
    end
  ),0) as "pointsFor",
  coalesce(
  sum(
    CASE
      WHEN fixture."homeTeam" = team.id THEN 18 - fixture."homeScore"
      when fixture."awayTeam" = team.id then 18 - fixture."awayScore"
      else 0
    end
  ),0) as "pointsAgainst",
  sum(
    CASE
      WHEN fixture."homeTeam" = team.id
      AND fixture."homeScore" is not null then 1
      when fixture."awayTeam" = team.id
      and fixture."awayScore" is not null then 1
      else 0
    end
  ) as played,
  min(team."divRank") as "divRank"
from
${
    seasonName != "" 
    ? sql`${sql("team"+seasonName)} as team`
    : sql`team`
}
  join fixture on (
    team.id = fixture."homeTeam"
    OR team.id = fixture."awayTeam"
  )
  join ${
    seasonName != "" 
    ? sql`${sql("division"+seasonName)} as division`
    : sql`division`
} on team.division = division.id
  join season on (
    fixture.date > season."startDate"
    AND fixture.date < season."endDate"
  )
where
  season.name = ${ season }
group by
  team.name
order by
  "divisionName",
  "pointsFor" desc,
  "pointsAgainst" asc`.catch(err =>{
    return done(err)
  }
  )
  done(null,result);
}