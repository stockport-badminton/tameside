const { sql } = require('../utils/db_connect');
const seasonModel = require('./season');

// POST

  exports.createBatch = async function(BatchObj,done){
    if(typeof BatchObj.data !== undefined && typeof BatchObj.fields !== undefined && typeof BatchObj.tablename !== undefined){
      let bulkobj = BatchObj.data.map(row => {
        // Use reduce() to create an object for each row
        return row.reduce((obj, value, index) => {
            obj[BatchObj.fields[index]] = value; // Assign value to corresponding key
            return obj;
        }, {});
      })
      
      let rows = await sql`insert into ${sql(BatchObj.tablename)} ${ sql(bulkobj) }`.catch(err => {
        return done(err)
      })
      done(null,rows);
    }
    else{
      return done('not object');
    }
  }

// GET
exports.getAll = async function(done){
  let rows = await sql`SELECT * FROM "team"`.catch(err => {
        return done(err)
    })
    done(null,rows);
  }

// GET
exports.getTeams = async function(searchObject,done){
  if(typeof searchObject.club !== undefined || typeof searchObject.teamName !== undefined || typeof searchObject.division !== undefined|| typeof searchObject.section !== undefined  ){
    // console.log(searchObject);
    let rows = await sql`SELECT * from "team"

  ${
    searchObject.section !== undefined 
      ? sql`where section = ${searchObject.section}`
      : sql`where section like '%'`
  }
  ${
    searchObject.teamName !== undefined 
      ? sql`and team like ${searchObject.teamName}`
      : sql``
  }
  ${
    searchObject.clubid !== undefined 
    ? sql`and club = ${searchObject.club}`
    : sql``
}
  ${
    searchObject.divisionId !== undefined 
      ? sql`and division = ${searchObject.divisionId}`
      : sql``
  }`.catch(err => {
    console.log(err.query)
    return done(err)
  })
  done(null,rows);
  }
  else{
    return done('not object');
  }
}

// GET — team row(s) by exact name (id, division, club, rank). Used by the
// scorecard-OCR flow to resolve the S3 key's team names to ids.
exports.findByName = async function(teamName,done){
  let rows = await sql`SELECT "id","name","division","club","rank" FROM team WHERE "name" = ${teamName}`.catch(err => {
        return done(err)
    })
    if (!rows) return;
    done(null,rows);
  }

// GET
exports.getById = async function(teamId,done){
  let rows = await sql`SELECT * FROM team WHERE id = ${teamId}`.catch(err => {
        return done(err)
    })
    console.log(rows)
    done(null,rows);
  }

// GET


exports.getAllAndSelectedById = async function(teamId,divisionId,done){
  let rows = await sql`select *, CASE WHEN team.id = ${teamId} THEN true ELSE false END as selected from team WHERE division = ${divisionId}`.catch(err => {
        return done(err)
    })
    done(null,rows);
  }

/* ------------------------------------------------------------------ *
 * Lewis Shield bracket — result entry + winner auto-progression.
 * ------------------------------------------------------------------ */

// Pure bracket topology: where does the winner of `drawPos` advance to?
// Layout (standard 16-slot single elim, P = prelimCount):
//   prelims 1..P | R1 P+1..P+8 | QF P+9..P+12 | SF P+13..P+14 | Final P+15
// Prelims feed R1 via the season's j-values (lewisPrelims): a prelim at drawPos
// p (i = p-1) fills R1 drawPos floor(j/2)+P+1, home slot if j even else away
// (mirrors fixtureGenModel.getLewisConstraints). Returns {targetDrawPos, side}
// or null (final / no parent / off-bracket, e.g. a 3rd-place slot).
exports.lewisAdvanceTarget = function (drawPos, prelimCount, jValues) {
  drawPos = Number(drawPos);
  prelimCount = Number(prelimCount) || 0;
  jValues = jValues || [];
  if (drawPos <= prelimCount) {
    const j = jValues[drawPos - 1];
    if (j === undefined) return null;
    return { targetDrawPos: Math.floor(j / 2) + prelimCount + 1, side: (j % 2 === 0) ? 'home' : 'away' };
  }
  // Main draw: fixed sizes 8/4/2/1 regardless of prelimCount.
  const rounds = [
    { start: prelimCount + 1,  size: 8 }, // R1
    { start: prelimCount + 9,  size: 4 }, // QF
    { start: prelimCount + 13, size: 2 }, // SF
    { start: prelimCount + 15, size: 1 }, // Final
  ];
  for (let r = 0; r < rounds.length; r++) {
    const { start, size } = rounds[r];
    const end = start + size - 1;
    if (drawPos >= start && drawPos <= end) {
      if (r === rounds.length - 1) return null; // final — winner is champion
      const idx = drawPos - start;
      return { targetDrawPos: (end + 1) + Math.floor(idx / 2), side: (idx % 2 === 0) ? 'home' : 'away' };
    }
  }
  return null;
};

// Current-season prelim metadata: j-values and prelim count (from lewisPrelims).
exports.getLewisMeta = async function (done) {
  const s = await sql`SELECT "lewisPrelims" FROM season WHERE name = ${seasonModel.current()}`.catch(err => { return done(err); });
  if (!s) return;
  const jValues = (s[0] && s[0].lewisPrelims)
    ? s[0].lewisPrelims.split(',').map(Number).filter(n => !isNaN(n))
    : [];
  done(null, { jValues: jValues, prelimCount: jValues.length });
};

