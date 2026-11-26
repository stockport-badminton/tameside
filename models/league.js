const { sql, withRetry } = require('../utils/db_connect');
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
  // Declared: as a global it outlived the request, and the withRetry thunk below reads
  // it again on a retry, by which time another request may have set it.
  let seasonName
  if (season === undefined){
    seasonName = ''
    season = seasonModel.current();
  }
  else {
    // Only archived seasons have a team<season> snapshot. This used to trust the URL
    // and suffix unconditionally, so /tables/:division/<current season> asked for a
    // team20262027 that has never existed, and so did any junk season name — both a
    // 500. Fall back to the live tables when there's no snapshot; the season filter
    // further down still applies, so a name matching no season gives an empty table,
    // which is the right answer rather than an error.
    seasonName = await seasonModel.hasSnapshot(season) ? season : ''
  }
  division = division.replace('-',' ');
  // Lewis Shield ties (fixture.lewis_round, from 2026/27) are filtered out below: they are
  // published through the same path as a league result, so they carry a homeScore.

  // /tables/:division. Retried on a dead connection — see withRetry in
  // utils/db_connect.js. The thunk rebuilds the whole template, which matters here:
  // the JOIN below interpolates a nested sql`` fragment, and a fragment belongs to the
  // query that was built with it. Re-awaiting a Query object instead would just replay
  // the settled rejection.
 try {
  const result = await withRetry(() => sql`
  SELECT c."name", c."played", c."pointsFor" AS "gamesWon", c."pointsAgainst" AS "gamesLost"
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
                            END AS "matchWon", CASE
                                WHEN fixture."homeScore" = 9 THEN 1
                                ELSE 0
                            END AS "matchDrawn", "homeScore" AS "pointsFor", "awayScore" AS "pointsAgainst", fixture."homeTeam" AS "teamId"
                        FROM fixture
                            join season  
                            on (fixture."date" > season."startDate"
                            AND fixture."date" < season."endDate")
                        where
                            season."name" = ${ season }
                            AND fixture.lewis_round IS NULL
                        UNION ALL
                        SELECT
                            fixture."date", CASE
                                WHEN fixture."awayScore" IS NOT NULL THEN 1
                                ELSE 0
                            END AS played, CASE
                                WHEN fixture."awayScore" > 9 THEN 1
                                ELSE 0
                            END AS "matchWon", CASE
                                WHEN fixture."awayScore" = 9 THEN 1
                                ELSE 0
                            END AS "matchDrawn", "awayScore" AS "pointsFor", "homeScore" AS "pointsAgainst", fixture."awayTeam" AS "teamId"
                        FROM fixture
                            join season on
                            (fixture."date" > season."startDate"
                            AND fixture."date" < season."endDate")
                        where
                            season."name" = ${ season }
                            AND fixture.lewis_round IS NULL
                    ) AS a
                GROUP BY
                    a."teamId"
            ) AS b
            JOIN
            ${
                /* The alias has to sit OUTSIDE sql(), as it does in getAllLeagueTables
                 * below. postgres.js escapes a sql(string) as a single identifier
                 * (types.js escapeIdentifier: quote it, double any embedded quotes), so
                 * sql("team"+seasonName+" as team") asked for one relation literally
                 * named `team20242025 as team` and every archived-season request to
                 * /tables/:division/:season 500'd on "relation does not exist". */
                seasonName != ""
                ? sql`${sql("team"+seasonName)} as team`
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
ORDER BY "gamesWon" DESC
  `);
  // try/catch replaces the old `.catch(done)` + `if (!result) return` pair. With that
  // idiom a failure called done(err) and then fell through to done(null, undefined), so
  // leagueController took its success branch and rendered `tables` with no result after
  // next(err) had already begun the 500 — and being outside the request chain, that
  // throw killed the process rather than producing an error page. The guard patched it;
  // try/catch removes the path, and is what lets withRetry's rejection be caught here.
  done(null,result);
 } catch (err) { done(err); }
}

