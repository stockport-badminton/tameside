// A shared session store, so a session survives changing Cloud Run instance.
//
// THE BUG THIS FIXES. express-session had no `store`, so it used the built-in
// MemoryStore: one JavaScript object, per Node process. Cloud Run runs this service with
// `maxScale 4`, session affinity **off**, and `minScale 0`. So a session existed only on
// the instance that created it, and every session vanished when the service scaled to
// zero. ("Warning: connect.session() MemoryStore is not designed for a production
// environment" was in the logs several times a day.)
//
// What made it visible was the login round trip. `secured` stores `returnTo` and
// redirects to /login; passport then stores its OAuth `state` in the session too. That is
// three hops — /login, Auth0, /callback — and any of them can land on a different
// instance:
//
//   - state lost      -> passport.authenticate finds no user, and /callback redirects
//                        back to /login. The "it just fails" symptom.
//   - returnTo lost   -> the callback's `|| '/'` fallback fires and you arrive at the
//                        homepage instead of the page you clicked. The other symptom.
//
// It was always broken; it became obvious when GET /scorecard-photo/:id replaced the
// public S3 URL in the results-secretary email, because that turned a link that needed no
// session at all into one that forces the whole round trip. It also silently broke the
// registration-import review -> apply handover, which parks the parsed document in the
// session — that works locally, where there is one process, and would intermittently
// answer "that review has expired" in production.
//
// WHY NOT connect-pg-simple. It needs `pg`, and this app uses `postgres` (postgres.js).
// Adding a second driver means a second connection pool, and the pool size here is
// coupled to a hard backend limit: POOL_MAX (5) x max-instances (4) must stay under 60,
// and test/db-pool.test.js asserts it. A store built on the existing `sql` needs no new
// dependency, opens no new pool, and is about sixty lines.
//
// COST. express-session only calls `get` when the request carries a `__session` cookie,
// and `saveUninitialized: false` means anonymous visitors never get one. So this adds a
// query per request for *logged-in* users only — the admins — and nothing at all for the
// public pages that carry the traffic.

const { Store } = require('express-session');
const { sql, withRetry } = require('./db_connect');

// Used when the cookie is a browser-session cookie (no maxAge), which is how this app
// configures it: `sess.cookie` sets httpOnly/sameSite/secure but no expiry, so
// `session.cookie.expires` is null and the row would otherwise have no TTL at all.
// A day is comfortably longer than any admin sitting, and short enough that abandoned
// rows do not accumulate.
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

// Expired rows are ignored on read, so pruning is housekeeping rather than correctness.
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

function expiryFor(session) {
  const cookieExpires = session && session.cookie && session.cookie.expires;
  if (cookieExpires) {
    const at = new Date(cookieExpires);
    if (!Number.isNaN(at.getTime())) return at;
  }
  return new Date(Date.now() + DEFAULT_TTL_MS);
}

class PostgresSessionStore extends Store {
  // `get` must answer (null, null) for "no such session" — an *error* there makes
  // express-session treat every unknown cookie as a failed request rather than as a new
  // visitor.
  async get(sid, done) {
    try {
      // withRetry because this now runs on EVERY request from a logged-in user, so a
      // pooled connection that died while idle would otherwise turn into a 500 on an
      // admin page. Same reasoning as the three pages it already protects — a read, and
      // a thunk so the query is rebuilt rather than a settled rejection re-awaited.
      const rows = await withRetry(() => sql`
        select sess from "session" where sid = ${sid} and expire > now()`);
      if (!rows.length) return done(null, null);
      // jsonb comes back already parsed by postgres.js.
      return done(null, rows[0].sess);
    } catch (err) {
      return done(err);
    }
  }

  async set(sid, session, done) {
    try {
      await sql`
        insert into "session" (sid, sess, expire)
        values (${sid}, ${sql.json(session)}, ${expiryFor(session)})
        on conflict (sid) do update
          set sess = excluded.sess, expire = excluded.expire`;
      return done(null);
    } catch (err) {
      return done(err);
    }
  }

  async destroy(sid, done) {
    try {
      await sql`delete from "session" where sid = ${sid}`;
      return done(null);
    } catch (err) {
      return done(err);
    }
  }

  // Needed because the app runs with `resave: false`: without `touch`, a session that is
  // read but not modified is never written, so its `expire` never moves and an admin gets
  // logged out mid-session at a fixed time after logging in.
  async touch(sid, session, done) {
    try {
      await sql`
        update "session" set expire = ${expiryFor(session)} where sid = ${sid}`;
      return done(null);
    } catch (err) {
      return done(err);
    }
  }
}

// Deleting expired rows. Failure is logged and ignored: a session store that throws on
// housekeeping would be worse than one carrying dead rows, and reads already filter on
// `expire`.
async function prune() {
  try {
    const rows = await sql`delete from "session" where expire <= now() returning sid`;
    if (rows.length) console.log('[session] pruned', rows.length, 'expired sessions');
  } catch (err) {
    console.warn('[session] prune failed:', err.message);
  }
}

// Timer is unref'd so it never holds the process open — the same reason the blocklist
// refresh in app.js does.
function startPruning() {
  const timer = setInterval(prune, PRUNE_INTERVAL_MS);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = {
  PostgresSessionStore, startPruning, prune,
  DEFAULT_TTL_MS, PRUNE_INTERVAL_MS,
  expiryFor, // exported for tests: the TTL rule is the part with real logic in it
};
