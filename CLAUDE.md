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
  check. Set it in the deployed environment.
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

Client uploads scorecard images directly to S3 (`badmintontemp` bucket, `eu-west-1`) using presigned URLs generated by the `GET /sign-s3` route in `app.js`.

### Social Image Generation

`social_controller.js` generates PNG images of league tables and results (for social
media) with **Jimp** — see `GET /resultImage/*` and `GET /tables-social`. Text is drawn
from pre-baked bitmap fonts (`fonts/*.fnt` + their `.png` sheets), loaded via
`Jimp.loadFont`. That is pure JS: no fontconfig, freetype or system font packages are
involved, which is why the image installs none. `sharp` is used only for pixel ops in
`utils/scorecardVision.js` (greyscale/normalize/sharpen) — never for rendering text —
so it doesn't need them either. If you ever add SVG text rendering via sharp, you'll
need to reinstate `fontconfig` + a font in the Dockerfile.

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
```

## Scorecard Validation

Badminton scoring rules enforced in `fixtureController.validateScorecard`:
- Each game score: 0–30 points
- Winner must score ≥ 21; winning margin ≥ 2 (except at 30)
- Applied across all 18 games in a fixture
