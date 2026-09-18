# Two issues on project `tdsvugmbkgakgbtmoajj` — September 2026

Written to send to Supabase support. They are unrelated and can be split; the first is
the serious one.

1. **Pooler connections stop answering without closing** (2026-09-17) — caused a
   repeated site outage. The app-side mitigations are deployed and described below;
   what this asks for is the pooler side, which we cannot see.
2. **A disabled Data API leaves PostgREST reconnecting every ~32 seconds**
   (2026-09-18) — harmless but wasteful, and looks like an oversight in the toggle.

---

# 1. Pooler connections stop answering without closing

## Summary

From about **20:15 UTC on 17 September 2026**, established connections from our Cloud Run
service to the Supabase transaction pooler stopped answering queries **without closing**.
The client had no error to react to: the socket stayed open, the query was written, and
nothing came back. Because the driver has no client-side query timeout, each affected
request hung until the platform killed it ten minutes later.

Postgres was idle throughout. This is not a load problem, a slow-query problem or a
connection-limit problem — the queries never arrived.

## Environment

| | |
|---|---|
| Supabase project ref | `tdsvugmbkgakgbtmoajj` |
| Postgres | 17.6 on aarch64 |
| Endpoint | `aws-0-eu-west-2.pooler.supabase.com:6543` (transaction mode) |
| Client | `postgres` (postgres.js) v3, `prepare: false` |
| Pool | `max: 5`, `idle_timeout: 180`, `connect_timeout: 10` |
| Caller | Google Cloud Run, `europe-west2`, max 4 instances (so ≤ 20 client connections) |

## Timeline (UTC, 17 Sep 2026)

| Time | What |
|---|---|
| 00:00–20:14 | Normal. **Zero 5xx in the preceding 7 days.** |
| ~20:15 | First instance stops answering. 75 5xx in the 20:00 hour |
| 21:23:44 | A second instance, healthy since 20:59, stops mid-life. 90 5xx in the 21:00 hour |
| 21:50:09 | `ECONNRESET` finally raised on the stalled sockets — i.e. ~26 min after the stall began |
| ~21:56 | That instance serves normally again, with no intervention |

Each episode lasted roughly ten minutes and cleared on its own.

## Evidence that the queries never reached Postgres

**1. Postgres was idle while the service was serving nothing.** Sampled at 22:08:49Z, from
a laptop, while every request to the service was hanging:

```
connections: 13 / 60
state    wait_event_type  wait_event    n   max_secs
idle     Client           ClientRead    4   (idle)
active   —                —             1   0        <- this sampling query
```

No query anywhere on the instance had been running longer than 5 seconds.

**2. Two clean populations of request latency, nothing in between.** Failed requests
returned at exactly `600.0s` / `601.0s` — our platform's request timeout, not anything
the database did. Successful requests over the same window had a **median of 60ms** and a
**p90 of 0.55s**, max 0.97s.

**3. The containers were idle.** Container CPU sat at **1–15% (p99)** and memory at
**13–16%** throughout, so the client was not blocked on its own work.

**4. The query blamed in the logs is fast.** Run directly against the same database
during the incident: **54ms**, 180 rows, hash joins throughout, all tables indexed.

**5. New connections worked the whole time.** From a laptop, to the same pooler hostname,
repeatedly during the outage: connect + query in **314ms** and **332ms**. Only the
service's already-established connections were affected.

**6. Our own driver logged the eventual reset.** When the OS TCP stack finally gave up,
we logged `[db] connection failed mid-query (ECONNRESET), retrying once` and the retry
then succeeded. That delay — tens of minutes — is consistent with TCP retransmission
timeout on a socket whose peer has stopped responding without sending FIN or RST.

**7. A second league site we run was unaffected.** Same Cloud Run region, same night,
different Supabase project and a different driver: zero 5xx in 24 hours.

## What we are asking

1. Was there any pooler-side event on `tdsvugmbkgakgbtmoajj` around **20:15 UTC on
   17 Sep 2026** — a Supavisor restart, failover, node migration or rebalance?
2. Is there a known path where Supavisor stops servicing an established client
   connection without closing it? Our reading of the evidence is that the TCP session
   stayed up while the session behind it was gone, so the client had nothing to detect.
3. Is there a server-side setting that would make this fail fast rather than hang —
   a client-side idle or statement bound enforced by the pooler?
4. What is the **tenant pool size** for this project? We size our client pool against
   Postgres's `max_connections` (60), and if the effective ceiling at the pooler is
   lower we would rather size against the real number.

## What we changed on our side

These contain the damage; they do not address the cause.

- **Request timeout 600s → 60s.** A stalled instance was holding every request it had
  been handed for a full ten minutes. Across 3,000 sampled requests over the preceding
  7 days, the slowest *successful* response on the site was 16.9s.
- **A liveness probe** (`GET /health`, 30s period, 3 failures) so an instance whose pool
  has stopped answering is replaced in ~60–90s instead of ~10–15 minutes. It treats a
  **timeout** as unhealthy and an **error** as healthy, so a genuine database outage does
  not become a restart loop across every instance at once.

The gap we cannot close ourselves: **postgres.js v3 has no client-side query timeout.**
Its `idle_timeout`, `connect_timeout`, `max_lifetime` and `keep_alive` all concern a
connection at rest; none bounds a query already in flight. So a socket that accepts
writes and never answers is, to this driver, indistinguishable from a slow query.

---

# 2. A disabled Data API leaves PostgREST reconnecting every ~32 seconds

Separate issue, same project, noticed the following day while closing off the first.

## What we did

Having found that `anon` could read and write four tables over the Data API (RLS was off
on three; a fourth had RLS *on* with a `FOR ALL / USING (true) / TO PUBLIC` policy), we
fixed the RLS and then **disabled the Data API outright** in the dashboard, since nothing
uses it — 43 days of `pg_stat_statements` show no PostgREST traffic at all beyond its own
introspection.

## What we then saw

This, repeatedly, in the Postgres logs:

```
schema "pg_pgrst_no_exposed_schemas" does not exist
```

That schema does not exist in `pg_namespace`, which we take to be deliberate — disabling
the Data API appears to point PostgREST at a sentinel name chosen so that nothing can be
exposed. But PostgREST is not stopped. It stays up, connects, fails to build its schema
cache, drops the connection and retries.

From `pg_stat_activity`, sampled every 20s:

```
07:40:52  n=2  ages: 30445, 25
07:41:12  n=2  ages: 30465, 13
07:41:32  n=2  ages: 30485, 1     <- new connection
07:41:52  n=2  ages: 30505, 21
```

One stable listener connection, and one recycling on roughly a 32-second cycle — about
**2,700 connection opens per day**, plus that log line each time, for a service that has
been switched off.

For scale: we previously measured a timer on this database causing 1,800 connection
opens/day and removed it, because at ~3.6ms per open it was spending several times more
database time than every application query on the site combined.

## Our workaround

We created an empty schema `api` (no objects, `USAGE` only) and exposed that instead of
disabling the API. PostgREST then loads a valid, empty cache: no error, no reconnect
loop, and nothing served, because there is nothing in the schema.

## What we are asking

5. Is the reconnect loop behind a disabled Data API intended? From the outside it looks
   like the toggle sets `db-schemas` to an unusable value without stopping or quietening
   the service, so the supported way to switch the API off costs a connection every ~32
   seconds and a log line to match.
6. If it is not intended, is exposing an empty schema the right workaround in the
   meantime, or is there a supported way to stop PostgREST entirely?
