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

Last reviewed 24 Nov 2026, against league-site `7ce4dca` and its open HARD and REARCH briefs.
That pass took HARD-46 (event-page map on tap) and the 404 half of `7ce4dca` (no service
worker from a 404); the withdrawn-team half doesn't apply, as we have no withdrawn teams.
The 23 Nov review covered Stockport's ratings, predictions, event-page and route lockdown
commits from 2 to 22 Nov (league-site `b3ff421`). The 2 Nov review covered about
110 commits from 3 Oct plus their open HARD and REARCH briefs.

## Open, in order

| # | What | Brief | Different here |
|---|---|---|---|
| 2 | CSP resource allowlist | league-site `docs/hardening/done/HARD-12-security-headers.md` | **Report-only since 24 Nov 2026**, collected at `/csp-report` (`csp-report:` in Cloud Logging). Client-side EJS removed 24 Nov 2026 (`static/js/form-options.js`, their `9e6f2df`), so the e2e suite passes enforcing, 65/65. First night (24 Nov): reports arrive; one real photo upload reported nothing against the bucket; Sentry's blob worker reported and allowed (`8f1b128`); one sourceless `wasm-eval` on `/email-scorecard`, probably an extension (allow `'wasm-unsafe-eval'` only if it recurs from several visitors). Left: a full league-night week, the page walk listed in `utils/securityHeaders.js`, another upload or two, then set `CSP_ENFORCE=true`. Removing inline script is a separate job (their HARD-15, absorbed by REARCH-07). |
| 5 | Weekly fixtures post links to the division | — | Ours: `controllers/weeklyFixturesController.js` uses `siteUrl()`, the homepage. Stockport's c482fc3 did the result posts (we already do) and not this one, so this goes beyond them. |
| — | OCR for the v2 scorecard | [BL-05](BL-05-ocr-scorecard-v2.md) | Ours alone. Waits on the committee adopting the card (sent to captains 16 Nov 2026). The A/B write-in box is done (v2.1); a printed version mark is still worth asking for before printing — see the brief. |
| — | PDF scorecards whose image is `/FlateDecode` | league-site `docs/hardening/HARD-29-flatedecode-scorecards.md` | Low: about one card a season there. Ours decline for other reasons first (MRC layers, two pages; see CLAUDE.md, Document scorecards), so measure our archive's share before building it. |
| — | `/sign-s3` lets the client choose the key | [BL-02](BL-02-sign-s3-server-keys.md) | Parked 30 Oct 2026. |
| — | Build social cards from layers | [BL-03](BL-03-social-card-layers.md) | Parked 2 Oct 2026. |

## Christmas break (matches thin out for a fortnight)

| What | Brief | Different here |
|---|---|---|
| A local database, and the site in Docker beside it | [BL-06](BL-06-local-database.md) | We have **no** local DB and no baseline schema (ours was cloned from Stockport's), so it starts from a cleaned `pg_dump` of production. Six tasks; the dev-mode guard (their HARD-13) is the last, and can wait for the off-season. Raised 25 Nov 2026. |

## Off-season (before the June 2027 rollover)

| What | Brief | Different here |
|---|---|---|
| Season history | league-site `docs/hardening/2728-rearch/REARCH-02-season-history.md` | Must land before `clone_season()` runs in June 2027. |
| Drop `player_id_key` / `team_id_key` | — | Ours alone. Each duplicates its `_pkey`, but six FKs are bound to them (four to player's, the two `tameside_draft_fixture` team FKs to team's; see `migrations/drop-redundant-indexes.sql`). One migration: recreate those six against the pkeys (`NOT VALID`, then `VALIDATE`), then drop both keys, **never with CASCADE**. Small gain (a few kB, a duplicate btree write); off-season because `player` is read by every page. Raised 2 Nov 2026. |
| Weekly rating snapshots and the "about these ratings" text | league-site `88de0ee`, `3dbfd9e`, `f9e1ac0`, `d02a3c0`, migration 038 | Row 7 has landed. Theirs reads the REARCH-02 history tables (`player_at`, `team_season`). Ours would use `team<season>` until season history lands. |
| Other league's games in the ratings | league-site `63504e2`, migration 033, `utils/externalLeagues.js` | Optional. Row 7 has landed; check it with `tools/strength-backtest.js`. Stockport already reads **our** DB read-only for this (`TAMESIDE_DATABASE_URL`). The reverse needs a read-only Stockport credential. Players are linked only on a unique exact name match with compatible gender, never by id. |
| One outbox for every side effect | league-site `docs/hardening/2728-rearch/REARCH-05-outbox.md` | Smaller here: we have `social_result_post` and `sendResultZap`'s swallow-and-log, no `afterCommit`, Threads queue or invoice run. Worth it mainly if a second queue appears. |
| `req.user` as our own object; logging defaults | league-site `docs/hardening/2728-rearch/REARCH-09-small-defaults.md` | Part A fits us directly: we write DB roles into Auth0's claim namespace at login too (`authz.applyRoleClaims`), and four views spell those keys out. Part C (tokenless drafts) doesn't apply: we have no draft tokens. |
| Per-season Elo rank | league-site commit `18d1067` | Accuracy, not speed. Deferred 2 Oct 2026. The backfill rates the past with each player's *current* team's division (see CLAUDE.md, Elo). |

## Skipped, and why

These are recorded so nobody proposes them again.

- **REARCH-01 typed queries.** Skipped in the 2 Nov 2026 review. The reason was not written
  down. Add it here if this is reopened.
- **REARCH-03 Part A.** We chose FK pointers for club officers instead
  (`project_club_contact_consolidation`, Sep 2026).
- **Messer items.** Stockport-only (Messer is their competition).
- **Officer contacts on `/club/:id` limited to own club.** Decided 23 Nov 2026 to keep
  them open to every linked player: a captain arranging or rearranging a match needs the
  other side's captain and match secretary. Stockport logins can't reach it (`member`).
- **Tournament posters.** Their content, down to the venue address (see CLAUDE.md).
