-- Mail received for the league's list addresses (docs/backlog/BL-04-inbound-email-resend.md).
--
-- A Namecheap catch-all forwards every address with no forward of its own to Resend, which
-- calls POST /webhooks/resend once per message. controllers/inboundEmailController.js
-- records each one here, works out which list it was for, checks the sender, and forwards
-- it through Mailjet.
--
-- `inbound_email` is three things at once:
--   - the dedupe for Resend's at-least-once delivery (one row per Resend `email_id`);
--   - the log, which /admin/inbound-email shows, refusals included, so a real captain who
--     was refused can be found;
--   - the counter for Resend's free 100-a-day receiving cap. The catch-all receives
--     dictionary-attack spam too, and every one of those counts.
--
-- `outcome` is NULL while a delivery is being worked on, and 'failed' when it threw; Resend
-- retries both, and a retry may claim a 'failed' row again (see InboundEmail.claim).
--
-- `inbound_email_delivery` stops one person getting the same mail twice. Each league
-- address on a message arrives as its OWN Resend email (Namecheap's forwarder delivers per
-- recipient), so "to division1@ and hyde@" is two webhooks with two email_ids, and a
-- person on both lists is a recipient of both. Keyed by the message's Message-ID and a
-- sha256 of the recipient's address: the address itself is encrypted everywhere else in
-- this database, so it is not written here in the clear.
--
-- Both tables are purged as rows age (InboundEmail.purge): the log holds senders' addresses.
--
-- TIMESTAMPTZ because these are instants compared with now().
-- Additive and idempotent. No BEGIN/COMMIT: tools/run-migration.js sends the file whole.

CREATE TABLE IF NOT EXISTS inbound_email (
  email_id        TEXT PRIMARY KEY,
  message_id      TEXT NULL,
  league_address  TEXT NULL,
  list            TEXT NULL,
  sender          TEXT NULL,
  subject         TEXT NULL,
  auth            TEXT NULL,
  outcome         VARCHAR(32) NULL,
  recipients      INTEGER NULL,
  detail          TEXT NULL,
  attempts        INTEGER NOT NULL DEFAULT 1,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS inbound_email_created_at ON inbound_email (created_at);

CREATE TABLE IF NOT EXISTS inbound_email_delivery (
  message_key     TEXT NOT NULL,
  recipient_hash  TEXT NOT NULL,
  email_id        TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (message_key, recipient_hash)
);

CREATE INDEX IF NOT EXISTS inbound_email_delivery_created_at ON inbound_email_delivery (created_at);

-- RLS on with no policy, like session and club_registration (migrations/rls-close-anon-access.sql):
-- the app connects as the table owner, which bypasses RLS, and anon gets nothing.
ALTER TABLE inbound_email ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbound_email_delivery ENABLE ROW LEVEL SECURITY;
