// Missed three: nominated players who have not played in any of their team's last three
// completed matches this season. League rule 18 (Stockport's 19b — same rule, their
// numbering): the results secretary is told, and may have a replacement promoted.
//
// Ported from Stockport (league-site 30df345, 15a3e88, 3fde4a5). What changed on the way:
//
//  - A Tameside side is FOUR men and TWO ladies (homeMan1-4, homeLady1-2), not 3 + 3. That
//    shows up twice: in the slots read, and in the "fielded a full side of its own players"
//    exemption, which is 4 + 2 here.
//  - Officers resolve POINTER FIRST, FLAG SECOND (club."clubSec" / club."matchSec", then the
//    player flags), exactly as the club contact page does — see models/club.js. Stockport
//    reads the flags.
//  - postgres.js tagged templates, and the season from season.current().
const { sql } = require('../utils/db_connect');
const seasonModel = require('./season');
const { NO_CLUB_ID, mergeOfficers } = require('./clubRegistration');

// A reserve's rank. Everything else — including NULL — is a nominated player.
const RESERVE_RANK = 99;
// A full side of a team's own players. A team that fielded this many of its own men AND
// ladies across its last three matches had no gap a nominated player left; one that
// borrowed while a nominated player sat out is what the rule is about.
const SIDE = { men: 4, ladies: 2 };

// One row per flagged player. Each team must have played at least three completed matches
// this season, must not be its club's lowest team (there is nobody below to promote, so
// the notice could not name one), and its club must not be the No Club placeholder.
exports.getPlayers = async function () {
  return sql`
WITH season_window AS (
  SELECT "startDate", "endDate" FROM season WHERE name = ${seasonModel.current()}
),
team_fixtures AS (
  SELECT f.id AS fixture_id, f.date AS fixture_date, f."homeTeam" AS team_id,
         f."homeMan1" AS m1, f."homeMan2" AS m2, f."homeMan3" AS m3, f."homeMan4" AS m4,
         f."homeLady1" AS l1, f."homeLady2" AS l2
    FROM fixture f JOIN season_window w ON f.date >= w."startDate" AND f.date <= w."endDate"
   WHERE f.status = 'complete'
  UNION ALL
  SELECT f.id, f.date, f."awayTeam",
         f."awayMan1", f."awayMan2", f."awayMan3", f."awayMan4", f."awayLady1", f."awayLady2"
    FROM fixture f JOIN season_window w ON f.date >= w."startDate" AND f.date <= w."endDate"
   WHERE f.status = 'complete'
),
ranked AS (
  SELECT tf.*, ROW_NUMBER() OVER (PARTITION BY team_id ORDER BY fixture_date DESC, fixture_id DESC) AS rn
    FROM team_fixtures tf
),
last3 AS (SELECT * FROM ranked WHERE rn <= 3),
teams_with_three AS (SELECT team_id FROM ranked GROUP BY team_id HAVING COUNT(*) >= 3),
slots AS (
            SELECT team_id, fixture_id, m1 AS player_id, 'Male' AS slot_gender FROM last3
  UNION ALL SELECT team_id, fixture_id, m2, 'Male'   FROM last3
  UNION ALL SELECT team_id, fixture_id, m3, 'Male'   FROM last3
  UNION ALL SELECT team_id, fixture_id, m4, 'Male'   FROM last3
  UNION ALL SELECT team_id, fixture_id, l1, 'Female' FROM last3
  UNION ALL SELECT team_id, fixture_id, l2, 'Female' FROM last3
),
-- Distinct players of the team's OWN registration used across those matches.
own_used AS (
  SELECT s.team_id,
         COUNT(DISTINCT s.player_id) FILTER (WHERE s.slot_gender = 'Male')   AS men,
         COUNT(DISTINCT s.player_id) FILTER (WHERE s.slot_gender = 'Female') AS ladies
    FROM slots s JOIN player p ON p.id = s.player_id AND p.team = s.team_id
   WHERE s.player_id <> 0
   GROUP BY s.team_id
),
-- 0 is the "No Player" sentinel, never a person.
appearances AS (
  SELECT team_id, player_id, COUNT(DISTINCT fixture_id) AS n
    FROM slots WHERE player_id <> 0 GROUP BY team_id, player_id
),
team_filtered AS (
  SELECT t.*,
         COUNT(*) OVER (PARTITION BY t.club) AS club_team_count,
         MAX(t.rank) OVER (PARTITION BY t.club) AS club_lowest_rank
    FROM team t
   WHERE t.club <> ${NO_CLUB_ID}
)
SELECT t.id AS "teamId", t.name AS "teamName", t.club AS "clubId", t.rank AS "teamRank",
       p.id AS "playerId", p.first_name AS "firstName", p.family_name AS "familyName", p.gender,
       (SELECT n.name FROM team n
         WHERE n.club = t.club AND n.rank > t.rank
         ORDER BY n.rank, n.id LIMIT 1) AS "nextTeamName"
  FROM team_filtered t
  JOIN teams_with_three twt ON twt.team_id = t.id
  JOIN player p ON p.team = t.id AND p.id <> 0 AND (p.rank IS NULL OR p.rank <> ${RESERVE_RANK})
  LEFT JOIN appearances a ON a.team_id = t.id AND a.player_id = p.id
  LEFT JOIN own_used ou ON ou.team_id = t.id
 WHERE t.club_team_count > 1
   AND t.rank < t.club_lowest_rank
   AND COALESCE(a.n, 0) = 0
   AND NOT (COALESCE(ou.men, 0) >= ${SIDE.men} AND COALESCE(ou.ladies, 0) >= ${SIDE.ladies})
 ORDER BY t.club, t.rank, p.family_name, p.first_name`;
};

