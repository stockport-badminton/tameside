-- Replace every contact detail in a freshly loaded local copy (tools/local-db.sh load).
--
-- Run with the local key set first:  SET tbl.local_key = '...';
-- Nothing is decrypted: each non-null value is overwritten with a fake one, encrypted with
-- the LOCAL key, so the app's pgp_sym_decrypt path still runs and every address is fake.
-- That key is not production's DB_ENCODE, so this copy can't read production's data and
-- production can't read this copy's.
--
-- The rows of the tables that hold mail, sessions, push subscriptions and contact-form
-- submissions never leave Supabase at all (pg_dump --exclude-table-data, in local-db.sh).
-- check.sql runs after this and fails the load if anything here was missed.

BEGIN;

-- Players: the fake address names the row, so a page showing "player1234@example.invalid"
-- can be traced back. Phones are Ofcom's drama range (07700 900000-900999).
UPDATE player SET
  "playerEmail" = CASE WHEN "playerEmail" IS NULL THEN NULL
                       ELSE pgp_sym_encrypt('player' || id || '@example.invalid', current_setting('tbl.local_key')) END,
  "playerTel"   = CASE WHEN "playerTel" IS NULL THEN NULL
                       ELSE pgp_sym_encrypt('07700 900' || lpad((id % 1000)::text, 3, '0'), current_setting('tbl.local_key')) END,
  "authEmail"   = CASE WHEN "authEmail" IS NULL THEN NULL
                       ELSE pgp_sym_encrypt('player' || id || '.login@example.invalid', current_setting('tbl.local_key')) END;

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

-- Login addresses, several per player. One fake per row, distinct.
UPDATE player_auth_email SET
  email = pgp_sym_encrypt('player' || player || '.login' || id || '@example.invalid', current_setting('tbl.local_key'));

-- Login account ids (Auth0 user_id), the link from a login to a player. Kept as links, so
-- the member gate and stats scoping still have something to read, under fake ids.
UPDATE player_auth_account a SET user_id = 'local|' || n.player || '-' || n.rn
  FROM (SELECT user_id, player, row_number() OVER (PARTITION BY player ORDER BY user_id) AS rn
          FROM player_auth_account) n
 WHERE a.user_id = n.user_id;

-- The captain who filed each scorecard, in plain text. One fake per real address, so "my
-- scorecards" still groups the way it does in production.
UPDATE scorecardstore s SET email = 'captain' || m.n || '@example.invalid'
  FROM (SELECT email, dense_rank() OVER (ORDER BY email) AS n
          FROM (SELECT DISTINCT email FROM scorecardstore WHERE email IS NOT NULL AND email <> '') d) m
 WHERE s.email = m.email;

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
    EXECUTE format($q$UPDATE public.%I SET "contactUs" = 'club' || id || '@example.invalid'
                      WHERE "contactUs" IS NOT NULL AND "contactUs" <> ''$q$, t);
  END LOOP;
END $$;

-- Who ticked a club's registration form as received: a superadmin's login address.
UPDATE club_registration c SET updated_by = 'admin' || m.n || '@example.invalid'
  FROM (SELECT updated_by, dense_rank() OVER (ORDER BY updated_by) AS n
          FROM (SELECT DISTINCT updated_by FROM club_registration WHERE updated_by IS NOT NULL) d) m
 WHERE c.updated_by = m.updated_by;

-- Blocklist: the phrases and words are no one's; the addresses and IPs are somebody's.
DELETE FROM blocked_entry WHERE kind IN ('ip', 'email');

COMMIT;
