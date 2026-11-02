-- Which migrations this database has had. Ported from Stockport's HARD-32
-- (league-site migrations/025_schema_migrations.sql), same table.
--
-- Until Nov 2026 nothing recorded it. Re-applying was safe only because most files are
-- written with IF NOT EXISTS, and "has this one run against production yet?" was answered
-- by remembering — or not: validate-club-contact-fks.sql was written on 17 Sep 2026 to be
-- applied and was found, when this table was backfilled, never to have been. Not every
-- file is safe to re-run either: consolidate-club-contacts.sql rewrites officer pointers.
--
-- One row per file, written by whatever put the file into this database:
--   applied     tools/run-migration.js ran it, in the same transaction as this row
--   replayed    a local database rebuilt from the files (none yet; see docs/backlog)
--   backfilled  recorded without running, for a file the schema showed was already
--               applied before this table existed (2 Nov 2026)
--
-- `sha256` is of the file's bytes when it was recorded, so a migration edited after it ran
-- is visibly not the one that ran, and the runner refuses it rather than calling it done.
--
-- Not created by the runner on the fly: a migration describes what the database holds,
-- and this file is how a database gets it. The runner applies this file to a database
-- with no ledger and refuses every other file until it has.

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename    VARCHAR(255) PRIMARY KEY,
  sha256      CHAR(64) NOT NULL,
  how         VARCHAR(16) NOT NULL CHECK (how IN ('applied', 'replayed', 'backfilled')),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS on and no policy, as social_result_post: the app connects as the table's owner,
-- which bypasses it, and anon gets nothing. See rls-close-anon-access.sql.
ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;
