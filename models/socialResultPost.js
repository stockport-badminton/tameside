// Published results waiting for Facebook and Instagram, one row per fixture and target.
// See migrations/social-result-post.sql for the states and why this is a queue rather than
// a call inside the publish request. Ported from Stockport (league-site 2c20c6a).
//
// async/await returning a value, like models/clubRegistration.js.

const { sql } = require('../utils/db_connect');

/**
 * Queue a fixture's result for each target kind. A target already queued for that fixture,
 * in any state, is left alone. Returns the rows that were added.
 */
exports.enqueue = async function(fixtureId, targets) {
  if (!targets.length) return [];
  const rows = targets.map(target => ({ fixture_id: fixtureId, target }));
  return sql`
    INSERT INTO social_result_post ${sql(rows, 'fixture_id', 'target')}
    ON CONFLICT (fixture_id, target) DO NOTHING
    RETURNING id, target`;
};

/**
 * Take up to `limit` pending rows for this run, oldest first, and mark them `posting`.
 * SKIP LOCKED so two overlapping runs take different rows rather than the same ones.
 *
 * `exclude` is the ids this run has already tried. The job claims one row at a time, so
 * without it a row released for a retry is claimed straight back and spends all its
 * attempts in one run, seconds apart, which is no retry at all.
 */
exports.claim = async function(limit, exclude = []) {
  const rows = await sql`
    UPDATE social_result_post
       SET state = 'posting', claimed_at = now(), attempts = attempts + 1
     WHERE id IN (SELECT id FROM social_result_post
                   WHERE state = 'pending'
                     AND id <> ALL(${sql.array(exclude.map(Number), 23)})
                   ORDER BY id LIMIT ${limit}
                   FOR UPDATE SKIP LOCKED)
    RETURNING id, fixture_id AS "fixtureId", target, attempts, queued_at AS "queuedAt"`;
  // RETURNING does not promise the subquery's order, and a fixture's targets should go out
  // in the order they were queued.
  return [...rows].sort((a, b) => a.id - b.id);
};

/**
 * The result as it stands now, which is what gets posted, not what was published. A
 * correction made between publishing and the job running is what goes out.
 */
exports.resultFor = async function(fixtureId) {
  const [row] = await sql`
    SELECT f.status, f."homeScore", f."awayScore",
           ht.name AS "homeTeam", awt.name AS "awayTeam", d.name AS division
      FROM fixture f
      LEFT JOIN team ht ON ht.id = f."homeTeam"
      LEFT JOIN team awt ON awt.id = f."awayTeam"
      LEFT JOIN division d ON d.id = ht.division
     WHERE f.id = ${fixtureId}`;
  return row || null;
};

// Each finishing write is guarded on `state = 'posting'`, so it can only close a row this
// run claimed. Returns the number of rows written, 0 or 1.
async function finish(id, { state, mediaId = null, error = null }) {
  const res = await sql`
    UPDATE social_result_post
       SET state = ${state},
           last_error = ${error},
           media_id = COALESCE(${mediaId}, media_id),
           posted_at = CASE WHEN ${state} = 'posted' THEN now() ELSE posted_at END
     WHERE id = ${id} AND state = 'posting'`;
  return res.count;
}

exports.markPosted = (id, mediaId) => finish(id, { state: 'posted', mediaId });
exports.markFailed = (id, error) => finish(id, { state: 'failed', error });
exports.markSkipped = (id, reason) => finish(id, { state: 'skipped', error: reason });
/** Back to the queue for the next run, keeping the error that sent it back. */
exports.release = (id, error) => finish(id, { state: 'pending', error });

/**
 * Rows that need a person, for the daily email: failed, stuck mid-post, or never attempted.
 *
 * Stockport's check plus their one addition: a row still `pending` twelve hours after it was
 * queued. A queue whose job has stopped running fails silently, because nothing is ever
 * attempted and so nothing ever fails. Twelve hours clears the overnight gap in the job's
 * 07:00–23:45 schedule.
 */
exports.needingAttention = async function() {
  return sql`
    SELECT q.fixture_id AS "fixtureId",
           ht.name AS "homeTeam", awt.name AS "awayTeam",
           q.target, q.state, q.attempts, q.queued_at AS "queuedAt",
           LEFT(COALESCE(q.last_error,
             CASE WHEN q.state = 'pending' THEN 'never attempted: is tbl-results-meta running?'
                  ELSE 'the run did not finish, so it may be live' END), 200) AS problem
      FROM social_result_post q
      LEFT JOIN fixture f ON f.id = q.fixture_id
      LEFT JOIN team ht ON ht.id = f."homeTeam"
      LEFT JOIN team awt ON awt.id = f."awayTeam"
     WHERE q.queued_at > now() - INTERVAL '14 days'
       AND (q.state = 'failed'
            OR (q.state = 'posting' AND q.claimed_at < now() - INTERVAL '15 minutes')
            OR (q.state = 'pending' AND q.queued_at < now() - INTERVAL '12 hours'))
     ORDER BY q.queued_at, q.id`;
};
