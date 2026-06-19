-- Draft fixture table for the fixture generator.
-- Holds generated fixtures before they are published to the live fixture table.

CREATE TABLE IF NOT EXISTS tameside_draft_fixture (
  id            SERIAL PRIMARY KEY,
  season        VARCHAR(10)  NOT NULL,
  "homeTeam"    INTEGER      NOT NULL REFERENCES team(id),
  "awayTeam"    INTEGER      NOT NULL REFERENCES team(id),
  date          DATE         NOT NULL,
  division      INTEGER      NOT NULL REFERENCES division(id),
  "generatedAt" TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_draft_fixture_season ON tameside_draft_fixture (season);
