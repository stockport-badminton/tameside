#!/usr/bin/env bash
# A local copy of the league's database, for development (BL-06).
#
#   tools/local-db.sh up        start the container
#   tools/local-db.sh load      copy production in and scrub it (rebuilds from scratch)
#   tools/local-db.sh status    what is in it
#   tools/local-db.sh psql      a shell on it (or a one-shot: psql -c '...')
#   tools/local-db.sh url       the LOCAL_DATABASE_URL that points the app at it
#   tools/local-db.sh down      stop, keep the data
#   tools/local-db.sh nuke      stop and delete the data
#
# WHY: everything that runs locally runs against production: `npm run dev`, every
# Playwright spec (as a mock superadmin), the demo-video recorder. One wrong click in an
# admin page writes to the live league, with no request in Cloud Run's logs to say where it
# came from. Stockport found three rows nobody could explain that way (their HARD-13).
#
# load READS production (pg_dump through the session pooler, with .env's DATABASE_URL and
# PGPASSWORD) and writes nothing there. Contact details are rewritten before anything can
# read the copy, and the load fails, dropping the copy, unless check.sql proves it.
set -Eeuo pipefail
cd "$(dirname "$0")/.."

COMPOSE="docker compose -f docker-compose.local.yml"
CONTAINER=tbl-local-db
DB_USER=tbl
DB_NAME=tbl
PORT=5434
# Not a secret, and deliberately not production's DB_ENCODE: this copy must not be able to
# decrypt production data, nor production this. dev.env's DB_ENCODE should equal it.
LOCAL_KEY="${LOCAL_DB_KEY:-local-dev-not-a-secret}"

# Their rows hold mail, sessions, push subscriptions, contact-form submissions and the login
# cull's notices, so they are created empty: the data never leaves Supabase. `transactions`
# is somebody's billing-quota log that came with the Stockport clone; nothing reads it.
NO_DATA=(session inbound_email inbound_email_delivery registration_request
         rearrangement_request submission_log push_subscription push_send
         auth_account_notice social_result_post transactions)

psql_in() { docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -q -U "$DB_USER" -d "$DB_NAME" "$@"; }

wait_healthy() {
  for _ in $(seq 1 60); do
    [ "$(docker inspect --format='{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || true)" = healthy ] && return 0
    sleep 1
  done
  echo "the local database is not running: tools/local-db.sh up" >&2; exit 1
}

# A load that stops part-way may have left real contact details in the copy. Dropping the
# schema is not enough: the rows are still in the write-ahead log on the volume. So the whole
# volume goes. An EXIT trap, because an ERR trap does not fire when a failure inside a
# function ends the script under set -e (the first version left an unscrubbed copy that way).
LOAD_CLEAN=1
on_exit() {
  if [ "$LOAD_CLEAN" = 0 ]; then
    echo >&2
    echo "✗ load did not finish: deleting the local database and its volume, so no" >&2
    echo "  unscrubbed data is left. Fix the cause, then: tools/local-db.sh up && tools/local-db.sh load" >&2
    $COMPOSE down -v >/dev/null 2>&1 || true
  fi
}
trap on_exit EXIT
trap 'exit 130' INT TERM

case "${1:-}" in
  up)
    $COMPOSE up -d
    wait_healthy
    echo "up on 127.0.0.1:$PORT"
    ;;

  load)
    wait_healthy
    # Production's connection, from .env, into this shell's environment only. Never printed.
    eval "$(node -e '
      require("dotenv").config();
      for (const k of ["DATABASE_URL", "PGPASSWORD"]) {
        if (!process.env[k]) { console.error(k + " is not set in .env"); process.exit(1); }
        console.log("export " + k + "=" + JSON.stringify(process.env[k]));
      }')"
    host=$(node -e 'process.stdout.write(new URL(process.env.DATABASE_URL).host)')
    case "$host" in
      *:6543) echo "DATABASE_URL is the transaction pooler (6543); pg_dump needs session mode (5432)" >&2; exit 1 ;;
    esac

    LOAD_CLEAN=0   # from here until check.sql passes, a failure deletes the volume

    echo "→ fresh schema, with the extensions the app uses and Supabase's admin role"
    # supabase_admin: 33 RLS policies name it, and the restore stops without it. NOLOGIN.
    psql_in -c 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;' \
            -c 'CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS "uuid-ossp";' \
            -c "DO \$\$ BEGIN CREATE ROLE supabase_admin NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END \$\$;"

    echo "→ copying production ($host), read-only"
    excludes=""
    for t in "${NO_DATA[@]}"; do excludes="$excludes --exclude-table-data=public.$t"; done
    # The container's own pg_dump (17.x, matching the server), streamed straight into its
    # psql, so the copy never sits in a file. The dump's CREATE SCHEMA is dropped: the
    # schema exists, holding the extensions.
    docker exec -e DATABASE_URL -e PGPASSWORD "$CONTAINER" bash -c "
      set -euo pipefail
      pg_dump \"\$DATABASE_URL\" --no-owner --no-privileges --schema=public \
        --exclude-table='public.game_seed_backup_*' $excludes \
      | sed -e '/^CREATE SCHEMA public;\$/d' -e '/^COMMENT ON SCHEMA public /d' \
      | psql -v ON_ERROR_STOP=1 -q -U $DB_USER -d $DB_NAME >/dev/null"

    echo "→ replacing contact details with fakes"
    psql_in -c "SET tbl.local_key = '$LOCAL_KEY';" -f - < tools/local-db/scrub.sql

    echo "→ checking that nothing real is left"
    psql_in -c "SET tbl.local_key = '$LOCAL_KEY';" -f - < tools/local-db/check.sql

    LOAD_CLEAN=1

    # A restored database has no planner statistics; without them pages that are instant in
    # production can take seconds here (Stockport's experience).
    echo "→ analysing"
    psql_in -c 'ANALYZE;'

    echo
    "$0" status
    ;;

  status)
    wait_healthy
    psql_in -P pager=off -c "
      SELECT relname AS table, n_live_tup AS rows
        FROM pg_stat_user_tables WHERE n_live_tup > 0
       ORDER BY n_live_tup DESC LIMIT 10;"
    echo "contact details (should all be @example.invalid and 07700 900xxx):"
    psql_in -P pager=off -t -c "
      SELECT '  ' || pgp_sym_decrypt(\"playerEmail\", '$LOCAL_KEY') || '   ' ||
                     coalesce(pgp_sym_decrypt(\"playerTel\", '$LOCAL_KEY'), '')
        FROM player WHERE \"playerEmail\" IS NOT NULL ORDER BY id LIMIT 3;" 2>/dev/null ||
      echo "  (none readable: has load run?)"
    echo "point the app at it with:  LOCAL_DATABASE_URL=$("$0" url)  (and DB_ENCODE=$LOCAL_KEY)"
    ;;

  # No arguments: an interactive shell. With arguments, a one-shot without -t, because
  # `docker exec -it` with no terminal fails ("the input device is not a TTY").
  psql)    wait_healthy
           shift
           if [ "$#" -gt 0 ]; then
             docker exec -i "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" "$@"
           else
             docker exec -it "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME"
           fi ;;
  url)     echo "postgresql://$DB_USER:$DB_USER@127.0.0.1:$PORT/$DB_NAME" ;;
  key)     echo "$LOCAL_KEY" ;;
  down)    $COMPOSE down ;;
  nuke)    $COMPOSE down -v; echo "container and data removed" ;;
  *)       sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
