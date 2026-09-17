-- Index the three foreign keys that have none.
--
-- club."clubSec", club."matchSec" and team.captain all reference player(id) and none of
-- them is indexed. Postgres indexes the *referenced* side automatically (it must be
-- unique) but never the referencing side, so every UPDATE or DELETE of a player row has
-- to sequentially scan all three tables to enforce the constraint.
--
-- The tables are small — club is 13 rows, team 20 — so this is not about today's query
-- plans. It is about player, which is rewritten in bulk: the team-registration import
-- parks removed players at the "No Club" placeholder, and POST /player/batch-update
-- rewrites team/rank/club for a whole drag-and-drop reorder. Each of those row writes
-- pays three scans without this.
--
-- All three constraints arrived with the September 2026 club-contact consolidation
-- (migrations/consolidate-club-contacts.sql), which replaced the boolean flags on
-- player with real foreign keys and did not index them.
--
-- Plain CREATE INDEX rather than CONCURRENTLY: CONCURRENTLY cannot run inside a
-- transaction and the runner wraps the file in one, and at this size the lock is held
-- for microseconds. Idempotent, like the rest of migrations/.

CREATE INDEX IF NOT EXISTS club_clubsec_idx  ON club  ("clubSec");
CREATE INDEX IF NOT EXISTS club_matchsec_idx ON club  ("matchSec");
CREATE INDEX IF NOT EXISTS team_captain_idx  ON team  (captain);
