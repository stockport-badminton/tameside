-- Close the four public tables the `anon` role can still read and write.
--
-- Supabase grants anon/authenticated full DML on every table in `public` by default, so
-- RLS is the only thing holding the Data API off. 32 of the 36 tables here have it on
-- with a single policy scoped to supabase_admin, which denies anon outright. Four do not,
-- and it is the four that matter most:
--
--   session            120 rows. `sess` is jsonb and holds the serialised passport user,
--                      including the role claims. Readable = every live admin session is
--                      copyable. Writable = mint a superadmin session at will.
--   player_auth_email   60 rows. The login -> player link that getAuthRoleByEmail
--                      resolves a role from. Writable = grant yourself superadmin.
--   club_registration   11 rows. Low value on its own.
--   game            30,456 rows. Public data, but writable — i.e. rewrite any result.
--
-- Confirmed by being anon rather than by reading catalogs (SET LOCAL ROLE anon in a
-- read-only transaction, 2026-09-17): those four return rows, the other eight tested
-- return nothing.
--
-- NOT live exposure today. The Data API answers `{"message":"No API key found in
-- request"}` without an apikey, and no Supabase anon key appears anywhere in this repo
-- or its environment — the site talks to Postgres directly through postgres.js and has
-- never used PostgREST. The risk is that an anon key is *designed* to be published: it
-- is the key you paste into front-end code. The day anyone does, or reaches the project
-- API settings, these four tables are open. That is one paste away, which is not a
-- margin worth keeping for the session table.
--
-- SAFE FOR THE APP, and this is the part worth checking before believing it: all four
-- tables are owned by `postgres`, which is the role the app connects as, and none has
-- relforcerowsecurity set. A table owner bypasses RLS unless FORCE is used. So this
-- changes nothing for the site, exactly as it already changes nothing for `player` and
-- `fixture`, which the app reads on every page with RLS enabled.
--
-- Do NOT add FORCE ROW LEVEL SECURITY here. That is what would break the app.
--
-- Additive and idempotent, like the rest of migrations/. No BEGIN/COMMIT: the runner
-- (tools/run-migration.js) sends the file whole and manages the transaction itself.

ALTER TABLE session           ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_auth_email ENABLE ROW LEVEL SECURITY;
ALTER TABLE club_registration ENABLE ROW LEVEL SECURITY;

-- `game` already has RLS on, but its policy is the Postgres default shape rather than
-- the one the other 32 tables use: permissive, FOR ALL, USING (true), and granted to
-- PUBLIC — which includes anon. So RLS is enabled and permits everything, which reads
-- as protected in the dashboard and is not. Replace it with the same admin-only policy
-- the rest of the schema uses.
DO $$
DECLARE pol text;
BEGIN
  FOR pol IN
    SELECT p.polname
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'game'
      AND 0 = ANY (p.polroles)            -- 0 is PUBLIC, i.e. anon included
  LOOP
    EXECUTE format('DROP POLICY %I ON public.game', pol);
  END LOOP;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'game' AND p.polname = 'game_admin_only'
  ) THEN
    EXECUTE 'CREATE POLICY game_admin_only ON public.game FOR ALL TO supabase_admin USING (true)';
  END IF;
END $$;
