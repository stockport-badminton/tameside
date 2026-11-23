-- Lewis Shield handicaps, one per tie (controllers/lewisHandicapController.js).
--
-- The Lewis Shield is played as a normal match and decided on total points, with a handicap
-- of points added to one side. The Lewis secretary used to give it to the captains by phone
-- after the match. Now it is set here in advance and shown to the two teams' captains and
-- their clubs' secretaries from 21:30 on the night (/lewis-shield/handicap), never before.
--
-- Keyed by FIXTURE, not by the `lewis` bracket row: the bracket row has no date, and the
-- reveal is by date. The fixture generator writes a row for every pairing a round could
-- produce, so only the ties actually on get a handicap.
--
-- `to_team` is the side that gets the points; NULL exactly when `points` is 0 (scratch).
-- Which team it may be (one of the fixture's two) is checked by the app, not here.
-- `set_by` is the login's email address, as `closed_by` elsewhere.
--
-- Not the `team.handicap` text column: that is a per-team figure copied over with
-- Stockport's schema ('Scr', '-7', '-2H'), read by nothing here.
--
-- Additive and idempotent. No BEGIN/COMMIT: tools/run-migration.js sends the file whole.

CREATE TABLE IF NOT EXISTS lewis_handicap (
  fixture  BIGINT PRIMARY KEY REFERENCES fixture(id) ON DELETE CASCADE,
  to_team  BIGINT REFERENCES team(id),
  points   INTEGER NOT NULL CHECK (points BETWEEN 0 AND 400),
  set_by   TEXT,
  set_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((points = 0) = (to_team IS NULL))
);
