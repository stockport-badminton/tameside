-- Drop indexes that duplicate another index on the same column.
--
-- Ten tables carry both a `<table>_pkey` and a `<table>_id_key` on `id` — a PRIMARY KEY
-- and a separate UNIQUE constraint over the identical column, so two identical btrees
-- are maintained on every insert and update. Plus fixture has both `fixture_date_idx`
-- and `idx_fixture_date` on `date`.
--
-- Which half is live is measured, not guessed (pg_stat_user_indexes, 2026-09-17):
--
--   player_pkey        120,219 scans      player_id_key             0
--   team_pkey           45,869 scans      team_id_key               0
--   venue_pkey          34,933 scans      venue_id_key              0
--   idx_fixture_date    13,020 scans      fixture_date_idx          0
--   fixture_pkey         1,292 scans      fixture_id_key            0
--   scorecardstore_pkey    154 scans      scorecardstore_id_key     0
--
-- TWO OF THE PAIRS ARE NOT REDUNDANT, and this is the part that makes the list shorter
-- than the advisor's. Postgres binds a foreign key to a specific unique index, and on
-- this database it bound six of them to the `_id_key` rather than to the `_pkey`, by an
-- accident of creation order:
--
--   player_id_key  <- player_auth_email_player_fkey, team_captain_fkey,
--                     club_clubsec_fkey, club_matchsec_fkey
--   team_id_key    <- tameside_draft_fixture_homeTeam_fkey,
--                     tameside_draft_fixture_awayTeam_fkey
--
-- So `player_id_key` and `team_id_key` are load-bearing despite reporting zero scans —
-- the scans that use them are the constraint checks, which pg_stat does not attribute
-- to the index. They are deliberately NOT dropped here. Repointing those six constraints
-- at the pkey would mean dropping and recreating them, which is real risk on the two
-- tables the whole site reads, to reclaim 64 kB.
--
-- **Never add CASCADE to these statements.** Without it, dropping a constraint another
-- object depends on fails loudly, which is the behaviour worth keeping. With it,
-- Postgres would silently drop those six foreign keys instead.
--
-- Reclaims ~900 kB, most of it game_id_key at 688 kB, and removes a duplicate btree
-- write from every insert on the tables listed.

ALTER TABLE game             DROP CONSTRAINT IF EXISTS game_id_key;
ALTER TABLE fixture          DROP CONSTRAINT IF EXISTS fixture_id_key;
ALTER TABLE scorecardstore   DROP CONSTRAINT IF EXISTS scorecardstore_id_key;
ALTER TABLE season           DROP CONSTRAINT IF EXISTS season_id_key;
ALTER TABLE venue            DROP CONSTRAINT IF EXISTS venue_id_key;
ALTER TABLE league           DROP CONSTRAINT IF EXISTS league_id_key;
ALTER TABLE player20232024   DROP CONSTRAINT IF EXISTS player20232024_id_key;
ALTER TABLE team20232024     DROP CONSTRAINT IF EXISTS team20232024_id_key;

-- A plain index, not a constraint: idx_fixture_date is the one the planner actually
-- chooses (13,020 scans against 0), and it is the one tonight's EXPLAIN used.
DROP INDEX IF EXISTS fixture_date_idx;
