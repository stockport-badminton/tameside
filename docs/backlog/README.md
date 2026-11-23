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

Last reviewed 23 Nov 2026, against Stockport's ratings, predictions, event-page and route
lockdown commits from 2 to 22 Nov (league-site `b3ff421`). The 2 Nov review covered about
110 commits from 3 Oct plus their open HARD and REARCH briefs.

## Open, in order

| # | What | Brief | Different here |
|---|---|---|---|
| 1 | Bootstrap 4 leftovers | [BL-01](BL-01-bootstrap-4-leftovers.md) | Ours alone. Their HARD-50 is a whole BS4→BS5 migration. |
| 2 | CSP resource allowlist | league-site `docs/hardening/done/HARD-12-security-headers.md` | The helmet headers and the enforced CSP baseline landed 4 Nov 2026 (`utils/securityHeaders.js`). Still to do: the allowlist, run report-only first behind a `/csp-report` collector, as Stockport did. Removing inline script is a separate job (their HARD-15, absorbed by REARCH-07). |
| 3 | Event page metadata | league-site `6801d52` (the `fixture_event_detail` and `header.ejs` parts) | Match-first `documentTitle`/`metaDescription`, the result card as `og:image`, JSON-LD built in code (`utils/structuredData.js`) with a BreadcrumbList. **Trap:** our `header.ejs` emits SportsEvent only when the title contains "Event", so renaming the title silently drops it. Move that to a flag first. |
| 4 | Match preview and report, without forecasts | league-site `utils/fixturePreview.js`, `Fixture.getMatchContext` (both `6801d52`) | Table places, recent form, previous meetings, post-match report. Leave out the forecast sentences until row 8. The wording assumes "six" and 3+3 categories (`fixturePreview.js` ~152-200): rework it for 4 men + 2 ladies and check our game-type names. Format dates by hand, not `toLocaleDateString`. Never name a player. |
| 5 | Weekly fixtures post links to the division | — | Ours: `controllers/weeklyFixturesController.js` uses `siteUrl()`, the homepage. Stockport's c482fc3 did the result posts (we already do) and not this one, so this goes beyond them. |
| 6 | League run-in: who can still go up or down | league-site `097de0a` (`utils/leagueRunIn.js`, `League.getRunIn`, `/admin/league-run-in`) | The logic doesn't depend on anything else. Confirm our promotion and relegation counts first (theirs: two up, two down). Feeds row 8. |
| 8 | Predictions, projected tables, order checks, event-page forecast | league-site `e9ea24b`, `750637a`, `2cc3b7b`, `99716c7`, and the `public` block / `TeamStrength.forecastFor` from `6801d52` | Row 7 landed 23 Nov 2026 (`docs/team-strength.md`): the rating, the nightly run and each team's usual 4+2 are stored; `predictFixture` and the 4+2 `RUBBERS` are built and backtested. Still needs row 6 for standings. Port `projectSeason` with `formSd` sized by the share of the season left (0.15 from September, 0.1 from January, see the doc). Their order check assumes three nominated players (`MAX_NOMINATED`, `LEVEL_POSITIONS`). The public block holds no names or player ids, and their tests assert that. Keep those tests. |
| — | OCR for the v2 scorecard | [BL-05](BL-05-ocr-scorecard-v2.md) | Ours alone. Waits on the committee adopting the card (sent to captains 16 Nov 2026). The A/B write-in box is done (v2.1); a printed version mark is still worth asking for before printing — see the brief. |
| — | `/sign-s3` lets the client choose the key | [BL-02](BL-02-sign-s3-server-keys.md) | Parked 30 Oct 2026. |
| — | Build social cards from layers | [BL-03](BL-03-social-card-layers.md) | Parked 2 Oct 2026. |

## Off-season (before the June 2027 rollover)

| What | Brief | Different here |
|---|---|---|
| A local database | league-site `docs/hardening/2728-rearch/done/REARCH-08-real-database-tests.md`, `docs/hardening/done/HARD-13-dev-database-guard.md` | Matters more here: we have **no** local DB, so Playwright reads production and SQL is rehearsed in a rolled-back transaction (`tools/rehearse-roster.js`, `tools/rotate-db-encode.js --rehearse`). |
| Season history | league-site `docs/hardening/2728-rearch/REARCH-02-season-history.md` | Must land before `clone_season()` runs in June 2027. |
| Drop `player_id_key` / `team_id_key` | — | Ours alone. Each duplicates its `_pkey`, but six FKs are bound to them (four to player's, the two `tameside_draft_fixture` team FKs to team's; see `migrations/drop-redundant-indexes.sql`). One migration: recreate those six against the pkeys (`NOT VALID`, then `VALIDATE`), then drop both keys, **never with CASCADE**. Small gain (a few kB, a duplicate btree write); off-season because `player` is read by every page. Raised 2 Nov 2026. |
| Weekly rating snapshots and the "about these ratings" text | league-site `88de0ee`, `3dbfd9e`, `f9e1ac0`, `d02a3c0`, migration 038 | Row 7 has landed. Theirs reads the REARCH-02 history tables (`player_at`, `team_season`). Ours would use `team<season>` until season history lands. |
| Other league's games in the ratings | league-site `63504e2`, migration 033, `utils/externalLeagues.js` | Optional. Row 7 has landed; check it with `tools/strength-backtest.js`. Stockport already reads **our** DB read-only for this (`TAMESIDE_DATABASE_URL`). The reverse needs a read-only Stockport credential. Players are linked only on a unique exact name match with compatible gender, never by id. |
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
