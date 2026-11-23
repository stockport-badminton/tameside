-- Team strength: one row per nightly run (/admin/team-strength, utils/teamStrength.js).
-- Ported from Stockport's migrations/032_strength_run.sql.
--
-- The run fits a points-based rating to every league game on record. None of that is wanted
-- on a page request, so it is computed once a night and kept here whole: `payload` is
-- everything the page shows, as of `ran_at`. It names players, so only superadmin pages
-- read it.
--
-- Only the latest row is read. models/teamStrength.js keeps the last 14 so a bad night can
-- be compared with the one before.

CREATE TABLE IF NOT EXISTS strength_run (
  id       SERIAL PRIMARY KEY,
  ran_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  season   TEXT NOT NULL,
  caller   TEXT NOT NULL,
  games    INTEGER NOT NULL,
  took_ms  INTEGER NOT NULL,
  payload  JSONB NOT NULL
);

-- RLS on and no policy: only the app (which bypasses it) reads this.
ALTER TABLE strength_run ENABLE ROW LEVEL SECURITY;
