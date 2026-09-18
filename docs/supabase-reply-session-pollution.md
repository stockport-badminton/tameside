# Reply to Supabase support — session pollution does not fit this

Draft reply to the support response on the 2026-09-17 stall. Evidence and the original
report are in `docs/incident-2026-09-17-pooler-stall.md`.

---

Thanks — we ran the diagnostic and audited the app as suggested. Session pollution
is not what happened here, and there are two things in the reply worth feeding back.

## 1. The diagnostic in your reply cannot detect session pollution

```sql
SELECT pid, usename, application_name, state, query,
  current_setting('default_transaction_read_only') AS read_only,
  current_setting('statement_timeout')             AS stmt_timeout,
  current_setting('search_path')                   AS search_path
FROM pg_stat_activity
WHERE datname = current_database() AND pid <> pg_backend_pid();
```

`current_setting()` reads the GUC of the session **running the query**, not of the
backend in each row. It is not correlated with `pid` at all, so it returns the same
three values on every row no matter what those backends actually hold. Run against our
project it prints `off / 2min / "$user", public, extensions` six times — which is our own
session's configuration, repeated.

Postgres has no supported way to read another backend's GUCs, so that shape cannot work.
Anyone following this advice gets an all-clear that means nothing, which seems worth
correcting in whatever macro it came from.

What does work is sampling from the client side, checking out pooled connections
repeatedly and asking each what it inherited. We did that — five consecutive checkouts,
all `statement_timeout=2min`, `default_transaction_read_only=off`, default `search_path`.
No pollution.

## 2. Pollution cannot produce this symptom, and `statement_timeout` proves it

Every failure mode in your reply is an **error**:

- `default_transaction_read_only=on` → writes fail with `ReadOnlySqlTransaction`
- a bad `search_path` → `relation ... does not exist`
- an inherited `statement_timeout` → the query is **cancelled**, i.e. fails *sooner*

Ours was the opposite: **no error at all**. Requests hung until our platform killed them
at 600 seconds, with nothing raised client-side and nothing in the Postgres logs.

The decisive detail is your own default. `statement_timeout` on this project is **2
minutes**. Had our queries reached Postgres in any state — polluted, read-only, wrong
search_path, whatever — they would have been terminated at 120s with an error. Instead
they hung for 600s and returned nothing.

That is only possible if **the queries never arrived**. Which is what we measured directly
at the time: during the outage `pg_stat_activity` showed 13/60 connections, **zero
active queries**, and nothing running longer than 5 seconds, while the service was serving
nothing at all. Container CPU was 1-15% (p99). An idle application and an idle database,
with every request hanging in between.

For completeness on the audit you asked for: the application issues **no `SET` of any
kind**. It is postgres.js v3 with `prepare: false`, no `connection` options, no connect
hooks, no ORM, no read-replica routing. The only session-state statement anywhere near
this database is `SET LOCAL ROLE anon` inside an explicit transaction, in a read-only
audit script we ran *after* the incident — correctly scoped, and confirmed above to leave
no residue.

## What we would like looked at

The original question stands: established client connections to
`aws-0-eu-west-2.pooler.supabase.com:6543` stopped answering **without closing**, for
about ten minutes at a time, on 2026-09-17 from ~20:15 UTC. New connections succeeded
throughout, including from a laptop mid-outage (314ms connect+query). Only already-open
ones were affected, and they recovered on their own when the client OS eventually raised
`ECONNRESET` — tens of minutes later, consistent with TCP retransmission timeout against
a peer that has stopped responding without FIN or RST.

So the specific question is whether there was a Supavisor-side event on project
`tdsvugmbkgakgbtmoajj` in that window — a restart, failover, node migration or rebalance —
that could leave established client sessions attached to a backend that is no longer
being serviced.

We have mitigated our side (a 60s request timeout and a liveness probe that recycles an
instance whose pool has gone silent), so this is not urgent. But the mitigation only
bounds the damage; it does not explain it, and we would rather know than guess.
