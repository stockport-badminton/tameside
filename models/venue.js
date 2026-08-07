const { sql, withRetry } = require('../utils/db_connect');

// POST


// GET
exports.getAll = async function(done){
  let result = await sql`SELECT * FROM venue`.catch(err => {
        return done(err)
    })
    done(null,result.insertId);

  }

// /info/clubs. Retried on a dead connection — see withRetry in utils/db_connect.js.
exports.getVenueClubs = async function(done){
 try {
  const result = await withRetry(() => sql`select
  "venueName",
  "Lat",
  "Lng",
  string_agg("venueClubsHTML", '<br />') as "venueInfoBox"
from
  (
    select
      "venueName",
      "Lat",
      "Lng",
      concat(
        '<strong id="firstHeading" class="firstHeading"><a href="',
        "clubWebsite",
        '">',
        "clubName",
        '</a></strong><div id="bodyContent"><p>Match Night:',
        "matchNightText",
        '<br />Club Night:',
        "clubNightText",
        '<br />Address:<a href="',
        "gMapUrl",
        '">',
        address,
        '</a></p></div>'
      ) as "venueClubsHTML"
    from
      (
        select
          venue."name" as "venueName",
          venue."address",
          venue."gMapUrl",
          venue."Lat",
          venue."Lng",
          club."name" as "clubName",
          club."matchNightText",
          club."clubNightText",
          club."clubWebsite"
        from
          venue
          join club
        on
          venue."id" = club."venue"
        union
        select
          venue."name" as "venueName",
          venue."address",
          venue."gMapUrl",
          venue."Lat",
          venue."Lng",
          club."name" as "clubName",
          club."matchNightText",
          club."clubNightText",
          club."clubWebsite"
        from
          venue
          join club
        on
          venue."id" = club."matchVenue"
      ) as "venueInfo"
  ) as "groupedVenueInfo"
group by
  "venueName",
  "Lat",
  "Lng"`);
  done(null,result);
 } catch (err) { done(err); }
}

// GET

// DELETE

// PATCH
