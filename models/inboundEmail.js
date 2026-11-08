// The inbound list-mail log and its dedupe (migrations/inbound-email.sql).
//
// Async/await returning values, like models/clubRegistration.js, not the callback style of
// the older models.

const crypto = require('crypto');
const { sql } = require('../utils/db_connect');

// The log holds senders' addresses, including every spammer's guess at one. Long enough to
// look back over a season's problem; Resend itself keeps the message for 30 days.
const LOG_DAYS = 90;
// A Message-ID is only ever redelivered within minutes; a month is generous.
const DELIVERY_DAYS = 30;

const hashAddress = (address) => crypto.createHash('sha256').update(String(address).toLowerCase()).digest('hex');

/**
 * Claim a Resend email for processing. Resend delivers at least once, so a second webhook
 * for the same `email_id` gets false here and does nothing.
 *
 * A row whose last attempt FAILED can be claimed again: the failure answered Resend with a
 * 500 precisely so that it would retry. Recipients the failed attempt did reach are still
 * claimed in inbound_email_delivery, so the retry does not send to them twice.
 */
async function claim(emailId) {
  const rows = await sql`
    INSERT INTO inbound_email (email_id) VALUES (${emailId})
    ON CONFLICT (email_id) DO UPDATE
      SET outcome = NULL, attempts = inbound_email.attempts + 1, updated_at = now()
      WHERE inbound_email.outcome = 'failed'
    RETURNING email_id`;
  return rows.length > 0;
}

// Whatever is known so far, plus the outcome. Fields left undefined are not written.
async function record(emailId, fields) {
  const f = {
    message_id: fields.messageId,
    league_address: fields.leagueAddress,
    list: fields.list,
    sender: fields.sender,
    subject: fields.subject == null ? undefined : String(fields.subject).slice(0, 300),
    auth: fields.auth,
    outcome: fields.outcome,
    recipients: fields.recipients,
    detail: fields.detail == null ? undefined : String(fields.detail).slice(0, 1000),
  };
  const set = Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined));
  if (!Object.keys(set).length) return;
  await sql`UPDATE inbound_email SET ${sql(set)}, updated_at = now() WHERE email_id = ${emailId}`;
}

/**
 * Claim recipients of one message. Returns the addresses nobody has sent this message to
 * yet; the rest already had it, through another league address on the same message or an
 * earlier attempt.
 */
async function claimRecipients(messageKey, emailId, addresses) {
  if (!addresses.length) return [];
  const byHash = new Map(addresses.map(a => [hashAddress(a), a]));
  const rows = await sql`
    INSERT INTO inbound_email_delivery (message_key, recipient_hash, email_id)
    SELECT ${messageKey}, h, ${emailId} FROM unnest(${[...byHash.keys()]}::text[]) AS h
    ON CONFLICT DO NOTHING
    RETURNING recipient_hash`;
  return rows.map(r => byHash.get(r.recipient_hash));
}

// Give recipients back after a send that failed, so the retry reaches them.
async function releaseRecipients(messageKey, addresses) {
  if (!addresses.length) return;
  await sql`
    DELETE FROM inbound_email_delivery
    WHERE message_key = ${messageKey} AND recipient_hash = ANY(${addresses.map(hashAddress)}::text[])`;
}

async function purge() {
  await sql`DELETE FROM inbound_email WHERE created_at < now() - make_interval(days => ${LOG_DAYS})`;
  await sql`DELETE FROM inbound_email_delivery WHERE created_at < now() - make_interval(days => ${DELIVERY_DAYS})`;
}

// The words a list address may be built from. Clubs that have a team in a real division,
// so No Club (whose only team is No Team, division 0) and any other league's club rows are
// out.
async function vocabulary() {
  const [divisions, clubs] = await Promise.all([
    sql`SELECT id::int AS id, name FROM division ORDER BY rank`,
    sql`
      SELECT DISTINCT club.id::int AS id, club.name
      FROM club JOIN team ON team.club = club.id JOIN division ON division.id = team.division
      ORDER BY club.name`,
  ]);
  return { divisions, clubs };
}

/**
 * May this address post to a list? A login address linked to a player (player_auth_email:
 * every captain and officer who logs in), or the contact address of a player at a real club.
 *
 * Not a contact address at No Club: that is where ~200 Stockport seed rows were parked in
 * Oct 2026, and where players who have left the league go.
 */
async function isKnownSender(address) {
  if (!address) return false;
  const key = process.env.DB_ENCODE;
  const rows = await sql`
    SELECT 1 FROM player_auth_email pae
    WHERE LOWER(pgp_sym_decrypt(pae.email, ${key})::text) = LOWER(${address})
    UNION ALL
    SELECT 1 FROM player JOIN club ON club.id = player.club
    WHERE player.id <> 0 AND club.name <> 'No Club' AND player."playerEmail" IS NOT NULL
      AND LOWER(pgp_sym_decrypt(player."playerEmail", ${key})::text) = LOWER(${address})
    LIMIT 1`;
  return rows.length > 0;
}

// For /admin/inbound-email.
async function recent(limit = 200) {
  return sql`
    SELECT email_id, created_at, league_address, list, sender, subject, auth, outcome,
           recipients, detail, attempts
    FROM inbound_email ORDER BY created_at DESC LIMIT ${limit}`;
}

// Arrivals per day, against Resend's free cap of 100 a day. Every arrival counts, refused
// or not, because every arrival counted at Resend.
async function dailyCounts(days = 14) {
  return sql`
    SELECT (created_at AT TIME ZONE 'Europe/London')::date::text AS day,
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE outcome IN ('forwarded', 'test', 'queued', 'already-queued'))::int AS forwarded
    FROM inbound_email
    WHERE created_at > now() - make_interval(days => ${days})
    GROUP BY 1 ORDER BY 1 DESC`;
}

// Mail to a queue address (registrations@) that the sender gate refused, for that queue's
// page. Nothing refused is relayed anywhere, so this is where a real secretary who was
// refused shows up.
async function refusedFor(leagueAddress, limit = 20) {
  return sql`
    SELECT created_at, sender, subject, auth, outcome
    FROM inbound_email
    WHERE league_address = ${leagueAddress} AND outcome IN ('unknown-sender', 'unauthenticated')
    ORDER BY created_at DESC LIMIT ${limit}`;
}

module.exports = {
  claim,
  record,
  claimRecipients,
  releaseRecipients,
  purge,
  vocabulary,
  isKnownSender,
  recent,
  dailyCounts,
  refusedFor,
  hashAddress,
  LOG_DAYS,
};
