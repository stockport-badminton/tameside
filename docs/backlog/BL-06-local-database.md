# BL-06: A local database, and the site in Docker beside it

**Size:** about a day for tasks 1–4, then a separate small change for 5–6 ·
**When:** the Christmas break (matches thin out for a fortnight), tasks 5–6 no later than the
off-season · **Raised:** 25 Nov 2026 ·
**Upstream:** league-site `tools/local-db.sh`, `docker-compose.local.yml`,
`docs/hardening/done/HARD-13-dev-database-guard.md`,
`docs/hardening/2728-rearch/done/REARCH-08-real-database-tests.md`, and HARD-38 (their load
broke because the seed predated a production repair)

## Why

Everything that runs locally runs against production: `npm run dev`, every Playwright spec
(`playwright.config.js` boots `DEV_MODE=true`, a **mock superadmin**), dev-mode checks like the
reminder dry run on 25 Nov 2026, and the demo-video recorder. Reads are fine. The risk is one
wrong click in the roster editor or an admin page writing to the live league, with no request
in Cloud Run's logs to show where it came from. That is exactly how Stockport found three
`messer_scorecard` rows nobody could explain (HARD-13).

New SQL is proven by rehearsal tools that run against production and always roll back
(`tools/rehearse-roster.js`, `rehearse-push.js`, `rotate-db-encode.js --rehearse`). They work,
but each new feature has to write one, and a rehearsal can't run the app around the SQL.

## What is different from Stockport

- **We have no schema to build from.** Stockport has `001_initial.sql` plus numbered
  migrations. Ours was cloned from theirs, so `migrations/` describes changes to an existing
  database and can't rebuild one. The starting point is a `pg_dump` of production.
- **It is small.** 49 tables, 21 MB in total (25 Nov 2026), the biggest being
  `game_seed_backup_20261006` (25,002 rows, which a local copy can skip). One function in
  `public` (`clone_season`). A full data dump restores in seconds, so there is no need for
  Stockport's seed + `sync` split: load production, then clean it.
- **Supabase extensions.** Production is Postgres 17.6 with `pgcrypto`, `uuid-ossp`,
  `pg_stat_statements`, `hypopg`, `index_advisor`, `pgsodium` and `supabase_vault`. Only
  `pgcrypto` (`pgp_sym_*`) and `uuid-ossp` matter to the app. The image should be
  `postgres:17`, and the restore must tolerate (or filter out) the Supabase-only ones, plus
  Supabase's roles and grants (`--no-owner --no-privileges`).

## Status, 26 Nov 2026

**Done: the `db_connect` prerequisite and tasks 1–2.** `LOCAL_DATABASE_URL` (development
only), `docker-compose.local.yml`, `tools/local-db.sh`, `tools/local-db/scrub.sql` and
`check.sql`. A load takes about ten seconds, and the site boots and renders on the copy.
Where it differs from the plan below:

