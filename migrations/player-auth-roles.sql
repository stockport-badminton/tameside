-- Site-wide authorization moves out of Auth0 app_metadata and onto the player
-- table, joining the club roles (teamCaptain, clubSecretary, matchSecrertary,
-- treasurer, otherComms) that already live here. Auth0 goes back to being pure
-- authentication; Postgres becomes the single source of truth for authorization.
--
-- Additive and idempotent, same as migrations/spam-controls.sql — safe to re-run.
--
--   role         'admin' (scoped to this row's own club) or 'superadmin' (sees
--                every club). NULL means no site-wide role, which is exactly
--                what an absent Auth0 `role` claim meant before.
--
--   statsAccess  Lets an 'admin' see the Individual/Pair Stats pages. Mirrors the
--                old `stats` claim 1:1 rather than being folded into `role`, so
--                nobody's access moves at cutover. bigint, not smallint — every
--                existing boolean flag on this table is bigint DEFAULT 0 and
--                there is no reason for this one to be the odd one out.
--
--   authEmail    The email address this row's Auth0 identity actually logs in
--                with. A person's login email is frequently NOT their registered
--                contact email, so the login lookup cannot rely on playerEmail
--                alone — Stockport measured only 53 of 151 role-holders matching
--                that way, which is why two thirds of their backfill needed
--                manual linking. Encrypted exactly like playerEmail: a plaintext
--                lookup column would undo the point of encrypting contact
--                details for precisely the highest-privilege rows in the table.
--
-- No messerAdmin equivalent: that is Stockport's competition. Tameside's Lewis
-- Shield admin is gated by superadmin, not by a per-player flag.

ALTER TABLE player ADD COLUMN IF NOT EXISTS role TEXT;

-- Added separately and guarded, because ADD COLUMN IF NOT EXISTS does not apply
-- the CHECK when the column already exists, and re-running a bare ADD CONSTRAINT
-- would fail the second time.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'player_role_check'
  ) THEN
    ALTER TABLE player ADD CONSTRAINT player_role_check
      CHECK (role IN ('admin', 'superadmin'));
  END IF;
END $$;

ALTER TABLE player ADD COLUMN IF NOT EXISTS "statsAccess" bigint DEFAULT 0;
ALTER TABLE player ADD COLUMN IF NOT EXISTS "authEmail" bytea;

-- getAuthRoleByEmail() runs on every login and decrypts authEmail/playerEmail to
-- compare them, so it is deliberately restricted to rows that could plausibly
-- carry a role. This partial index keeps that set cheap to find as the roster
-- grows — it indexes the ~150 admins, not the ~1100 players.
CREATE INDEX IF NOT EXISTS player_site_role_idx
  ON player (id) WHERE role IS NOT NULL OR "statsAccess" = 1;
