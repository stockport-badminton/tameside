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
| 1 | Publishing a result waits on the social posts **(deployed 2 Nov 2026; acceptance check due ~9 Nov: see `docs/social-posting.md`, last section)** | league-site `docs/hardening/done/HARD-47-publish-waits-on-social.md` | Read the `[timing] meta:` lines in Cloud Logging first (`utils/metaPublisher.js`). Our `_REQUEST_TIMEOUT` is 60s, and our version of their `afterCommit` is `sendResultZap`, which never calls back with an error. |
| 2 | Bootstrap 4 leftovers | [BL-01](BL-01-bootstrap-4-leftovers.md) | Ours alone. Their HARD-50 is a whole BS4→BS5 migration. |
| 3 | CSP resource allowlist | league-site `docs/hardening/done/HARD-12-security-headers.md` | The helmet headers and the enforced CSP baseline landed 4 Nov 2026 (`utils/securityHeaders.js`). Still to do: the allowlist, run report-only first behind a `/csp-report` collector, as Stockport did. Removing inline script is a separate job (their HARD-15, absorbed by REARCH-07). |
| 4 | `member` means "linked to a Tameside player", not "logged in" | — | Ours alone. Stockport approving someone lets them log in here (shared `betaAccess`). Waits until `/admin/link-auth-accounts` has linked our own captains, or narrowing `access.member` locks them out of result entry. Check the "Needs a player" count first. Raised 5 Nov 2026. |
| 5 | Inbound email: `registrations@` and `rearrangements@` queues (the lists are built) | [BL-04](BL-04-inbound-email-resend.md) | Stockport receives through SES; we use Resend for receiving only and keep sending on Mailjet. Raised 6 Nov 2026. Lists (steps 1-5, 7) live 7 Nov 2026. Step 6 (registrations@ and rearrangements@ queues) built 8 Nov 2026; live once its two migrations are applied. |
| — | `/sign-s3` lets the client choose the key | [BL-02](BL-02-sign-s3-server-keys.md) | Parked 30 Oct 2026. |
| — | Build social cards from layers | [BL-03](BL-03-social-card-layers.md) | Parked 2 Oct 2026. |

## Off-season (before the June 2027 rollover)

| What | Brief | Different here |
|---|---|---|
| A local database | league-site `docs/hardening/2728-rearch/done/REARCH-08-real-database-tests.md`, `docs/hardening/done/HARD-13-dev-database-guard.md` | Matters more here: we have **no** local DB, so Playwright reads production and SQL is rehearsed in a rolled-back transaction (`tools/rehearse-roster.js`, `tools/rotate-db-encode.js --rehearse`). |
| Season history | league-site `docs/hardening/2728-rearch/REARCH-02-season-history.md` | Must land before `clone_season()` runs in June 2027. |
| Drop `player_id_key` / `team_id_key` | — | Ours alone. Each duplicates its `_pkey`, but six FKs are bound to them (four to player's, the two `tameside_draft_fixture` team FKs to team's; see `migrations/drop-redundant-indexes.sql`). One migration: recreate those six against the pkeys (`NOT VALID`, then `VALIDATE`), then drop both keys, **never with CASCADE**. Small gain (a few kB, a duplicate btree write); off-season because `player` is read by every page. Raised 2 Nov 2026. |
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
