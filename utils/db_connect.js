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

// ---------------------------------------------------------------------------
// Retrying a read whose connection died under it
// ---------------------------------------------------------------------------
//
// A pooled connection can be dead by the time it is used: the socket was fine when
// it went into the pool and the far side closed it before the next query. Nothing
// on this side can prevent that — the only question is whether a visitor sees it.
//
// Observed 2026-08-06 on both league sites within hours of each other, which is what
// says this is the platform and not our pooling: Tameside got `read ECONNRESET` on
// the homepage (Sentry TAMESIDE-NODE-5) 12 minutes into a container's life, and
// Stockport got `Connection terminated unexpectedly` (NODE-X) on a container that
// had been up a week, through a different driver (`pg`) against a different Supabase
// project. One visitor arriving from a Google search got a 500 page.
//
// postgres.js will not retry this itself. Its only retry path is `retryRoutines` on a
// server ErrorResponse for prepared statements (connection.js); a socket that dies
// errors the in-flight query outright.
//
// Two deliberate limits:
//
//   * Only connection-class failures. A PostgresError means the server received the
//     query and rejected it — syntax, a missing relation, a constraint. Re-sending
//     that gets the same answer, so it is passed straight through.
//   * Only once, then give up. This is sized for a stale socket, which the next
//     connection fixes. If the database is actually away, further attempts just hold
//     the request open and add load to something already struggling.
//
// SAFETY: only for reads, and callers must pass a thunk that builds the query fresh
// (`() => sql`...``, never a Query already created). Re-awaiting an existing Query
// replays its settled rejection, and an INSERT/UPDATE that timed out may well have
// committed — retrying it would double the write.
const RETRYABLE_CODES = new Set([
  // postgres.js's own, from Errors.connection
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
  'CONNECT_TIMEOUT',
  // Node socket/DNS failures, which arrive verbatim off the TLS socket
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
])

const RETRY_DELAY_MS = 100

function isRetryable(err) {
  if (!err) return false
  if (err.name === 'PostgresError') return false
  return RETRYABLE_CODES.has(err.code)
}

async function withRetry(run) {
  try {
    return await run()
  } catch (err) {
    if (!isRetryable(err)) throw err
    // Prefixed to match processGuards, so both are greppable in Cloud Run logs. A
    // retry that succeeds produces no Sentry event, so this line is the only trace
    // that the fault happened at all — worth keeping when judging whether the rate
    // has changed.
    console.warn('[db] connection failed mid-query (' + err.code + '), retrying once')
    await new Promise(function (resolve) { setTimeout(resolve, RETRY_DELAY_MS) })
    return run()
  }
}

// POOL_MAX and IDLE_TIMEOUT are exported so a test can assert the two ceilings that
// are enforced elsewhere: the pool cap against cloudbuild.yaml's --max-instances,
// and the idle timeout against the blocklist refresh interval.
module.exports = { sql, POOL_MAX, IDLE_TIMEOUT, withRetry, isRetryable, RETRY_DELAY_MS }
