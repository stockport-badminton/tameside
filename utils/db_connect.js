const postgres = require('postgres')

// Cap the pool per instance, because the real limit is on the far side of the
// connection and it is not large: Postgres itself allows 60 backends, and the
// Supavisor tenant pool in front of it is smaller still.
//
// The dangerous number is the *product* of this and Cloud Run's max-instances,
// which was unset (defaulting to 100) until 2026-08-05: 100 instances x max 10
// is up to 1,000 clients chasing 60 slots. The Stockport league site took exactly
// that outage in session mode (EMAXCONNSESSION, Sentry NODE-V, 28 July) — see the
// comment in league-site/db_connect.js. Transaction mode multiplexes so it fails
// less abruptly, but the ceiling is still there, and nothing here needs 10.
//
// 5 is well clear of what the traffic needs: the heaviest page fires a handful of
// queries, and anything beyond the cap queues rather than failing. Paired with
// --max-instances=4 in cloudbuild.yaml, the worst case is 20 clients.
//
// PG_POOL_MAX is an escape hatch so this can be raised without a deploy.
const POOL_MAX = parseInt(process.env.PG_POOL_MAX, 10) || 5

// This MUST stay above the blocklist refresh interval in models/spamControls.js
// (CACHE_TTL_MS), and test/db-pool.test.js asserts that it does.
//
// It was 30s against a 60s refresh, which is the worst possible pairing: the timer
// in app.js queries, the connection goes idle, it is closed at t=30s, and the next
// tick opens a brand new one. Measured 2026-08-05 — 1,800 connection opens/day at
// 1.25 per refresh, i.e. the timer was the churn, running flat out on zero traffic.
// Each open costs a postgres.js type-cache fetch of ~3.6ms, so connecting was
// burning several times more DB time (~6.5 s/day) than every application query on
// the site put together (~1 s/day).
//
// (pgbouncer.get_auth is NOT part of that per-open cost, despite looking like it in
// the cumulative totals: sampling it live shows a constant ~3.75/min whether or not
// this pool is opening connections, so it belongs to Supavisor's own auth refresh.)
//
// At 180s the timer reuses one warm connection instead of replacing it, and a real
// browsing session does too. postgres.js recycles connections on its own
// max_lifetime (30-60 min, randomised) regardless, so nothing is held forever.
// Verified after deploy: 0 connection opens over 4 minutes, refresh still 1/min.
const IDLE_TIMEOUT = 180

// Supabase transaction-mode pooler (port 6543), not session mode (5432).
// Cloud Run scales stateless instances that each open a pool, so on a
// low-traffic site session-mode connections churn (every reopen re-runs
// pgbouncer.get_auth — our single biggest DB-time consumer). Transaction
// mode multiplexes, releasing the server connection after each transaction.
// It can't hold session state, so prepared statements must be disabled
// (postgres.js uses them by default); sql.begin() transactions are fine —
// each runs start-to-finish on one server connection.
const sql = postgres(
  `postgres://postgres.tdsvugmbkgakgbtmoajj:${encodeURIComponent(process.env.PGPASSWORD)}@aws-0-eu-west-2.pooler.supabase.com:6543/postgres`,
  {
    ssl: { rejectUnauthorized: false },
    prepare: false,
    max: POOL_MAX,
    idle_timeout: IDLE_TIMEOUT,
    connect_timeout: 10,
  }
)

// POOL_MAX and IDLE_TIMEOUT are exported so a test can assert the two ceilings that
// are enforced elsewhere: the pool cap against cloudbuild.yaml's --max-instances,
// and the idle timeout against the blocklist refresh interval.
module.exports = { sql, POOL_MAX, IDLE_TIMEOUT }
