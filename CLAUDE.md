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
- **JWT**: `checkJwt` middleware (RS256, JWKS from Auth0) used on API-style routes like `PATCH /club/:id` and `DELETE /club/:id`.

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
