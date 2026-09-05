-- Tracking which clubs have sent in their player registration forms.
--
-- Every club must return the league's team registration form before its first fixture,
-- and chasing that was done from memory. This table is what the daily digest and
-- /admin/registration-reminders read.
--
-- KEYED BY SEASON, and that is the whole design. The job runs once a season, so the
-- status has to reset every season -- and the cheapest correct reset is not to reset at
-- all: a new season simply has no rows, which reads as "nothing received, nothing
-- chased". No cron to clear it, nothing to remember in July, and last season's record is
-- still there to look back at. A `received` boolean on `club` would have needed exactly
-- the annual wipe nobody would remember to run -- and note `club.registrations` already
-- exists as a boolean, carries five stale `true`s from some earlier attempt, and is read
-- by nothing. Do not press it into service here.
--
-- No row is created until something happens to a club, so absence is meaningful and the
-- table stays small (12 rows a season at most, one per club with a fixture).
--
-- `club` is deliberately NOT a foreign key, matching the rest of this schema, which has
-- none. A club is never deleted here, only emptied onto the "No Club" placeholder, so
-- the risk is small.
--
-- Additive and idempotent: safe to run before the code that reads it is deployed, and
-- safe to re-run. Ported from the Stockport league site's migrations/013.

CREATE TABLE IF NOT EXISTS club_registration (
  id           SERIAL PRIMARY KEY,
  season       VARCHAR(8)   NOT NULL,
  club         INTEGER      NOT NULL,
  received_at  TIMESTAMP    NULL,
  chased_at    TIMESTAMP    NULL,
  chase_count  INTEGER      NOT NULL DEFAULT 0,
  note         TEXT         NULL,
  updated_by   VARCHAR(255) NULL,
  updated_at   TIMESTAMP    NOT NULL DEFAULT now()
);

-- One row per club per season. The upserts in models/clubRegistration.js target this
-- constraint by its columns, so ON CONFLICT has something to match.
CREATE UNIQUE INDEX IF NOT EXISTS club_registration_season_club
  ON club_registration (season, club);

-- The digest reads one season at a time.
CREATE INDEX IF NOT EXISTS club_registration_season
  ON club_registration (season);
