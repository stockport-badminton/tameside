const { sql } = require('../utils/db_connect');
const seasonModel = require('./season');

// POST
exports.create = async function(name,starttime,endtime,matchDay,venue,courtspace,club,division,rank,done){
  let rows = await sql`INSERT INTO "team" ("name","starttime","endtime","matchDay","venue","courtspace","club","division","rank") VALUES (${name},${starttime},${endtime},${matchDay},${venue},${courtspace},${club},${division},${rank})`.catch(err => {
        return done(err)
    })
    done(null,rows);
  }

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

// GET
exports.getById = async function(teamId,done){
  let rows = await sql`SELECT * FROM team WHERE id = ${teamId}`.catch(err => {
        return done(err)
    })
    console.log(rows)
    done(null,rows);
  }

// GET
exports.getByName = async function(teamName,done){
  let rows = await sql`SELECT * FROM "team" WHERE "name" = ${teamName}`.catch(err => {
        return done(err)
    })
    done(null,rows);
  }

exports.getAllAndSelectedByName = async function(teamName,divisionId,done){
  let rows = await sql`select *, CASE WHEN team.name = ${teamName} THEN true ELSE false END as selected from team WHERE division = ${divisionId}`.catch(err => {
        return done(err)
    })
    done(null,rows);
  }

exports.getAllAndSelectedById = async function(teamId,divisionId,done){
  let rows = await sql`select *, CASE WHEN team.id = ${teamId} THEN true ELSE false END as selected from team WHERE division = ${divisionId}`.catch(err => {
        return done(err)
    })
    done(null,rows);
  }

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
exports.deleteById = async function(teamId,done){
  let rows = await sql`DELETE FROM "team" WHERE "id" = ${teamId}`.catch(err => {
        return done(err)
    })
    done(null,rows);
  }

// PATCH
exports.updateById = async function(teamObj,teamId,done){
  if (typeof teamObj !== undefined){
    let rows = await sql`
      update team set ${
        sql(Object.values(teamObj), Object.keys(teamObj))
      }
      where id = ${ teamId }
    `.catch(err => {
      return done(err)
    })
    done(null,rows);
  }
  else {
    return done(err);
  }

}

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
    done(null,rows);
  }