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
/**
 * Every venue anything happens at, with what happens there.
 *
 * ── The red herring, which cost two attempts at this ─────────────────────────
 *
 * `club.matchNightText` and `club.matchVenue` look like the answer to "where and when does
 * this club play". **They are not, and nothing else on the page reads them.**
 * `matchNightText` is a hand-written summary — G.H.A.P's says *"A: Tuesday, B: Monday
 * 7.30pm 2 courts"* — that lumps every team into one string, and `matchVenue` can only
 * name one place. `club_controller` copies `matchNightText` onto the card model and
 * `views/club.ejs` never prints it; the card's "Match Details" panel is built from
 * `team.matchDay` and each team's OWN venue.
 *
 * **The truth is per team.** G.H.A.P proves it: GHAP **A** plays at Old Trafford Sports
 * Barn on a Tuesday, GHAP **B** at Manchester Communication Academy on a Monday, and the
 * club's `matchVenue` names only the second. A map built from the club columns cannot
 * express that, whichever way it is sliced — the first attempt at this fix moved the wrong
 * information around instead of dropping it.
 *
 * So this returns two separate things per venue, from the two places that actually know:
 *
 *   matchTeams  — from `team.venue`, one entry per TEAM, with that team's `matchDay`
 *   clubNights  — from `club.venue`, one entry per CLUB, with its `clubNightText`
 *
 * A venue can have either, or both. Manchester Communication Academy has one team and no
 * club night; "No Venue" is a real row with a club night and no teams and no coordinates.
 *
 * ── And why it returns data rather than HTML ─────────────────────────────────
 *
 * The original built the popup markup here with `concat`, interpolating the club name, its
 * website into an `href` and the venue address, none of them escaped. Alderley Park's
 * address already contains an apostrophe ("NOT Mulberry's"); a `"` or a `<` in any of these
 * free-text fields would have broken the markup. The markup now lives in
 * `static/js/venue-popup.js`, where it can be escaped and tested.
 */
exports.getVenueClubs = async function(done){
 try {
  const result = await withRetry(() => sql`
    SELECT
      venue."name"    AS "venueName",
      venue."Lat",
      venue."Lng",
      venue."address",
      venue."gMapUrl",
      (
        SELECT json_agg(
                 json_build_object(
                   'club',     club."name",
                   'website',  club."clubWebsite",
                   'team',     team."name",
                   'matchDay', team."matchDay"
                 ) ORDER BY club."name", team."name")
        FROM team
        JOIN club ON club."id" = team."club"
        WHERE team."venue" = venue."id"
      ) AS "matchTeams",
      (
        SELECT json_agg(
                 json_build_object(
                   'club',          club."name",
                   'website',       club."clubWebsite",
                   'clubNightText', club."clubNightText"
                 ) ORDER BY club."name")
        FROM club
        WHERE club."venue" = venue."id"
      ) AS "clubNights"
    FROM venue
    WHERE EXISTS (SELECT 1 FROM team WHERE team."venue" = venue."id")
       OR EXISTS (SELECT 1 FROM club WHERE club."venue" = venue."id")
    ORDER BY venue."name"`);
  done(null,result);
 } catch (err) { done(err); }
}

// GET

// DELETE

// PATCH
