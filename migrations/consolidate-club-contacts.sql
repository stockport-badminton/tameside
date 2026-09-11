-- Consolidate the three places a club contact role is recorded.
--
-- Apply with:  node tools/run-migration.js consolidate-club-contacts.sql --commit
-- Idempotent: every statement is a targeted UPDATE that is already true after the
-- first run, so it is safe to re-run.
--
-- NO BEGIN/COMMIT IN HERE. The runner opens the transaction with sql.begin() and sends
-- the file inside it, so the whole migration is already all-or-nothing. Writing them in
-- the file instead fails outright — postgres.js rejects transaction control on a pooled
-- connection with `UNSAFE_TRANSACTION: Only use sql.begin, sql.reserved or max: 1`,
-- because the pool could run the following statements on a different connection.
--
--
-- THE PROBLEM
--
-- Three roles, each recorded in two places that disagree:
--
--   role              foreign key on the subject   boolean on the player
--   ----------------  ---------------------------  -----------------------------
--   team captain      team."captain"               player."teamCaptain"
--   club secretary    club."clubSec"               player."clubSecretary"
--   match secretary   club."matchSec"              player."matchSecrertary"
--
-- Measured 2026-09-10: the two disagree for 13 of 20 teams and 6 of 13 clubs. The
-- /club/:id contact page joined on BOTH with an OR, which is what produced its
-- duplicate captain cards (see the note on getContactDetailsById in models/club.js).
--
--
-- WHICH SOURCE WINS, AND WHY IT IS THE FOREIGN KEY
--
-- The boolean cannot express what is already true. It lives on the player and is
-- interpreted relative to `player."team"`, so it can only ever say "I captain the team
-- I play FOR". Three of the league's captains captain a team they do not play in, and
-- two of those captain BOTH of their club's teams:
--
--   Aerospace A          captain Alison Cosadinos  plays for Aerospace B
--   GHAP B               captain Ross Owen         plays for GHAP A   (also captains GHAP A)
--   Manchester Edgeley A captain Pete Taylor       plays for Man Edgeley B (also captains B)
--
-- A one-person-one-team boolean has nowhere to put any of those, and a small club
-- running both its teams under one captain is completely ordinary. `team."captain"` is
-- a single FK per team and expresses all 20 teams exactly.
--
-- Same argument for the club roles, plus one of its own: club."clubSec" and
-- club."matchSec" currently hold IDENTICAL values in all 13 rows — they were filled by
-- copying one "club contact" person into both — so on their own they cannot tell the
-- two roles apart. Where they are empty the flags CAN: College Green's secretary is
-- Miriam Turner and its match secretary is Simon Owen, and only the flags know that.
--
-- So the direction of travel is: the FK becomes the single source of truth, and this
-- migration moves everything the flags know into it. The flags are NOT dropped here —
-- eight read sites and the player edit form still use them (models/fixture.js,
-- models/players.js, models/clubRegistration.js, controllers/contactusController.js,
-- controllers/playerController.js, views/player_update_form.ejs,
-- views/fixtures-results.ejs, views/viewEventDetails.ejs). Dropping them is a separate
-- change once those move over, and it needs the player edit form's three checkboxes
-- rethought: "Team Captain" on a player is not the same question as "who captains this
-- team", and only the latter is answerable.


-- 1. `0` is a player id meaning "nobody" — the "No Player" sentinel documented for
--    scorecards in CLAUDE.md. Stored in a FK column it reads as a real person: it is
--    what made Mellor's contact page show a Club Secretary called "No Player",
--    complete with that row's decrypted phone number and email address.
UPDATE club SET "clubSec"   = NULL WHERE "clubSec"   = 0;
UPDATE club SET "matchSec"  = NULL WHERE "matchSec"  = 0;
UPDATE team SET "captain"   = NULL WHERE "captain"   = 0;


