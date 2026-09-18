-- Give PostgREST an empty schema to point at, instead of a non-existent one.
--
-- Disabling the Data API in the Supabase dashboard does not stop PostgREST. It points
-- it at a sentinel schema name that is guaranteed not to exist — confirmed 2026-09-18,
-- there is no `pg_pgrst_no_exposed_schemas` in pg_namespace. PostgREST keeps running,
-- connects, tries to build its schema cache, fails with
--
--   schema "pg_pgrst_no_exposed_schemas" does not exist
--
-- drops the connection and retries. Measured from pg_stat_activity: one stable listener
-- connection plus one recycling every ~32 seconds, i.e. ~2,700 connection opens a day,
-- and that error in the Postgres log every time.
--
-- That is the same waste this project already fixed once. See utils/db_connect.js: a
-- 30s idle_timeout against a 60s refresh was costing 1,800 opens/day, and at ~3.6ms per
-- open that was several times more database time than every application query on the
-- site put together. This is that again, slightly worse, and not ours to begin with.
--
-- So: expose a real schema that happens to be empty. PostgREST builds a valid cache,
-- stops erroring and stops reconnecting, and the API serves nothing because there is
-- nothing in here to serve.
--
-- AFTER APPLYING THIS, set Exposed schemas to `api` in the dashboard
-- (Settings -> API -> Data API). Until that is done this schema is simply unused and
-- the reconnect loop continues — the migration alone changes nothing.
--
-- NOTHING MAY EVER BE CREATED IN THIS SCHEMA. It is the exposed surface of the Data
-- API; a table here is a table on the public internet, subject only to its own RLS.
-- The site's tables live in `public`, which is deliberately no longer exposed, and a
-- table added to `public` later stays unexposed because only `api` is listed.
--
-- USAGE is granted because it is the documented shape for a custom exposed schema and
-- because withholding it risks trading this error loop for a "permission denied for
-- schema api" one. It grants nothing in practice: USAGE on a schema conveys no access
-- to objects, and there are none. Note also that Supabase's default privileges are set
-- ON SCHEMA public specifically, so they do not reach into this schema — an object
-- created here would not silently inherit anon access. That is a reason to be careful,
-- not a reason to relax: see the line above.
--
-- Idempotent, like the rest of migrations/.

CREATE SCHEMA IF NOT EXISTS api;

COMMENT ON SCHEMA api IS
  'Intentionally empty. Exposed to PostgREST so the Data API has a valid schema to '
  'load instead of the non-existent pg_pgrst_no_exposed_schemas sentinel, which made '
  'it reconnect every ~32s. Do not create anything here: it would be internet-facing. '
  'See migrations/postgrest-empty-schema.sql.';

GRANT USAGE ON SCHEMA api TO anon, authenticated, service_role;

-- Only the owner should be able to add objects. This is the default, restated so that
-- the intent is visible rather than inherited.
REVOKE CREATE ON SCHEMA api FROM PUBLIC;
