const { sql, withRetry } = require('../utils/db_connect');


// POST
exports.create = async function(name,venue,done){
  let result = await sql`INSERT INTO club ("name","venue") VALUES (${name},${venue})`.catch(err => {
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

// /info/clubs. Retried on a dead connection — see withRetry in utils/db_connect.js.
exports.clubDetail = async function(done){
 try {
  const result = await withRetry(() => sql`select
  club."id" as "clubId",
  club."name",
  team.name as teamName,
  team."matchDay" as "matchDay",
  venue."name" as clubvenue,
  venue."gMapUrl" as clubgmap,
  venue."address" as clubaddress,
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
`);
  done(null,result);
 } catch (err) { done(err); }
}



// The club contact page (/club/:id -> views/club-contact.ejs).
//
// WHAT WAS WRONG, AND WHY IT LOOKED LIKE A DUPLICATE-ROW BUG
//
// This was five inner joins with no guarantee of matching one row each, so it returned
// the CARTESIAN PRODUCT of every candidate for every role. Disley has one team, one
// match secretary, two players flagged `clubSecretary` and two captain candidates, so
// the page rendered 1 x 1 x 2 x 2 = FOUR "Disley A" captain cards. Five of the
// league's thirteen clubs were affected (Disley x4, No Club x3, Medlock x2, Aerospace
// and Manchester Edgeley x1.5).
//
// Duplicated cards were the visible half. Three worse things were hidden under them:
//
//  1. views/club-contact.ejs reads every CLUB-level field off `clubrow[0]`, so where
//     two people are flagged for one role, one of them is silently dropped and which
//     one you see depends on an order the query never specified. Julian Cherryman
//     never appeared on Disley's page at all.
//
//  2. `0` IS A PLAYER ID MEANING "NOBODY" — the same "No Player" sentinel documented
//     for scorecards in CLAUDE.md — and `club."clubSec"` is 0 for Mellor and No Club.
//     The old join compared against it directly, so Mellor's Club Secretary rendered
//     as "No Player" WITH THAT ROW'S DECRYPTED PHONE AND EMAIL, on a page whose own
//     banner calls itself confidential. Every candidate below is guarded with
//     `p.id <> 0`.
//
//  3. Every join was INNER and club_controller turns zero rows into a 500, so a club
//     missing any one of a venue, a match venue, a club secretary or a team captain
//     took the whole page down rather than rendering without that field. No club hit
//     it only because `0` accidentally satisfied Mellor's club-secretary join. All of
//     them are LEFT joins now and the officers resolve to null.
//
// ROLE RESOLUTION: THE POINTER WINS, THE FLAG FILLS THE GAPS
//
// Each of these three roles is recorded in two places that disagree — a foreign key on
// the subject of the role (`team.captain`, `club."clubSec"`, `club."matchSec"`) and a
// boolean on the player (`player."teamCaptain"`, `player."clubSecretary"`,
// `player."matchSecrertary"`). They disagree for 13 of 20 teams. See
// migrations/consolidate-club-contacts.sql for the measurement and the direction of
// travel; the short version is that the foreign key is the only one of the two that
// can express what is actually true, because a boolean on a player says "I captain the
// team I play FOR" and three of the league's captains captain a team they do not play
// in (and two of them captain both of their club's teams).
//
// So each LATERAL takes the pointer where it is set and falls back to the flag where it
// is not. That ordering is deliberately correct BOTH BEFORE AND AFTER the backfill in
// that migration, so this can ship on its own: today the flag supplies the five teams
// and four clubs whose pointer is empty, and once the pointer is complete the fallback
// stops firing without this query changing. LIMIT 1 is what makes it one row per team
// no matter how many candidates exist.
exports.getContactDetailsById = async function(clubId,done){
 try {
  const key = process.env.DB_ENCODE;
  const result = await sql`SELECT club."name" AS "clubName",
    team."name" AS "teamName",
    venue."id" AS "venueId",
    venue."name" AS "venueName",
    venue."address" AS address,
    "matchVenue"."id" AS "matchVenueId",
    "matchVenue"."name" AS "matchVenueName",
    "matchVenue"."address" AS "matchVenueAddress",
    CASE WHEN "matchSec"."id" IS NOT NULL
        THEN CONCAT("matchSec"."first_name", ' ', "matchSec"."family_name") END AS "matchSecretary",
    pgp_sym_decrypt("matchSec"."playerTel", ${ key }) AS "matchSecTel",
    pgp_sym_decrypt("matchSec"."playerEmail", ${ key }) AS "matchSecEmail",
    CASE WHEN "clubSec"."id" IS NOT NULL
        THEN CONCAT("clubSec"."first_name", ' ', "clubSec"."family_name") END AS "clubSecretary",
    pgp_sym_decrypt("clubSec"."playerTel", ${ key }) AS "clubSecTel",
    pgp_sym_decrypt("clubSec"."playerEmail", ${ key }) AS "clubSecEmail",
    CASE WHEN "teamCaptain"."id" IS NOT NULL
        THEN CONCAT("teamCaptain"."first_name", ' ', "teamCaptain"."family_name") END AS "teamCaptain",
    pgp_sym_decrypt("teamCaptain"."playerTel", ${ key }) AS "teamCaptainTel",
    pgp_sym_decrypt("teamCaptain"."playerEmail", ${ key }) AS "teamCaptainEmail"
FROM club
    JOIN team ON team."club" = club."id"
    LEFT JOIN venue ON venue."id" = club."venue"
    LEFT JOIN venue "matchVenue" ON "matchVenue"."id" = club."matchVenue"
    LEFT JOIN LATERAL (
        SELECT p.* FROM player p
        WHERE p."id" <> 0
          AND (p."id" = club."matchSec" OR (p."club" = club."id" AND p."matchSecrertary" = 1))
        ORDER BY COALESCE(p."id" = club."matchSec", false) DESC, p."id"
        LIMIT 1
    ) "matchSec" ON true
    LEFT JOIN LATERAL (
        SELECT p.* FROM player p
        WHERE p."id" <> 0
          AND (p."id" = club."clubSec" OR (p."club" = club."id" AND p."clubSecretary" = 1))
        ORDER BY COALESCE(p."id" = club."clubSec", false) DESC, p."id"
        LIMIT 1
    ) "clubSec" ON true
    LEFT JOIN LATERAL (
        SELECT p.* FROM player p
        WHERE p."id" <> 0
          AND (p."id" = team."captain" OR (p."team" = team."id" AND p."teamCaptain" = 1))
        ORDER BY COALESCE(p."id" = team."captain", false) DESC, p."id"
        LIMIT 1
    ) "teamCaptain" ON true
WHERE club.id = ${ clubId }
ORDER BY team."name"`;
  done(null,result);
 } catch (err) { done(err); }
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



/**
 * Clubs that have told us an Instagram handle, for the mentions in a social caption.
 *
 * Promise-returning rather than callback-style, deliberately: its only caller is an async
 * controller, and wrapping a promise in a `done` only to await it again adds a way to get
 * it wrong. The callback models above are the older convention, not a house rule.
 *
 * **Built from the database, never hardcoded into the caption.** The Make.com scenario this
 * replaces carried `@manor_badminton_club` in its text where the club's stored handle was
 * `manorbadmintonclubwilmslow`, and named another club that has no handle at all. A wrong
 * `@handle` mentions a stranger, or nothing, and nobody ever notices.
 *
 * The character filter is not tidiness. A handle with a space or a `/` in it becomes a
 * mention of something else once Instagram parses the caption, so a malformed one is
 * dropped rather than posted.
 *
 * Note: as of Sep 2026 no Tameside club has a handle stored, so this correctly returns an
 * empty list and captions carry no mentions. That is a gap in the data, not in the code.
 */
exports.getInstagramHandles = async function () {
  const rows = await sql`
    SELECT name, instagram FROM club
     WHERE instagram IS NOT NULL AND TRIM(instagram) <> ''
     ORDER BY name`;
  return rows
    .map(r => ({ name: r.name, handle: String(r.instagram).trim().replace(/^@+/, '') }))
    .filter(r => /^[A-Za-z0-9._]+$/.test(r.handle));
};
