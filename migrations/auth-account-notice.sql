-- The monthly login cull's memory: who was warned, when, and who asked to keep their login.
--
-- The cull (controllers/authCullController.js) warns a Tameside login that has not been
-- used for twelve months, waits a month, and then lists it for a superadmin to delete from
-- Auth0. "Used" is the later of the tenant's last_login and kept_at, so the account itself
-- holds most of the state; this table holds only what Auth0 cannot.
--
--   notified_at      when the last warning was sent. A login after it is the response.
--   keep_token_hash  sha256 of the "keep my login" link's token. The raw token is only
--                    ever in the email. NULL once used, or for a row a superadmin kept.
--   kept_at          the keep link was confirmed, or a superadmin kept it. Counts as use.
--
-- One row per Auth0 account. A row is deleted with its account.

CREATE TABLE IF NOT EXISTS auth_account_notice (
  user_id         text PRIMARY KEY,
  notified_at     timestamptz,
  keep_token_hash bytea UNIQUE,
  kept_at         timestamptz
);

-- The keep link is the one unauthenticated way in. RLS with no policy denies anon; the
-- app connects as the owner and is unaffected. Never FORCE it (see
-- migrations/rls-close-anon-access.sql).
ALTER TABLE auth_account_notice ENABLE ROW LEVEL SECURITY;
