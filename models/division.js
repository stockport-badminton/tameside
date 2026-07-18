const { sql } = require('../utils/db_connect');

// POST

// GET
exports.getAll = async function(done){
  let result = await sql`SELECT * FROM "division"`.catch(err => {
    return done(err) ;
  })
  done(null,result);
}

// GET
exports.getAllByLeague = async function(leagueId,done){
  let result = await sql`SELECT * FROM "division" where league = ${leagueId}`.catch(err => {
    return done(err) ;
  })
  done(null,result);
}

// GET
exports.getById = async function(divisionId,done){
  let result = await sql`SELECT * FROM "division" WHERE "id" = ${divisionId}`.catch(err => {
    return done(err) ;
  })
  done(null,result);
}



exports.getIdByURLParam = async function(divisionName,done){
  divisionName = divisionName.replace('-',' ');
  let result = await sql`SELECT id FROM "division" WHERE name = ${divisionName}`.catch(err => {
    return done(err) ;
  })
  done(null,result);
}


exports.getAllAndSelectedById = async function(leagueId,divisionId,done){
  let result = await sql`select *, CASE WHEN division.id = ${divisionId} THEN true ELSE false END as selected from division WHERE league = ${leagueId}`.catch(err => {
    return done(err) ;
  })
  done(null,result);
}

// DELETE

// PATCH
