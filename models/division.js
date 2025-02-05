let postgres = require('postgres')
const sql = postgres(`postgres://postgres.tdsvugmbkgakgbtmoajj:${encodeURIComponent(process.env.PGPASSWORD)}@aws-0-eu-west-2.pooler.supabase.com:5432/postgres`,{ ssl : { rejectUnauthorized : false } })

// POST
exports.create = async function(name,league,rank,done){
  let result = await sql`INSERT INTO "division" ("name","league","rank") VALUES (?,?,?)`.catch(err => {
    return done(err) ;
  })
  done(null,result);

}

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

exports.getByName = async function(divisionName,done){
  let result = await sql`SELECT * FROM "division" WHERE name = ${divisionName}`.catch(err => {
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

exports.getAllAndSelectedByName = async function(leagueId,divisionName,done){
  let result = await sql`select *, CASE WHEN division.name = ${divisionName} THEN true ELSE false END as selected from division WHERE league = ${leagueId}`.catch(err => {
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
exports.deleteById = async function(divisionId,done){
  let result = await sql`DELETE FROM "division" WHERE "id" = ${divisionId}`.catch(err => {
    return done(err) ;
  })
  done(null,result);
}

// PATCH
exports.updateById = async function(name, league, rank, divisionId,done){
  let result = await sql`UPDATE "division" SET "name" = ${name}, "league" = ${league}, "rank" = ${rank} WHERE "id" = ${divisionId}`.catch(err => {
    return done(err) ;
  })
  done(null,result);
}
