// Which clubs have sent their player registration form in, and who still needs chasing.
//
// One row per (season, club) in `club_registration`, created lazily. Absence means
// "nothing received, nothing chased", which is what makes the season rollover free —
// see migrations/club-registration.sql.
//
// Everything here is async/await returning a value, not the callback style the older
// models use. The callers are all async (the admin controller and the digest task), and
// the `.catch(err => done(err))` idiom the older models use has a real bug in it — it
// calls done(err) and then falls through to done(null, undefined). See the note on
// withRetry in CLAUDE.md.

const { sql } = require('../utils/db_connect');
const seasonModel = require('./season');

// `No Club` is the placeholder a released player parks on, not a club to chase. It has
// one team ("No Team") and no fixtures, so the join below would drop it anyway — but
// naming it means a stray fixture against No Team can never put it on the worklist.
const NO_CLUB_ID = 63;

// A season name is appended to nothing here, but it is written to the table and used as
// a lookup key, so it is still validated: a junk name would silently create a parallel
// set of rows nothing ever reads again.
function assertSeason(name) {
  const season = name || seasonModel.current();
  if (!seasonModel.isValidName(season)) {
    throw new Error(`clubRegistration: not a season name: ${season}`);
  }
  return season;
}

// Each club's first fixture of the season, with whatever registration status it has.
//
// THE SEASON WINDOW IS A DATE RANGE, NOT A JOIN. `fixture` holds every season's matches
// in one table (652 rows spanning 2023–2027), and there is no season column — the only
// thing separating them is the date. Joining `season ON fixture.date BETWEEN ...` is
// what silently dropped 48 fixtures from getFixtureEventById: an INNER JOIN to a table
// the SELECT list never touches removes rows for free.
//
// `fixture.date` is a `timestamp without time zone` holding local midnight, so it is
// compared to CURRENT_DATE directly. Do not convert it AT TIME ZONE 'Europe/London' —
// that shifts every match a day earlier and puts league nights on a Sunday.
//
// Rearranged fixtures are excluded: a rearranged match has been moved, and its original
// date is not a deadline for anything. The replacement carries its own row.
async function statusRows(season) {
  return sql`
    WITH season_window AS (   -- not plain "window": reserved, for the WINDOW clause
      SELECT "startDate", "endDate" FROM season WHERE name = ${season}
    ),
    first_fixture AS (
      SELECT t.club AS club,
             MIN(f.date)::date AS first_date,
             COUNT(DISTINCT t.id) AS teams
      FROM team t
      JOIN fixture f ON (f."homeTeam" = t.id OR f."awayTeam" = t.id)
      CROSS JOIN season_window w
      WHERE f.date >= w."startDate" AND f.date <= w."endDate"
        AND f.status IS DISTINCT FROM 'rearranged'
      GROUP BY t.club
    )
    SELECT c.id, c.name,
           ff.first_date               AS "firstFixture",
           ff.teams,
           (ff.first_date - CURRENT_DATE) AS "daysAway",
           r.received_at               AS "receivedAt",
           r.chased_at                 AS "chasedAt",
           COALESCE(r.chase_count, 0)  AS "chaseCount",
           r.note,
           r.updated_by                AS "updatedBy"
    FROM club c
    JOIN first_fixture ff ON ff.club = c.id
    LEFT JOIN club_registration r ON r.club = c.id AND r.season = ${season}
    WHERE c.id <> ${NO_CLUB_ID}
    ORDER BY ff.first_date, c.name`;
}

// The people to chase. Both roles are read because the club secretary is the addressee
// and the match secretary is usually the one holding the team lists.
//
// AT MOST TAMESIDE CLUBS ONE PERSON HOLDS BOTH, and this is one row per player, so the
// role has to be built from both flags — a plain `CASE WHEN clubSecretary THEN … ELSE …`
// labels that person "club secretary" and quietly drops the other half. The worklist
// prints this next to the address it is about to email, so it should be true.
//
// Two rows can still share an address (a duplicated player row — there are eight
// duplicated display names in this table), which is what mergeOfficers below is for.
//
// `matchSecrertary` is spelt that way in the schema. It is not a typo here.
//
// The PgP key is BOUND AS A PARAMETER, never interpolated. A blank address is sometimes
// NULL and sometimes an encrypted empty string, so the emptiness test has to decrypt
// rather than check IS NOT NULL.
async function officerRows() {
  return sql`
    SELECT t.club AS "clubId",
           trim(p.first_name || ' ' || p.family_name) AS name,
           NULLIF(TRIM(pgp_sym_decrypt(p."playerEmail", ${process.env.DB_ENCODE})::text), '') AS email,
           CASE WHEN p."clubSecretary" = 1 AND p."matchSecrertary" = 1
                  THEN 'club and match secretary'
                WHEN p."clubSecretary" = 1 THEN 'club secretary'
                ELSE 'match secretary' END AS role
    FROM player p
    JOIN team t ON p.team = t.id
    WHERE (p."clubSecretary" = 1 OR p."matchSecrertary" = 1)
      AND t.club <> ${NO_CLUB_ID}
    ORDER BY t.club, CASE WHEN p."clubSecretary" = 1 THEN 0 ELSE 1 END, p.id`;
}

