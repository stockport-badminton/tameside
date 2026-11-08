-- Fixture rearrangement emails, waiting for the results secretary (BL-04 step 6; ported from
-- Stockport's migrations/035_rearrangement_request.sql).
--
-- Captains and secretaries agree a rearrangement between themselves and email the league,
-- usually with the opposition copied in. Those emails were read and the change entered by
-- hand through the superadmin modal on the results page. Mail to
-- rearrangements@tameside-badminton.co.uk now lands here instead
-- (controllers/inboundEmailController.js, through Resend), with a first reading of it (the
-- dates it mentions, the clubs it names) for /admin/rearrangements to confirm.
--
-- Nothing here is ever applied automatically. `reading` is what utils/rearrangementEmail.js
-- made of the email; the page shows it beside the email, every part editable, and the one
-- write goes through Fixture.rearrangeById.
--
-- `message_id` is unique, as registration_request's is.
--
-- `reading`: { dates: [{ ymd, raw, role, line, dayMismatch }], clubIds, teamIds, noDateYet, refused }
-- `outcome`: null until applied, then { action: 'rearranged' | 'rearranging', fixtureId,
--   replacementId, date }: what was actually written, not what the email said.
--
-- TIMESTAMPTZ because these are instants compared with now().
-- Additive and idempotent. No BEGIN/COMMIT: tools/run-migration.js sends the file whole.

CREATE TABLE IF NOT EXISTS rearrangement_request (
  id            SERIAL PRIMARY KEY,
  message_id    TEXT NOT NULL UNIQUE,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  forwarded_by  TEXT,
  original_from TEXT,
  subject       TEXT,
  body_text     TEXT,
  reading       JSONB NOT NULL DEFAULT '{}'::jsonb,
  outcome       JSONB,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'done', 'dismissed')),
  closed_at     TIMESTAMPTZ,
  closed_by     TEXT
);

CREATE INDEX IF NOT EXISTS rearrangement_request_status_idx
  ON rearrangement_request (status, received_at DESC);

-- RLS on with no policy, like registration_request and inbound_email.
ALTER TABLE rearrangement_request ENABLE ROW LEVEL SECURITY;
