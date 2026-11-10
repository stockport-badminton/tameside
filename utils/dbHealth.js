const { sql } = require('./db_connect')

// Liveness probe for the DB pool.
//
// The failure this exists for, observed 2026-09-17: connections from Cloud Run to the
// Supabase pooler stop answering without closing. postgres.js has no client-side query
// timeout (its options are idle_timeout / connect_timeout / max_lifetime / keep_alive —
// all of them about a connection at rest, none about a query in flight), so a query
// written to such a socket waits forever. At max:5 per instance, five poisoned
// connections wedge the instance; at --max-instances=4, four wedged instances are the
// whole site. It clears only when the OS TCP stack gives up, ~10-15 minutes later,
// which is the ECONNRESET burst in the logs — the recovery, not the fault.
//
// Nothing in the process notices: during the 2026-09-17 wedges container CPU sat at
// 1-15% (p99) and Postgres showed zero active queries. An idle app and an idle database
// with every request hanging is the signature.
//
// So the probe answers one question only: does a trivial query come back at all?
const TIMEOUT_MS = parseInt(process.env.DB_HEALTH_TIMEOUT_MS, 10) || 4000

// A TIMEOUT IS UNHEALTHY; AN ERROR IS NOT. This is the important line in the file.
//
// A query that fails fast — auth rejected, relation missing, database genuinely down —
// proves the socket is alive and the process is fine. Restarting on that would turn a
// Supabase outage into a restart loop across every instance, which is strictly worse
// than serving what can still be served: Firebase's cache, the static assets, the
// pages that need no query. Only silence means this container is the broken part.
let pending = null

// ...AND A CONNECT TIMEOUT IS AN ERROR, even though it arrives as silence. Observed
// 2026-11-08, 09:42-09:52 UTC: the pooler stopped completing new connections for ten
// minutes. postgres.js waits connect_timeout (10s, utils/db_connect.js) before it says
// so, and the probe's deadline is 4s, so every check timed out first and read as a
// wedged container. Each instance was killed ~90s in, and each replacement ran its boot
// queries into the same stall: five instances restarted for an outage none of them
// could fix. That is exactly the loop the rule above exists to prevent.
//
// So when the probe's own query has recently failed with CONNECT_TIMEOUT, a check that
// times out is reported healthy, reason 'db-unreachable'. During a sustained stall each
// probe's query fails 10s after it is issued, so the record never ages past ~20s
// between 30s probes; the window is two probe periods. Only the probe's OWN query
// counts: it is the one this module can see, and a query hung on an established socket
// (the 2026-09-17 / 2026-11-02 wedges) never produces CONNECT_TIMEOUT, so those still
// fail the probe and restart the container.
const UNREACHABLE_WINDOW_MS = 60000
let lastConnectTimeoutAt = 0

// Test seam. The three behaviours worth pinning — a hang is unhealthy, a fast error is
// not, and concurrent checks share one query — are all about what this module does with
// the answer, so tests supply the answer rather than a database.
let runQuery = function () { return sql`select 1` }
function _setProbeQueryForTests(fn) { runQuery = fn || function () { return sql`select 1` }; pending = null; lastConnectTimeoutAt = 0 }

function currentProbe() {
  // One outstanding query at a time. A poisoned connection never settles, so issuing a
  // fresh query per check would check out another pool slot on every probe and starve
  // the very pool it is meant to be reporting on.
  if (!pending) {
    const done = function (answered) { pending = null; return answered }
    pending = Promise.resolve().then(runQuery).then(function () { return done(true) }, function (err) {
      if (err && err.code === 'CONNECT_TIMEOUT') lastConnectTimeoutAt = Date.now()
      return done(true)
    })
  }
  return pending
}

// Resolves { ok, reason }, never rejects — a probe that throws is a 500, and a 500 from
// a liveness endpoint is indistinguishable from the fault it is supposed to detect.
function check(timeoutMs) {
  const ms = timeoutMs || TIMEOUT_MS
  return new Promise(function (resolve) {
    let settled = false
    const timer = setTimeout(function () {
      if (settled) return
      settled = true
      if (Date.now() - lastConnectTimeoutAt < UNREACHABLE_WINDOW_MS) {
        resolve({ ok: true, reason: 'db-unreachable', ms: ms })
      } else {
        resolve({ ok: false, reason: 'db-timeout', ms: ms })
      }
    }, ms)
    // Deliberately NOT unref'd. It is bounded at a few seconds and the server's own
    // listening socket keeps the process alive anyway, so unref buys nothing — while
    // in a process whose only pending work IS the probe (a test, a one-shot script)
    // it lets the event loop drain and the check never settles at all.
    currentProbe().then(function () {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: true })
    })
  })
}

module.exports = { check, TIMEOUT_MS, UNREACHABLE_WINDOW_MS, _setProbeQueryForTests }
