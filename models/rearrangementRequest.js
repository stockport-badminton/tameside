// Fixture rearrangement emails sent to rearrangements@ (migrations/rearrangement-request.sql).
// utils/rearrangementEmail.js reads the email; controllers/rearrangementRequestController.js
// is the page that confirms it. Ported from Stockport's models/rearrangementRequest.js
// (kysely there, postgres.js here).
//
// Also the reads that page needs about fixtures (the candidates an email points at, a team's
// usual home night, what else is on the new date), kept here rather than in models/fixture.js
// because nothing else asks these questions.
//
// jsonb is written with sql.json(value): a JSON.stringify'd parameter cast to jsonb is
// stored as a jsonb STRING under postgres.js (CLAUDE.md, Inbound list email).

const { sql } = require('../utils/db_connect');
const seasonModel = require('./season');

const SUMMARY = sql`
  id, received_at AS "receivedAt", forwarded_by AS "forwardedBy",
  original_from AS "originalFrom", subject, outcome, status,
  closed_at AS "closedAt", closed_by AS "closedBy"`;

// Queue one email. Returns its id, or null when this message is already queued.
async function create({ messageId, forwardedBy, originalFrom, subject, bodyText, reading }) {
  const rows = await sql`
    INSERT INTO rearrangement_request
      (message_id, forwarded_by, original_from, subject, body_text, reading)
    VALUES (${messageId}, ${forwardedBy || null}, ${originalFrom || null}, ${subject || null},
            ${bodyText || null}, ${sql.json(reading || {})}::jsonb)
    ON CONFLICT (message_id) DO NOTHING
    RETURNING id`;
  return rows.length ? Number(rows[0].id) : null;
}

async function list(status) {
  return sql`
    SELECT ${SUMMARY} FROM rearrangement_request
    WHERE status = ${status} ORDER BY received_at DESC LIMIT 100`;
}

async function countPending() {
  const [row] = await sql`SELECT COUNT(*)::int AS n FROM rearrangement_request WHERE status = 'pending'`;
  return row ? row.n : 0;
}

async function getById(id) {
  const [row] = await sql`
    SELECT ${SUMMARY}, body_text AS "bodyText", reading
    FROM rearrangement_request WHERE id = ${id}`;
  return row || null;
}

async function setStatus(id, status, by) {
  const closing = status !== 'pending';
  const rows = await sql`
    UPDATE rearrangement_request
    SET status = ${status},
        closed_at = ${closing ? sql`now()` : null},
        closed_by = ${closing ? by : null}
    WHERE id = ${id}
    RETURNING id`;
  return rows.length > 0;
}

// Record what was applied and close the request, inside the rearrangement's transaction
// (Fixture.rearrangeById's `withinTransaction`). Only a pending request: one already closed
// returns false, and the caller throws so the fixture change rolls back with it.
async function recordOutcome(tx, id, outcome, by) {
  const rows = await tx`
    UPDATE rearrangement_request
    SET outcome = ${sql.json(outcome)}::jsonb, status = 'done', closed_at = now(), closed_by = ${by}
    WHERE id = ${id} AND status = 'pending'
    RETURNING id`;
  return rows.length > 0;
}

// The clubs and teams an email might name: those with a team in a real division. That
// leaves out No Club and the other league's club rows. (Stockport filters out No Club and
// withdrawn teams; this schema has no `withdrawn`.)
async function clubsAndTeams() {
  const teams = await sql`
    SELECT team.id::int AS id, team.name, team.club::int AS "clubId", club.name AS "clubName"
    FROM team
    JOIN club ON club.id = team.club
    JOIN division ON division.id = team.division
    ORDER BY team.name`;
  const clubs = [...new Map(teams.map(t => [t.clubId, { id: t.clubId, name: t.clubName }])).values()]
    .sort((a, b) => a.name.localeCompare(b.name));
  return { clubs, teams: teams.map(({ id, name, clubId }) => ({ id, name, clubId })) };
}

// This season's league fixtures, in the shape the page and utils/rearrangementEmail.propose
// use. Lewis Shield fixtures are left out: Fixture.rearrangeById refuses them.
function seasonFixtures(where) {
  return sql`
    SELECT f.id::int AS id, to_char(f.date, 'YYYY-MM-DD') AS date,
           to_char(f.date, 'Dy FMDD Mon YYYY') AS "dayLabel",
           f.status, f."homeScore", f."awayScore",
           f."homeTeam"::int AS "homeTeamId", f."awayTeam"::int AS "awayTeamId",
           h.name AS "homeTeam", a.name AS "awayTeam",
           h.club::int AS "homeClubId", a.club::int AS "awayClubId", d.name AS division
    FROM fixture f
    JOIN season s ON s.name = ${seasonModel.current()}
    JOIN team h ON h.id = f."homeTeam"
    JOIN team a ON a.id = f."awayTeam"
    LEFT JOIN division d ON d.id = h.division
    WHERE f.date >= s."startDate" AND f.date <= s."endDate" AND f.lewis_round IS NULL
      AND (${where})`;
}