// Current-season Lewis bracket rows (raw drawPos/team-id/score) for admin entry.
exports.getLewisBracket = async function (done) {
  const rows = await sql`
    SELECT "drawPos", "homeTeam", "awayTeam", "homeScore", "awayScore", "winningTeam"
    FROM lewis ORDER BY "drawPos"`.catch(err => { return done(err); });
  if (!rows) return;
  done(null, rows);
};

// Record a Lewis result and advance the winner into its next-round slot.
// Guards: both teams must be known (no id 52 placeholder), a clear winner is
// required (no draws in a knockout), and it won't overwrite a next-round slot
// that already has a result. Returns { winningTeam, advance }.
exports.saveLewisResult = async function (drawPos, homeScore, awayScore, prelimCount, jValues, done) {
  homeScore = Number(homeScore); awayScore = Number(awayScore);
  if (!Number.isInteger(homeScore) || !Number.isInteger(awayScore) || homeScore < 0 || awayScore < 0) {
    return done(new Error('Scores must be non-negative whole numbers.'));
  }
  if (homeScore === awayScore) return done(new Error('A Lewis tie needs a winner — scores cannot be equal.'));

  const rows = await sql`SELECT "drawPos","homeTeam","awayTeam" FROM lewis WHERE "drawPos" = ${drawPos}`.catch(err => { return done(err); });
  if (!rows) return;
  const m = rows[0];
  if (!m) return done(new Error('No Lewis match at drawPos ' + drawPos));
  if (Number(m.homeTeam) === 52 || Number(m.awayTeam) === 52) {
    return done(new Error('Both teams must be known before entering a result.'));
  }
  const winningTeam = homeScore > awayScore ? m.homeTeam : m.awayTeam;

  const upd = await sql`
    UPDATE lewis SET "homeScore" = ${homeScore}, "awayScore" = ${awayScore}, "winningTeam" = ${winningTeam}
    WHERE "drawPos" = ${drawPos}`.catch(err => { return done(err); });
  if (!upd) return;

  let advance = { advanced: false };
  const target = exports.lewisAdvanceTarget(drawPos, prelimCount, jValues);
  if (target) {
    const tRows = await sql`SELECT "homeScore","awayScore" FROM lewis WHERE "drawPos" = ${target.targetDrawPos}`.catch(err => { return done(err); });
    if (!tRows) return;
    const t = tRows[0];
    if (t && (t.homeScore != null || t.awayScore != null)) {
      advance = { advanced: false, reason: 'target-already-played', targetDrawPos: target.targetDrawPos };
    } else if (t) {
      if (target.side === 'home') {
        await sql`UPDATE lewis SET "homeTeam" = ${winningTeam} WHERE "drawPos" = ${target.targetDrawPos}`;
      } else {
        await sql`UPDATE lewis SET "awayTeam" = ${winningTeam} WHERE "drawPos" = ${target.targetDrawPos}`;
      }
      advance = { advanced: true, targetDrawPos: target.targetDrawPos, side: target.side };
    }
  }
  done(null, { winningTeam: winningTeam, advance: advance });
};

// Superadmin admin UI helpers — explicit column handling so they don't depend
// on the legacy updateById's sql(values, keys) shape.

// Insert a team from a plain {column: value} object.
exports.adminCreate = async function(teamObj,done){
  let rows = await sql`insert into "team" ${ sql(teamObj) }`.catch(err => {
    return done(err)
  })
  done(null,rows);
}

// Update the given columns on a team from a plain {column: value} object.
exports.adminUpdate = async function(teamObj,teamId,done){
  let rows = await sql`update "team" set ${ sql(teamObj) } where "id" = ${ teamId }`.catch(err => {
    return done(err)
  })
  done(null,rows);
}

// Promotion / relegation: move a team to a different division.
exports.setDivision = async function(teamId,divisionId,done){
  let rows = await sql`update "team" set "division" = ${ divisionId } where "id" = ${ teamId }`.catch(err => {
    return done(err)
  })
  done(null,rows);
}

// DELETE

// PATCH

exports.getLewis = async function(searchTerms,done){
  var season = ""
  var seasonVal = seasonModel.current()

  if (!searchTerms.season){
    console.log("no season");
  }
  else {
    season = searchTerms.season;
    seasonVal = searchTerms.season;
  }
  let rows = await sql`SELECT 
    "homeTeam".name as "homeTeamName",
    "awayTeam".name as "awayTeamName",
    lewis."homeScore",
    lewis."awayScore",
    lewis."drawPos",
    season."lewisPrelims"
FROM
    ${sql ("lewis" + season)} lewis join
    ${sql ("team" + season)} "homeTeam" on lewis."homeTeam" = "homeTeam".id join
    ${sql ("team" + season)} "awayTeam" on lewis."awayTeam" = "awayTeam".id join 
    season on season.name  = ${seasonVal}`.catch(err => {
      return done(err)
    })
    // If the query errored (e.g. no lewis<season> table for that season), the
    // .catch above already called done(err); bail out so we don't call done a
    // second time with undefined rows (which crashed the caller's .reduce).
    if (!rows) return;
    done(null,rows);
  }