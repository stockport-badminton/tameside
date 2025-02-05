let postgres = require('postgres')
const sql = postgres(`postgres://postgres.tdsvugmbkgakgbtmoajj:${encodeURIComponent(process.env.PGPASSWORD)}@aws-0-eu-west-2.pooler.supabase.com:5432/postgres`,{ ssl : { rejectUnauthorized : false } })


// POST
exports.create = async function(name,venue,done){
  let result = await sql`INSERT INTO club ("name","venue") VALUES (${name},${venue})')`.catch(err => {
    return done(err) ;
  })
  done(null,result);
}


exports.createBatch = async function(BatchObj,done){
    if(db.isObject(BatchObj)){
      let bulkobj = BatchObj.data.map(row => {
        // Use reduce() to create an object for each row
        return row.reduce((obj, value, index) => {
            obj[BatchObj.fields[index]] = value; // Assign value to corresponding key
            return obj;
        }, {});
      })
      
      let rows = sql`insert into ${BatchObj.tablename} ${ sql(bulkobj) }`.catch(err => {
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
  let result = await sql`SELECT * FROM "club" order by name asc`.catch(err => {
    return done(err) ;
  })
  done(null,result);
}

exports.clubDetail = async function(done){
  let result = await sql`select
  club."id" as "clubId",
  club."name",
  team.name as teamName,
  team."matchDay" as "matchDay",
  venue."name" as clubvenue,
  venue."gMapUrl" as clubgmap,
  venue."address" as clubaddress,
  club."matchNightText",
  club."clubNightText",
  club."clubWebsite",
  club."matchVenue",
  teamvenue.name as teammatchvenue,
  teamvenue."gMapUrl" as teamgmap,
  teamvenue.address as teamaddress
from
  club
  join team on team.club = club.id
  join venue on venue."id" = club."venue"
  join venue teamvenue on teamvenue.id = team.venue
order by
  name
`.catch(err => {
    return done(err) ;
  })
  done(null,result);
}

exports.clubDetailbyId = async function(clubId,done){
  let result = await sql`SELECT a."clubId", a."name", a."venue", a."address", a."gMapURL" AS clubVenueURL, a."matchNightText",a."clubNightText", a."clubWebsite", venue."name" AS matchVenueName, venue."gMapUrl" AS matchVenueURL, venue."Lat", venue."Lng" FROM (SELECT club."id" as clubId, club."name", venue."name" AS venue, venue."gMapUrl",venue."address", club."matchNightText", club."clubNightText", club."clubWebsite",club."matchVenue" FROM club JOIN venue WHERE venue."id" =club."venue") AS a JOIN venue WHERE (a."matchVenue" = venue."id" OR a."matchVenue" = NULL) ORDER BY a."name"`.catch(err => {
    return done(err) ;
  })
  done(null,result);
}


exports.getContactDetailsById = async function(clubId,done){
  let result = await sql`SELECT club."name" AS "clubName",
    team."name" AS "teamName",
    venue."id" AS "venueId",
    venue."name" AS "venueName",
    venue."address" AS address,
    "matchVenue"."id" AS "matchVenueId",
    "matchVenue"."name" AS "matchVenueName",
    "matchVenue"."address" AS "matchVenueAddress",
    "matchNightText" AS "matchNight",
    CONCAT(
        "matchSec"."first_name",
        ' ',
        "matchSec"."family_name"
    ) AS "matchSecretary",
    pgp_sym_decrypt("matchSec"."playerTel", ${ process.env.DB_ENCODE }) AS "matchSecTel",
    pgp_sym_decrypt("matchSec"."playerEmail", ${ process.env.DB_ENCODE }) AS "matchSecEmail",
    CONCAT("clubSec"."first_name", ' ', "clubSec"."family_name") AS "clubSecretary",
    pgp_sym_decrypt("clubSec"."playerTel", ${ process.env.DB_ENCODE }) AS "clubSecTel",
    pgp_sym_decrypt("clubSec"."playerEmail", ${ process.env.DB_ENCODE }) AS "clubSecEmail",
    CONCAT(
        "teamCaptain"."first_name",
        ' ',
        "teamCaptain"."family_name"
    ) AS "teamCaptain",
    pgp_sym_decrypt("teamCaptain"."playerTel", ${ process.env.DB_ENCODE }) AS "teamCaptainTel",
    pgp_sym_decrypt("teamCaptain"."playerEmail", ${ process.env.DB_ENCODE }) AS "teamCaptainEmail"
FROM club
    JOIN team ON team."club" = club."id"
    JOIN venue ON club."venue" = venue."id"
    JOIN venue "matchVenue" ON club."matchVenue" = "matchVenue"."id"
    JOIN player "matchSec" ON club."id" = "matchSec"."club"
    and "matchSec"."matchSecrertary" = 1
    JOIN player "clubSec" ON (
        (
            club."id" = "clubSec"."club"
            and "clubSec"."clubSecretary" = 1
        )
        OR (club."clubSec" = "clubSec"."id")
    )
    JOIN player "teamCaptain" ON (
        (
            team."id" = "teamCaptain"."team"
            and "teamCaptain"."teamCaptain" = 1
        )
        OR (team."captain" = "teamCaptain"."id")
    )
WHERE club.id = ${ clubId }
order by "teamName"`.catch(err => {
    return done(err) ;
  })
  done(null,result);
}

// GET
exports.getById = async function(clubId,done){
  let result = await sql`SELECT * FROM club WHERE id = ${clubId}`.catch(err => {
    return done(err) ;
  })
  done(null,result);
}


// DELETE
exports.deleteById = async function(clubId,done){
  let result = await sql`DELETE FROM club WHERE id = ${clubId}`.catch(err => {
    return done(err) ;
  })
  done(null,result);
}


// PATCH
exports.updateById = async function(name, venue, clubId,done){
  let result = await sql`UPDATE club SET name = ${name}, venue = ${venue} WHERE id = ${clubId}`.catch(err => {
    return done(err) ;
  })
  done(null,result);
}

