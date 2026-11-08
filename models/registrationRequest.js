// Player registration requests that arrived by email (migrations/registration-request.sql).
// utils/registrationEmail.js reads the email; controllers/playerRequestController.js is the
// page that works through them. Ported from Stockport's models/registrationRequest.js
// (kysely there, postgres.js here).

const { sql } = require('../utils/db_connect');

const OUTCOMES = ['created', 'attached', 'transferred', 'skipped'];

const SUMMARY = sql`
  id, received_at AS "receivedAt", forwarded_by AS "forwardedBy",
  original_from AS "originalFrom", subject, candidates, status,
  closed_at AS "closedAt", closed_by AS "closedBy"`;

// Queue one email. Returns its id, or null when this message is already queued.
async function create({ messageId, forwardedBy, originalFrom, subject, bodyText, attachments, candidates }) {
  const rows = await sql`
    INSERT INTO registration_request
      (message_id, forwarded_by, original_from, subject, body_text, attachments, candidates)
    VALUES (${messageId}, ${forwardedBy || null}, ${originalFrom || null}, ${subject || null},
            ${bodyText || null}, ${sql.json(attachments || [])}::jsonb,
            ${sql.json(candidates || [])}::jsonb)
    ON CONFLICT (message_id) DO NOTHING
    RETURNING id`;
  return rows.length ? Number(rows[0].id) : null;
}

async function list(status) {
  return sql`
    SELECT ${SUMMARY} FROM registration_request
    WHERE status = ${status} ORDER BY received_at DESC LIMIT 100`;
}

async function countPending() {
  const [row] = await sql`SELECT COUNT(*)::int AS n FROM registration_request WHERE status = 'pending'`;
  return row ? row.n : 0;
}

async function getById(id) {
  const [row] = await sql`
    SELECT ${SUMMARY}, body_text AS "bodyText", attachments
    FROM registration_request WHERE id = ${id}`;
  return row || null;
}

// Record what happened to one person on the request. The whole candidate is replaced by the
// edited version the page sends (a corrected spelling, a chosen team), so what is kept is
// what was actually registered rather than the first reading of the email.
//
// jsonb_set on the one index, in one statement, so two tabs working the same request cannot
// overwrite each other's rows, only the same row.
async function setCandidate(id, index, candidate) {
  const [row] = await sql`
    UPDATE registration_request
    SET candidates = jsonb_set(candidates, ARRAY[${String(index)}::text], ${sql.json(candidate)}::jsonb)
    WHERE id = ${id} AND ${index}::int < jsonb_array_length(candidates)
    RETURNING candidates`;
  return row ? row.candidates : null;
}

// Add a person the reading missed.
async function appendCandidate(id, candidate) {
  const [row] = await sql`
    UPDATE registration_request
    SET candidates = candidates || jsonb_build_array(${sql.json(candidate)}::jsonb)
    WHERE id = ${id}
    RETURNING candidates`;
  return row ? row.candidates : null;
}

async function setStatus(id, status, by) {
  const closing = status !== 'pending';
  const rows = await sql`
    UPDATE registration_request
    SET status = ${status},
        closed_at = ${closing ? sql`now()` : null},
        closed_by = ${closing ? by : null}
    WHERE id = ${id}
    RETURNING id`;
  return rows.length > 0;
}

// Teams a player can be registered to: those in a real division. That leaves out No Team
// (division 0, under No Club) and the other league's club rows, which have no team here in
// a division — offering either would put a new player somewhere nobody plays. Stockport
// filters out No Club only; their table holds no other league.
async function registrableTeams() {
  return sql`
    SELECT team.id::int AS id, team.name, club.id::int AS "clubId", club.name AS "clubName"
    FROM team
    JOIN club ON club.id = team.club
    JOIN division ON division.id = team.division
    ORDER BY club.name, team.name`;
}

module.exports = {
  OUTCOMES, create, list, countPending, getById, setCandidate, appendCandidate, setStatus,
  registrableTeams,
};