exports.getAllLeagueTables = async function(season,done){
  // Declared: as a global it outlived the request, and the withRetry thunk below reads
  // it again on a retry, by which time another request may have set it.
  let seasonName
  if (season === undefined){
    seasonName = ''
    season = seasonModel.current()
  }
  else {
    // See the note in getLeagueTable above — same trap, and this one suffixes
    // division<season> too.
    seasonName = await seasonModel.hasSnapshot(season) ? season : ''
  }
  // /tables/All. Retried on a dead connection — see the note in getLeagueTable above.
 try {
  const result = await withRetry(() => sql`select
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
  ),0) as "gamesWon",
  coalesce(
  sum(
    CASE
      WHEN fixture."homeTeam" = team.id THEN 18 - fixture."homeScore"
      when fixture."awayTeam" = team.id then 18 - fixture."awayScore"
      else 0
    end
  ),0) as "gamesLost",
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
  -- Lewis Shield ties are a cup, not the league: from 2026/27 they are fixture rows,
  -- and a result entered through /email-scorecard sets homeScore like any other.
  AND fixture.lewis_round IS NULL
group by
  team.name
order by
  "divisionName",
  "gamesWon" desc,
  "gamesLost" asc`);
  // See the note on the same conversion in getLeagueTable above.
  done(null,result);
 } catch (err) { done(err); }
}
// This season's standings with the fixtures each team has left, for the run-in page and the
// team-strength projection (utils/leagueRunIn.js, controllers/teamStrengthController.js).
// Ported from Stockport's League.getRunIn (097de0a). Games won count exactly as the
// /tables query counts them: every scored league fixture, less penalties, Lewis Shield ties
// left out. A fixture is still to play while it has no score and is outstanding or being
// rearranged; a superseded `rearranged` row is left out, as its replacement is counted.
// Ordered as /tables orders them, then by team.divRank. Numbers come back as numbers.
exports.getRunIn = async function() {
  const season = seasonModel.current();
  const rows = await sql`
    SELECT division.id AS division, division.name AS "divisionName", division.rank AS "divisionRank",
           team.id, team.name, team."divRank", s.played, s.remaining,
           s.won - COALESCE(team.penalties, 0) AS "gamesWon", s.lost AS "gamesLost"
    FROM (
      SELECT x.team, SUM(x.played) AS played, SUM(x.remaining) AS remaining,
             COALESCE(SUM(x.won), 0) AS won, COALESCE(SUM(x.lost), 0) AS lost
      FROM (
        SELECT f."homeTeam" AS team, f."homeScore" AS won, f."awayScore" AS lost,
               CASE WHEN f."homeScore" IS NOT NULL THEN 1 ELSE 0 END AS played,
               CASE WHEN f."homeScore" IS NULL AND f.status IN ('outstanding', 'rearranging') THEN 1 ELSE 0 END AS remaining
        FROM fixture f JOIN season ON f.date > season."startDate" AND f.date < season."endDate"
        WHERE season.name = ${season} AND f.lewis_round IS NULL
        UNION ALL
        SELECT f."awayTeam", f."awayScore", f."homeScore",
               CASE WHEN f."awayScore" IS NOT NULL THEN 1 ELSE 0 END,
               CASE WHEN f."awayScore" IS NULL AND f.status IN ('outstanding', 'rearranging') THEN 1 ELSE 0 END
        FROM fixture f JOIN season ON f.date > season."startDate" AND f.date < season."endDate"
        WHERE season.name = ${season} AND f.lewis_round IS NULL
      ) AS x
      GROUP BY x.team
    ) AS s
    JOIN team ON team.id = s.team
    JOIN division ON division.id = team.division
    WHERE division.league = 1
    ORDER BY division.rank, "gamesWon" DESC, team."divRank", team.name`;
  return rows.map(r => ({
    ...r,
    division: Number(r.division), divisionRank: Number(r.divisionRank), id: Number(r.id),
    played: Number(r.played), remaining: Number(r.remaining),
    gamesWon: Number(r.gamesWon), gamesLost: Number(r.gamesLost),
  }));
}

// How many teams go up from, and down to, each pair of divisions this season: the site
// setting `promotion_places` (/admin/site-settings), 2 when unset or not a small number.
// It varies by season (decided 23 Nov 2026), so it is a setting, not a constant.
const { DEFAULT_MOVING } = require('../utils/leagueRunIn');
exports.movingPlaces = async function() {
  try {
    const [row] = await sql`SELECT value FROM site_setting WHERE key = 'promotion_places'`;
    const n = row ? Number.parseInt(row.value, 10) : NaN;
    return Number.isInteger(n) && n >= 0 && n <= 4 ? n : DEFAULT_MOVING;
  } catch (err) {
    console.log('[league] promotion_places unreadable, using the default', err.message);
    return DEFAULT_MOVING;
  }
}
