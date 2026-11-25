// Web push: who is subscribed to which teams, and the ledger of sends (migrations/push.sql).
// The sending itself is utils/push/; docs/push.md has the design. Ported from Stockport
// (league-site models/push.js, Kysely there), async/await returning a value.
//
// Every function takes an optional trailing `db` (a transaction), defaulting to the pool, so
// tools/rehearse-push.js can run them all against production and roll back.

const { sql } = require('../utils/db_connect');

const INT4 = 23;
const TEXT = 25;

/**
 * Save a browser's subscription, or update the teams and types of one already saved.
 * @param {{ id: string, endpoint: string, p256dh: string, auth: string, teams: number[], types: string[] }} s
 */
exports.upsertSubscription = async function(s, db = sql) {
  await db`
    INSERT INTO push_subscription (id, endpoint, p256dh, auth, teams, types)
    VALUES (${s.id}, ${s.endpoint}, ${s.p256dh}, ${s.auth},
            ${sql.array(s.teams, INT4)}, ${sql.array(s.types, TEXT)})
    ON CONFLICT (id) DO UPDATE SET
      endpoint = excluded.endpoint, p256dh = excluded.p256dh, auth = excluded.auth,
      teams = excluded.teams, types = excluded.types, updated_at = now()`;
};

/** @param {string} id */
exports.getSubscription = async function(id, db = sql) {
  const [row] = await db`SELECT teams, types FROM push_subscription WHERE id = ${id}`;
  return row || null;
};

/** @param {string[]} ids @returns {Promise<number>} rows deleted */
exports.removeSubscriptions = async function(ids, db = sql) {
  if (!ids.length) return 0;
  const res = await db`DELETE FROM push_subscription WHERE id = ANY(${sql.array(ids, TEXT)})`;
  return res.count;
};

/**
 * Subscriptions that want a notification about any of `teams` of kind `type`. No teams means
 * every subscription (a test send); a subscription with no types wants every type.
 * @param {{ teams?: number[], type?: 'results' | 'reminders' }} what
 */
exports.subscribersFor = async function({ teams, type } = {}, db = sql) {
  const byTeam = teams && teams.length ? sql`AND teams && ${sql.array(teams.map(Number), INT4)}` : sql``;
  const byType = type ? sql`AND (cardinality(types) = 0 OR ${type} = ANY(types))` : sql``;
  return db`
    SELECT id, endpoint, p256dh, auth FROM push_subscription
     WHERE true ${byTeam} ${byType}
     ORDER BY id`;
};

/** @param {string[]} ids */
exports.markSent = async function(ids, db = sql) {
  if (!ids.length) return;
  await db`UPDATE push_subscription SET last_sent_at = now() WHERE id = ANY(${sql.array(ids, TEXT)})`;
};

/**
 * Claim a send before making it. True for the first caller with this key, false for every
 * later one, so a send happens at most once.
 * @param {string} key
 */
exports.claimSend = async function(key, db = sql) {
  const rows = await db`
    INSERT INTO push_send (key) VALUES (${key})
    ON CONFLICT (key) DO NOTHING
    RETURNING key`;
  return rows.length > 0;
};

/** @param {string} key @param {object} summary */
exports.recordSummary = async function(key, summary, db = sql) {
  // sql.json, never JSON.stringify(...)::jsonb, which stores a jsonb string (CLAUDE.md).
  await db`UPDATE push_send SET summary = ${sql.json(summary)} WHERE key = ${key}`;
};

/** @param {number} limit */
exports.recentSends = async function(limit, db = sql) {
  return db`SELECT key, sent_at AS "sentAt", summary FROM push_send ORDER BY sent_at DESC LIMIT ${limit}`;
};

/** How many subscriptions follow each team, most followed first. */
exports.teamCounts = async function(db = sql) {
  const [{ subscriptions }] = await db`SELECT count(*)::int AS subscriptions FROM push_subscription`;
  const teams = await db`
    SELECT t.id::int AS id, COALESCE(team.name, 'team ' || t.id) AS name, count(*)::int AS subscribers
      FROM push_subscription s
      CROSS JOIN LATERAL unnest(s.teams) AS t(id)
      LEFT JOIN team ON team.id = t.id
     GROUP BY t.id, team.name
     ORDER BY subscribers DESC, name`;
  return { subscriptions, teams: [...teams] };
};

/**
 * The teams a subscriber can follow: teams in a division that exists, with their club, in
 * club order. Also the set a subscription's teams are checked against. The division join is
 * INNER on purpose: the "No Team" placeholder has no division row. (No `withdrawn` column
 * here, unlike Stockport's.)
 */
exports.followableTeams = async function(db = sql) {
  const rows = await db`
    SELECT team.id::int AS id, team.name, club.id::int AS "clubId", club.name AS "clubName",
           division.name AS "divisionName"
      FROM team
      JOIN club ON club.id = team.club
      JOIN division ON division.id = team.division
     ORDER BY club.name, team.rank, team.name`;
  return [...rows];
};

// The fixture a notification is built from. The venue is the home team's, as on the homepage.
// Ids are cast to int so they compare with the subscription's INTEGER[] teams in JS.
function fixtureQuery(where, db) {
  return db`
    SELECT fixture.id::int AS id, fixture.date, fixture.status,
           fixture."homeScore", fixture."awayScore", fixture.lewis_round AS "lewisRound",
           fixture."homeTeam"::int AS "homeTeamId", fixture."awayTeam"::int AS "awayTeamId",
           home.name AS "homeTeam", away.name AS "awayTeam", home.starttime AS "startTime",
           division.name AS "divisionName", venue.name AS "venueName"
      FROM fixture
      JOIN team home ON home.id = fixture."homeTeam"
      JOIN team away ON away.id = fixture."awayTeam"
      LEFT JOIN division ON division.id = home.division
      LEFT JOIN venue ON venue.id = home.venue
     ${where}`;
}

/** @param {number} fixtureId */
exports.resultFor = async function(fixtureId, db = sql) {
  const [row] = await fixtureQuery(sql`WHERE fixture.id = ${fixtureId}`, db);
  return row || null;
};

/**
 * Fixtures still to be played on one calendar day. `fixture.date` is a timestamp without
 * time zone holding the UK date at midnight, so its date part is the UK date, with no time
 * zone arithmetic.
 *
 * **Lewis Shield rows are included.** Each is a real match on its date (confirmed 24 Nov
 * 2026), and none duplicates a league row for the same teams and day, so a tie gets one
 * reminder. Stockport leaves out Messer, which has no dates; that doesn't apply here.
 * @param {string} ymd  YYYY-MM-DD, a UK date
 */
exports.remindersFor = async function(ymd, db = sql) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) throw new Error('remindersFor: not a date: ' + ymd);
  return [...await fixtureQuery(sql`
     WHERE fixture.date::date = ${ymd}::date
       AND fixture.status = 'outstanding'
     ORDER BY fixture.id`, db)];
};