// The fixtures an email could be about:
//  - on a date it mentions, involving a club it names (or any club, when it names none);
//  - already 'rearranging' between two clubs it names, which is what the second email
//    ("the date is now agreed") is about, and it need not repeat the original date;
//  - every remaining fixture of `teamId`, when the page asks ("not listed? pick a team").
async function candidateFixtures({ dates, clubIds, teamId }) {
  if (!dates.length && clubIds.length < 2 && !teamId) return [];
  const either = [];
  if (dates.length) {
    const onDate = sql`to_char(f.date, 'YYYY-MM-DD') IN ${sql(dates)}`;
    either.push(clubIds.length
      ? sql`(${onDate} AND (h.club IN ${sql(clubIds)} OR a.club IN ${sql(clubIds)}))`
      : onDate);
  }
  if (clubIds.length >= 2) {
    either.push(sql`(f.status = 'rearranging' AND h.club IN ${sql(clubIds)} AND a.club IN ${sql(clubIds)})`);
  }
  if (teamId) {
    either.push(sql`((f."homeTeam" = ${teamId} OR f."awayTeam" = ${teamId}) AND f."homeScore" IS NULL
      AND (f.status IS NULL OR f.status IN ('outstanding', 'rearranging')))`);
  }
  const where = either.reduce((acc, part) => sql`${acc} OR ${part}`);
  return sql`${seasonFixtures(where)} ORDER BY f.date, h.name LIMIT 60`;
}

async function fixtureById(id) {
  const [row] = await seasonFixtures(sql`f.id = ${id}`);
  return row || null;
}

// The weekdays a team plays its home fixtures on this season, most common first, as
// [{ dow, n }] with dow 0 = Sunday: the "usual home night" checked by eye. Read from the
// fixtures, as Stockport's is, rather than team.matchNight.
async function homeWeekdays(teamId) {
  return sql`
    SELECT extract(dow FROM f.date)::int AS dow, COUNT(*)::int AS n
    FROM fixture f JOIN season s ON s.name = ${seasonModel.current()}
    WHERE f."homeTeam" = ${teamId} AND f.date >= s."startDate" AND f.date <= s."endDate"
      AND f.lewis_round IS NULL
      AND (f.status IS NULL OR f.status NOT IN ('rearranged', 'void'))
    GROUP BY 1 ORDER BY n DESC`;
}

// Everything either team has on a date, other than the fixture being moved. A team with two
// matches on one night is the clash worth flagging. Lewis matches count here: they are still
// a night the team is playing.
async function fixturesOn(date, teamIds, exceptId) {
  return sql`
    SELECT f.id::int AS id, h.name AS "homeTeam", a.name AS "awayTeam"
    FROM fixture f
    JOIN team h ON h.id = f."homeTeam"
    JOIN team a ON a.id = f."awayTeam"
    WHERE to_char(f.date, 'YYYY-MM-DD') = ${date} AND f.id <> ${exceptId}
      AND (f."homeTeam" IN ${sql(teamIds)} OR f."awayTeam" IN ${sql(teamIds)})
      AND (f.status IS NULL OR f.status NOT IN ('rearranged', 'void'))`;
}

// Where a rearranged fixture went: the next fixture between the same pairing this season.
async function replacementOf(fixture) {
  const [row] = await sql`${seasonFixtures(sql`f."homeTeam" = ${fixture.homeTeamId}
    AND f."awayTeam" = ${fixture.awayTeamId} AND f.id > ${fixture.id}`)} ORDER BY f.id LIMIT 1`;
  return row || null;
}

async function seasonEnd() {
  const [row] = await sql`SELECT to_char("endDate", 'YYYY-MM-DD') AS "end" FROM season WHERE name = ${seasonModel.current()}`;
  return row ? row.end : null;
}

// Who on file has this address, as contact or login, with their team and offices, so the
// page can say "Nathan M, captain of Disley A" rather than just an address. Logins come from
// player_auth_email (player."authEmail" is superseded).
async function playersByEmail(address) {
  const wanted = String(address || '').trim().toLowerCase();
  if (!wanted.includes('@')) return [];
  const key = process.env.DB_ENCODE;
  return sql`
    SELECT p.id::int AS id, p.first_name AS "firstName", p.family_name AS "familyName",
           t.name AS team, p.club::int AS "clubId", c.name AS club,
           p."teamCaptain", p."clubSecretary", p."matchSecrertary"
    FROM player p
    LEFT JOIN team t ON t.id = p.team
    LEFT JOIN club c ON c.id = p.club
    WHERE p.id <> 0 AND (
      (p."playerEmail" IS NOT NULL AND LOWER(TRIM(pgp_sym_decrypt(p."playerEmail", ${key})::text)) = ${wanted})
      OR EXISTS (SELECT 1 FROM player_auth_email pae WHERE pae.player = p.id
                 AND LOWER(TRIM(pgp_sym_decrypt(pae.email, ${key})::text)) = ${wanted}))
    LIMIT 5`;
}

module.exports = {
  create, list, countPending, getById, setStatus, recordOutcome, clubsAndTeams,
  candidateFixtures, fixtureById, homeWeekdays, fixturesOn, replacementOf, seasonEnd,
  playersByEmail,
};
