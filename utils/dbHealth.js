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

// Test seam. The three behaviours worth pinning — a hang is unhealthy, a fast error is
// not, and concurrent checks share one query — are all about what this module does with
// the answer, so tests supply the answer rather than a database.
let runQuery = function () { return sql`select 1` }
function _setProbeQueryForTests(fn) { runQuery = fn || function () { return sql`select 1` }; pending = null }

function currentProbe() {
  // One outstanding query at a time. A poisoned connection never settles, so issuing a
  // fresh query per check would check out another pool slot on every probe and starve
  // the very pool it is meant to be reporting on.
  if (!pending) {
    const done = function (answered) { pending = null; return answered }
    pending = Promise.resolve().then(runQuery).then(function () { return done(true) }, function () { return done(true) })
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
      resolve({ ok: false, reason: 'db-timeout', ms: ms })
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

module.exports = { check, TIMEOUT_MS, _setProbeQueryForTests }
