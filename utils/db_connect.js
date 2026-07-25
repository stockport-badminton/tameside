const postgres = require('postgres')

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
    max: 10,
    idle_timeout: 30,
    connect_timeout: 10,
  }
)

module.exports = { sql }
