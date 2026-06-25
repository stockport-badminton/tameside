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
      INSERT INTO fixture ("homeTeam", "awayTeam", date, status)
      SELECT "homeTeam", "awayTeam", date, 'outstanding'
      FROM tameside_draft_fixture
      WHERE season = ${season}
    `;

    done(null, result.count);
  } catch (err) {
    done(err);
  }
};

// Load lewis draw constraints for a season — identifies R1 (prelim), R2 (bracket round 1), and QF pairings.
// Returns { r1Pairs, r2Pairs, qfPairs } with { homeTeamId, awayTeamId } objects.
// Includes alternate pairings for slots whose team depends on a prelim result.
// Gracefully returns empty arrays if the lewis table isn't populated yet.
exports.getLewisConstraints = async function (season, done) {
  try {
    const [seasonRow] = await sql`
      SELECT "lewisPrelims" FROM season WHERE name = ${season}
    `;
    if (!seasonRow || !seasonRow.lewisPrelims) {
      return done(null, { r1Pairs: [], r2Pairs: [], qfPairs: [] });
    }

    const rawMatches = await sql`
      SELECT "drawPos", "homeTeam" AS "homeTeamId", "awayTeam" AS "awayTeamId"
      FROM lewis
      ORDER BY "drawPos"
    `;
    if (rawMatches.length === 0) {
      return done(null, { r1Pairs: [], r2Pairs: [], qfPairs: [] });
    }
    // Normalise to JS numbers so strict === comparisons work regardless of postgres column type
    const matches = rawMatches.map(m => ({
      drawPos:    Number(m.drawPos),
      homeTeamId: Number(m.homeTeamId),
      awayTeamId: Number(m.awayTeamId),
    }));

    // lewisPrelims stores the j-values (0-indexed bracket slot positions) of the prelim matches.
    // e.g. "0,9" means prelim match i fills slot j=jValues[i] in the 16-slot R2 bracket.
    const jValues = seasonRow.lewisPrelims.split(',').map(Number).filter(n => !isNaN(n));
    const prelimCount = jValues.length;

    console.log(`[lewis] lewisPrelims="${seasonRow.lewisPrelims}" → jValues=[${jValues}], prelimCount=${prelimCount}`);
    console.log(`[lewis] all drawPos in table: ${matches.map(m => `${m.drawPos}(${m.homeTeamId}v${m.awayTeamId})`).join(', ')}`);

    // Standard 16-slot bracket layout: prelim(1..P) | Round1(P+1..P+8) | QF(P+9..P+12) | SF(P+13..P+14)
    const r1Pairs = matches.filter(m => m.drawPos >= 1               && m.drawPos <= prelimCount);
    const r2Drawn = matches.filter(m => m.drawPos >= prelimCount + 1  && m.drawPos <= prelimCount + 8);
    const qfDrawn = matches.filter(m => m.drawPos >= prelimCount + 9  && m.drawPos <= prelimCount + 12);
    console.log(`[lewis] R1 pairs (${r1Pairs.length}):`, r1Pairs.map(m => `dp${m.drawPos}:${m.homeTeamId}v${m.awayTeamId}`));
    console.log(`[lewis] R2 drawn (${r2Drawn.length}):`, r2Drawn.map(m => `dp${m.drawPos}:${m.homeTeamId}v${m.awayTeamId}`));
    console.log(`[lewis] QF drawn (${qfDrawn.length}):`, qfDrawn.map(m => `dp${m.drawPos}:${m.homeTeamId}v${m.awayTeamId}`));

    // R2 pairs: definite entries (no No-Team placeholders) + alternates for prelim-dependent slots.
    // Prelim-dependent slots are stored in the DB as teamId=52 (No Team).
    // j-value mapping: j → R2 drawPos = Math.floor(j/2) + prelimCount + 1
    //                  even j → home slot;  odd j → away slot
    // jValues[i] → r1Pairs[i] (correlated by position in the lewisPrelims string).
    const r2Pairs = r2Drawn
      .filter(m => m.homeTeamId !== 52 && m.awayTeamId !== 52)
      .map(m => ({ homeTeamId: m.homeTeamId, awayTeamId: m.awayTeamId }));

    for (let i = 0; i < jValues.length; i++) {
      const jVal     = jValues[i];
      const r2DrawPos = Math.floor(jVal / 2) + prelimCount + 1;
      const isHomeSide = (jVal % 2 === 0);
      const r2Match  = r2Drawn.find(m => m.drawPos === r2DrawPos);
      const prelim   = r1Pairs[i];

      if (!r2Match) { console.warn(`[lewis] no R2 match found for j=${jVal} → drawPos ${r2DrawPos}`); continue; }
      if (!prelim)  { console.warn(`[lewis] no R1 prelim at index ${i} for j=${jVal}`); continue; }

      const knownId = isHomeSide ? r2Match.awayTeamId : r2Match.homeTeamId;
      if (knownId === 52) { console.warn(`[lewis] both sides of R2 drawPos ${r2DrawPos} are unknown`); continue; }

      console.log(`[lewis] R2 drawPos ${r2DrawPos}: ${isHomeSide ? 'home' : 'away'} slot filled by prelim ${prelim.homeTeamId} vs ${prelim.awayTeamId}; known ${isHomeSide ? 'away' : 'home'}=${knownId}`);

      if (isHomeSide) {
        r2Pairs.push({ homeTeamId: prelim.homeTeamId, awayTeamId: knownId });
        r2Pairs.push({ homeTeamId: prelim.awayTeamId, awayTeamId: knownId });
      } else {
        r2Pairs.push({ homeTeamId: knownId, awayTeamId: prelim.homeTeamId });
        r2Pairs.push({ homeTeamId: knownId, awayTeamId: prelim.awayTeamId });
      }
    }

    // QF permutations: derived from the bracket structure.
    // For each QF slot (q = 1..4), the two R2 matches that feed it are:
    //   home side = drawPos P + 2*(q-1) + 1  (lower drawPos → home bracket side)
    //   away side = drawPos P + 2*(q-1) + 2  (higher drawPos → away bracket side)
    // Possible winners of each R2 match:
    //   - If both teams known: [homeId, awayId]
    //   - If one slot is 52 (prelim-dependent): [knownId, prelim.homeTeamId, prelim.awayTeamId]
    // QF pairs = cross-product of (home-side winners × away-side winners).
    const getPossibleR2Winners = (r2DrawPos) => {
      const match = r2Drawn.find(m => m.drawPos === r2DrawPos);
      if (!match) return [];
      if (match.homeTeamId !== 52 && match.awayTeamId !== 52) {
        return [match.homeTeamId, match.awayTeamId];
      }
      // Find which prelim (r1Pair) feeds this R2 slot via jValues
      const jIndex = jValues.findIndex(j => Math.floor(j / 2) + prelimCount + 1 === r2DrawPos);
      if (jIndex === -1) return [match.homeTeamId, match.awayTeamId].filter(id => id !== 52);
      const prelim = r1Pairs[jIndex];
      const knownId = match.homeTeamId !== 52 ? match.homeTeamId : match.awayTeamId;
      return [knownId, prelim.homeTeamId, prelim.awayTeamId];
    };

    // qfPairs (for scheduling): one representative per QF slot — the bracket-default
    // outcome where the home team of each R2 match wins. Exactly 4 fixtures get scheduled.
    // qfPermutations (for display): all possible pairings per QF slot.
    const qfPairs = [];
    const qfPermutations = [];
    for (let q = 1; q <= 4; q++) {
      const r2DrawPosA = prelimCount + 2 * (q - 1) + 1;  // home bracket side
      const r2DrawPosB = prelimCount + 2 * (q - 1) + 2;  // away bracket side
      const homeWinners = getPossibleR2Winners(r2DrawPosA);
      const awayWinners = getPossibleR2Winners(r2DrawPosB);
      const slotPairs = [];
      for (const homeId of homeWinners) {
        for (const awayId of awayWinners) {
          slotPairs.push({ homeTeamId: homeId, awayTeamId: awayId });
        }
      }
      qfPermutations.push({ qfDrawPos: prelimCount + 8 + q, pairs: slotPairs });
      // Schedule all permutations — only one per slot will ever be played, but all need dates
      qfPairs.push(...slotPairs);
    }
    console.log(`[lewis] QF: ${qfPairs.length} scheduling fixtures (all permutations), ${qfPermutations.reduce((s,p)=>s+p.pairs.length,0)} total permutations`);

    console.log(`[lewis] final: r1=${r1Pairs.length}, r2=${r2Pairs.length}, qf=${qfPairs.length}`);
    done(null, { r1Pairs, r2Pairs, qfPairs, qfPermutations });
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
