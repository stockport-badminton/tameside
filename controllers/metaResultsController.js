// POST /admin/social/results/meta — post published results to Facebook and Instagram.
//
// Publishing a result used to post to every Meta target inside the publish request, one
// after another, in front of the 60 s request ceiling (Stockport's HARD-47 measured 26–52 s
// for the same four targets). So publishing now only queues one row per target
// (`social_result_post`, migrations/social-result-post.sql) and this route, called by the
// scheduler job `tbl-results-meta` every 15 minutes, posts what is waiting. Ported from
// Stockport's metaResultsController (league-site 2c20c6a), with their rules.
//
// The job carries no retries: a retry of a run that timed out on the way back is a second
// post. Retrying is done here instead, per row, and only where Meta cannot have published
// anything (`metaPublisher.mayHavePublished`).
//
// ── Where this differs from Stockport: a time budget, not a batch size ───────
//
// Their job claims 8 rows and has 300 s to post them. Every request here is cut at 60 s
// (`_REQUEST_TIMEOUT`, lowered after the 2026-09-17 pooler stall), and a run cut off
// mid-post leaves a row in `posting` that a person then has to check by hand. So this claims
// ONE row at a time, and only starts another while there is room for a slow one: a target
// is ~5–9 s, 16 s on a slow Meta day, plus up to 15 s waiting on an Instagram container. The
// rest wait for the next run, 15 minutes later.

const SocialResultPost = require('../models/socialResultPost');
const Fixture = require('../models/fixture');
const meta = require('../utils/metaPublisher');

// Stop starting new rows after this long. 25 s + a worst-case target (~31 s) stays inside 60.
const START_BUDGET_MS = 25000;
// A result queued this long ago is news nobody wants, typically because the credentials
// were broken for a while. Skipped, not posted as a burst of old results.
const STALE_MS = 48 * 60 * 60 * 1000;
// Attempts at a post Meta definitely did not publish, before giving up.
const MAX_ATTEMPTS = 3;

async function postOne(row) {
  if (Date.now() - new Date(row.queuedAt).getTime() > STALE_MS) {
    await SocialResultPost.markSkipped(row.id, 'stale: queued over 48 hours ago');
    return { outcome: 'skipped', reason: 'stale' };
  }

  const r = await SocialResultPost.resultFor(row.fixtureId);
  if (!r || r.homeScore == null || r.awayScore == null || !r.homeTeam || !r.awayTeam) {
    await SocialResultPost.markSkipped(row.id, 'the fixture no longer has a result');
    return { outcome: 'skipped', reason: 'no result' };
  }

  // Failed, not skipped: a target that was configured when the result was queued and is not
  // now is a credential gone missing from the service, which is somebody's problem to fix.
  const target = Fixture.resultTargets().find(t => t.kind === row.target);
  if (!target) {
    const message = `no ${row.target} target is configured on the service now`;
    await SocialResultPost.markFailed(row.id, message);
    return { outcome: 'failed', error: message };
  }

  // publishEverywhere does not throw: it reports per target, and logs the `[timing]` line.
  const out = await meta.publishEverywhere([target], Fixture.resultPostContent(r));

  if (!out.posted.length) {
    const err = (out.failed[0] && out.failed[0].error) || new Error('nothing was posted');
    const live = meta.mayHavePublished(err);
    const retry = !live && err.step !== 'validate' && row.attempts < MAX_ATTEMPTS;
    const message = live
      ? `${err.message} — no answer to the publish, so it may be live; check ${target.name} before retrying`
      : err.message;
    console.error(`[meta-results] fixture ${row.fixtureId} -> ${target.name} failed${retry ? ' (will retry)' : ''}: ${message}`);
    if (retry) await SocialResultPost.release(row.id, message);
    else await SocialResultPost.markFailed(row.id, message);
    return { outcome: retry ? 'retrying' : 'failed', error: message };
  }

  // After the post, and allowed to throw. The post is live by now, so a failure to record it
  // must not be mistaken for a Meta failure and released for another go; the row stays
  // `posting`, and the daily email asks a person to look.
  await SocialResultPost.markPosted(row.id, out.posted[0].id);
  console.log(`[meta-results] fixture ${row.fixtureId} posted to ${target.name}: ${out.posted[0].id}`);
  return { outcome: 'posted', id: out.posted[0].id };
}

exports.run = async function (req, res, next) {
  try {
    const started = Date.now();
    const results = [];
    const tried = [];
    while (Date.now() - started < START_BUDGET_MS) {
      // Never a row this run has already tried: a retry waits for the next run.
      const [row] = await SocialResultPost.claim(1, tried);
      if (!row) break;
      tried.push(row.id);
      results.push({ fixtureId: row.fixtureId, target: row.target, ...(await postOne(row)) });
    }

    // Red when anything did not post, retries included: a job that is green while posts
    // fail is the shape this codebase keeps getting caught by.
    const ok = results.every(r => r.outcome === 'posted' || r.outcome === 'skipped');
    return res.status(ok ? 200 : 502).json({ ok, results, caller: req.socialCaller });
  } catch (err) {
    next(err);
  }
};

exports.START_BUDGET_MS = START_BUDGET_MS;