- **Port 5434, not 5433**: Stockport's local database has 5433 and both should run at once.
- **More was scrubbed than the list in task 2**, because the check scans every column rather
  than trusting the list: `club."contactUs"` (and archives), `club_registration.updated_by`,
  `scorecardstore.email`, `player_auth_account.user_id`, and `transactions` (another
  system's billing log from the clone) comes across empty.
- **Rows that are never needed are never copied**: those tables are dumped schema-only
  (`--exclude-table-data`) rather than copied and truncated.
- **A failed or interrupted load deletes the volume**, not just the schema: the rows are in
  the WAL. The first version used an ERR trap, which bash skips when a failure inside a
  function ends the script under `set -e`, and it left an unscrubbed copy behind (found and
  deleted at once). It is an EXIT trap now, and was tested by forcing a failure.

**Left for the break:** task 3 (`dev.env`, and making the local copy the default for
`npm run dev`), task 4 (the site in the compose file), 5 and 6.

## Spike, 26 Nov 2026 (schema only, no rows)

A schema-only `pg_dump` of production, restored into a throwaway `postgres:17`, to find what
breaks before the break. No personal data left Supabase: `--schema-only` copies no rows.

- **The app cannot point anywhere else today.** `utils/db_connect.js` hard-codes production's
  pooler host and project ref; only `PGPASSWORD` comes from the environment, and SSL is
  forced. It is the only connection in the codebase (tools, session store and migrations
  all go through it), so it is one change, and it is a **prerequisite for task 3**: read an
  opt-in local URL when `NODE_ENV !== 'production'`, SSL off for localhost, production
  unchanged by default. `tools/rotate-db-encode.js` and `tools/merge-players.js` print
  `DATABASE_URL`'s host as their "target" while connecting through the hard-coded string;
  make them print what `db_connect` actually uses.
- **No local `pg_dump` is needed.** `docker run postgres:17 pg_dump` (17.11 against the
  server's 17.6) works through the session pooler, `DATABASE_URL` in `.env` (port 5432),
  with `PGPASSWORD` passed in: the URL itself carries no password.
- **The restore is clean except Supabase's roles.** All 48 tables and `clone_season` came
  through. The only errors were 33 RLS policies granted `TO supabase_admin`; create that
  role (`NOLOGIN`) before restoring and they apply. RLS is enabled on most tables, which is
  harmless locally because the app connects as their owner.
- Nothing in `public` references the `extensions`, `auth`, `vault` or `pgsodium` schemas,
  and the dump sets an empty `search_path`. Install `pgcrypto` and `uuid-ossp` first; the
  app calls `pgp_sym_*` unqualified, which finds them in `public` locally (in
  `extensions` on Supabase).

## Tasks

1. **`docker-compose.local.yml` and `tools/local-db.sh`** (`up`, `load`, `status`, `psql`,
   `url`, `down`, `nuke`), copied from Stockport's and cut down. Port 5433, a container name of
   our own. Nothing here touches production.
2. **`load`: dump, restore, clean, in one go, rebuilt from scratch every time.**
   `pg_dump --no-owner --no-privileges` from `DATABASE_URL` (read-only), excluding
   `game_seed_backup_*`, into a dropped-and-recreated `public` schema. Then **clean, before
   anything else can read it**:
   - Contact columns are `bytea`, PgP-encrypted with `DB_ENCODE`: `player."playerEmail"`,
     `"playerTel"`, `"authEmail"`, `player_auth_email.email` and the `player<season>`
     archives' copies (cleared in production since 2 Oct 2026; clear again anyway).
     **Decrypt nothing locally.** Overwrite each non-null value with
     `pgp_sym_encrypt('player<id>@example.invalid', <local key>)` (phones with a fixed dummy),
     so the app's decrypt path still runs and every address is fake. The local key is a
     constant like Stockport's `local-dev-not-a-secret`, so this database can't read
     production's data and production can't read this one's.
   - Truncate: `session`, `inbound_email`, `inbound_email_delivery`, `registration_request`,
     `rearrangement_request`, `submission_log`, `push_subscription`, `push_send`,
     `auth_account_notice`, `social_result_post`. Clear `blocked_entry` of `ip`/`email` rows.
   - Keep: fixtures, games, teams, clubs, players' names, the archives, `strength_run`,
     `schema_migrations`. They are what makes the local site look like the real one, and
     names are already public on the site.
   - **A check at the end that fails the load** if any contact column still decrypts with the
     *production* key, or if any truncated table has rows.
3. **`dev.env` (gitignored) pointing at the local database**, with a dummy `DB_ENCODE` equal
   to the local key and no Mailjet, Resend, Meta, VAPID private or S3 write credentials. **Opt
   in**: `.env` and production stay the default, so nothing anyone runs today changes.
   `tools/run-migration.js` should accept the local URL, so a new migration is tried locally
   first.
4. **The site in Docker beside it.** A `site` service in the same compose file built from the
   existing `Dockerfile` (unchanged), on the compose network, `NODE_ENV=development`,
   `DEV_MODE=true`. That's the production image against a production-shaped database: it also
   catches what only shows in the container (fonts in the social cards, ffmpeg, sharp's linux
   binaries; see CLAUDE.md, Social Image Generation).
5. **Move Playwright onto it.** `playwright.config.js`'s `webServer` takes the local URL. Then
   `test/e2e/helpers/read-only.js` becomes optional rather than load-bearing, and specs can
   exercise real writes. Check every spec still passes before switching.
6. **Only then, the guard (HARD-13).** A development process (`NODE_ENV !== 'production'`)
   refuses to start against the production host unless a deliberate override is set; the
   rehearsal tools and the demo-video recorder pass that override, because production is the
   point of them. Do this last: turning it on before 1–5 are trusted breaks local work in the
   middle of a season.

Update CLAUDE.md (Commands, and the "reads the **production** database" note under
Playwright) and the demo-video README when 3 and 5 land.

## Risks

- **A half-cleaned copy is personal data on a laptop.** That's why cleaning is part of `load`,
  not a separate step, and why the load fails its own check rather than warning.
- **Drift.** The copy is a snapshot. `load` is cheap, so re-run it rather than maintaining
  it. A migration applied to production must also be in `schema_migrations` locally, which a
  fresh load gives for free.
- **Not a reason to stop rehearsing against production.** A rehearsal still proves the SQL
  against the real data and the real Supavisor pooler, which a local Postgres isn't.
