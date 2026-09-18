-- Give PostgREST an empty schema to point at, instead of a non-existent one.
--
-- Disabling the Data API in the dashboard does not stop PostgREST. Supabase confirms
-- this: "we don't really shutdown PostgREST when the Data API is disabled"
-- https://supabase.com/docs/guides/troubleshooting/schema-pg_pgrst_no_exposed_schemas-does-not-exist
--
-- It points PostgREST at a sentinel schema name instead, and the service stays up:
-- connects, fails to build its schema cache, logs
--
--   schema "pg_pgrst_no_exposed_schemas" does not exist
--
-- drops the connection, and retries.
--
-- YOU CANNOT SIMPLY CREATE THE MISSING SCHEMA, which is the obvious first instinct.
-- Postgres reserves the `pg_` prefix for system schemas, so the sentinel is
-- un-creatable by design — verified 2026-09-18:
--
--   create schema pg_pgrst_no_exposed_schemas;
--   ERROR 42939: unacceptable schema name "pg_pgrst_no_exposed_schemas"
--
-- Hence a differently-named empty schema. The name here matches the one in Supabase's
-- article so that a future reader — or Supabase support — recognises it on sight.
--
-- Supabase describes the impact as "additional entries in your logs". On this project
-- it is also a reconnect: measured from pg_stat_activity, one stable listener plus one
-- connection recycling on a ~32 second cycle, about 2,700 connection opens a day for a
-- service that has been switched off. Small, but the same waste already recorded in
-- utils/db_connect.js, where a 30s idle_timeout against a 60s refresh cost 1,800
-- opens/day and was removed because at ~3.6ms per open it spent several times more
-- database time than every application query on the site combined.
--
-- AFTER APPLYING THIS: in Settings -> API -> Data API, the API must be ENABLED with
-- Exposed schemas set to `pgrst_no_exposed_schemas`. The Exposed schemas field lives
-- inside that section, so it cannot be set while the API is switched off — turning it
-- back on is a required step, not a mistake. Doing so is safe here because every table
-- in `public` carries RLS with an admin-only policy or none at all
-- (migrations/rls-close-anon-access.sql); verified by sweeping all 36 as anon, which
-- return nothing whether or not `public` is exposed.
--
-- NOTHING MAY EVER BE CREATED IN THIS SCHEMA. It is the exposed surface of a public
-- API; a table here is a table on the internet, subject only to its own RLS. The site's
-- tables live in `public`, which is no longer exposed, and a table added to `public`
-- later stays unexposed because only this schema is listed.
--
-- USAGE is granted because it is the documented shape for a custom exposed schema and
-- because withholding it risks trading this error loop for a "permission denied for
-- schema" one. It conveys nothing in practice: USAGE gives no access to objects, and
-- there are none. Supabase's default privileges are set ON SCHEMA public specifically,
-- so they do not reach in here either — a reason to keep this schema empty rather than
-- a reason to relax.
--
-- Idempotent, like the rest of migrations/.

CREATE SCHEMA IF NOT EXISTS pgrst_no_exposed_schemas;

COMMENT ON SCHEMA pgrst_no_exposed_schemas IS
  'Intentionally empty. Exposed to PostgREST so the Data API has a valid schema to '
  'load instead of the pg_pgrst_no_exposed_schemas sentinel, which does not exist and '
  'cannot be created (reserved pg_ prefix), leaving PostgREST reconnecting every ~32s. '
  'Do not create anything here: it would be internet-facing. '
  'See migrations/postgrest-empty-schema.sql.';

GRANT USAGE ON SCHEMA pgrst_no_exposed_schemas TO anon, authenticated, service_role;

-- Only the owner should be able to add objects. This is the default, restated so the
-- intent is visible rather than inherited.
REVOKE CREATE ON SCHEMA pgrst_no_exposed_schemas FROM PUBLIC;

-- An earlier revision of this file used the name `api`, before Supabase's own article
-- was found. It existed for about an hour, was never exposed and never held an object.
-- `api` is a bad name for this: it reads as "here is our API" and invites someone to
-- put a table in it, which is the one thing that must not happen. Dropped without
-- CASCADE, so if anything HAS been created there this fails loudly rather than
-- destroying it. No-op on a database that never had it.
DROP SCHEMA IF EXISTS api;
