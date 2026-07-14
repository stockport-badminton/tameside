-- Indexes for the ELO feature.
-- The time-series chart query scans game with ANY() over the four player
-- columns, and every scorecard entry runs 12 per-player prev-rating lookups
-- (ORDER BY fixture.date DESC LIMIT 1) — without these each is a seq scan.
-- Apply manually via the Supabase SQL editor (or psql). Idempotent.

CREATE INDEX IF NOT EXISTS idx_game_home_player1 ON game ("homePlayer1");
CREATE INDEX IF NOT EXISTS idx_game_home_player2 ON game ("homePlayer2");
CREATE INDEX IF NOT EXISTS idx_game_away_player1 ON game ("awayPlayer1");
CREATE INDEX IF NOT EXISTS idx_game_away_player2 ON game ("awayPlayer2");
CREATE INDEX IF NOT EXISTS idx_game_fixture      ON game (fixture);
CREATE INDEX IF NOT EXISTS idx_fixture_date      ON fixture (date);
