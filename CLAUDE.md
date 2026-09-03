# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Badminton league management website for the Tameside Badminton League (tameside-badminton.co.uk). Manages fixtures, results, player statistics, club info, and league tables. Hosted on Google Cloud Run.

## Commands

```bash
npm run dev        # Start with nodemon (auto-reload), listens on PORT 8080
npm start          # Production start (node server.js)
```

```bash
npm test           # Unit/integration tests (node:test + supertest), no browser
npm run test:e2e    # Playwright — email-scorecard wizard only (see below)
```

`test.js` in the root is an unrelated manual scratch file (not part of either suite).

Playwright (`test/e2e/`) is scoped to the email-scorecard entry wizard specifically —
step navigation, live score validation, and OCR-photo reuse — not the whole site. It
boots the real server via `playwright.config.js`'s `webServer` (`DEV_MODE=true
NODE_ENV=development` on port 8199) and drives a real Chromium browser against it,
so it needs the real dev DB for the AJAX team/player cascades (reads only, no writes).

```bash
# Docker build & run locally
docker build . --tag IMAGE_NAME
docker run -p 8080:8080 -e PORT=8080 IMAGE_NAME

# Deploy: automatic on push to main (Cloud Build trigger → cloudbuild.yaml).
# Manual re-run of the same pipeline:
gcloud builds submit --region=global --config cloudbuild.yaml
```

### Deploy pipeline

`cloudbuild.yaml` is the source of truth: build → push → `gcloud run services update`.
A Cloud Build trigger on `push to ^main$` runs it (project `avid-compound-429108-g9`,
region `europe-west2`, service `tameside-site`). Keep the pipeline in that file rather
than in the trigger's inline config, so build changes are reviewable in git.

Build caching relies on the `:latest` tag: it is pushed on every build purely so the
*next* build can import it via `--cache-from` (with `BUILDKIT_INLINE_CACHE=1`). Never
add `--no-cache`, and don't stop pushing `:latest` — either one makes every deploy
recompile `npm ci` from cold.

The `Dockerfile` is deliberately single-stage: nothing is compiled at image-build time
(sharp ships prebuilt linux-x64 binaries, jimp is pure JS), so there are no build-only
deps to strip and a builder stage would only add slow `COPY --from` passes. It also has
no font/fontconfig packages — see Social Image Generation below.

## Architecture

**Entry points**: `server.js` → `app.js` (Express setup, all route registration, middleware).

**Pattern**: Controller-Model with async/await models and callback-style controllers.

- `controllers/` — HTTP handlers. Import models, validate input with `express-validator`, render EJS views.
- `models/` — Database layer. Each function executes a SQL tagged-template query and returns results via a Node-style callback: `done(err, result)`.
- `views/` — EJS templates. `header.ejs`, `nav.ejs`, `footer.ejs` are included as partials. Several views have `-old.ejs` siblings (legacy versions, unused).

### Database

PostgreSQL via Supabase, accessed with the `postgres` (v3) library. All queries use tagged template literals — never string-concatenated SQL:

```javascript
const result = await sql`SELECT * FROM player WHERE id = ${playerId}`;
```

Sensitive columns (player phone, email) are PgP-encrypted in the DB; decrypted with the `DB_ENCODE` env var using `pgp_sym_decrypt`.

### Authentication

- **Auth0** (`stockport-badminton.eu.auth0.com`) via `passport-auth0`. Login at `/login`, callback at `/callback`, logout at `/logout`.
- **Session**: `express-session` with cookie name `__session`.
- **Protected routes**: wrapped with `secured()` middleware — checks `req.isAuthenticated()`, redirects to `/login` if not.
- **Local dev bypass**: `middleware/devMode.js` injects a mock **superadmin** `req.user` when `DEV_MODE=true` and `NODE_ENV !== 'production'`, so admin/superadmin routes can be exercised locally without a real Auth0 login. No-op in the deployed image, which sets `ENV NODE_ENV=production` in the `Dockerfile` — note Cloud Run does **not** set `NODE_ENV` itself (only the buildpack path does, and this project builds from a Dockerfile), so that ENV line is what keeps the bypass off in production. Run locally with `DEV_MODE=true NODE_ENV=development npm run dev`.
  `DEV_ROLE` / `DEV_CLUB` / `DEV_STATS` override the mock's claims —
  `DEV_ROLE=admin DEV_CLUB=Hyde` gives a club-scoped admin, `DEV_ROLE=none` an
  ordinary logged-in user. Use them: the admin branch is a materially different
  site and is the least-exercised one.
- **JWT**: `checkJwt` middleware (RS256, JWKS from Auth0) used on API-style routes like `PATCH /club/:id` and `DELETE /club/:id`.
- **The Auth0 tenant is shared with the Stockport league site** (`~/league-site`) —
  same `AUTH0_DOMAIN`, two applications with different client IDs and audiences. So
  the user directory and `app_metadata` are *one set of records read by both sites*.
  Anything you change tenant-side affects both.
- **The login page is Classic Universal Login (Lock 11), and its HTML is in this repo** —
  `auth0/tameside-login-page.html`, deployed into Auth0 by `tools/auth0-login-page.js`.
  It is per-application (`custom_login_page` on the client), which is the only way to
  brand Tameside separately without a paid plan. `GET /api/v2/prompts` claims
  `universal_login_experience: "new"` and is misleading — the rendered page is Lock.
  Read `auth0/README.md` before touching any Auth0 setting; several are shared with
  Stockport.

### Emails

Nine emails, one pipeline. `emails/*.mjml` → `npm run build:email` → committed
`views/emails/*.ejs` → sent by `utils/mailer.js`.

Before this there were nine send sites across three files: seven inline HTML string
literals, one from a **Mailjet-hosted** template (`TemplateID 6134550` — the layout of an
email this site sends lived outside version control), and two SendGrid exports. Three
files each built their own Mailjet client. Adding an email meant copying whichever block
looked closest.

Adding one now: write `emails/<name>.mjml`, run `npm run build:email`, call
`mailer.send({ template, subject, text, to, data })`, add a case to
`test/email-templates.test.js`.

**MJML is a devDependency and never ships.** The Dockerfile runs `npm ci --omit=dev`, so
the compiled `.ejs` is committed and production renders it with the `ejs` it already had —
the runtime path is unchanged. Compiling in the image (as `build:css` does) would make
mjml a production dependency for the sake of a build step.

Three MJML 5 traps, all of which fail **silently**:

- **The API is async.** `mjml2html()` returns a Promise; treating it as synchronous yields
  an object with no `html` and a template containing only the banner comment.
- **`mj-include` is off by default.** Passing `filePath` is not enough — without
  `ignoreIncludes: false` the partials are dropped with no error, and you get a template
  with no header, footer or theme. The CLI spelling is `--config.allowIncludes true`.
- **An EJS tag between two MJML components is discarded, and the content it guarded then
  renders unconditionally.** `<% if (photoUrl) { %>` around an `<mj-text>` produced a photo
  link that always showed. Inside a text node EJS survives; between components it does not.
  Wrap those in `<mj-raw>`. `tools/build-emails.js` counts EJS tags in the source (and its
  includes) against the output and **fails the build** if any were eaten — verified by
  reintroducing the bug on purpose.

Other things worth not rediscovering:

- **`utils/mailer.js` owns the one Mailjet client**, and both controllers re-export it as
  `_mailjetClientForTesting`. That export **must be `mailer.client`** — a separate instance
  would leave the test stub intercepting nothing while real mail went out.
- **Every email needs a plain-text part**; `send()` throws without one. Some senders had
  none, which scores worse with filters and renders as an empty body in a text-only client.
- **The footer's "why you are receiving this" line is per-email** (`whyReceiving`), because
  the audiences differ — a captain, a club secretary hearing from a stranger, a player on
  the mailing list. It is the main defence against a junk click, which in Mailjet
  permanently suppresses that address with no bounce. See `docs/email-deliverability.md`.
- **The score in a "scorecard received" email is counted from the submitted games and
  labelled "games".** At that point the row is a draft in `scorecardstore` and no
  `fixture.homeScore` exists yet, so it must not be presented as the league's match score.
- **`GET /mailjet` is deleted.** The Mailjet getting-started sample, never removed: an
  unauthenticated endpoint that sent a hardcoded message to the league results mailbox, so
  a curl loop was a mail bomb. (An HTTP **HEAD** probe fires it too — Express routes HEAD to
  the GET handler.) Same shape as the `/SESemail` endpoint Stockport deleted.
- **`describeFixtureFromBody` never rejects.** An email naming the match beats the old one;
  an email that fails to send because a team-name lookup timed out is worse than both, so a
  failed lookup degrades to the team id.
- Two pre-existing bugs fixed in passing: the "website updated" email fell back to
  **`stockport.badders.results@`** — the *other* league's mailbox — whenever the submitter's
  address was missing; and `POST /add-scorecard-photo` had no `.catch` on its send, so a
  Mailjet failure was an unhandled rejection and the request never got a response.
- The `scorecard received` send also sat **outside** its `else` (closed off early by a stray
  `};`, working only because `msg` was an implicit global), so on a create error it called
  `next(err)` and then sent anyway. It `return`s now.

### Absolute URLs — never from `req.headers.host`

`utils/siteUrl.js` owns the site's public address. Anything that must be absolute — links
in emails, the Auth0 logout `returnTo`, webhook payloads, `rel=canonical` — goes through
`siteUrl()` / `absoluteUrl(path)` / `canonicalFor(req)`, which read `SITE_URL` (default
`https://tameside-badminton.co.uk`).

**tameside-badminton.co.uk resolves to Firebase Hosting, which proxies to Cloud Run and
REWRITES the Host header.** Proven by experiment 2026-09-02: a request sent to
`https://tameside-badminton.co.uk/hostprobe-…` was recorded by Cloud Run as
`https://tameside-site-p6gfjwl72q-nw.a.run.app/hostprobe-…`. So in production
`req.headers.host` is **always** the run.app hostname and the domain the visitor typed
**cannot be recovered from the request at all**.

What that broke, and why it looked like a scorecard bug: the results-secretary email built
its links from `req.headers.host`, so it sent
`https://tameside-site-…a.run.app/populated-scorecard-beta/2164`. Clicking one puts the
browser on the run.app origin, and then

1. `secured` stores `returnTo` and sets `__session` — for `*.a.run.app`;
2. `/login` goes to Auth0, whose callback is (correctly) `…co.uk/callback`;
3. the browser returns to the **`.co.uk` origin — a different cookie jar** — which does not
   send that cookie;
4. no OAuth state and no `returnTo`, so `/callback`'s `|| '/'` fires and you land logged in
   on the homepage having asked for a scorecard.

**No session store can fix this** — two origins cannot share a cookie. The only fix is to
never emit a run.app link. `test/site-url.test.js` has a repo-wide source assertion that
fails if `req.headers.host` / `req.get('host')` reappears anywhere outside the helper: this
was one expression copy-pasted into seven files, and it is exactly what gets reintroduced
from an older handler.

- **The app cannot detect which origin the browser is on**, so a "redirect to the canonical
  host" middleware is NOT safe here — it would loop on every page. Don't add one.
- **Emails already sent still contain run.app links** and will still misbehave. Editing the
  host in the address bar is the workaround.
- The `.replace('.com', '.co.uk')` chains that used to decorate the canonical-url code were
  earlier attempts at the same problem; they could never work, because a run.app hostname
  contains no `.com` to replace.
- **Nothing renders `canonical`.** Several controllers pass it as a view local and no view
  reads it, so it is dead — worth knowing before "fixing" it again.
- `AUTH0_CALLBACK_URL` is `https://tameside-badminton.co.uk/callback`, which is correct and
  should stay on the custom domain.

### Sessions

`express-session`, cookie name `__session`, **stored in Postgres** —
`utils/sessionStore.js`, table from `migrations/session-store.sql` (applied to production
2026-09-02).

**There was no `store` at all until then**, so it used the built-in `MemoryStore`: one
object, per Node process. This service runs with `maxScale 4`, **session affinity OFF**
and `minScale 0`, so a session was valid only on the instance that created it and every
session died when the service scaled to zero. `Warning: connect.session() MemoryStore is
not designed for a production environment` was in the Cloud Run logs several times a day.

The symptom was the **login round trip**, which is three hops — `/login`, Auth0,
`/callback` — any of which can land on a different instance:

- **OAuth state lost** → `passport.authenticate` finds no user and `/callback` redirects
  back to `/login`. Reads as "the link just fails".
- **`returnTo` lost** → the callback's `|| '/'` fallback fires and you arrive at the
  homepage instead of the page you clicked.

It was always broken, and it became reachable far more often when
`GET /scorecard-photo/:id` replaced the public S3 URL in the results-secretary email,
because that turned a link needing no session into one that forces the whole round trip.
It had also silently broken the registration-import **review → apply** handover, which
parks the parsed document in the session — fine locally, where there is one process, and an
intermittent "that review has expired" in production.

> **This was not the cause of the "emailed link dumps me on the homepage" report**, though
> it looks identical. That was the Host rewrite putting a `*.a.run.app` link in the email —
> see **Absolute URLs** above. Both bugs are real and both had to be fixed; when a session
> appears to vanish across the Auth0 round trip, check which ORIGIN the browser is on before
> assuming the store.

- **Not `connect-pg-simple`.** It needs `pg`, and this app uses `postgres` (postgres.js).
  A second driver means a second pool, and `POOL_MAX` (5) × `_MAX_INSTANCES` (4) ≤ 60 is
  a hard ceiling that `test/db-pool.test.js` asserts. A store on the existing `sql` adds
  no dependency and opens no pool.
- **`touch` is not optional here.** The app runs `resave: false`, so a session that is
  read but not modified is never written back; without `touch` its `expire` never moves
  and an admin is logged out mid-session at a fixed time after logging in.
- **The cookie sets no `maxAge`**, so `session.cookie.expires` is null and the row would
  have no TTL at all — hence the 24h default in `expiryFor`. `test/session-store.test.js`
  fails if a `maxAge` appears, so the two can't drift apart silently.
- **Cost is paid by admins only.** express-session calls `get` only when the request
  carries a `__session` cookie, and `saveUninitialized: false` means anonymous visitors
  never get one. The public pages that carry the traffic touch the store not at all.
- **Apply the migration before deploying**: without the table every session read throws
  and nobody can log in.
- **A `secured` link in an email costs a full Auth0 login**, which is the intended
  security posture. Stockport avoids that with a signed per-draft token (their HARD-03) and
  Tameside has no equivalent — **decided 2026-09-02 not to build one**: in practice only
  the results secretary opens these photos and is normally already logged in, so the token
  would be machinery for a problem nobody has. Revisit only if photo review is ever shared
  out to captains.

> Browser Sentry captures console at `levels: ['error']` (`views/header.ejs`), so a stray
> `console.error` used as a debug log files a Sentry issue per occurrence. One in the
> scorecard upload path (logging the S3 URL) was doing exactly that — Sentry
> JAVASCRIPT-1VD. Use `console.log` for debug output on any page a logged-in user sees.

### Authorization

**Postgres is the single source of truth; Auth0 only proves identity.** Site-wide role
used to live in Auth0 `app_metadata` custom claims while club roles (`teamCaptain`,
`clubSecretary`, …) lived on the `player` table — two sources for one question. The
claims now come from the player table (`migrations/player-auth-roles.sql`), ported from
Stockport's `23a5cea` + `551b6e8`.

- `player.role` — `'admin'` (scoped to that row's own club) or `'superadmin'`; NULL
  means no site role. **Deliberately not derived** from the club-role flags: ticking
  "teamCaptain" must not silently grant site access.
- `player."statsAccess"` — lets an *admin* see the Individual/Pair Stats pages.
- `player_auth_email` (`migrations/player-auth-email.sql`) — encrypted login addresses,
  **many per player**. This is the login→player link, and it is very often *not* the
  registered contact email: only 34 of 101 Tameside role-holders matched on
  `playerEmail` alone. Only `setAuthRole` writes here, only when given an address, and
  it **adds** rather than replaces — so an ordinary player edit can't remove the link
  the lookup depends on.
  - Several per player because one person genuinely has several Auth0 identities. The
    league results mailbox exists as both `stockport.badders.results@` and
    `tameside.badders.results@` and **both are superadmin**; the original single
    `player."authEmail"` column could hold one, so the other silently lost its role.
    Three further addresses in the tenant carry two Auth0 identities each (a password
    `auth0|…` login and a Google `google-oauth2|…` login).
  - `player."authEmail"` is superseded and no longer read or written. Left in place as
    the rollback path — drop it once this has been through a real cutover.

**The claim keys did not change — only their source.** The Auth0Strategy verify
callback in `app.js` calls `Player.getAuthRoleByEmail()` at login and writes the answer
onto the same three `_json` keys the app always read, via `authz.applyRoleClaims()`.
That's what kept a ~46-call-site change small. Consequences worth knowing:

- **`utils/authz.js` owns the claim strings.** Every JS reader goes through it
  (`isSuperAdmin`, `isAdmin`, `userClub`, `hasClubAccess`, `hasStatsAccess`,
  `scopeToAdminClub`). Only `middleware/devMode.js` also names them, because it builds
  a mock — and it does so through `applyRoleClaims` so it can't drift. Four **views**
  still spell the keys out longhand, so a rename has to land in the same commit;
  `test/authz.test.js` pins the literal strings for that reason.
- **One query per login, not per request** — the profile is serialised into the
  session. So **a role change only takes effect on that person's next login.**
- **A DB failure at login grants no role rather than failing the login.**
  Authentication now touches Postgres; blocking login on a DB blip would take the whole
  site down. Logged as `[authz] role lookup failed at login` and sent to Sentry.
- **`club` is `'All'` for a superadmin, and `'All'` is not a club name.** Never
  interpolate the claim into a URL or a club lookup without branching first — Stockport
  shipped `/manage-players/club-All` to its own superadmin exactly that way (`ce6250d`).
  `scopeToAdminClub` and `hasClubAccess` both handle it.
- **Roles moving to the DB puts far more people in the `admin` branch.** Stockport's
  127 club captains landed there and found a crash nobody had hit (`72f54fa`). Browse
  as `DEV_ROLE=admin` before believing a change is safe.
- **`app_metadata.betaAccess` looks dead and is not.** Nothing in either repo reads it;
  a separate Auth0 **Action gates real login on it**, and the tenant is shared. The
  PATCH in `models/auth.js` must stay.
- Auth0-side cleanup (dropping the Action/Rule that injects `role`/`club`/`stats`) is
  **still outstanding** and is a two-site change — don't do it until both are stable.

Approving a new signup and assigning a role are one step: `GET /approve-user/:userId`
renders `views/approve-signup.ejs` (superadmin only, pure display), and the POST does
everything. Both used to be a single **unauthenticated GET with side effects**, so a
mail scanner prefetching the link in the notification email could approve someone.

The central error handler in `app.js` honours `err.status` for 4xx: an expected 403/404
answers with that status and **no Sentry event**. Before this, every `next(...)`
rendered a 500 and spent an event — and several call sites passed a bare **string**,
which carries no status at all.

#### Migration ordering

`migrations/player-auth-roles.sql` **must be applied before this code is deployed**.
Without those columns, `getAuthRoleByEmail` throws on every login and the fail-safe
path grants nobody a role — i.e. every admin silently loses access. Additive and
idempotent, so it's safe to run first and safe to re-run.

Migrations have a runner now: `node tools/run-migration.js <file.sql>` (dry run by
default, `--commit` to apply, `--list` to see them). It sends the file whole via the
simple query protocol rather than splitting on semicolons — `player-auth-roles.sql`
contains a `DO $$ … $$` block whose body has its own semicolons, and splitting mangles
it. Applied to production 2026-08-30.

**Linking is a screen, not a spreadsheet**: `/admin/link-auth-accounts` (superadmin, in
the Admin nav) is the worklist — it lists every Tameside role-holder still needing a
player, offers a one-click link where the login email happens to match a contact email,
and a search-and-link for the rest. The role it writes comes from the **tenant**, never
from the form body, so a tampered POST can't mint a superadmin;
`test/integration/auth-link.test.js` guards that. It also surfaces "roles with no
matching Auth0 account", which is how a drifted link shows up.

The classification rules live in `utils/authMigration.js` — committed, unlike the
scripts, because the two-signal cross-league rule is the part worth keeping.

Backfill (one-off, `scripts/` is gitignored). `audit-auth-roles.js` is read-only and
runs on either side of the migration, reporting which mode it's in; `backfill` refuses
to run before it. Its **cutover gate has two conditions**, not one: an empty MISMATCHES
list alone is not a pass, because it only compares accounts the lookup already resolves
— before the backfill it's empty *because* nothing has been migrated.

```bash
node scripts/audit-auth-roles.js                     # 1. read-only. pre-migration: how many
                                                     #    role-holders match on playerEmail alone
# 2. apply migrations/player-auth-roles.sql
node scripts/audit-auth-roles.js --csv > roles.csv   # 3. now proposes dbPlayerId per account
# 4. review roles.csv: fill dbPlayerId where blank, delete stale/test accounts
node scripts/backfill-auth-roles.js roles.csv        # 5. dry run
node scripts/backfill-auth-roles.js roles.csv --commit
node scripts/audit-auth-roles.js                     # 6. check the CUTOVER GATE. Then deploy.
```

The **cutover gate has two conditions**, and an empty MISMATCHES list alone is not a
pass: MISMATCHES only compares accounts the lookup already resolves, so before the
backfill it is empty *because* nothing has been migrated. The gate also requires nothing
"unreviewed" — an account that is neither linked nor named in
`scripts/accepted-unlinked.txt`. Accounts are named rather than counted on purpose: a
count silently absorbs the *next* unlinked account, so someone signing up tomorrow would
keep the gate green while quietly having no role. `--write-accepted` generates that file
from the current unlinked set.

**MISMATCHES means someone's admin scope moves**, not that the wrong person is linked.
After cutover an admin's club comes from `player.club`, so an account whose Auth0 claim
named a different club changes scope. A player at the placeholder club **"No Club"** ends
up scoped to nothing.

#### What the audit actually found (2026-08-30)

203 accounts in the tenant; **155 carry `role`/`club`/`stats`** (150 `admin`, 2
`superadmin`, 3 club-only; only **3** have the `stats` flag). **54 of the 155 belong to
Stockport** — their `club` claim names a club Tameside has never heard of.

Of the 101 that are ours, only **34 matched a player row on `playerEmail` alone** — the
concrete argument for `player_auth_email`.

**`app_metadata.league` is not an authorization signal.** It records which site someone
signed up on (`stockport` | `tameside`, set on 51 of 203) and was an abandoned attempt
at differentiating the two experiences. It was briefly used here as a second
cross-league test, which wrongly held back **8 genuine Tameside admins** whose accounts
happened to carry `league=stockport` (Alderley Park, College Green, Disley — all real
Tameside clubs). The club claim is the only signal;
`test/integration/auth-link.test.js` has a test that `league` is ignored.

Other keys, for reference: `betaAccess` (162 — the login gate), `messeradmin` (1,
Stockport's), `team` (1). Anything not `role`/`club`/`stats` belongs to the other site
or to Auth0 itself; leave it alone.

**Deduplicate by email, not by `user_id`.** Three addresses have two Auth0 identities
each, and the lookup matches the address — so one link covers both, and counting
identities overstates the work.

`roles.csv` is gitignored — it holds every role-holder's email address.

### Season Detection

Single source of truth: **`models/season.js`**. `season.init()` runs once at boot
(in `app.js`) and resolves the current season from the DB — the season whose
`startDate` most recently passed (`SELECT name FROM season WHERE "startDate" <= now()
ORDER BY "startDate" DESC`) — then caches it. Call sites use `season.current()` /
`season.previous()` (both synchronous, cached). A date-based fallback (rolls over
~1 July) is used only if the DB lookup fails.

```javascript
const seasonModel = require('./season');
const SEASON = seasonModel.current(); // e.g. "20242025"
```

`season.getAll()` lists past seasons that have an archived `team<season>` snapshot
table (plus a `hasLewis` flag), used by the DB-driven History nav and `/history`
archive page.

Season names arrive from URLs and get **appended to table names** (`team<season>`,
`lewis<season>`), so anything building a suffixed identifier must check the name first —
otherwise Postgres answers `relation "..." does not exist` and the request 500s on what
should be a 404. Three helpers, all in `models/season.js`:

- `season.isValidName(name)` — format only: two consecutive four-digit years from 2012 on.
  Note `"null"` and `"undefined"` are truthy strings, so a bare `if (!season)` does **not**
  catch them (that was Sentry TAMESIDE-NODE-4, `relation "lewisnull" does not exist`).
- `season.hasSnapshot(season)` — is there a `team<season>` table? Cached probe.
- `season.hasLewis(season)` — is there a `lewis<season>` table? Cached probe. Tracked
  separately because not every snapshotted season ran the competition.

A well-formed name can still have no data, so pair the format check with the relevant
existence probe and render the 404 page (`utils/render404.js` — keep its no-store header,
or Firebase's edge pins the 404 to a URL that later becomes valid).

> Legacy note: older code inlined `new Date().getMonth()` math (and it had drifted
> — players.js rolled over on 1 Aug, everything else on 1 July). That's all been
> replaced by the shared model; don't reintroduce inlined season math.

### Error Tracking (Sentry)

Server-side errors report to Sentry via `instrument.js` (required first in `app.js`)
and the central 500 handler. It's a **no-op unless `SENTRY_DSN` is set**, and only
sends when `NODE_ENV=production` or `K_SERVICE` is present (so local/dev/test never
ship events). The central 500 handler in `app.js` **must** be a 4-arg function
(`err, req, res, next`) — Express only registers error middleware by arity.
Read-only triage: `tools/sentry/sentry-issues.js` (uses `SENTRY_AUTH_TOKEN`).
Browser Sentry lives in `views/header.ejs` (logged-in users only) and scopes
`captureConsoleIntegration` to `levels: ['error']`.

### Superadmin Admin UI

Superadmin-gated pages under `/admin/*` (session-`secured()` route + in-controller
`isSuperAdmin(req)` check — role `superadmin` in the Auth0 `_json` claim):
homepage content, site settings, and league structure — **clubs** and **teams**
(`/admin/clubs`, `/admin/teams`) with add/edit and one-click promotion/relegation
(moves `team.division` to the adjacent-rank division in the same league). Superadmins
can also edit a fixture's date inline on the admin results grid.

### Spam and abuse controls

Four layers on `/contact-us`, deliberately independent, because each covers what the
others can't. Ported from the Stockport league site 2026-07-31.

| Layer | Where | Notes |
|---|---|---|
| reCAPTCHA | `validCaptcha` in `contactusController` | Pre-existing |
| Blocklists | `blocked_entry` table, `models/spamControls.js` | ip / email / phrase / word |
| Honeypot + timing | `views/spam-fields.ejs`, `utils/spamChecks.js` | Catches bots we've never seen |
| Submission log | `submission_log` table | The only way to tell whether any of it works |

There is **no rate limiting** on this site — that's Stockport's fifth layer and was not
ported. Schema lives in `migrations/spam-controls.sql` (additive, safe to re-run).

**Blocking someone is a form submission, not a deploy** — `/admin/spam` (superadmin, in
the Admin nav). It used to be a source edit: 26 spammer addresses and ~180 phrases were
hardcoded in `contactusController.js`. Don't put lists back in code.

Rules worth not rediscovering:

- **The blocklist validators must `throw`, not `return false`.** express-validator 7
  fails a *synchronous* validator that returns falsy, but judges an async one on whether
  its promise **rejects** — resolving to `false` is a silent pass. Reading the lists from
  the DB makes them async, so returning false turns both blocklists into no-ops that let
  everything reach Mailjet. `test/integration/spam-gate.test.js` guards this.
- **Mount the spam middlewares below the static handlers** (they are, in `app.js`). Above
  them, one page view means a dozen HMACs and a dozen blocklist lookups.
- **A new public form must include `views/spam-fields.ejs`** inside its `<form>`, and its
  POST route must carry `spamGate()`. The shared partial exists so the honeypot and the
  timing floor can't drift apart or be forgotten.
- **A rejection is deliberately indistinguishable from a success.** Naming the check that
  fired is how a spammer tunes a payload. The cost is that a false positive silently eats
  a real message — which is why only the two checks with negligible false-positive rates
  behave this way. **Watch the `validation` count on `/admin/spam`:** rising means real
  people are failing the form.
- **A missing timing stamp is not spam.** Caches, autofill and any form rendered before
  the field existed would all be caught. Only the floor is enforced, so a stale tab still
  submits.
- **`models/spamControls` never fails closed.** A DB hiccup means empty lists, not
  rejecting every submission. The cache is warmed at boot in `app.js` because the IP check
  reads it synchronously on every request — skipped under `NODE_ENV=test` so every test
  file doesn't open its own connection.
- **`SESSION_SECRET` signs the timing stamp** and `app.js` falls back to a hardcoded
  string if it is unset. With a known key a stamp can be forged, which downgrades that
  check. It is **still unset in Cloud Run, and deliberately parked until the end of the
  2026/27 season (June 2027)** — setting it invalidates every live session, so it wants a
  quiet moment rather than mid-season. Don't re-raise it before then; the honeypot and the
  two blocklists are unaffected.
- The profanity list was **not** carried over: politeness policing rather than spam
  defence, and it cost real messages ("ass", "sex", "gay", "hell" as bare substrings).
  `Christ` and `God` were in the *spam* half as substrings and blocked Christine,
  Christopher, Goddard and Godfrey. That's why `phrase` (substring) and `word`
  (whole-word) are separate kinds — prefer `word` for anything short or ordinary.

### Connection pooling and its two ceilings

`utils/db_connect.js` holds one shared `sql` pool on the Supabase **transaction** pooler
(port 6543, `prepare: false`). Two numbers there are coupled to things outside the file,
and `test/db-pool.test.js` asserts both:

- **`IDLE_TIMEOUT` (180s) must stay above `spamControls.CACHE_TTL_MS` (60s).** The blocklist
  refresh timer in `app.js` runs on that interval; if the pool closes idle connections
  sooner, every tick reconnects. That pairing (30s vs 60s) was costing **1,800 connection
  opens/day on zero traffic** — at ~3.6ms per open that is ~6.5 s/day, several times more
  DB time than every application query combined (~1 s/day). Verified after the fix: **0
  opens over 4 minutes**, with the refresh still ticking once a minute. `app.js` reads the
  interval from `spamControls` rather than restating it, so the two can't drift.
- **`POOL_MAX` (5) × `_MAX_INSTANCES` (4, in `cloudbuild.yaml`) must stay ≤ 60**, the
  backend limit. `--max-instances` was unset (Cloud Run defaults to **100**) until
  2026-08-05, i.e. up to 1,000 clients for 60 slots. Stockport took exactly that outage
  in session mode (`EMAXCONNSESSION`, Sentry NODE-V). Raise either number and you must
  check the other. `PG_POOL_MAX` overrides the pool cap without a deploy.

#### Retrying a read whose connection died

`withRetry()` (same file) re-runs a query **once** when it fails with a connection-class
error. A pooled connection can be dead by the time it is used — fine when it went into
the pool, closed by the far side before the next query — and nothing on this side
prevents that. Without a retry the visitor gets the 500 page.

This is a platform behaviour, not a pooling bug of ours: on 2026-08-06 Tameside got
`read ECONNRESET` on the homepage (Sentry TAMESIDE-NODE-5) 12 minutes into a container's
life, and Stockport got `Connection terminated unexpectedly` (NODE-X) the same day, on a
container up for a week, through a different driver (`pg`) against a different Supabase
project. postgres.js won't retry it — its only retry path is `retryRoutines` on a server
`ErrorResponse` for prepared statements.

- **Reads only, and always pass a thunk**: `withRetry(() => sql\`...\`)`. Re-awaiting an
  already-built Query just replays its settled rejection, and the `/tables` queries
  interpolate nested `` sql`` `` fragments that belong to a single build. An `INSERT`
  that timed out may well have committed, so retrying a write would double it.
- **`PostgresError` is never retried.** The server received the query and rejected it;
  re-sending gets the same answer.
- **Once, then give up.** Sized for a stale socket, which the next connection fixes. If
  the DB is genuinely away, more attempts just hold the request open.
- Applied to the three pages judged worth protecting — `/`, `/info/clubs`, `/tables/*` —
  across 9 model functions. `test/db-retry.test.js` asserts the behaviour *and* that
  those 9 still use it, so it can't be dropped by a later edit to one of the queries.
- Those 9 were also moved from the `.catch(err => done(err))` idiom to `try`/`catch`.
  The old idiom called `done(err)` and then fell through to `done(null, undefined)`, so
  the controller rendered on top of a 500 already in flight — and being outside the
  request chain, the resulting throw killed the process. `try`/`catch` removes the path
  rather than guarding it, and is what lets `withRetry`'s rejection be caught at all.
- A retry that succeeds produces **no Sentry event**, so `[db] connection failed
  mid-query` in the Cloud Run logs is the only trace. Grep for it to judge the rate.

> Diagnosing DB resource warnings: query load is almost never the answer here — measured
> 2026-08-05, all application SQL was ~1 s/day. Supabase's own dashboard introspection cost
> more DB time than the entire site. The real cause of "exhausting multiple resources" was
> the **old PG 15.6 platform image**, which preloaded `timescaledb` and `pg_stat_monitor`
> into every backend on a ~1GB instance; upgrading to 17.6 dropped both. Compare against
> the Stockport project (`~/league-site`) before assuming a workload problem.

> Known issue: the DB-backed integration tests are flaky under connection pressure
> (`npm test` intermittently fails 2 of the email-scorecard tests). Pre-existing, and
> reproducible with these changes reverted; `node --test` runs files in parallel and the
> one real-DB test contends. Serialising the runner or mocking that test's models fixes it.

### Key Dependencies

| Purpose | Package |
|---|---|
| Database | `postgres` v3 |
| Templates | `ejs` |
| Auth | `passport`, `passport-auth0`, `express-jwt`, `jwks-rsa` |
| Image processing | `sharp` (scorecard OCR pre-enhance), `jimp` |
| Email | `node-mailjet` |
| S3 uploads | `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` |
| Fuzzy matching | `fastest-levenshtein` |
| Calendar export | `ical.js` |
| CMS content | `contentful` |
| SCSS | `express-dart-sass` (Bootstrap source in `/bootstrap/`) |

### S3 Scorecard Photos

Client uploads scorecard images directly to S3 (`badmintontemp` bucket, `eu-west-1`) using
presigned URLs generated by the `GET /sign-s3` route in `app.js`. Reads go through
**`GET /scorecard-photo/:id`** (`secured`), never straight from the bucket.

**The bucket is shared with the Stockport league site (`~/league-site`), which owns it.**
Nobody planned that; it was found while auditing the bucket, and it is the reason for
everything below. Their handover note is `~/league-site/docs/handover/tameside-s3-bucket.md`.

Every object at the bucket root was world-readable — not from a bucket policy but from the
per-object `ACL: public-read` that `/sign-s3` set at upload time. Our photos were rendered
straight from the bucket with the public URL stored in `scorecardstore."scoresheet-url"`
and pasted into the results-secretary email, so the authorization on a photo of a match
was "know the URL", forever, for anyone that email was forwarded to. Stockport is stripping
those ACLs over the root, which is where our photos live, so a public `<img src>` would
have turned into a broken image on the day they swept.

- **`GET /scorecard-photo/:id` is keyed by row id, never by an object key from the
  request.** A proxy that streams any object anyone can name has moved the problem, not
  solved it — and this bucket holds another league's scorecards. `utils/scorecardPhoto.js`
  derives the key from the row; `fixtureController.scorecard_photo` streams it.
- **817 of the 1,139 photo rows in `scorecardstore` are not ours.** The table was cloned
  from Stockport's database when this site was built: ids 878–1757 point at *their*
  un-prefixed objects at the shared root (their teams are Canute, Dome, Cheadle Hulme,
  Tatton, Parrswood… clubs that exist nowhere in this database, and only 9 of the 817 join
  a real fixture). Ours are ids 1758–2087, all keyed `tameside-…`. **So ownership is an
  allowlist on the `tameside-` prefix, not a denylist of the other prefixes** — a denylist
  would have let `/scorecard-photo/1545` serve another league's scorecard out of our own
  origin. Those 817 rows 404, which is correct; nothing has ever rendered a photo for them.
- **`+` in a stored URL is a space in the real key.** The upload widget rebuilds the object
  URL from the presigned one and rewrites `%20` as `+` (`views/email-scorecard.ejs`). Those
  URLs work in a browser because S3's REST endpoint decodes `+` in a path as a space — so
  both spellings answer 200 over HTTPS and it looks like two objects when it is one.
  `GetObject` does **not**: it takes the key literally. Without that translation 314 rows
  ask for a key that has never existed. Confirmed with `HeadObject`: the `+` form is
  `NotFound`, the space form is found.
- **Two host spellings, and the majority is the one you would not write today**: 808 rows
  use `badmintontemp.s3-eu-west-1.amazonaws.com` (dashed), 325 the dotted
  `s3.eu-west-1`. A reader built only for what the current uploader writes would 404 two
  thirds of the archive, silently.
- **Never echo S3's `ContentType` back.** These objects were uploaded through a `/sign-s3`
  that was unauthenticated and stored the caller's content type, so a legacy object can
  claim `text/html` — and reflecting that serves attacker-chosen HTML from *our* origin,
  same-origin with the `__session` cookie, which is strictly worse than serving it from the
  bucket. The extension decides, and an unrecognised one is a 404. This applied to
  `/admin/scorecard-ocr/image` too, which did echo it.
- **PDFs are 40 of our 322 photos** and go out as `Content-Disposition: attachment`, never
  inline: an inline PDF renders in our origin and PDFs can carry script.
- **`/sign-s3` is `secured` and no longer sets an ACL.** It was unauthenticated, presigning
  a PUT with a caller-chosen key into a bucket shared with the other league — anyone could
  write any object anywhere in it. Dropping the ACL is what makes the lockdown durable:
  Stockport's sweep is one-off, so while that line stayed the bucket would drift back to
  world-readable one scorecard at a time.
- **A `secured` link in an email needs a working session**, and sessions used to live in
  a per-process MemoryStore — so replacing the public URL here is what exposed that bug.
  See **Sessions** above; the fix is `utils/sessionStore.js`.
- **Preview an upload from the local file, not the bucket.** `views/email-scorecard.ejs`
  uses `URL.createObjectURL(file)`: at upload time there is no `scorecardstore` row yet,
  so `/scorecard-photo/:id` does not exist for it, and an `<img>` aimed at S3 breaks the
  day the ACLs come off.
- **Ask before Stockport changes Object Ownership.** Their sweep only covers reads. If they
  set Object Ownership to "bucket owner enforced", a presigned PUT that carries
  `x-amz-acl` fails outright — that would have broken *uploads*, not just reads, which is
  why the ACL had to come off this side first.
- `utils/s3.js` owns the credential choice. The default `AWS_ACCESS_KEY_ID` pair was
  rotated out at some point and everything presigned with it gets 403
  `InvalidAccessKeyId`; `S3_LOGS_STORAGE_*` is the live pair. That selection used to be
  copy-pasted in three places, which is how one of them gets missed at the next rotation.

The reply telling Stockport we took option A is
`docs/handover/s3-bucket-reply-to-stockport.md`, **sent 2026-09-02** — so they are clear to
sweep the whole bucket root with no `tameside-*` carve-out, and the Object Ownership
sequencing ask in that note is with them.

Verified against production 2026-09-01: 322 rows claimed as ours, 321 resolve via
credentialed `HeadObject`, 817 correctly refused. The one miss (id 1767) is a pre-existing
dead link and 404s. `test/scorecard-photo.test.js` pins the key derivation against the real
URL shapes; `test/integration/scorecard-photo.test.js` pins the route's gating and headers.

### Social Image Generation

`social_controller.js` generates PNG images of league tables and results (for social
media) with **Jimp** — see `GET /resultImage/*` and `GET /tables-social`. Text is drawn
from pre-baked bitmap fonts (`fonts/*.fnt` + their `.png` sheets), loaded via
`Jimp.loadFont`. That is pure JS: no fontconfig, freetype or system font packages are
involved, which is why the image installs none. `sharp` is used only for pixel ops in
`utils/scorecardVision.js` (greyscale/normalize/sharpen) — never for rendering text —
so it doesn't need them either. If you ever add SVG text rendering via sharp, you'll
need to reinstate `fontconfig` + a font in the Dockerfile.

### Team Registration Forms

Two directions, and they share one format contract:

**Out.** `/forms/team-registration/:club/prefilled` fills the PDF AcroForm
(`documentsController.js`, pdf-lib), and the team-admin page links a `.docx` generated by
`playerController.js`. Both are pre-filled from the club's current roster.

**Back in.** `/admin/team-registrations` (superadmin, or a club admin for their own club —
in the Admin nav) takes the file a club has edited and returned, diffs it against the
database, and applies the ticked changes in one go. Clubs return **both** formats, so both
are read. Comparing the two by eye was the job this replaces.

- `utils/registrationDoc.js` — reads either format into one shape. Dispatches on the
  file's **magic bytes, not its extension**: a `.docx` renamed `.pdf` is a normal thing to
  receive.
- `utils/registrationDiff.js` — pure. Turns that plus the current roster into typed
  changes: `order`, `team`, `reserve`, `new`, `reactivate`, `transfer`, `ambiguous`,
  `no-such-team`, `remove`, `unchanged`.
- `controllers/teamRegistrationController.js` — the three routes.

**The letter column is the data model.** `A`/`B`/`C` means nominated for that team, `R`
means reserve. That maps onto `player.team` plus `player.rank` (99 = reserve, otherwise
position within team+gender), and **row order within a block IS the rank order** — there is
no rank column on the form, so "changes in order" means "the rows moved".

Things that will bite anyone editing this:

- **The `.docx` and the PDF encode reserves differently.** The `.docx` writes `R` in the
  letter column. The PDF does **not** — `documentsController.reserveRows()` writes the
  player's *current team letter* there, and reserve-ness comes from **which table** the row
  is in. Reading the PDF's letter as nominated silently promotes every reserve in the club.
  The two dynamic PDF tables are told apart by their Men column x-position (373.2 for
  reserves, 321.4 for nominated overflow), because the `Dyn_<n>` field names carry only a
  counter whose meaning depends on how many rows the generator happened to draw.
- **A reserve's team comes from the block heading**, not the letter column, because the
  `.docx` doesn't record it anywhere else and the database does keep a team for reserves.
- **Ownership of a name is decided by searching everyone, not the roster.** 486 of 1,138
  players sit at the placeholder club `No Club` and 196 have no club row, against 456
  actually registered — so a name missing from the roster is far more often a dormant
  player (`reactivate`) than a new one. Concluding `new` without the wider search would
  mint duplicate rows as a matter of routine.
- **Names are not unique and the collisions are live.** 8 display names are duplicated in
  the player table; Hyde holds two `Richard Jakeman` rows and two `Dave Lee` rows, and both
  names are on a returned form. `ambiguous` is a first-class outcome — and an ambiguous
  entry's candidates are **held back from the removal sweep**, or ticking them would park
  the real player at `No Club` on the strength of a duplicate nobody had noticed.
- **`remove` parks, it never deletes** — club/team set to the `No Club` / `No Team`
  placeholders, rank 99, exactly what the team-admin remove button already writes. `No
  Club` is the league's archive, not a bin. Removals are never pre-ticked, and >5 of them
  raises a warning: a club omitting a page looks identical to a club dropping players.
- **Transfers are flagged, never applied.** A name resolving to another club's player is a
  `transfer` and is not in `APPLICABLE_KINDS`; a tampered payload that ticks one is skipped.
- **The client never says what a change means.** The review page posts back change **keys**
  only. `apply` re-parses the stored document from the session, re-reads the database,
  re-runs the diff, and looks each key up in its own fresh result — so a payload can only
  select from what the server proposed, and the write reflects the DB as it is now.
- **The upload is the raw request body** (`express.raw` on that one route), not multipart:
  this repo has no multipart parser and doesn't need one for a single file.
- Club naming is inconsistent and the diff has to tolerate it: the club row is `G.H.A.P`
  while its teams are `GHAP A`/`GHAP B` (comparison normalises punctuation away), and
  `Hyde High` is a document name with no club row at all — which raises the
  "document says X, you are importing Y" warning rather than being applied silently.

Verified against production 2026-09-01: all seven returned `.docx` files parse with zero
warnings, and feeding a freshly generated PDF back produces **zero** spurious changes.
`test/registration-doc.test.js` builds its fixture with the same `docx` package the real
generator uses, so it can't drift from it.

#### POST /player/batch-update

Had **no auth gate and no validation**, and passed `req.body` straight into
`Player.updateBulk` as `tablename` / `fields` / `data` — an unauthenticated *UPDATE any
table SET any column WHERE id = any id*, `player.role` included. Identifiers are escaped by
postgres.js so it wasn't SQL injection, which hardly helped.

**It is not redundant and must not be deleted**: `views/team-admin.ejs` (twice) and
`views/AddCreatePlayerModal.ejs` all drive it for drag-and-drop reordering. So it is
narrowed instead — `secured`, an allowlist of the one table and the four columns those
callers use (`id`, `team`, `rank`, `club`), integer-and-shape validation, and club scope
resolved **from the database, not the payload**, for the whole batch before any write. A
player id that doesn't exist is a refusal, not a pass: a missing row has no club to compare
and would otherwise fall past the scope check.

### Fuzzy Player Matching

`GET /players/matching/:name/:gender` uses `fastest-levenshtein` to find the closest player name. Used when entering match results to handle name variations.

### Scorecard OCR (superadmin)

`/admin/scorecard-ocr` reads an uploaded scorecard photo from S3 and prefills the
normal entry flow. Pipeline: `sharp` pre-enhance → **Google Vision REST**
(`images:annotate`, `DOCUMENT_TEXT_DETECTION`, authenticated with the plain
`GMAPSAPIKEY` — no service account) → `utils/scorecardExtraction.js` (pure:
orientation auto-correct on text-block coordinates, printed-label anchors, merged
digit-token splitting disambiguated by the scoring rules) →
`utils/scorecardMatch.js` (fuzzy-match names against each team's eligible roster,
gender-constrained per event) → review page → handoff link into the existing
`/populated-scorecard/...` prefilled form. **Nothing is saved by the OCR flow
itself** — submission goes through the normal validated entry path. Extraction and
matching are unit-tested against cached Vision responses in `test/fixtures/` (no
API calls). The 9 card events map 1:1 onto `Game1..Game18`
(`GAME_MAP` in scorecardExtraction).

## Required Environment Variables

```
DATABASE_URL / PGHOST / PGPORT / PGDATABASE / PGUSERNAME / PGPASSWORD
AUTH0_DOMAIN / AUTH0_CLIENTID / AUTH0_CLIENT_SECRET / AUTH0_CALLBACK_URL / AUTH0_AUDIENCE
S3_BUCKET_NAME / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
MAILJET_KEY / MAILJET_SECRET
GMAPSAPIKEY / RECAPTCHA / RECAPTCHA_SECRET
CONTENTFUL_KEY / CONTENTFUL_SPACE
DB_ENCODE          # PgP key for decrypting player contact data
SENTRY_DSN         # Server-side error reporting (instrument.js). Dormant unless set;
                   # only sends when NODE_ENV=production or K_SERVICE is set (Cloud Run).
SENTRY_AUTH_TOKEN  # Read-only token for the tools/sentry/sentry-issues.js triage helper
SITE_URL           # The site's own public address for absolute links (emails, canonical,
                   # logout returnTo). Defaults to https://tameside-badminton.co.uk.
                   # NEVER derive one from req.headers.host — Firebase rewrites Host to the
                   # Cloud Run hostname. See utils/siteUrl.js.
MAILJET_WEBHOOK_TOKEN  # Shared secret in the Mailjet event-callback URL
                   # (/webhooks/mailjet?t=...). Unset means the route 404s, i.e. inert.
                   # See docs/email-deliverability.md.
```

## Scorecard Validation

**`0` is a player id meaning "nobody".** It is the `No Player Home Team` /
`No Player Away Team` option, which is how a captain records a side that turned up short,
and several slots can legitimately hold it in one match. `noDuplicatePlayerValidator`
therefore **skips** the duplicate check for `0` — it used to `return false`, which failed
validation with "can't use the same player more than once" and made the documented
workflow impossible on `/email-scorecard`.

That was the first link in a three-bug chain that put a captain in an unrecoverable 500
loop on 3 Sep 2026 (three `POST /email-scorecard` 500s in 18 seconds). Worth understanding
as a whole, because each part looks harmless alone:

1. Picking `No Player` failed validation, with a message that pointed at the wrong thing.
2. The rejection re-renders the form, and on that render the first option was
   `<option>Choose Lady 2</option>` — **no `value`, not `disabled`, so submittable**. The
   options partial also marked a row selected only where `row[ordinalKey] == 1`, which
   nothing satisfies when the previous choice was `0`. So the captain's choice vanished,
   the select fell back to the placeholder, and **the label was posted as the player id**.
3. The error branch of `fixture_populate_scorecard_errors` feeds those values into
   `getEligiblePlayersP` → a `bigint` column. So the page whose entire job is to show the
   validation message crashed on the bad value instead
   (`invalid input syntax for type bigint: "Choose Lady 2"`), and every retry did the same.

Rules that follow, all pinned by `test/scorecard-no-player.test.js`:

- **No `<option>` on a form may lack a `value`.** Without one the browser posts the
  option's own label, so a placeholder becomes a fake data value. Placeholders are
  `value="" disabled`.
- **The error branch must never query with unvalidated input.** It coerces every player
  field with `parseInt`, falling back to `0`. Bug 3 predates the rest and is reachable by
  anyone: the same crash hit revision 00235 on 19 Aug 2026 with `"lmdkqrfp"` and
  `"gkuhrrew"`, i.e. a scanner posting junk.
- **`views/partials/scorecard-player-options.ejs` re-selects what was actually posted**
  (`selectedValue`), not what the ordinal columns say, so a `No Player` choice survives a
  validation error. `side` picks the matching home/away label — cosmetic, since both carry
  `0`, but showing "No Player Home Team" in an away dropdown reads like a bug.
- The happy path builds these selects client-side from `static/playerFormOptions.ejs`,
  whose placeholder is already `disabled`. Only the **error re-render** used the server
  partial, which is why this went unnoticed for so long: it needs a first failure to reach.

Badminton scoring rules enforced in `fixtureController.validateScorecard`:

- Each game score: 0–30 points
- Winner must score ≥ 21; winning margin ≥ 2 (except at 30)
- Applied across all 18 games in a fixture