// One person can hold both roles — at Tameside most do — and would otherwise appear
// twice and be emailed twice. Merged on the address, keeping the first (club secretary,
// by the ORDER BY above) and recording both titles.
function mergeOfficers(rows) {
  const byEmail = new Map();
  const noEmail = [];
  for (const o of rows) {
    if (!o.email) { noEmail.push({ name: o.name, email: null, role: o.role }); continue; }
    const key = o.email.toLowerCase();
    const seen = byEmail.get(key);
    if (seen) {
      if (!seen.role.includes(o.role)) seen.role += ' and ' + o.role;
    } else {
      byEmail.set(key, { name: o.name, email: o.email, role: o.role });
    }
  }
  return [...byEmail.values(), ...noEmail];
}

// Every club with a fixture this season, each with its deadline and status.
exports.getStatus = async function (season) {
  const name = assertSeason(season);
  const [clubs, officers] = await Promise.all([statusRows(name), officerRows()]);

  const byClub = new Map();
  for (const o of officers) {
    const key = Number(o.clubId);
    if (!byClub.has(key)) byClub.set(key, []);
    byClub.get(key).push(o);
  }

  return clubs.map(row => ({
    ...row,
    id: Number(row.id),
    teams: Number(row.teams),
    daysAway: Number(row.daysAway),
    chaseCount: Number(row.chaseCount),
    season: name,
    received: !!row.receivedAt,
    chased: !!row.chasedAt,
    officers: mergeOfficers(byClub.get(Number(row.id)) || []),
  }));
};

// Everything the daily digest reports, in the two groups the results secretary asked for.
//
// `dueSoon` is deliberately inclusive of clubs whose first fixture has already gone: a
// deadline that has passed is more urgent than one three days out, not less, and
// dropping a club the morning it expires is how one plays a match unregistered.
//
// `chased` is the second group — outstanding, not yet due, but already chased at least
// once, i.e. the ones that have had their nudge and still not replied.
exports.getDigest = async function (season, withinDays = 3) {
  const name = assertSeason(season);
  const clubs = await exports.getStatus(name);
  const outstanding = clubs.filter(c => !c.received);
  return {
    season: name,
    withinDays,
    dueSoon: outstanding.filter(c => c.daysAway <= withinDays),
    chased: outstanding.filter(c => c.daysAway > withinDays && c.chased),
    outstanding: outstanding.length,
    received: clubs.length - outstanding.length,
    total: clubs.length,
  };
};

// The upserts. All three target the (season, club) unique index, so a club with no row
// gets one on its first event and nothing has to pre-populate the table.
//
// `updated_by` is the acting user's email, for the "who ticked this" question that comes
// up a season later. postgres.js parameterises every ${} here, including the timestamps.

exports.markReceived = async function (season, clubId, updatedBy) {
  const name = assertSeason(season);
  const rows = await sql`
    INSERT INTO club_registration (season, club, received_at, updated_by)
    VALUES (${name}, ${Number(clubId)}, now(), ${updatedBy || null})
    ON CONFLICT (season, club) DO UPDATE
      SET received_at = now(), updated_by = EXCLUDED.updated_by, updated_at = now()
    RETURNING id`;
  return rows[0] && Number(rows[0].id);
};

exports.markNotReceived = async function (season, clubId, updatedBy) {
  const name = assertSeason(season);
  const rows = await sql`
    INSERT INTO club_registration (season, club, received_at, updated_by)
    VALUES (${name}, ${Number(clubId)}, NULL, ${updatedBy || null})
    ON CONFLICT (season, club) DO UPDATE
      SET received_at = NULL, updated_by = EXCLUDED.updated_by, updated_at = now()
    RETURNING id`;
  return rows[0] && Number(rows[0].id);
};

// chase_count increments rather than being set, so "chased three times and still
// nothing" is visible on the screen. A first chase inserts 1.
exports.recordChase = async function (season, clubId, updatedBy) {
  const name = assertSeason(season);
  const rows = await sql`
    INSERT INTO club_registration (season, club, chased_at, chase_count, updated_by)
    VALUES (${name}, ${Number(clubId)}, now(), 1, ${updatedBy || null})
    ON CONFLICT (season, club) DO UPDATE
      SET chased_at = now(),
          chase_count = club_registration.chase_count + 1,
          updated_by = EXCLUDED.updated_by,
          updated_at = now()
    RETURNING id, chase_count AS "chaseCount"`;
  return rows[0] && { id: Number(rows[0].id), chaseCount: Number(rows[0].chaseCount) };
};

exports.setNote = async function (season, clubId, note, updatedBy) {
  const name = assertSeason(season);
  const text = note && String(note).trim() ? String(note).trim().slice(0, 2000) : null;
  const rows = await sql`
    INSERT INTO club_registration (season, club, note, updated_by)
    VALUES (${name}, ${Number(clubId)}, ${text}, ${updatedBy || null})
    ON CONFLICT (season, club) DO UPDATE
      SET note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = now()
    RETURNING id`;
  return rows[0] && Number(rows[0].id);
};

exports.NO_CLUB_ID = NO_CLUB_ID;
exports.mergeOfficers = mergeOfficers;
