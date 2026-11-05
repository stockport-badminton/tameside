-- Which player an Auth0 account belongs to, keyed by the account rather than its address.
--
-- player_auth_email (migrations/player-auth-email.sql) links a login to a player by
-- encrypted address. That works for the login lookup only because it is restricted to
-- the ~60 players holding a role: an encrypted column cannot be indexed, so matching
-- every player would decrypt the whole table on every login. Nov 2026 widened the
-- question from "what role does this login carry" to "which player is this login", for
-- everyone who can log in (members see their own club's stats), so the link needs a key
-- that can be indexed. The Auth0 user_id is that key, and is not contact data.
--
-- Written only by a superadmin: on the approve page, on /admin/link-auth-accounts, or
-- copied from a player_auth_email row a superadmin wrote earlier. Never self-service:
-- anyone can claim to be "Dave Lee from Hyde", and nothing would show they weren't.
--
-- One row per Auth0 identity. A person with a password login and a Google login has two.

CREATE TABLE IF NOT EXISTS player_auth_account (
  user_id    text PRIMARY KEY,
  player     bigint NOT NULL REFERENCES player(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS player_auth_account_player_idx ON player_auth_account (player);

-- Writable through the Data API, this table is "link yourself to a club admin's player".
-- RLS with no policy denies anon; the app connects as the owner and is unaffected. Never
-- FORCE it (see migrations/rls-close-anon-access.sql).
ALTER TABLE player_auth_account ENABLE ROW LEVEL SECURITY;
