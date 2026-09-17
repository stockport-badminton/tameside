-- Finish what migrations/consolidate-club-contacts.sql deliberately left open.
--
-- That migration added team_captain_fkey, club_clubsec_fkey and club_matchsec_fkey as
-- NOT VALID, so adding them could not fail on a row that predated them, and said so:
-- "the UPDATEs above are what make the data conform, and a later VALIDATE CONSTRAINT
-- can confirm it". This is that confirmation.
--
-- NOT VALID means the constraint is enforced for new and changed rows but the existing
-- ones were never checked — so the catalog reports convalidated = false and the planner
-- cannot rely on it. Checked 2026-09-17: zero orphan references across all three
-- (a non-null clubSec / matchSec / captain with no matching player row), so validation
-- will pass rather than error.
--
-- Cheap and non-blocking: VALIDATE CONSTRAINT takes only SHARE UPDATE EXCLUSIVE, so it
-- does not block reads or writes, and club is 13 rows and team 20.
--
-- Idempotent — validating an already-valid constraint is a no-op.

ALTER TABLE team VALIDATE CONSTRAINT team_captain_fkey;
ALTER TABLE club VALIDATE CONSTRAINT club_clubsec_fkey;
ALTER TABLE club VALIDATE CONSTRAINT club_matchsec_fkey;
