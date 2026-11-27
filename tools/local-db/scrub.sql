-- Replace every contact detail in a freshly loaded local copy (tools/local-db.sh load).
--
-- Run with the local key set first:  SET tbl.local_key = '...';
-- Nothing is decrypted: each non-null value is overwritten, encrypted with the LOCAL key,
-- so the app's pgp_sym_decrypt path still runs. That key is not production's DB_ENCODE, so
-- this copy can't read production's data and production can't read this copy's.
--
-- Addresses become plus-aliases of the league's results mailbox, as Stockport's do
-- (league-site tools/local-db/sanitise.sql): anything a local run really sends lands in
-- one inbox that we read, and says who it was meant for, so email flows can be tested end
-- to end. Phones are Ofcom's drama range, 07700 900000-900999, which can never ring anyone.
--
--   player        tameside.badders.results+firstnamelastname@gmail.com
--   club          tameside.badders.results+ClubNameContactUs@gmail.com
--   scorecard     tameside.badders.results+draft<id>@gmail.com   (no name on the row)
--
-- The rows of the tables that hold mail, sessions, push subscriptions and contact-form
-- submissions never leave Supabase at all (pg_dump --exclude-table-data, in local-db.sh).
-- check.sql runs after this and fails the load if anything here was missed.

BEGIN;

-- The alias for a name: letters and digits only, lowercased, as Stockport's. A row with no
-- usable name falls back to its id rather than a bare "+@".
CREATE FUNCTION pg_temp.alias(local_part text, fallback text) RETURNS text
  LANGUAGE sql IMMUTABLE AS $$
    SELECT 'tameside.badders.results+'
        || coalesce(nullif(regexp_replace(coalesce(local_part, ''), '[^a-zA-Z0-9]', '', 'g'), ''), fallback)
        || '@gmail.com'
  $$;

-- Players: the contact address and the login address both become the name's alias.
UPDATE player SET
  "playerEmail" = CASE WHEN "playerEmail" IS NULL THEN NULL
                       ELSE pgp_sym_encrypt(lower(pg_temp.alias(first_name || family_name, 'player' || id)), current_setting('tbl.local_key')) END,
  "playerTel"   = CASE WHEN "playerTel" IS NULL THEN NULL
                       ELSE pgp_sym_encrypt('07700 900' || lpad((id % 1000)::text, 3, '0'), current_setting('tbl.local_key')) END,
  "authEmail"   = CASE WHEN "authEmail" IS NULL THEN NULL
                       ELSE pgp_sym_encrypt(lower(pg_temp.alias(first_name || family_name, 'player' || id)), current_setting('tbl.local_key')) END;

-- Season archives (player<season>): cleared, as production's have been since 2 Oct 2026.
-- Nothing decrypts from an archive. Found by name, so next season's archive is covered.
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT DISTINCT table_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name ~ '^player[0-9]{8}$'
       AND column_name IN ('playerEmail', 'playerTel')
  LOOP
    EXECUTE format('UPDATE public.%I SET "playerEmail" = NULL, "playerTel" = NULL', t);
  END LOOP;
END $$;

-- Login addresses, several per player: each becomes that player's alias.
UPDATE player_auth_email e SET
  email = pgp_sym_encrypt(lower(pg_temp.alias(p.first_name || p.family_name, 'player' || p.id)), current_setting('tbl.local_key'))
  FROM player p WHERE p.id = e.player;
-- A login linked to no player row (none today) still must not keep a real address.
UPDATE player_auth_email e SET
  email = pgp_sym_encrypt(pg_temp.alias(NULL, 'login' || e.id), current_setting('tbl.local_key'))
 WHERE NOT EXISTS (SELECT 1 FROM player p WHERE p.id = e.player);

-- Login account ids (Auth0 user_id), the link from a login to a player. Kept as links, so
-- the member gate and stats scoping still have something to read, under fake ids.
UPDATE player_auth_account a SET user_id = 'local|' || n.player || '-' || n.rn
  FROM (SELECT user_id, player, row_number() OVER (PARTITION BY player ORDER BY user_id) AS rn
          FROM player_auth_account) n
 WHERE a.user_id = n.user_id;

-- Scorecard drafts: who filed it (plain text, no name on the row, so the draft id stands
-- in, as Stockport's), and the photo, which is cleared. A photo is a team sheet with twelve
-- names and both captains' signatures in the PRODUCTION bucket, and a local server showing
-- a draft would fetch it with whatever AWS credentials it has. NULL is an ordinary state:
-- the "add a photo later" flow exists for it. (Stockport's sanitise.sql, 12 Sep 2026.)
UPDATE scorecardstore SET email = pg_temp.alias(NULL, 'draft' || id)
 WHERE email IS NOT NULL AND email <> '';
UPDATE scorecardstore SET "scoresheet-url" = NULL WHERE "scoresheet-url" IS NOT NULL;

-- Clubs' contact address ("contactUs"), in the live table and its season archives. Often a
-- secretary's own address, and one club has two in the field, so the whole value goes.
-- Found by the check on the first load; not in the BL-06 brief's list.
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT table_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name ~ '^club([0-9]{8})?$' AND column_name = 'contactUs'
  LOOP
    EXECUTE format($q$UPDATE public.%I SET "contactUs" = pg_temp.alias(name || 'ContactUs', 'club' || id)
                      WHERE "contactUs" IS NOT NULL AND "contactUs" <> ''$q$, t);
  END LOOP;
END $$;

-- Who ticked a club's registration form as received: a superadmin's login address.
UPDATE club_registration c SET updated_by = pg_temp.alias(NULL, 'admin' || m.n)
  FROM (SELECT updated_by, dense_rank() OVER (ORDER BY updated_by) AS n
          FROM (SELECT DISTINCT updated_by FROM club_registration WHERE updated_by IS NOT NULL) d) m
 WHERE c.updated_by = m.updated_by;

-- Blocklist: the phrases and words are no one's; the addresses and IPs are somebody's.
DELETE FROM blocked_entry WHERE kind IN ('ip', 'email');

COMMIT;