-- 2. Team captains the flag knows about and the FK does not.
--    Restricted to teams with EXACTLY ONE flagged candidate: where several players on
--    one team carry the flag there is no answer to pick, and guessing would put a name
--    and a phone number on a confidential page on the strength of a stale checkbox.
--    Today this fills five teams — Alderley Park TS, College Green A, College Green B,
--    Hyde C and Syddal Park A — and deliberately skips the placeholder "No Team".
UPDATE team t
   SET "captain" = c.id
  FROM (
    SELECT p."team" AS team_id, MIN(p."id") AS id
      FROM player p
     WHERE p."teamCaptain" = 1 AND p."id" <> 0 AND p."team" IS NOT NULL
     GROUP BY p."team"
    HAVING COUNT(*) = 1
  ) c
 WHERE t."id" = c.team_id
   AND (t."captain" IS NULL OR t."captain" = 0)
   AND t."name" <> 'No Team';


-- 3. Disley A. The only team where the FK names someone the flag contradicts outright
--    (the FK said Natalie Clemmit, who is Disley's match secretary; the flag says Jon
--    Paul). Confirmed 2026-09-10: Jon Paul is the captain. Written by id rather than by
--    name because the player table has eight duplicated display names.
UPDATE team SET "captain" = 250
 WHERE "name" = 'Disley A' AND "captain" = 276;


-- 4. Club secretaries and match secretaries the flags know about and the FKs do not.
--    Same one-candidate rule, and the same reason for it.
UPDATE club cl
   SET "clubSec" = c.id
  FROM (
    SELECT p."club" AS club_id, MIN(p."id") AS id
      FROM player p
     WHERE p."clubSecretary" = 1 AND p."id" <> 0 AND p."club" IS NOT NULL
     GROUP BY p."club"
    HAVING COUNT(*) = 1
  ) c
 WHERE cl."id" = c.club_id
   AND (cl."clubSec" IS NULL OR cl."clubSec" = 0)
   AND cl."name" <> 'No Club';

UPDATE club cl
   SET "matchSec" = c.id
  FROM (
    SELECT p."club" AS club_id, MIN(p."id") AS id
      FROM player p
     WHERE p."matchSecrertary" = 1 AND p."id" <> 0 AND p."club" IS NOT NULL
     GROUP BY p."club"
    HAVING COUNT(*) = 1
  ) c
 WHERE cl."id" = c.club_id
   AND (cl."matchSec" IS NULL OR cl."matchSec" = 0)
   AND cl."name" <> 'No Club';


-- 5. Referential integrity, now that these columns are the source of truth rather than
--    a second opinion. Guarded so the file stays re-runnable, and NOT VALID so adding
--    them cannot fail on a row that predates them — the UPDATEs above are what make the
--    data conform, and a later VALIDATE CONSTRAINT can confirm it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'team_captain_fkey') THEN
    ALTER TABLE team ADD CONSTRAINT team_captain_fkey
      FOREIGN KEY ("captain") REFERENCES player("id") ON DELETE SET NULL NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'club_clubsec_fkey') THEN
    ALTER TABLE club ADD CONSTRAINT club_clubsec_fkey
      FOREIGN KEY ("clubSec") REFERENCES player("id") ON DELETE SET NULL NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'club_matchsec_fkey') THEN
    ALTER TABLE club ADD CONSTRAINT club_matchsec_fkey
      FOREIGN KEY ("matchSec") REFERENCES player("id") ON DELETE SET NULL NOT VALID;
  END IF;
END $$;



-- AFTER THIS RUNS, every real club has both officers and every real team has one
-- captain. The only rows left empty are the placeholders -- club "No Club" and team
-- "No Team", the league's archive for dormant players -- which is correct: they are not
-- clubs and both are explicitly excluded above.
--
-- Two gaps that were open when this file was written were closed in the data on
-- 2026-09-11 rather than here, so do not go looking for them:
--
--   Mellor club secretary  -- was unrecorded (the FK held the 0 sentinel and no player
--                             carried the flag). John Pawsey is now flagged, so step 4
--                             backfills club."clubSec" to him.
--   Disley club secretary  -- had two flagged players. Julian Cherryman's roles were
--                             cleared; Natalie Clemmit genuinely covers both the club
--                             and match secretary roles at Tameside, which the FK
--                             already said.
