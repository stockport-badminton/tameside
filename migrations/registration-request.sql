-- Player registration requests that arrived by email, waiting for the results secretary
-- (BL-04 step 6; ported from Stockport's migrations/020_registration_request.sql).
--
-- Registrations reach the league as email, from club secretaries, captains and players
-- themselves, often several names to a message, and were handled by copying each name into
-- the roster editor by hand. Mail to registrations@tameside-badminton.co.uk now lands here
-- instead (controllers/inboundEmailController.js, through Resend), with the names it
-- appears to contain already pulled out, for /admin/player-requests to work through.
--
-- Nothing here is ever applied automatically. `candidates` is a *reading* of the email, and
-- a wrong reading is corrected on the page before anything touches `player`; the writes go
-- through the roster API the roster editor uses.
--
-- `message_id` is unique as a second line behind inbound_email's per-email_id claim: the
-- same message sent twice, or a Resend retry after a failure, must not queue it twice.
--
-- `candidates` is a JSON array, one element per person the email seems to name:
--   { first, family, gender, team, raw, outcome, playerId }
-- `outcome` is null until that person is dealt with, then 'created' | 'attached' |
-- 'transferred' | 'skipped'. Per person, not per email: a message naming six players is
-- rarely finished in one sitting.
--
-- TIMESTAMPTZ because these are instants compared with now().
-- Additive and idempotent. No BEGIN/COMMIT: tools/run-migration.js sends the file whole.

CREATE TABLE IF NOT EXISTS registration_request (
  id            SERIAL PRIMARY KEY,
  message_id    TEXT NOT NULL UNIQUE,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  forwarded_by  TEXT,
  original_from TEXT,
  subject       TEXT,
  body_text     TEXT,
  attachments   JSONB NOT NULL DEFAULT '[]'::jsonb,
  candidates    JSONB NOT NULL DEFAULT '[]'::jsonb,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'done', 'dismissed')),
  closed_at     TIMESTAMPTZ,
  closed_by     TEXT
);

CREATE INDEX IF NOT EXISTS registration_request_status_idx
  ON registration_request (status, received_at DESC);

-- RLS on with no policy, like inbound_email: the app connects as the table owner, which
-- bypasses RLS, and anon gets nothing. The bodies are other people's email.
ALTER TABLE registration_request ENABLE ROW LEVEL SECURITY;
