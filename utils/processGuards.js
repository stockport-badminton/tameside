// Process-level guard for unhandled promise rejections.
//
// Why this exists at all: most model functions in this codebase are `async` but are
// called with a Node-style callback and no `.catch()`, e.g.
//
//     exports.getRecent = async function (done) {
//       const rows = await sql`...`      // <- rejects if the DB is unreachable
//       done(null, rows)
//     }
//
// A rejection there is not returned to Express, so it surfaces as an *unhandled
// rejection*, and Node's default for that is to kill the process. One unreachable
// database therefore takes the whole container down, Cloud Run restarts it, and the
// next request repeats it — a crashloop for as long as the DB is away, rather than
// some failed requests. There are still a lot of these unguarded callbacks; fixing
// them one by one is the real fix, and this is the floor underneath that work.
//
// Measured, not assumed: in production this crash is currently *already* suppressed,
// but only by accident. Sentry's OnUnhandledRejection integration defaults to 'warn'
// mode, and merely having a listener registered is what stops Node exiting. Tested
// 2026-08-05 across three configurations:
//
//     Sentry enabled (DSN set + NODE_ENV=production) : rejection SURVIVES
//     Sentry with no DSN                             : rejection KILLS the process
//     Sentry explicitly disabled                     : rejection KILLS the process
//
// So the site's resilience currently hinges on SENTRY_DSN being set — unset or rotate
// it and every unguarded model callback silently becomes fatal again. CLAUDE.md
// describes Sentry as "dormant unless set", which is exactly the trap. This makes the
// behaviour explicit and independent of how the error reporter happens to be
// configured. In production it changes nothing; it just stops being luck.
//
// Deliberately NOT handling uncaughtException. A synchronous throw that escapes to the
// top can leave the process in an undefined state, so exiting is correct there, and it
// is what already happens (Sentry captures it when enabled, Node prints it when not).
// Express also catches synchronous throws inside route handlers and routes them to the
// central 500 handler, so it is a much rarer path than rejections.
//
// Reporting is left to Sentry's own integration rather than duplicated here with
// captureException — doing both produces two events for one fault.

function install(logger) {
  const log = logger || console;

  process.on('unhandledRejection', function (reason, promise) {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    // Prefixed so it is greppable in Cloud Run logs, and kept to one line plus stack
    // so a DB outage does not flood the log budget.
    log.error(
      '[unhandledRejection] request failed but the process is staying up:',
      err.message
    );
    if (err.stack) log.error(err.stack);
    void promise;
  });

  return true;
}

module.exports = { install };
