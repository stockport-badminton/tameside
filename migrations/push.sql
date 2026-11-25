-- Web push notifications: results when they are published, and match reminders the evening
-- before and on the day (utils/push/, docs/push.md). Ported from Stockport (league-site
-- 1a5f9d2, their migration 039), which ported it from the Hyde club site.
--
-- A subscription is a browser, not a person: nothing here says who holds the device. `id` is
-- sha256(endpoint), so the same browser saving again updates its row rather than adding one.
-- `teams` is the team ids it follows (at least one; no foreign key, so a deleted team just
-- stops producing notifications), `types` the kinds it wants ('results', 'reminders';
-- empty = both). A push service answering 404/410 deletes the row.
--
-- Additive and idempotent: safe to apply before the code is deployed, and safe to re-run.
-- No BEGIN/COMMIT: tools/run-migration.js sends the file whole.

CREATE TABLE IF NOT EXISTS push_subscription (
  id            TEXT PRIMARY KEY,
  endpoint      TEXT NOT NULL,
  p256dh        TEXT NOT NULL,
  auth          TEXT NOT NULL,
  teams         INTEGER[] NOT NULL CHECK (cardinality(teams) > 0),
  types         TEXT[] NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_sent_at  TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS push_subscription_teams ON push_subscription USING GIN (teams);

-- One row per send, claimed BEFORE sending with INSERT … ON CONFLICT DO NOTHING, so a send
-- happens at most once whoever asks for it: a result republished after a correction, a
-- scheduler retry, two overlapping runs. Keys:
--   result-<fixture id>
--   reminders-<UK date>-<tonight|tomorrow>
--   test-<epoch ms>
-- `summary` is what the fan-out reported (subscribers, sent, failed, removed), written after.
CREATE TABLE IF NOT EXISTS push_send (
  key      TEXT PRIMARY KEY,
  sent_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  summary  JSONB NULL
);

-- RLS on and no policy, like the other tables only the app reads.
ALTER TABLE push_subscription ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_send ENABLE ROW LEVEL SECURITY;
