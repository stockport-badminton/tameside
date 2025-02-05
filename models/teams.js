let postgres = require("postgres")
const sql = postgres(`postgres://postgres.tdsvugmbkgakgbtmoajj:${encodeURIComponent(process.env.PGPASSWORD)}@aws-0-eu-west-2.pooler.supabase.com:5432/postgres`,{ ssl : { rejectUnauthorized : false } })

let  SEASON = "";
 if (new Date().getMonth() < 6){
   SEASON = "" + new Date().getFullYear()-1 +""+ new Date().getFullYear();
 }
 else {
   SEASON = "" + new Date().getFullYear() +""+ (new Date().getFullYear()+1);
 }

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
  var seasonVal = SEASON

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
    lewis."drawPos"
FROM
    ${sql ("lewis" + season)} lewis join
    ${sql ("team" + season)} "homeTeam" on lewis."homeTeam" = "homeTeam".id join
    ${sql ("team" + season)} "awayTeam" on lewis."awayTeam" = "awayTeam".id`.catch(err => {
      return done(err)
    })
    done(null,rows);
  }