// The club and match secretary of each club, merged by address (at most Tameside clubs one
// person holds both). Pointer first, flag second, and never player 0 — the same resolution
// as Club.getContactDetailsById, so the notice goes to whoever the contact page names.
// Officers with no address on file come back with `email: null`.
exports.getOfficers = async function (clubIds) {
  const ids = [...new Set((clubIds || []).map(Number).filter(Number.isInteger))];
  if (!ids.length) return [];
  const key = process.env.DB_ENCODE;
  const rows = await sql`
    SELECT club.id AS "clubId", club.name AS "clubName", r.role,
           trim(r.first_name || ' ' || r.family_name) AS name,
           NULLIF(TRIM(pgp_sym_decrypt(r."playerEmail", ${key})::text), '') AS email
      FROM club
      CROSS JOIN LATERAL (
        (SELECT 'club secretary' AS role, p.id, p.first_name, p.family_name, p."playerEmail"
           FROM player p
          WHERE p.id <> 0 AND (p.id = club."clubSec" OR (p.club = club.id AND p."clubSecretary" = 1))
          ORDER BY COALESCE(p.id = club."clubSec", false) DESC, p.id LIMIT 1)
        UNION ALL
        (SELECT 'match secretary', p.id, p.first_name, p.family_name, p."playerEmail"
           FROM player p
          WHERE p.id <> 0 AND (p.id = club."matchSec" OR (p.club = club.id AND p."matchSecrertary" = 1))
          ORDER BY COALESCE(p.id = club."matchSec", false) DESC, p.id LIMIT 1)
      ) r
     WHERE club.id = ANY(${ids}::int[])
     ORDER BY club.id, r.role`;
  const byClub = new Map();
  for (const r of rows) {
    if (!byClub.has(r.clubId)) byClub.set(r.clubId, []);
    byClub.get(r.clubId).push(r);
  }
  return [...byClub.entries()].flatMap(([clubId, list]) =>
    mergeOfficers(list).map(o => ({ clubId, clubName: list[0].clubName, ...o })));
};

exports.SIDE = SIDE;
exports.RESERVE_RANK = RESERVE_RANK;
