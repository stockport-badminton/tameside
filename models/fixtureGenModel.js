const { sql } = require('../utils/db_connect');

// Derive team index (A=1, B=2, C=3) from last letter of team name
function getTeamIndex(name) {
  const letter = name.trim().slice(-1).toUpperCase();
  return { A: 1, B: 2, C: 3, D: 4 }[letter] || 1;
}

// Fetch all teams from DB, grouped into divisions — ready for the scheduler
exports.getTeamsForScheduler = async function (done) {
  try {
    const rows = await sql`
      SELECT
        t.id,
        t.name,
        t."matchNight"  AS "homeNight",
        d.id           AS "divisionId",
        d.name         AS "divisionName",
        c.id           AS "clubId",
        c.name         AS "clubName"
      FROM team t
      JOIN division d ON t.division = d.id
      JOIN club     c ON t.club     = c.id
      ORDER BY d.id, t.name
    `;

    const divMap = new Map();
    for (const row of rows) {
      if (!divMap.has(row.divisionId)) {
        divMap.set(row.divisionId, { id: row.divisionId, name: row.divisionName, teams: [] });
      }
      divMap.get(row.divisionId).teams.push({
        id:         row.id,
        name:       row.name,
        homeNight:  row.homeNight,
        club:       row.clubName,
        clubId:     row.clubId,
        teamindex:  getTeamIndex(row.name),
        divisionId: row.divisionId,
      });
    }

    done(null, Array.from(divMap.values()));
  } catch (err) {
    done(err);
  }
};

// Load saved draft fixtures for a season
exports.getDraftFixtures = async function (season, done) {
  try {
    const rows = await sql`
      SELECT
        d.id,
        d.date,
        d.division           AS "divisionId",
        div.name             AS "divisionName",
        d."homeTeam"         AS "homeTeamId",
        ht.name              AS "homeTeamName",
        hc.name              AS "homeClubName",
        d."awayTeam"         AS "awayTeamId",
        at.name              AS "awayTeamName",
        ac.name              AS "awayClubName",
        d."generatedAt"
      FROM tameside_draft_fixture d
      JOIN division div ON d.division   = div.id
      JOIN team     ht  ON d."homeTeam" = ht.id
      JOIN club     hc  ON ht.club      = hc.id
      JOIN team     at  ON d."awayTeam" = at.id
      JOIN club     ac  ON at.club      = ac.id
      WHERE d.season = ${season}
      ORDER BY d.date, div.id
    `;
    done(null, rows);
  } catch (err) {
    done(err);
  }
};

// Save generated season calendar to the draft table (replaces any existing draft)
exports.saveDraftFixtures = async function (seasonCalendar, season, done) {
  try {
    await sql`DELETE FROM tameside_draft_fixture WHERE season = ${season}`;

    const rows = [];
    for (const dateRow of seasonCalendar) {
      for (const fixture of dateRow.fixtures || []) {
        rows.push({
          season,
          homeTeam:  fixture.homeTeam.id,
          awayTeam:  fixture.awayTeam.id,
          date:      dateRow.dbDate,
          division:  fixture.divisionId,
        });
      }
    }

    if (rows.length > 0) {
      await sql`INSERT INTO tameside_draft_fixture ${sql(rows)}`;
    }

    done(null, rows.length);
  } catch (err) {
    done(err);
  }
};

// Publish draft fixtures into the live fixture table
exports.publishDraftFixtures = async function (season, done) {
  try {
    // Prevent double-publishing — delete any existing unplayed fixtures for this season first
    await sql`
      DELETE FROM fixture
      WHERE season = ${season}
        AND "homeScore" IS NULL
        AND status NOT IN ('complete', 'conceded', 'void')
    `;

    const result = await sql`
      INSERT INTO fixture ("homeTeam", "awayTeam", date, division, season, status)
      SELECT "homeTeam", "awayTeam", date, division, season, 'unplayed'
      FROM tameside_draft_fixture
      WHERE season = ${season}
    `;

    done(null, result.count);
  } catch (err) {
    done(err);
  }
};

// Clear the draft for a season (used by regenerate)
exports.clearDraftFixtures = async function (season, done) {
  try {
    await sql`DELETE FROM tameside_draft_fixture WHERE season = ${season}`;
    done(null);
  } catch (err) {
    done(err);
  }
};
