-- Shared session storage.
--
-- WHY: express-session had no store configured, so it used the default MemoryStore,
-- which lives in one Node process. Cloud Run runs this service with maxScale 4, session
-- affinity OFF and minScale 0 — so a session was only valid on the instance that created
-- it, and vanished entirely whenever the service scaled to zero.
--
-- The visible symptom was the Auth0 round trip: click a `secured` link while logged out,
-- and /login -> Auth0 -> /callback would frequently land on a different instance than the
-- one that stored `returnTo` and passport's OAuth state. A lost state made
-- passport.authenticate fail (redirect back to /login), and a lost `returnTo` made the
-- callback fall back to '/', dumping people on the homepage instead of the page they had
-- clicked. It also broke the registration-import review -> apply handover, which keeps the
-- parsed document in the session.
--
-- Additive and idempotent: safe to run before the code that uses it, and safe to re-run.

CREATE TABLE IF NOT EXISTS "session" (
  sid    text PRIMARY KEY,
  sess   jsonb NOT NULL,
  expire timestamptz NOT NULL
);

-- Pruning expired rows is a range scan over `expire`, and it runs on a timer.
CREATE INDEX IF NOT EXISTS session_expire_idx ON "session" (expire);
