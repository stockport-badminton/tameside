-- Published results waiting to be posted to Facebook and Instagram.
--
-- Ported from the Stockport league site (migration 024, their HARD-47). Until now a result
-- was posted inside the request that publishes it, one Meta target after another: the Page,
-- the Instagram feed post, the Instagram story and the Page story. On Stockport that took
-- 26–33 s a publish, and 52 s once, against the 60 s cut. Ours carries the same four targets.
-- So publishing now only writes rows here, and the scheduled job `tbl-results-meta` posts
-- them (controllers/metaResultsController.js).
--
-- One row per fixture AND target, because the outcome is per target: a run that posted the
-- Page and failed Instagram retries Instagram alone, and "did every result reach every
-- target" is a query. `target` is a utils/metaPublisher kind.
--
-- A fixture already queued for a target is never re-queued by a republish. To try a failed
-- row again, set its state back to 'pending' by hand, after checking the post isn't live.
--
-- `state`:
--   pending  waiting for the job
--   posting  claimed by a run. A row left here means a run died between asking Meta to
--            publish and recording the answer, so whether it is live is unknown. NOT
--            retried automatically, because the retry might be a second post; the
--            missing-scorecards email reports it for a person to look and decide.
--   posted   `media_id` is the post (story ids comma-joined)
--   failed   gave up; `last_error` says why
--   skipped  deliberately not posted (too old, or the fixture no longer has a result);
--            `last_error` says which
--
-- TIMESTAMPTZ because these are instants compared with now(), not league-night dates.
--
-- Additive and idempotent: safe to apply before the code is deployed, and safe to re-run.
-- No BEGIN/COMMIT: tools/run-migration.js sends the file whole.

CREATE TABLE IF NOT EXISTS social_result_post (
  id          SERIAL PRIMARY KEY,
  fixture_id  BIGINT NOT NULL REFERENCES fixture(id) ON DELETE CASCADE,
  target      VARCHAR(32) NOT NULL
              CHECK (target IN ('page', 'instagram', 'instagram-story', 'page-story')),
  state       VARCHAR(16) NOT NULL DEFAULT 'pending'
              CHECK (state IN ('pending', 'posting', 'posted', 'failed', 'skipped')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  queued_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at  TIMESTAMPTZ NULL,
  posted_at   TIMESTAMPTZ NULL,
  media_id    VARCHAR(128) NULL,
  last_error  TEXT NULL,
  UNIQUE (fixture_id, target)
);

CREATE INDEX IF NOT EXISTS social_result_post_pending
  ON social_result_post (id) WHERE state = 'pending';

-- RLS on with no policy, like session and club_registration (migrations/rls-close-anon-access.sql):
-- the app connects as the table owner, which bypasses RLS, and anon gets nothing.
ALTER TABLE social_result_post ENABLE ROW LEVEL SECURITY;
