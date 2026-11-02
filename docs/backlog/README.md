# Backlog

The work still queued for this site, most of it ported from the Stockport league site
(`~/league-site`). The top level is what is still open. Landed briefs move to `done/`, so a
glance at the directory answers "what is left".

**Most rows here do not have a brief of their own.** Where Stockport already wrote one, the
row links to it (paths are as of league-site `64d8758`) and records only what is different
for us. Copying their brief would give us a second version that drifts away from theirs.
A brief lives here only when nothing upstream covers the work.

This list used to exist only in the assistant's memory, which nobody else could see and git
did not track. Keep it here, and keep it current: when something lands, move its brief to
`done/` or delete the row.

Last reviewed 2 Nov 2026, against about 110 Stockport commits from 3 Oct to 2 Nov plus
their open HARD and REARCH briefs.

## Open, in order

| # | What | Brief | Different here |
|---|---|---|---|
| 1 | Publishing a result waits on the social posts **(built 2 Nov 2026, not deployed: see `docs/social-posting.md`, last section)** | league-site `docs/hardening/done/HARD-47-publish-waits-on-social.md` | Read the `[timing] meta:` lines in Cloud Logging first (`utils/metaPublisher.js`). Our `_REQUEST_TIMEOUT` is 60s, and our version of their `afterCommit` is `sendResultZap`, which never calls back with an error. |
| 2 | Load PostHog after the page has loaded; remove GA | — | Defer PostHog now. Removing GA follows the mid-Nov decision in `docs/analytics-posthog-vs-ga.md`, which also has the removal checklist. |
| 3 | Migration ledger | league-site `docs/hardening/done/HARD-32-migration-tracking.md` | `tools/run-migration.js` exists, but nothing records which migrations have been applied. |
| 4 | `pointsFor` → `gamesWon` | league-site `docs/hardening/2728-rearch/REARCH-03-one-record-per-fact.md`, Part C | Part C only. See Skipped for A. |
| 5 | Social posts link to the division, not the homepage | league-site commit `c482fc3` | Captions are built in `utils/metaPublisher.js` / `utils/socialVideo.js`. |
| 6 | Bootstrap 4 leftovers | [BL-01](BL-01-bootstrap-4-leftovers.md) | Ours alone. Their HARD-50 is a whole BS4→BS5 migration. |
| 7 | Basic security headers | league-site `docs/hardening/done/HARD-12-security-headers.md` | We send none. Start with the cheap headers; CSP is a separate job (their HARD-15, absorbed by REARCH-07). |
| 8 | Route access declarations | league-site `docs/hardening/2728-rearch/done/REARCH-04-route-access.md` | Our routes are all in `app.js`. `secured`, `requireSuperAdmin`, `requireCronCaller` and the in-controller `isSuperAdmin` checks are the four shapes it would replace. |
| — | `/sign-s3` lets the client choose the key | [BL-02](BL-02-sign-s3-server-keys.md) | Parked 30 Oct 2026. |
| — | Build social cards from layers | [BL-03](BL-03-social-card-layers.md) | Parked 2 Oct 2026. |

## Off-season (before the June 2027 rollover)

| What | Brief | Different here |
|---|---|---|
| A local database | league-site `docs/hardening/2728-rearch/done/REARCH-08-real-database-tests.md`, `docs/hardening/done/HARD-13-dev-database-guard.md` | Matters more here: we have **no** local DB, so Playwright reads production and SQL is rehearsed in a rolled-back transaction (`tools/rehearse-roster.js`, `tools/rotate-db-encode.js --rehearse`). |
| Season history | league-site `docs/hardening/2728-rearch/REARCH-02-season-history.md` | Must land before `clone_season()` runs in June 2027. |
| Team strength | — | Stockport feature, not yet looked at in detail. |
| Per-season Elo rank | league-site commit `18d1067` | Accuracy, not speed. Deferred 2 Oct 2026. The backfill rates the past with each player's *current* team's division (see CLAUDE.md, Elo). |

## Skipped, and why

These are recorded so nobody proposes them again.

- **REARCH-01 typed queries.** Skipped in the 2 Nov 2026 review. The reason was not written
  down. Add it here if this is reopened.
- **REARCH-03 Part A.** We chose FK pointers for club officers instead
  (`project_club_contact_consolidation`, Sep 2026).
- **Messer items.** Stockport-only (Messer is their competition).
- **Tournament posters.** Their content, down to the venue address (see CLAUDE.md).
